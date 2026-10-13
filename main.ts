import { App, Notice, Platform, Plugin, PluginSettingTab, type Setting, type SettingDefinitionItem } from 'obsidian';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  applyStartupWindow, LoginApp, STARTUP_ARG, StartupSession, StartupState,
  MAX_DELAY_SECONDS, StartupPreferences, StartupWindow, TRAY_ARG, WindowsStartup,
} from './startup';
import { ElectronWindowLike, TrayController, TrayRemote } from './tray';

interface ElectronRemote extends TrayRemote {
  app: LoginApp & TrayRemote['app'] & { commandLine: StartupSession };
  process: { execPath: string; argv: string[] };
  getCurrentWindow(): StartupWindow & ElectronWindowLike;
}

interface SavedSettings {
  startMinimized: boolean;
  startInTray: boolean;
  closeToTray: boolean;
  delaySeconds: number;
  defaultVault: string;
}

function getRemote(): ElectronRemote {
  // Electron runtime modules — static import is unavailable in Obsidian plugins.
  const load = (id: string): unknown =>
    (window as unknown as { require?: (id: string) => unknown }).require?.(id);
  let remote: ElectronRemote | undefined;
  try { remote = load('@electron/remote') as ElectronRemote | undefined; }
  catch { /* Older Electron may expose only electron.remote. */ }
  if (!remote) remote = (load('electron') as { remote?: ElectronRemote } | undefined)?.remote;
  if (!remote?.app?.getLoginItemSettings || !remote.app.setLoginItemSettings ||
    !remote.process?.execPath || !remote.getCurrentWindow ||
    !remote.app.commandLine?.hasSwitch || !remote.app.commandLine.removeSwitch) {
    throw new Error('Obsidian does not expose the Electron APIs required for Windows startup.');
  }
  return remote;
}

export default class WindowsStartupPlugin extends Plugin {
  startup?: WindowsStartup;
  tray?: TrayController;
  preferredMinimized = false;
  preferredStartInTray = false;
  closeToTray = false;
  delaySeconds = 0;
  defaultVault = '';
  unavailable = '';
  private active = false;

  async onload(): Promise<void> {
    this.active = true;
    const saved: unknown = await this.loadData();
    if (saved && typeof saved === 'object') {
      const data = saved as Partial<SavedSettings> & { delayMs?: unknown };
      this.preferredMinimized = data.startMinimized === true;
      this.preferredStartInTray = data.startInTray === true;
      this.closeToTray = data.closeToTray === true;
      if (Number.isInteger(data.delaySeconds) && (data.delaySeconds as number) >= 0 && (data.delaySeconds as number) <= MAX_DELAY_SECONDS) {
        this.delaySeconds = data.delaySeconds as number;
      } else if (Number.isInteger(data.delayMs) && (data.delayMs as number) >= 0) {
        this.delaySeconds = Math.min(Math.round((data.delayMs as number) / 1000), MAX_DELAY_SECONDS);
      } else {
        this.delaySeconds = 0;
      }
      this.defaultVault = typeof data.defaultVault === 'string' ? data.defaultVault.trim() : '';
    }
    if (Platform.isDesktopApp && process.platform === 'win32') {
      try {
        const remote = getRemote();
        const executable = remote.process.execPath;
        const directory = dirname(executable);
        const stub = /^app-/i.test(basename(directory))
          ? resolve(directory, '..', basename(executable)) : executable;
        const startupExecutable = existsSync(stub) ? stub : executable;
        this.startup = new WindowsStartup(remote.app, startupExecutable);
        this.startup.read(this.startupPreferences());
        const win = remote.getCurrentWindow();
        this.tray = new TrayController(remote, win, window, executable,
          () => this.app.vault.getName(), () => this.existingSecondaryWindows(), error => this.report(error));
        this.registerEvent(this.app.workspace.on('window-open', (_workspaceWindow, domWindow) => {
          this.tray?.trackWindow(domWindow);
        }));
        const markedTrayLaunch = remote.process.argv.includes(STARTUP_ARG) &&
          remote.process.argv.includes(TRAY_ARG) && remote.app.commandLine.hasSwitch(TRAY_ARG.slice(2));
        await this.tray.configure(this.closeToTray,
          this.closeToTray || this.preferredStartInTray || markedTrayLaunch);
        this.app.workspace.onLayoutReady(() => {
          if (!this.active) return;
          try { applyStartupWindow(remote.process.argv, remote.app.commandLine, win, () => this.tray?.hide() ?? false); }
          catch (error) { this.report(error); }
        });
      } catch (error) {
        this.startup = undefined;
        this.tray?.unload();
        this.tray = undefined;
        this.unavailable = error instanceof Error ? error.message : String(error);
      }
    } else {
      this.unavailable = 'These settings are available only on Windows desktop.';
    }
    this.addSettingTab(new WindowsStartupSettings(this.app, this));
  }

