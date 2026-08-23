; NSIS hooks for the DSH Desktop installer/uninstaller.
; Referenced from tauri.conf.json > bundle > windows > nsis > installerHooks
; and included at the top of tauri's installer.nsi.
;
; Engine policy: the engine closure ships with the installer and the app runs
; it straight from the install dir — no install-time copy, no ~/.dsh/engine
; until the user's first in-app engine update swaps a closure in. User data
; (profiles/storages/credentials under ~/.dsh) is untouched here.
;
; Uninstall behavior: the stock uninstaller always shows a "Delete app data"
; checkbox (default unchecked) that clears %APPDATA%/<bundleid> when checked.
; All real user data lives at the upstream dsh home ~/.dsh (passed to dsh as
; DSH_HOME), which the stock checkbox does NOT remove. When the user
; explicitly checks the box, also remove ~/.dsh so "delete user data"
; actually removes the data. Unchecked (the default) → kept.

; The template's `!ifmacrodef NSIS_HOOK_PREUNINSTALL` guard only matches a
; `!macro` definition — NOT `!define` constants (a dead `!define`-based
; indirection is how the old POSTINSTALL hook silently vanished; see git log).
!macro NSIS_HOOK_PREUNINSTALL
  ; The engine (~/.dsh/engine) exists only after the user updated it in-app;
  ; the installer always ships a fresh bundled closure, so it is regenerable.
  ; Always remove it on uninstall (and on update-mode re-install, which also
  ; runs this macro), so a leftover engine can never pin ~184MB on disk. User
  ; data (profiles/storages/credentials under ~/.dsh) is untouched here.
  ReadEnvStr $0 "USERPROFILE"
  StrCmp $0 "" dshd_engine_done
  RmDir /r "$0\.dsh\engine"
  dshd_engine_done:
  ; $DeleteAppDataCheckboxState is set by un.ConfirmLeave (BM_GETCHECK).
  ; Skip on updates (the installer re-runs this section in update mode).
  StrCmp $UpdateMode 1 dshd_nodata
  StrCmp $DeleteAppDataCheckboxState 1 dshd_del dshd_nodata
  dshd_del:
    ReadEnvStr $0 "USERPROFILE"
    StrCmp $0 "" dshd_nodata
    RmDir /r "$0\.dsh"
  dshd_nodata:
!macroend
