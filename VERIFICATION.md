# Verification — 11-10-2026, U.S. Central

**PASS: unit, build, and disposable native Electron tray integration. Installed Obsidian remains untouched.**

Production `main.js` SHA-256:
`1164a7a773e2ce27dc12af26a5e433f35d5e713ca5f2d888b97080f3001814af`

## Current results

| Gate | Outcome |
| --- | --- |
| `npm test` | PASS: 22 tests |
| `npm run build` | PASS: strict TypeScript and production bundle |
| Native tray creation | PASS: real Electron `Tray`, extracted executable icon |
| Marked startup to tray | PASS: hides only after tray creation; takes priority over minimized |
| One-time startup guard | PASS: tray and minimized main-process switches consumed; reload remains visible |
| Tray click | PASS: real asynchronous callback restores the native window |
| Close to tray | PASS: renderer `beforeunload` keeps the window alive and hidden |
| Unload | PASS: hidden window restored and real tray destroyed |
| Registry access in tray harness | NONE |
| Installed Obsidian/vault | NOT TOUCHED |

The native tray harness used retained external dependencies at:

```text
E:/ai/PiTempSpace/obsidian-startup-live-harness
```

Rerun from this repository:

```sh
npm run build
node test/live-tray-electron.cjs E:/ai/PiTempSpace/obsidian-startup-live-harness
```

It creates a disposable Electron profile and plugin folder under the native Windows temp directory, then removes both and stops only its own Electron process. It does not launch installed Obsidian or access the startup registry.

## Registry harness

`test/live-electron.cjs` still begins by checking every relevant Run/StartupApproved location and aborts before modification if the real `Obsidian Windows Startup` entry exists. A real owned entry is currently present, so the registry harness was not rerun. The prior native registry verification remains applicable to the existing `reg.exe` read path; unit tests now additionally cover the tray flag and preservation of a Windows-disabled entry.

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