  onunload(): void {
    this.active = false;
    this.tray?.unload();
    this.tray = undefined;
  }

  async savePreferences(): Promise<void> {
    const settings: SavedSettings = {
      startMinimized: this.preferredMinimized,
      startInTray: this.preferredStartInTray,
      closeToTray: this.closeToTray,
      delaySeconds: this.delaySeconds,
      defaultVault: this.defaultVault,
    };
    await this.saveData(settings);
  }

  async refreshTray(): Promise<void> {
    await this.tray?.configure(this.closeToTray, this.closeToTray || this.preferredStartInTray);
  }

  startupPreferences(): StartupPreferences {
    return { minimized: this.preferredMinimized, tray: this.preferredStartInTray, delaySeconds: this.delaySeconds, defaultVault: this.defaultVault };
  }

  report(error: unknown): void {
    new Notice(`Windows Startup and Tray: ${error instanceof Error ? error.message : String(error)}`, 10000);
  }

  private existingSecondaryWindows(): Window[] {
    const windows: Window[] = [];
    try {
      const workspace = this.app.workspace as unknown as { floatingSplit?: { children?: Array<{ win?: Window }> } };
      for (const child of workspace.floatingSplit?.children ?? []) if (child.win) windows.push(child.win);
    } catch { /* Private fallback changed; window-open tracking still covers new popouts. */ }
    try {
      const app = this.app as unknown as { setting?: { popout?: { win?: Window } | null } };
      if (app.setting?.popout?.win) windows.push(app.setting.popout.win);
    } catch { /* Settings window unavailable. */ }
    return windows;
  }
}

class WindowsStartupSettings extends PluginSettingTab {
  private saving = false;
  private cachedState: StartupState | undefined;
  private stateError = '';

  constructor(app: App, private readonly plugin: WindowsStartupPlugin) { super(app, plugin); }

  private readState(): void {
    this.stateError = this.plugin.unavailable;
    this.cachedState = undefined;
    try { this.cachedState = this.plugin.startup?.read(this.plugin.startupPreferences()); }
    catch (cause) { this.stateError = cause instanceof Error ? cause.message : String(cause); }
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    this.readState();
    return [
      {
        name: '',
        render: (setting: Setting) => {
          setting.settingEl.empty();
          setting.settingEl.createEl('p', { text: 'Startup applies to this Windows user. Delay and default vault belong to this vault; leave vault blank to use Obsidian’s normal startup behavior. Other startup entries are not managed. Startup detection uses fs to check the launcher path and reg.exe to read only this plugin’s startup value. Preferences are saved in this vault.' });
          if (this.stateError) setting.settingEl.createEl('p', { text: this.stateError });
        },
      },
      {
        name: 'Start with Windows',
        desc: 'Start Obsidian when you sign in. Reads the actual Windows startup status, including Task Manager changes.',
        control: { type: 'toggle', key: 'startWithWindows', disabled: () => !this.cachedState || this.saving },
      },
      {
        name: 'Start minimized',
        desc: 'Minimize to the taskbar after the startup vault loads. Start in tray takes priority when both are enabled.',
        control: { type: 'toggle', key: 'startMinimized', disabled: () => !this.cachedState || this.saving },
      },
      {
        name: 'Start in tray',
        desc: 'On this plugin\u2019s marked Windows startup launch only, hide this vault after its layout loads. Ordinary launches stay visible.',
        control: { type: 'toggle', key: 'startInTray', disabled: () => !this.cachedState || !this.plugin.tray || this.saving },
      },
      {
        name: 'Startup delay (seconds)',
        desc: 'Wait before Obsidian starts at Windows sign-in. 0 starts directly.',
        control: { type: 'number', key: 'delaySeconds', min: 0, max: MAX_DELAY_SECONDS, step: 1, validate: value => Number.isInteger(value) && value >= 0 && value <= MAX_DELAY_SECONDS ? undefined : `Use a whole number from 0 to ${MAX_DELAY_SECONDS} seconds.`, disabled: () => !this.cachedState || this.saving },
      },
      {
        name: 'Default vault',
        desc: 'Vault name or ID to open after Windows startup. Leave blank for Obsidian’s normal startup behavior.',
        control: { type: 'text', key: 'defaultVault', placeholder: 'Vault name or ID', disabled: () => !this.cachedState || this.saving },
      },
      {
        name: 'Close to tray',
        desc: 'Keep this vault running when its main window is closed. Its tray menu can show/hide it or really close this vault.',
        control: { type: 'toggle', key: 'closeToTray', disabled: () => !this.plugin.tray || this.saving },
      },
      {
        name: 'Refresh Windows status',
        desc: 'Refresh after changing Startup Apps or Task Manager while this tab is open.',
        action: () => this.update(),
      },
    ];
  }

