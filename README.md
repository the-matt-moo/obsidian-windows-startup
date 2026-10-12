# Windows Startup & Tray for Obsidian

Four Windows-only settings:

- **Start with Windows:** start Obsidian when the current Windows user signs in.
- **Start minimized:** minimize a marked startup launch to the taskbar.
- **Start in tray:** hide a marked startup launch after the vault layout loads; this takes priority over minimized.
- **Close to tray:** keep this vault running when its main window is closed.

The per-vault tray has **Show / Hide** and **Quit this vault** controls. New tray options default off. The plugin has no npm runtime dependencies or bundled binaries. It uses Windows' built-in `reg.exe` only to read its own startup command. This is independent implementation informed by MIT-licensed [Background Tray](https://github.com/Synaphi/background-tray), not a fork.

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
2. Create `<vault>/.obsidian/plugins/windows-startup/`.
3. Copy **`manifest.json` and `main.js`** into that directory. No CSS file is needed.
4. In Obsidian, allow community plugins and enable **Windows Startup & Tray**.
5. Open **Settings → Windows Startup & Tray** and choose the four toggles.

Windows startup is per Windows user, not per vault. Minimized and tray-start flags in an existing registry entry are authoritative; preferences and close-to-tray are saved in this vault's `data.json`. Multiple installed copies manage the same named entry. Startup opens the last-used vault, so keep the plugin enabled there for startup window behavior.

## How it works

The desktop renderer accesses Obsidian's existing `@electron/remote` bridge (or older `electron.remote`) to call `app.setLoginItemSettings`. If the bridge/API is unavailable, the affected controls are disabled with an explanation. On other desktop operating systems, all four controls are disabled. Mobile is excluded by the manifest.

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
```

For Squirrel's versioned `app-*` installs, the stable parent launcher is used if it exists. Normal installer paths use the running executable. Moving a portable installation requires disabling/re-enabling startup from its new location.

Windows Task Manager can disable the entry using:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run
```

The settings tab reads `getLoginItemSettings().launchItems`, including each entry's `enabled` status. Electron omits command-line switches from `launchItems[].args`, so minimized and tray flags are read from this plugin's Run value with Windows' built-in `reg.exe` (no shell execution). It does not rely on Electron's default `openAtLogin` name. Reopening the tab or pressing **Refresh** rereads Windows state. Preference changes preserve a Windows-disabled entry rather than silently re-enabling it.

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
4. Enable **Start minimized**. Inspect the registry again; expect both markers.
5. Fully quit Obsidian, then run the updated command or sign out/in. Expect Obsidian minimized on the taskbar once the startup vault finishes loading. Restore it to confirm it remains usable.
6. Restore the window and disable/re-enable the plugin. It must not minimize again. Fully quit and open Obsidian from its ordinary shortcut; that launch must remain normal.
7. Enable **Start in tray**, rerun the owned startup command, and confirm the tray icon appears and the vault hides instead of minimizing. Use **Show / Hide**, then **Quit this vault**.
8. Enable **Close to tray** and close the vault window. Confirm the tray restores it. Disable the option and confirm a normal close is no longer intercepted.
9. Disable the entry through **Task Manager → Startup apps**. Reopen plugin settings or press **Refresh**; **Start with Windows** must show off. Changing either startup behavior must leave it off. Turning **Start with Windows** on must re-enable it.
10. Turn **Start with Windows** off. The registry query must report the value is missing. The plugin's matching `StartupApproved` value is also removed by Electron. Unrelated startup values must remain unchanged.

The automated suite covers registry arguments/state, one-time startup priority, tray failure safety, close interception, quit/session-end bypass, multi-window restoration, canceled Quit, and late async tray creation. Native Electron harnesses are documented in `VERIFICATION.md`.

## Limits and removal

- Startup means **user login**, not a Windows service running before login.
- A brief visible window is possible: a vault plugin cannot hide an Electron window before Obsidian loads plugins.
- If the startup vault does not load this plugin, minimization cannot happen. Restricted mode, safe mode, a vault picker, or a different last-used vault can prevent it.
- An already-running Obsidian instance may absorb a launch through single-instance handling. Fully quit before testing startup arguments.
- Each enabled vault owns its own tray icon. **Quit this vault** closes only that vault for multi-vault safety; Obsidian exits when it is the last window. If Obsidian cancels close for unsaved work, the vault is shown again.
- This intentionally does not reproduce Background Tray's relaunch/vault-picker suppression or custom icon/tooltip features. Launching Obsidian again while hidden may follow Obsidian's normal single-instance/vault-picker behavior.
- Disabling/uninstalling the plugin does **not** remove its startup entry automatically, since unloading also occurs during reloads. Turn **Start with Windows** off before uninstalling. If already removed, delete only the named `Obsidian Windows Startup` value from the Run key above; do not delete the key or unrelated values.
- Obsidian's Electron bridge is not a public stable plugin API. Compatibility is checked at runtime. Community directory acceptance is not guaranteed; the plugin's system-setting changes need review.

## API references

- [Electron login-item APIs](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)
- [Electron Windows implementation](https://github.com/electron/electron/blob/04449e9846edb0eff60cb82bd619c0559bc62ec3/shell/browser/browser_win.cc)
- [BrowserWindow minimize/hide/show](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron Tray](https://www.electronjs.org/docs/latest/api/tray)
- [CommandLine.removeSwitch](https://www.electronjs.org/docs/latest/api/command-line#commandlineremoveswitchswitch)
- [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Background Tray remote access](https://github.com/Synaphi/background-tray/blob/415ab21b436c7122523dd3b7ed5bb02a7e7b3028/main.ts#L103-L124)
