import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const STARTUP_NAME = 'Obsidian Windows Startup';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

export function readStartupCommand(): string {
  const output = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
    ['query', RUN_KEY, '/v', STARTUP_NAME],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  const command = output.match(/REG_SZ\s+([^\r\n]+)/)?.[1];
  if (!command) throw new Error('Cannot read the Windows startup command.');
  return command;
}

function commandHasSwitch(command: string, flag: string): boolean {
  const args = command.trim().match(/^(?:"[^"]*"|\S+)\s+(.*)$/)?.[1] ?? '';
  return new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`).test(args);
}

export function commandStartsMinimized(command: string): boolean {
  // Electron launchItems.args omits switches; read this flag from the owned Run value.
  return commandHasSwitch(command, MINIMIZED_ARG);
}

export function commandStartsInTray(command: string): boolean {
  return commandHasSwitch(command, TRAY_ARG);
}

export const STARTUP_ARG = '--obsidian-windows-startup';
export const MINIMIZED_ARG = '--obsidian-windows-startup-minimized';
export const TRAY_ARG = '--obsidian-windows-startup-tray';

export interface LaunchItem {
  name: string;
  path: string;
  args: string[];
  scope: 'user' | 'machine';
  enabled: boolean;
}

export interface LoginApp {
  getLoginItemSettings(options: { path: string; args: string[] }): { launchItems: LaunchItem[] };
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    enabled: boolean;
    name: string;
    path: string;
    args: string[];
  }): void;
}

export interface StartupState {
  registered: boolean;
  enabled: boolean;
  minimized: boolean;
  tray: boolean;
}

export class WindowsStartup {
  constructor(private readonly app: LoginApp, readonly path: string,
    private readonly readCommand: () => string = readStartupCommand) {}

  read(preferredMinimized: boolean, preferredTray = false): StartupState {
    const items = this.app.getLoginItemSettings({ path: this.path, args: [STARTUP_ARG] }).launchItems;
    if (!Array.isArray(items)) throw new Error('This Electron version does not expose Windows startup status.');
    const item = items.find(item => item.scope === 'user' &&
      item.name.toLowerCase() === STARTUP_NAME.toLowerCase() &&
      item.path.toLowerCase() === this.path.toLowerCase());
    const command = item ? this.readCommand() : '';
    return {
      registered: Boolean(item),
      enabled: item?.enabled ?? false,
      minimized: item ? commandStartsMinimized(command) : preferredMinimized,
      tray: item ? commandStartsInTray(command) : preferredTray,
    };
  }

  write(registered: boolean, enabled: boolean, minimized: boolean, tray = false): StartupState {
    const args = [STARTUP_ARG];
    if (minimized) args.push(MINIMIZED_ARG);
    if (tray) args.push(TRAY_ARG);
    this.app.setLoginItemSettings({
      openAtLogin: registered,
      enabled,
      name: STARTUP_NAME,
      path: this.path,
      args,
    });
    const actual = this.read(minimized, tray);
    if (actual.registered !== registered || actual.enabled !== (registered && enabled) ||
      actual.minimized !== minimized || actual.tray !== tray) {
      throw new Error('Windows did not apply the startup change. Check permissions and Windows Startup settings.');
    }
    return actual;
  }
}

export interface StartupWindow {
  isDestroyed(): boolean;
  minimize(): void;
}

export interface StartupSession {
  hasSwitch(name: string): boolean;
  removeSwitch(name: string): void;
}

export function minimizeStartupWindow(argv: readonly string[], session: StartupSession, win: StartupWindow): boolean {
  if (!argv.includes(STARTUP_ARG) || !argv.includes(MINIMIZED_ARG) ||
    !session.hasSwitch(MINIMIZED_ARG.slice(2)) || win.isDestroyed()) return false;
  win.minimize();
  // Consume the main-process switch so reloads and other vaults cannot minimize again.
  session.removeSwitch(MINIMIZED_ARG.slice(2));
  return true;
}

export type StartupWindowAction = 'tray' | 'minimized' | false;

export function applyStartupWindow(argv: readonly string[], session: StartupSession,
  win: StartupWindow, hideInTray: () => boolean): StartupWindowAction {
  if (!argv.includes(STARTUP_ARG)) return false;
  const traySwitch = TRAY_ARG.slice(2);
  if (argv.includes(TRAY_ARG) && session.hasSwitch(traySwitch)) {
    if (hideInTray()) {
      session.removeSwitch(traySwitch);
      const minimizedSwitch = MINIMIZED_ARG.slice(2);
      if (session.hasSwitch(minimizedSwitch)) session.removeSwitch(minimizedSwitch);
      return 'tray';
    }
    // Claim the failed one-time attempt; a plugin reload must not unexpectedly hide later.
    session.removeSwitch(traySwitch);
  }
  return minimizeStartupWindow(argv, session, win) ? 'minimized' : false;
}