  getControlValue(key: string): unknown {
    switch (key) {
      case 'startWithWindows': return this.cachedState?.enabled ?? false;
      case 'startMinimized': return this.cachedState?.minimized ?? this.plugin.preferredMinimized;
      case 'startInTray': return this.cachedState?.tray ?? this.plugin.preferredStartInTray;
      case 'delaySeconds': return this.cachedState?.delaySeconds ?? this.plugin.delaySeconds;
      case 'defaultVault': return this.cachedState?.defaultVault ?? this.plugin.defaultVault;
      case 'closeToTray': return this.plugin.closeToTray;
      default: return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const { plugin } = this;
    const enabled = value === true;
    this.saving = true;
    this.refreshDomState();
    try {
      switch (key) {
        case 'startWithWindows': {
          if (!plugin.startup || !this.cachedState) return;
          const current = plugin.startup.read(plugin.startupPreferences());
          plugin.startup.write(enabled, enabled, { minimized: current.minimized, tray: current.tray, delaySeconds: current.delaySeconds, defaultVault: current.defaultVault });
          break;
        }
        case 'startMinimized': {
          if (!plugin.startup || !this.cachedState) return;
          const current = plugin.startup.read(plugin.startupPreferences());
          plugin.startup.write(current.registered, current.enabled, { minimized: enabled, tray: current.tray, delaySeconds: current.delaySeconds, defaultVault: current.defaultVault });
          plugin.preferredMinimized = enabled;
          await plugin.savePreferences();
          break;
        }
        case 'startInTray': {
          if (!plugin.startup || !this.cachedState) return;
          const current = plugin.startup.read(plugin.startupPreferences());
          plugin.startup.write(current.registered, current.enabled, { minimized: current.minimized, tray: enabled, delaySeconds: current.delaySeconds, defaultVault: current.defaultVault });
          plugin.preferredStartInTray = enabled;
          await plugin.savePreferences();
          await plugin.refreshTray();
          break;
        }
        case 'delaySeconds': {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_DELAY_SECONDS) return;
          const current = plugin.startup?.read(plugin.startupPreferences());
          if (current?.registered) plugin.startup?.write(current.registered, current.enabled, { minimized: current.minimized, tray: current.tray, delaySeconds: value, defaultVault: current.defaultVault });
          plugin.delaySeconds = value;
          await plugin.savePreferences();
          break;
        }
        case 'defaultVault': {
          if (typeof value !== 'string') return;
          const defaultVault = value.trim();
          const current = plugin.startup?.read(plugin.startupPreferences());
          if (current?.registered) plugin.startup?.write(current.registered, current.enabled, { minimized: current.minimized, tray: current.tray, delaySeconds: current.delaySeconds, defaultVault });
          plugin.defaultVault = defaultVault;
          await plugin.savePreferences();
          break;
        }
        case 'closeToTray': {
          plugin.closeToTray = enabled;
          await plugin.savePreferences();
          await plugin.refreshTray();
          break;
        }
      }
    } catch (cause) { plugin.report(cause); }
    finally {
      this.saving = false;
      this.update();
    }
  }
}
