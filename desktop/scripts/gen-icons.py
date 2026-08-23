# Regenerate the desktop icon set from a single source:
#
#   assets/icon-source.svg  full-detail logo on a white rounded-square tile
#
# Pipeline: headless Chrome rasterizes the tiles at master resolution
# (vector-faithful, no resample chain), then PIL Lanczos-downscales per target.
#
# One render of the source:
#   full   icon-source.svg  as-is (transparent, plate-less flat whale) -> every
#          surface size. The artwork is already a simplified 4-path flat whale
#          that stays legible at 16px, so no separate small-size variant is
#          needed (a decorative-stroke variant used to exist; retired with the
#          previous artwork).
#
# Platform variants:
#   Windows/Linux  art as-is on a transparent canvas -> *.png, Square*Logo, .ico
#   macOS          Apple icon grid: content scaled into a centered 1648/2048
#                  (~80.5%) box, transparent margins, NO plate — the OS applies
#                  its own squircle mask -> .icns
#   Tray           tight-cropped art, closest square crop
#
# Outputs:
#   desktop/assets/tray-icon.png            (256x256, tight-cropped full tile)
#   desktop/assets/{icon.png,icon.ico,icon.icns}
#   desktop/src-tauri/icons/*.png (32/64/128/128@2x/icon, Square*, StoreLogo)
#   desktop/src-tauri/icons/icon.ico        (16-256, mixed small/full frames)
#   desktop/src-tauri/icons/icon.icns       (macOS grid renders)
# Android/iOS icon dirs are NOT touched (desktop-only project).
#
# Usage: python scripts/gen-icons.py   (needs Chrome + Pillow)

import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSETS = os.path.join(ROOT, "desktop", "assets")
ICONS = os.path.join(ROOT, "desktop", "src-tauri", "icons")

CHROME_CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    os.environ.get("LOCALAPPDATA", "") + "/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

# Apple app-icon grid ratios (Big Sur+): content box / canvas
MAC_CONTENT = 1648 / 2048  # 0.805 -> 200px transparent margin per side at 2048


def find_chrome():
    for p in CHROME_CANDIDATES:
        if p and os.path.exists(p):
            return p
    raise SystemExit("headless Chrome not found; install Google Chrome or extend CHROME_CANDIDATES")


def shoot(chrome, tmp_dir, svg_text, px, name):
    """Rasterize an SVG string at px x px with transparency. The root
    width/height attributes are rewritten to px (they're a display hint on
    the source file, not part of the geometry)."""
    svg_text = re.sub(r'<svg([^>]*?)\s(width)="[^"]*"', f'<svg\\1 width="{px}"', svg_text, count=1)
    svg_text = re.sub(r'<svg([^>]*?)\s(height)="[^"]*"', f'<svg\\1 height="{px}"', svg_text, count=1)
    svg_path = os.path.join(tmp_dir, f"{name}.svg")
    png = os.path.join(tmp_dir, f"{name}.png")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg_text)
    subprocess.run(
        [
            chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
            f"--user-data-dir={os.path.join(tmp_dir, 'profile')}",
            f"--window-size={px},{px}", "--default-background-color=00000000",
            f"--screenshot={png}", "file:///" + svg_path.replace("\\", "/"),
        ],
        check=True, capture_output=True, timeout=120,
    )
    if not os.path.exists(png):
        raise SystemExit(f"failed to render {name} at {px}px")
    return Image.open(png).convert("RGBA")


def load(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def mac_variant(source_svg):
    """Place the artwork on Apple's icon grid: content scaled into a centered
    1648-box with transparent margins. No plate and no corner radius — macOS
    applies its own squircle mask to whatever it is given (the previous
    plate+radius version double-rounded against the OS mask)."""
    m_root = re.search(r"<svg[^>]*>", source_svg)
    if m_root is None:
        raise SystemExit("icon-source.svg: expected <svg> root")
    inner = source_svg[m_root.end():source_svg.rindex("</svg>")]
    s = MAC_CONTENT
    off = round((1 - s) * 2048 / 2)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048" '
        f'viewBox="0 0 2048 2048">'
        f'<g transform="translate({off} {off}) scale({s})">{inner}</g></svg>'
    )


def pack_ico(entries):
    """ICO container with PNG-compressed images. entries = [(size, png_bytes)]."""
    header = struct.pack("<HHH", 0, 1, len(entries))
    directory = b""
    offset = 6 + 16 * len(entries)
    for size, blob in entries:
        s = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    return header + directory + b"".join(blob for _, blob in entries)


def pack_icns(entries):
    """ICNS container; entries = [(4cc type, png_bytes)] (PNG allowed types)."""
    blobs = b"".join(t.encode("ascii") + struct.pack(">I", len(p) + 8) + p for t, p in entries)
    return b"icns" + struct.pack(">I", len(blobs) + 8) + blobs


