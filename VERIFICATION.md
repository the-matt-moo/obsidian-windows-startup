# Verification — 12-10-2026, U.S. Central

**PASS: current unit tests, isolated delay execution, production build, and installed plugin reload. Live startup registry/settings unchanged during installation.**

Production `main.js` SHA-256:
`c3bab607420c34e19d1aa957d84d890b429b85a9048ebec722d988e9f18bf2ff`

## Results

| Gate | Outcome |
| --- | --- |
| `npm test` | PASS: 31 tests, 0 failures |
| `npm run build` | PASS: strict TypeScript and production bundle |
| Delayed launcher | PASS: disposable UTF-16 VBS waited at least 1 second, then preserved startup flags, encoded Unicode vault URI, spaces and quotes in a harmless Node child |
| Native tray rerun | BLOCKED: external harness dependencies lack `electron`; historical results below were not rerun |
| Live Obsidian | PASS: installed via native CLI and vault adapter; matching bundle verified, reload succeeds, tray ready; positive-delay registry transition not live-tested |
| Native tray creation | Historical PASS (11-10-2026): real Electron `Tray`, extracted executable icon |
| Marked startup to tray | Historical PASS (11-10-2026): hides only after tray creation; takes priority over minimized |
| One-time startup guard | Historical PASS (11-10-2026): tray and minimized main-process switches consumed; reload remains visible |
| Tray click | Historical PASS (11-10-2026): real asynchronous callback restores the native window |
| Close to tray | Historical PASS (11-10-2026): renderer `beforeunload` keeps the window alive and hidden |
| Unload | Historical PASS (11-10-2026): hidden window restored and real tray destroyed |
| Registry access in tray harness | NONE |
| Installed Moo vault plugin | Updated with `.pre-delay-lookup-1791858890269.bak` backups; data.json unchanged |

The historical native tray harness used external dependencies at:

```text
E:/ai/PiTempSpace/obsidian-startup-live-harness
```

Rerun from this repository:

```sh
npm run build
node test/live-tray-electron.cjs E:/ai/PiTempSpace/obsidian-startup-live-harness
```

It creates a disposable Electron profile and plugin folder under the native Windows temp directory, then removes both and stops only its own Electron process. It does not launch installed Obsidian or access the startup registry.

## Delay lookup regression

Electron filters `getLoginItemSettings().launchItems` by executable path. Switching the Run command to `wscript.exe` previously made the Obsidian-only lookup miss the new entry, causing verification failure and rollback. Lookup now covers both executables. The unit fixture implements actual path filtering and tests direct → delayed → direct transitions while preserving Windows-disabled state, flags, and vault.

Installed and reloaded through the absolute `C:/Users/Tench/AppData/Local/Programs/Obsidian/Obsidian.com` CLI using Obsidian's vault adapter. Existing default vault and tray preferences were preserved. Delay remains 0 pending the user's selected value; no Windows sign-in test was run.

## Delay verification

The positive-delay test creates a temporary VBS launcher, starts it with the absolute Windows `wscript.exe`, validates elapsed time and exact argv in a harmless child Node process, then removes the temporary directory. It does not access the registry, installed Obsidian, or a vault. A full app relaunch was intentionally not run: a real named startup entry exists and the registry harness guard prevents altering it.

## Registry harness

`test/live-electron.cjs` still begins by checking every relevant Run/StartupApproved location and aborts before modification if the real `Obsidian Windows Startup` entry exists. A real owned entry is currently present, so the registry harness was not rerun. The earlier registry verification covered only the existing direct-launch `reg.exe` read path. The new delayed-wrapper registration still needs native Electron verification; unit tests cover its command/state, rollback, tray flags and preservation of a Windows-disabled entry.

Only when the named entry is intentionally absent, rerun with:

```sh
npm run build
node test/live-electron.cjs E:/ai/PiTempSpace/obsidian-startup-live-harness
```

The registry harness removes only entries it created, compares hashes for unrelated startup values, and verifies existing Obsidian processes remain alive.

## Remaining manual checks

- Full Obsidian UI/lifecycle and the installed Electron version.
- Actual Windows sign-in and Task Manager interaction.
- Obsidian-specific popouts/Settings restoration; equivalent ownership and restoration paths are covered by unit tests.
- Multi-vault single-instance/vault-picker behavior. This plugin deliberately does not implement Background Tray's picker suppression.
