# Windows Startup and Tray

Requires Obsidian **1.13.0 or newer** on Windows desktop. Settings use Obsidian's declarative API; older versions are not supported.

Six Windows-only settings:

- **Start with Windows:** start Obsidian when the current Windows user signs in.
- **Start minimized:** minimize a marked startup launch to the taskbar.
- **Start in tray:** hide a marked startup launch after the vault layout loads; this takes priority over minimized.
- **Startup delay (seconds):** wait before Obsidian starts; `0` starts directly.
- **Default vault:** optional vault name or ID to open at startup. Blank preserves Obsidian’s normal startup behavior.
- **Close to tray:** keep this vault running when its main window is closed.

The per-vault tray has **Show / Hide** and **Quit this vault** controls. New tray options default off. The plugin has no npm runtime dependencies or bundled binaries. This is independent implementation informed by MIT-licensed [Background Tray](https://github.com/Synaphi/background-tray), not a fork.

## System access

This plugin uses two Node.js APIs that Obsidian flags as elevated access. Node filesystem and process permissions are broad; the usage described below is narrow, not a sandbox or permission restriction. These startup-detection operations cannot be replaced by the Obsidian vault API.

| API | What it does | Why it is necessary |
|-----|-------------|---------------------|
| `fs` | Checks Obsidian's stable launcher at plugin load. For a positive delay only, writes and verifies a UTF-16 launcher plus metadata in `%LOCALAPPDATA%\Obsidian Windows Startup`. | Squirrel-installed Obsidian has a versioned `app-X.Y.Z/` directory, so the stable parent launcher must be checked. Windows limits Run commands to 260 characters; the local helper lets startup sleep before launching without exceeding that limit. No vault files or unrelated locations are read or written. |
| `child_process.execFileSync` | Runs `reg.exe query` to read the plugin's own startup registry value when a matching startup entry exists (during state reads at load, settings rendering/search indexing, refresh, and before/after startup changes). | Electron's `getLoginItemSettings` omits command-line switches from its return value. Reading the plugin's own `HKCU\...\Run` value detects whether `--obsidian-windows-startup-minimized` or `--obsidian-windows-startup-tray` is present in the current startup command. `reg.exe` is invoked with `windowsHide: true`, targets only the named value `Obsidian Windows Startup`, and no shell is involved (`execFileSync`, not `exec`). |

Startup registration and its command-line flags are written through Electron's `app.setLoginItemSettings`, not direct registry writes. `delaySeconds` defaults to `0` and accepts whole numbers from `0` to `86400` (up to 24 hours); missing or invalid saved delays become `0`. `defaultVault` defaults to an empty string; missing or non-string saved values become empty. The five preferences (`startMinimized`, `startInTray`, `closeToTray`, `delaySeconds`, `defaultVault`) are loaded and saved through Obsidian's vault-scoped `loadData`/`saveData` API in the plugin's `data.json`. Close-to-tray is not a login-item setting. Tray icons use Electron's native image APIs. These operations do not require reading note contents or managing unrelated startup entries. Source is available for inspection; `npm run build` produces the bundle.

## Build

Requires Node.js 22+ and npm.

```sh
npm ci
npm run build
npm test
```

`npm run build` type-checks and bundles `main.ts` into `main.js`. `npm run dev` watches source files. Electron and Obsidian are supplied by the host, not bundled.

## Install locally

1. Build the plugin.
2. Create `<vault>/.obsidian/plugins/windows-startup-tray/`.
3. Copy **`manifest.json` and `main.js`** into that directory. No CSS file is needed.
4. In Obsidian, allow community plugins and enable **Windows Startup and Tray**.
5. Open **Settings → Windows Startup and Tray** and choose the settings.

Windows startup is per Windows user, not per vault. Minimized, tray-start, delay, and default-vault values in an existing owned entry are authoritative; preferences are saved in this vault's `data.json`. Multiple installed copies manage the same named entry. A blank default vault opens Obsidian normally; a configured vault uses `obsidian://open?vault=` with its name or ID URL-encoded.

## How it works

The desktop renderer accesses Obsidian's existing `@electron/remote` bridge (or older `electron.remote`) to call `app.setLoginItemSettings`. If the bridge/API is unavailable, the affected controls are disabled with an explanation. On other desktop operating systems, all six controls are disabled. Mobile is excluded by the manifest.

The plugin owns exactly one current-user value:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  Obsidian Windows Startup
```

The command points to Obsidian's executable, with:

```text
--obsidian-windows-startup
```

Depending on the selected startup behavior, it also includes:

```text
--obsidian-windows-startup-minimized
--obsidian-windows-startup-tray
obsidian://open?vault=<URL-encoded vault name or ID>
```

For Squirrel's versioned `app-*` installs, the stable parent launcher is used if it exists. Normal installer paths use the running executable. Moving a portable installation requires disabling/re-enabling startup from its new location.

Windows Task Manager can disable the entry using:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run
```

The settings tab reads `getLoginItemSettings().launchItems`, including each entry's `enabled` status. Electron omits command-line switches from `launchItems[].args`, so startup settings are read by strictly parsing this plugin's Run value with Windows' built-in `reg.exe` (no shell execution). A zero delay runs Obsidian directly. A positive delay uses a generated UTF-16 VBScript under `%LOCALAPPDATA%\Obsidian Windows Startup`, launched hidden by the absolute built-in `wscript.exe`; it sleeps before launching Obsidian, so this is not a plugin-load delay. The Run command is kept within Windows’ 260-character limit. Executable paths and arguments are quoted as data; the generated helper and metadata must exactly match before the named entry is accepted as owned. It does not rely on Electron's default `openAtLogin` name. State is read on plugin load, when settings definitions are evaluated (including search indexing), on **Refresh**, and before/after startup changes. A registry query occurs for each state read only when a matching entry exists. Preference changes preserve a Windows-disabled entry rather than silently re-enabling it.

On a marked launch, the plugin creates the tray first, then hides after layout readiness. If tray creation fails, it never hides and falls back to marked taskbar minimization when enabled. Main-process switches are consumed so reloads and other vaults cannot repeat the one-time action.

Close interception uses renderer `beforeunload` capture as the synchronous veto; the remote close event is fallback only. Popouts and Settings windows tracked as belonging to this vault hide and restore with it. App quit and Windows session end bypass interception. Disabling either tray behavior when no longer needed, or disabling the plugin, restores windows hidden by this plugin and destroys its tray. It does not restore an ordinary taskbar-minimized window.

## Test locally on Windows

First disable other Obsidian autostart entries to avoid duplicate launches; this plugin deliberately does not change them.

1. Enable **Start with Windows**, with **Start minimized** off.
2. In PowerShell, inspect the entry:

   ```powershell
   reg.exe query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v 'Obsidian Windows Startup'
   ```

   Verify the quoted executable path and startup marker. There should be no minimized marker.
3. Fully quit Obsidian (all windows), then run the displayed executable and arguments, or sign out and sign back in. Expect a normal window.
4. Enable **Start minimized**. Inspect the registry again; expect both markers. Optionally set a short **Startup delay (seconds)** and a **Default vault**; the Run command should point to hidden `wscript.exe`, then the configured vault should open only after the delay.
5. Fully quit Obsidian, then run the updated command or sign out/in. Expect Obsidian minimized on the taskbar once the startup vault finishes loading. Restore it to confirm it remains usable.
6. Restore the window and disable/re-enable the plugin. It must not minimize again. Fully quit and open Obsidian from its ordinary shortcut; that launch must remain normal.
7. Enable **Start in tray**, rerun the owned startup command, and confirm the tray icon appears and the vault hides instead of minimizing. Use **Show / Hide**, then **Quit this vault**.
8. Enable **Close to tray** and close the vault window. Confirm the tray restores it. Disable the option and confirm a normal close is no longer intercepted.
9. Disable the entry through **Task Manager → Startup apps**. Reopen plugin settings or press **Refresh**; **Start with Windows** must show off. Changing either startup behavior must leave it off. Turning **Start with Windows** on must re-enable it.
10. Turn **Start with Windows** off. The registry query must report the value is missing. The plugin's matching `StartupApproved` value is also removed by Electron. Unrelated startup values must remain unchanged.

The automated suite covers registry arguments/state, declarative settings persistence and errors, Electron bridge fallback, one-time startup priority, tray failure safety, close interception, quit/session-end bypass, multi-window restoration, canceled Quit, and late async tray creation. Native Electron harnesses are documented in `VERIFICATION.md`.

## Limits and removal

- **System access:** The plugin uses `fs` for the launcher check and, only for positive delay, its `%LOCALAPPDATA%` helper; `child_process.execFileSync` reads one registry value via `reg.exe`. See [System access](#system-access) for full details.

- Startup means **user login**, not a Windows service running before login.
- A brief visible window is possible: a vault plugin cannot hide an Electron window before Obsidian loads plugins.
- Positive delay requires Windows Script Host/VBScript. A missing `wscript.exe` is reported when enabling delay; disabled or removed VBScript support can still prevent the helper from running. Set delay to `0` to use direct startup.
- If the startup vault does not load this plugin, minimization cannot happen. Restricted mode, safe mode, a vault picker, or a different last-used vault can prevent it.
- An already-running Obsidian instance may absorb a launch through single-instance handling. Fully quit before testing startup arguments.
- Each enabled vault owns its own tray icon. **Quit this vault** closes only that vault for multi-vault safety; Obsidian exits when it is the last window. If Obsidian cancels close for unsaved work, the vault is shown again.
- This intentionally does not reproduce Background Tray's relaunch/vault-picker suppression or custom icon/tooltip features. Launching Obsidian again while hidden may follow Obsidian's normal single-instance/vault-picker behavior.
- Disabling/uninstalling the plugin does **not** remove its startup entry automatically, since unloading also occurs during reloads. Turn **Start with Windows** off before uninstalling. If already removed, delete only the named `Obsidian Windows Startup` value from the Run key above; do not delete the key or unrelated values.
- Obsidian's Electron bridge is not a public stable plugin API. Compatibility is checked at runtime. Community directory acceptance is not guaranteed; the plugin's system-setting changes need review.

## API references

- [Obsidian URI](https://help.obsidian.md/uri)
- [Windows Run and RunOnce registry keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)
- [Electron login-item APIs](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)
- [Electron Windows implementation](https://github.com/electron/electron/blob/04449e9846edb0eff60cb82bd619c0559bc62ec3/shell/browser/browser_win.cc)
- [BrowserWindow minimize/hide/show](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron Tray](https://www.electronjs.org/docs/latest/api/tray)
- [CommandLine.removeSwitch](https://www.electronjs.org/docs/latest/api/command-line#commandlineremoveswitchswitch)
- [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Background Tray remote access](https://github.com/Synaphi/background-tray/blob/415ab21b436c7122523dd3b7ed5bb02a7e7b3028/main.ts#L103-L124)