def png_bytes(img):
    import io

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def fit_square(img, px, fill_ratio=1.0):
    """Center art inside a square px-canvas, art scaled so max(dim)=fill_ratio*px."""
    bbox = img.getbbox()
    art = img.crop(bbox)
    target = round(px * fill_ratio)
    w, h = art.size
    scale = target / max(w, h)
    art = art.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    canvas.paste(art, ((px - art.width) // 2, (px - art.height) // 2), art)
    return canvas


def sharpen(img, percent, radius=0.6, threshold=2):
    """RGB-only unsharp mask. Alpha stays untouched so downscaled small sizes
    gain edge contrast WITHOUT a bright/dark halo over transparent corners
    (ICO frames and the tray tile have rounded transparent corners)."""
    r, g, b, a = img.split()
    rgb = Image.merge("RGB", (r, g, b)).filter(
        ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold)
    )
    return Image.merge("RGBA", (*rgb.split(), a))


def main():
    chrome = find_chrome()
    tmp = tempfile.mkdtemp(prefix="dsh-icons-")
    try:
        source = load(os.path.join(ASSETS, "icon-source.svg"))

        full = shoot(chrome, tmp, source, 4096, "full")
        mac = shoot(chrome, tmp, mac_variant(source), 2048, "mac")

        def F(px):
            im = full.resize((px, px), Image.LANCZOS)
            # Small shell sizes lose the fine linework to downscaling — a mild
            # unsharp mask restores edge contrast; flat areas stay flat
            # (threshold). 16-48px (taskbar buttons, ICO frames, square logos)
            # get the full boost; the 64-128px class (Alt-Tab / window icon,
            # whose downstream render is 24-48px on the taskbar) gets a wider
            # halo so it survives the OS's own downscale. >= 256 are rendered
            # big enough already.
            if px <= 48:
                im = sharpen(im, 55)
            elif px <= 128:
                im = sharpen(im, 30, radius=1.2)
            return im

        def MAC(px):
            im = mac.resize((px, px), Image.LANCZOS)
            if px <= 64:
                im = sharpen(im, 35)
            return im

        def save(img, rel):
            path = os.path.join(ROOT, "desktop", rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            img.save(path)
            print(f"{rel} ({img.size[0]}x{img.size[1]})")

        # --- tray asset: tight-cropped art (smallest shell size there is) ---
        tray_src = sharpen(full.resize((256, 256), Image.LANCZOS), 45, radius=1.2)
        save(fit_square(tray_src, 256, fill_ratio=0.98), "assets/tray-icon.png")

        # --- standard png set ---
        save(F(32), "src-tauri/icons/32x32.png")
        save(F(64), "src-tauri/icons/64x64.png")
        # Window icon (taskbar/Alt-Tab/About header): the shell downscales it
        # to 24-48px, so give it the tiered sharpen of F(128).
        save(F(128), "src-tauri/icons/128x128.png")
        save(F(256), "src-tauri/icons/128x128@2x.png")
        save(F(512), "src-tauri/icons/icon.png")

        # --- windows .ico ---
        ico = pack_ico([(s, png_bytes(F(s))) for s in (16, 20, 24, 32, 48, 64, 128, 256)])
        with open(os.path.join(ICONS, "icon.ico"), "wb") as f:
            f.write(ico)
        print("src-tauri/icons/icon.ico (16-256)")

        # --- macOS .icns (Apple grid renders) ---
        icns = pack_icns([
            ("ic07", png_bytes(MAC(128))),
            ("ic08", png_bytes(MAC(256))),
            ("ic09", png_bytes(MAC(512))),
            ("ic10", png_bytes(MAC(1024))),
            ("ic11", png_bytes(MAC(32))),
            ("ic12", png_bytes(MAC(64))),
            ("ic13", png_bytes(MAC(256))),
            ("ic14", png_bytes(MAC(512))),
        ])
        with open(os.path.join(ICONS, "icon.icns"), "wb") as f:
            f.write(icns)
        print("src-tauri/icons/icon.icns (Apple grid, transparent margins)")

        # --- MSIX/store logos (vestigial for NSIS/dmg, kept consistent) ---
        for name, px in [
            ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
            ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
            ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
            ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
            ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
        ]:
            save(F(px), os.path.join("src-tauri", "icons", name))

        # --- assets copies stay in sync ---
        save(F(512), "assets/icon.png")
        with open(os.path.join(ASSETS, "icon.ico"), "wb") as f:
            f.write(ico)
        print("assets/icon.ico")
        with open(os.path.join(ASSETS, "icon.icns"), "wb") as f:
            f.write(icns)
        print("assets/icon.icns")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
