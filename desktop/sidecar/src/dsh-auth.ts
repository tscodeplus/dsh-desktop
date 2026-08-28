/**
 * DSH web authentication helper — handles the `?token` + Cookie gate
 * introduced in DeepSeek Harness 0.1.2-alpha.1 (BrowserAuth).
 *
 * Old engines (0.1.1-rc.2) serve `/` without auth; new engines require:
 *   1. GET <launchUrl> (e.g. http://127.0.0.1:3080/?token=xxx) → 303 + Set-Cookie
 *   2. Subsequent requests with `Cookie: dsh-auth-xxx=...`
 *
 * The sidecar (index.ts) pipes dsh's stdout, captures the printed
 * `dsh web: http://...` line, performs the exchange, caches the cookie,
 * and exposes it to:
 *   - engine-updater.ts:waitForHealth (Node, after engine swap)
 *   - control API: GET /_desktop/dsh-auth → Rust health_loop + WebView URL
 *   - heartbeat POST /ping (optional piggyback)
 *
 * The Rust shell ultimately loads the WebView at the authenticated URL so
 * the 303 plants the cookie in the WebView's jar.
 */

let current: { launchUrl: string; cookie: string } | null = null;

export function getDshAuth(): { launchUrl: string; cookie: string } | null {
  return current;
}

export function clearDshAuth(): void {
  current = null;
}

const LAUNCH_RE = /dsh web:\s*(http:\/\/[^\s]+)/u;

function parseSetCookie(header: string | null): string | null {
  if (!header) return null;
  // `Set-Cookie: name=value; Max-Age=...; Path=/; ...` — we need name=value
  const first = header.split(';', 1)[0]?.trim();
  return first && first.includes('=') ? first : null;
}

/**
 * Try to exchange the launch token for a session cookie.
 * Returns the cookie `name=value` on success, null on failure.
 * The cookie is authority-bound (hash of Host), so we keep the whole
 * `name=value` as returned.
 */
async function exchangeToken(launchUrl: string): Promise<string | null> {
  try {
    const res = await fetch(launchUrl, { redirect: 'manual' } as RequestInit);
    // New engine: 303 with Set-Cookie; old engine line would have no ?token but we only call this when token present
    const setCookie = res.headers.get('set-cookie');
    const cookie = parseSetCookie(setCookie);
    if (cookie) return cookie;
    // Fallback: some fetch impls combine headers — try getSetCookie if available
    const anyHeaders = res.headers as unknown as Record<string, unknown>;
    if (typeof (anyHeaders as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
      const cookies = (anyHeaders as { getSetCookie: () => string[] }).getSetCookie();
      for (const c of cookies) {
        const p = parseSetCookie(c);
        if (p) return p;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Called for every stdout/stderr chunk from the dsh child.
 * Detects the `dsh web: http://...` line, extracts token URL,
 * performs the 303 exchange, and caches the cookie.
 * Non-matching lines are ignored. Idempotent per launch URL.
 */
export async function handleDshOutputLine(line: string): Promise<void> {
  const m = LAUNCH_RE.exec(line);
  if (!m?.[1]) return;
  const launchUrl = m[1];
  // Only process token-bearing URLs; old engine prints bare http://127.0.0.1:3080
  const hasToken = (() => {
    try {
      return new URL(launchUrl).searchParams.has('token');
    } catch {
      return false;
    }
  })();
  if (!hasToken) {
    // Old engine — clear any previous auth (engine rollbacks)
    current = null;
    return;
  }
  if (current?.launchUrl === launchUrl) return; // already exchanged
  const cookie = await exchangeToken(launchUrl);
  if (cookie) {
    current = { launchUrl, cookie };
    // Push the launch URL + cookie to the Rust shell so its health probe and
    // the WebView URL use it. Best-effort: the shell spawns us and is already
    // listening, but a failed push is non-fatal — Rust falls back to GET
    // /_desktop/dsh-auth from the sidecar control API.
    try {
      const { postToShell } = await import('./control-server.js');
      await postToShell('/dsh-auth', { launchUrl, cookie });
    } catch {
      /* best effort */
    }
  } else {
    // Exchange failed (dsh not yet ready?) — keep launchUrl, retry on next probe via waitForHealth
    current = { launchUrl, cookie: '' };
  }
}

/**
 * Authenticated health probe for the DSH web server.
 * Tries:
 *   1. If we have a cached cookie → GET / with Cookie
 *   2. If we have a launchUrl without cookie yet → retry exchange then probe
 *   3. Fallback plain GET / (old engine)
 * Returns true when the server answers 2xx.
 */
export async function dshHealthProbe(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}/`;
  const auth = current;
  if (auth?.cookie) {
    try {
      const r = await fetch(base, {
        headers: { Cookie: auth.cookie },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
      // Cookie might be stale after engine swap — fall through to plain
    } catch {
      /* try plain */
    }
  }
  if (auth?.launchUrl && !auth.cookie) {
    // Token known but exchange not yet succeeded — retry
    const cookie = await exchangeToken(auth.launchUrl);
    if (cookie) {
      current = { launchUrl: auth.launchUrl, cookie };
      try {
        const r = await fetch(base, {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok) return true;
      } catch {
        /* fall through */
      }
    }
  }
  // Plain probe — works for old engine, and also for new engine's 401→fallback
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Poll `dshHealthProbe` until success or deadline.
 * Used by engine-updater.ts after a swap.
 */
export async function waitForDshHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dshHealthProbe(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
