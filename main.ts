import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  applyStartupWindow, LoginApp, STARTUP_ARG, StartupSession, StartupState,
  StartupWindow, TRAY_ARG, WindowsStartup,
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
}

function getRemote(): ElectronRemote {
  // Electron runtime modules — static import is unavailable in Obsidian plugins.
  const load = (id: string): unknown =>
    (globalThis as unknown as { require?: (id: string) => unknown }).require?.(id);
  let remote = load('@electron/remote') as ElectronRemote | undefined;
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
  unavailable = '';
  private active = false;

  async onload(): Promise<void> {
    this.active = true;
    const saved: unknown = await this.loadData();
    if (saved && typeof saved === 'object') {
      this.preferredMinimized = 'startMinimized' in saved && saved.startMinimized === true;
      this.preferredStartInTray = 'startInTray' in saved && saved.startInTray === true;
      this.closeToTray = 'closeToTray' in saved && saved.closeToTray === true;
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
        this.startup.read(this.preferredMinimized, this.preferredStartInTray);
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
    };
    await this.saveData(settings);
  }

  async refreshTray(): Promise<void> {
    await this.tray?.configure(this.closeToTray, this.closeToTray || this.preferredStartInTray);
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

type SettingKey = 'startWithWindows' | 'startMinimized' | 'startInTray' | 'closeToTray';

class WindowsStartupSettings extends PluginSettingTab {
  private saving = false;
  private cachedState: StartupState | undefined;
  private stateError = '';

  constructor(app: App, private readonly plugin: WindowsStartupPlugin) { super(app, plugin); }

  private readState(): void {
    this.stateError = this.plugin.unavailable;
    this.cachedState = undefined;
    try { this.cachedState = this.plugin.startup?.read(this.plugin.preferredMinimized, this.plugin.preferredStartInTray); }
    catch (cause) { this.stateError = cause instanceof Error ? cause.message : String(cause); }
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    this.readState();
    return [
      {
        name: '',
        render: (setting: Setting) => {
          setting.settingEl.empty();
          setting.settingEl.createEl('p', { text: 'Startup applies to this Windows user and opens Obsidian\u2019s last-used vault. Tray behavior belongs to this vault. Other startup entries are not managed.' });
          if (this.stateError) setting.settingEl.createEl('p', { text: this.stateError });
        },
      },
      {
        name: 'Start with Windows',
        desc: 'Start Obsidian when you sign in. Reads the actual Windows startup status, including Task Manager changes.',
        control: { type: 'toggle' as const, key: 'startWithWindows' as SettingKey, disabled: () => !this.cachedState || this.saving },
      },
      {
        name: 'Start minimized',
        desc: 'Minimize to the taskbar after the startup vault loads. Start in tray takes priority when both are enabled.',
        control: { type: 'toggle' as const, key: 'startMinimized' as SettingKey, disabled: () => !this.cachedState || this.saving },
      },
      {
        name: 'Start in tray',
        desc: 'On this plugin\u2019s marked Windows startup launch only, hide this vault after its layout loads. Ordinary launches stay visible.',
        control: { type: 'toggle' as const, key: 'startInTray' as SettingKey, disabled: () => !this.cachedState || !this.plugin.tray || this.saving },
      },
      {
        name: 'Close to tray',
        desc: 'Keep this vault running when its main window is closed. Its tray menu can show/hide it or really close this vault.',
        control: { type: 'toggle' as const, key: 'closeToTray' as SettingKey, disabled: () => !this.plugin.tray || this.saving },
      },
      {
        name: 'Refresh Windows status',
        desc: 'Refresh after changing Startup Apps or Task Manager while this tab is open.',
        action: () => { this.readState(); this.update(); },
      },
    ];
  }

  getControlValue(key: string): unknown {
    switch (key) {
      case 'startWithWindows': return this.cachedState?.enabled ?? false;
      case 'startMinimized': return this.cachedState?.minimized ?? this.plugin.preferredMinimized;
      case 'startInTray': return this.cachedState?.tray ?? this.plugin.preferredStartInTray;
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
          const current = plugin.startup.read(plugin.preferredMinimized, plugin.preferredStartInTray);
          plugin.startup.write(enabled, enabled, current.minimized, current.tray);
          break;
        }
        case 'startMinimized': {
          if (!plugin.startup || !this.cachedState) return;
          const current = plugin.startup.read(plugin.preferredMinimized, plugin.preferredStartInTray);
          plugin.startup.write(current.registered, current.enabled, enabled, current.tray);
          plugin.preferredMinimized = enabled;
          await plugin.savePreferences();
          break;
        }
        case 'startInTray': {
          if (!plugin.startup || !this.cachedState) return;
          const current = plugin.startup.read(plugin.preferredMinimized, plugin.preferredStartInTray);
          plugin.startup.write(current.registered, current.enabled, current.minimized, enabled);
          plugin.preferredStartInTray = enabled;
          await plugin.savePreferences();
          await plugin.refreshTray();
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
      this.readState();
      this.update();
    }
  }

  // Fallback for Obsidian < 1.13.0 — getSettingDefinitions() takes priority when available.
  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();
    containerEl.createEl('p', { text: 'Startup applies to this Windows user and opens Obsidian’s last-used vault. Tray behavior belongs to this vault. Other startup entries are not managed.' });
    let state: StartupState | undefined;
    let error = plugin.unavailable;
    try { state = plugin.startup?.read(plugin.preferredMinimized, plugin.preferredStartInTray); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    if (error) containerEl.createEl('p', { text: error });

    new Setting(containerEl)
      .setName('Start with Windows')
      .setDesc('Start Obsidian when you sign in. Reads the actual Windows startup status, including Task Manager changes.')
      .addToggle(toggle => toggle.setValue(state?.enabled ?? false).setDisabled(!state || this.saving).onChange(enabled => {
        toggle.setDisabled(true);
        try {
          if (!plugin.startup || !state) return;
          const current = plugin.startup.read(plugin.preferredMinimized, plugin.preferredStartInTray);
          plugin.startup.write(enabled, enabled, current.minimized, current.tray);
        } catch (cause) { plugin.report(cause); }
        finally { this.display(); }
      }));

    new Setting(containerEl)
      .setName('Start minimized')
      .setDesc('Minimize to the taskbar after the startup vault loads. Start in tray takes priority when both are enabled.')
      .addToggle(toggle => toggle.setValue(state?.minimized ?? plugin.preferredMinimized).setDisabled(!state || this.saving).onChange(async minimized => {
        this.saving = true;
        this.display();
        try {
          if (!plugin.startup || !state) return;
          const current = plugin.startup.read(plugin.preferredMinimized, plugin.preferredStartInTray);
          plugin.startup.write(current.registered, current.enabled, minimized, current.tray);
          plugin.preferredMinimized = minimized;
          await plugin.savePreferences();
        } catch (cause) { plugin.report(cause); }
        finally { this.saving = false; this.display(); }
      }));

    new Setting(containerEl)
      .setName('Start in tray')
      .setDesc('On this plugin’s marked Windows startup launch only, hide this vault after its layout loads. Ordinary launches stay visible.')
      .addToggle(toggle => toggle.setValue(state?.tray ?? plugin.preferredStartInTray).setDisabled(!state || !plugin.tray || this.saving).onChange(async inTray => {
        this.saving = true;
        this.display();
        try {
          if (!plugin.startup || !state) return;
          const current = plugin.startup.read(plugin.preferredMinimized, plugin.preferredStartInTray);
          plugin.startup.write(current.registered, current.enabled, current.minimized, inTray);
          plugin.preferredStartInTray = inTray;
          await plugin.savePreferences();
          await plugin.refreshTray();
        } catch (cause) { plugin.report(cause); }
        finally { this.saving = false; this.display(); }
      }));

    new Setting(containerEl)
      .setName('Close to tray')
      .setDesc('Keep this vault running when its main window is closed. Its tray menu can show/hide it or really close this vault.')
      .addToggle(toggle => toggle.setValue(plugin.closeToTray).setDisabled(!plugin.tray || this.saving).onChange(async closeToTray => {
        this.saving = true;
        this.display();
        try {
          plugin.closeToTray = closeToTray;
          await plugin.savePreferences();
          await plugin.refreshTray();
        } catch (cause) { plugin.report(cause); }
        finally { this.saving = false; this.display(); }
      }));

    new Setting(containerEl).setName('Refresh Windows status')
      .setDesc('Refresh after changing Startup Apps or Task Manager while this tab is open.')
      .addButton(button => button.setButtonText('Refresh').onClick(() => this.display()));
  }
}
