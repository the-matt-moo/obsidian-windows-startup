import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const STARTUP_NAME = 'Obsidian Windows Startup';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const MAX_DELAY_SECONDS = 86_400;
export const MAX_RUN_COMMAND_LENGTH = 260;

export const STARTUP_ARG = '--obsidian-windows-startup';
export const MINIMIZED_ARG = '--obsidian-windows-startup-minimized';
export const TRAY_ARG = '--obsidian-windows-startup-tray';

export interface StartupPreferences {
  minimized: boolean;
  tray: boolean;
  delaySeconds: number;
  defaultVault: string;
}

export interface StartupState extends StartupPreferences {
  registered: boolean;
  enabled: boolean;
}

export function readStartupCommand(): string {
  const output = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
    ['query', RUN_KEY, '/v', STARTUP_NAME],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  const command = output.match(/REG_SZ\s+([^\r\n]+)/)?.[1];
  if (!command) throw new Error('Cannot read the Windows startup command.');
  return command;
}

function tokenizeWindowsCommand(command: string): string[] | undefined {
  const args: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index])) index++;
    if (index === command.length) break;
    let arg = '';
    let quoted = false;
    while (index < command.length) {
      let slashes = 0;
      while (command[index] === '\\') { slashes++; index++; }
      if (command[index] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"';
        else quoted = !quoted;
        index++;
      } else {
        arg += '\\'.repeat(slashes);
        if (index === command.length || (!quoted && /\s/.test(command[index]))) break;
        arg += command[index++];
      }
    }
    if (quoted) return undefined;
    args.push(arg);
    while (/\s/.test(command[index])) index++;
  }
  return args;
}

function vaultUri(defaultVault: string): string | undefined {
  if (!defaultVault) return undefined;
  try { return `obsidian://open?vault=${encodeURIComponent(defaultVault)}`; }
  catch { throw new Error('Default vault contains invalid text.'); }
}

function validatePreferences(preferences: StartupPreferences): void {
  if (!Number.isInteger(preferences.delaySeconds) || preferences.delaySeconds < 0 || preferences.delaySeconds > MAX_DELAY_SECONDS) {
    throw new Error(`Delay must be a whole number from 0 to ${MAX_DELAY_SECONDS} seconds.`);
  }
  if (typeof preferences.defaultVault !== 'string') throw new Error('Default vault must be text.');
}

function launchArgs(preferences: StartupPreferences): string[] {
  const args = [STARTUP_ARG];
  if (preferences.minimized) args.push(MINIMIZED_ARG);
  if (preferences.tray) args.push(TRAY_ARG);
  const uri = vaultUri(preferences.defaultVault);
  if (uri) args.push(uri);
  return args;
}

export interface DelayedLaunch { path: string; args: string[]; delaySeconds: number; }

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1')}"`;
}

export function createDelayedVbs(launch: DelayedLaunch): string {
  const command = [launch.path, ...launch.args].map(quoteWindowsArg).join(' ');
  return `WScript.Sleep ${launch.delaySeconds * 1000}\r\nCreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 1, False\r\n`;
}

export interface LauncherStorage {
  scriptPath(): string;
  write(launch: DelayedLaunch): () => void;
  read(): DelayedLaunch | undefined;
}

class FileLauncherStorage implements LauncherStorage {
  private readonly directory = join(process.env?.LOCALAPPDATA && isAbsolute(process.env.LOCALAPPDATA)
    ? process.env.LOCALAPPDATA : join(process.env?.USERPROFILE ?? 'C:\\Users\\Default', 'AppData', 'Local'), 'Obsidian Windows Startup');
  private readonly payload = join(this.directory, 'startup.json');
  scriptPath(): string { return join(this.directory, 'startup.vbs'); }
  write(launch: DelayedLaunch): () => void {
    mkdirSync(this.directory, { recursive: true });
    const oldPayload = existsSync(this.payload) ? readFileSync(this.payload) : undefined;
    const scriptPath = this.scriptPath();
    const oldScript = existsSync(scriptPath) ? readFileSync(scriptPath) : undefined;
    const replace = (path: string, value: Buffer | undefined) => {
      if (value) { const temporary = `${path}.tmp`; writeFileSync(temporary, value, { mode: 0o600 }); renameSync(temporary, path); }
      else rmSync(path, { force: true });
    };
    const restore = () => { replace(scriptPath, oldScript); replace(this.payload, oldPayload); };
    try {
      replace(this.payload, Buffer.from(JSON.stringify(launch), 'utf8'));
      replace(scriptPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(createDelayedVbs(launch), 'utf16le')]));
    } catch (error) { restore(); throw error; }
    return restore;
  }
  read(): DelayedLaunch | undefined {
    try {
      const launch = JSON.parse(readFileSync(this.payload, 'utf8')) as DelayedLaunch;
      const script = readFileSync(this.scriptPath());
      const text = script.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? script.subarray(2).toString('utf16le') : '';
      return text === createDelayedVbs(launch) ? launch : undefined;
    } catch { return undefined; }
  }
}

function quotedCommand(path: string, args: readonly string[]): string {
  return [path, ...args].map(value => `"${value}"`).join(' ');
}

function commandFor(path: string, preferences: StartupPreferences, storage: LauncherStorage): { path: string; args: string[]; command: string; rollback: () => void } {
  validatePreferences(preferences);
  if (/[\r\n]/u.test(path) || launchArgs(preferences).some(arg => /[\r\n]/u.test(arg))) throw new Error('Startup paths and arguments cannot contain line breaks.');
  const args = launchArgs(preferences);
  if (preferences.delaySeconds === 0) {
    const command = quotedCommand(path, args);
    if (command.length > MAX_RUN_COMMAND_LENGTH) throw new Error('Startup command is too long. Shorten the default vault name.');
    return { path, args, command, rollback: () => {} };
  }
  const wscript = join(process.env?.SystemRoot && isAbsolute(process.env.SystemRoot) ? process.env.SystemRoot : 'C:\\Windows', 'System32', 'wscript.exe');
  const wrappedArgs = ['//B', '//Nologo', storage.scriptPath()];
  const command = quotedCommand(wscript, wrappedArgs);
  if (command.length > MAX_RUN_COMMAND_LENGTH) throw new Error('Startup command is too long for Windows Startup. Shorten the Windows user profile path.');
  if (!existsSync(wscript)) throw new Error('Windows Script Host is unavailable, so delayed startup cannot be enabled.');
  const rollback = storage.write({ path, args, delaySeconds: preferences.delaySeconds });
  if (quotedCommand(path, args).length > 32_767) { rollback(); throw new Error('Delayed startup command is too long. Shorten the default vault name.'); }
  return { path: wscript, args: wrappedArgs, command, rollback };
}

function parseLaunchArgs(args: readonly string[]): Omit<StartupPreferences, 'delaySeconds'> | undefined {
  if (args[0] !== STARTUP_ARG) return undefined;
  let minimized = false;
  let tray = false;
  let defaultVault = '';
  for (const arg of args.slice(1)) {
    if (arg === MINIMIZED_ARG && !minimized) minimized = true;
    else if (arg === TRAY_ARG && !tray) tray = true;
    else if (!defaultVault && /^obsidian:\/\/open\?vault=/.test(arg)) {
      try {
        defaultVault = decodeURIComponent(arg.slice('obsidian://open?vault='.length));
        if (vaultUri(defaultVault) !== arg) return undefined;
      } catch { return undefined; }
    } else return undefined;
  }
  return { minimized, tray, defaultVault };
}

function parseOwnedStartupCommand(command: string, executable: string, storage: LauncherStorage): StartupPreferences | undefined {
  const values = tokenizeWindowsCommand(command);
  if (!values?.length) return undefined;
  if (values[0].toLowerCase() === executable.toLowerCase()) {
    const parsed = parseLaunchArgs(values.slice(1));
    return parsed && { ...parsed, delaySeconds: 0 };
  }
  const expected = [join(process.env?.SystemRoot && isAbsolute(process.env.SystemRoot) ? process.env.SystemRoot : 'C:\\Windows', 'System32', 'wscript.exe'), '//B', '//Nologo', storage.scriptPath()];
  if (values.length !== expected.length || values.some((value, index) => value.toLowerCase() !== expected[index].toLowerCase())) return undefined;
  const launch = storage.read();
  if (!launch || launch.path !== executable || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string') ||
    !Number.isInteger(launch.delaySeconds) || launch.delaySeconds <= 0 || launch.delaySeconds > MAX_DELAY_SECONDS) return undefined;
  const parsed = parseLaunchArgs(launch.args);
  return parsed && { ...parsed, delaySeconds: launch.delaySeconds };
}

export interface LaunchItem {
  name: string;
  path: string;
  args: string[];
  scope: 'user' | 'machine';
  enabled: boolean;
}

export interface LoginApp {
  getLoginItemSettings(options: { path: string; args: string[] }): { launchItems: LaunchItem[] };
  setLoginItemSettings(settings: { openAtLogin: boolean; enabled: boolean; name: string; path: string; args: string[] }): void;
}

export class WindowsStartup {
  private readonly storage: LauncherStorage;
  constructor(private readonly app: LoginApp, readonly path: string,
    private readonly readCommand: () => string = readStartupCommand, storage?: LauncherStorage) { this.storage = storage ?? new FileLauncherStorage(); }

  read(fallback: StartupPreferences): StartupState {
    validatePreferences(fallback);
    let item: LaunchItem | undefined;
    const helper = join(process.env?.SystemRoot && isAbsolute(process.env.SystemRoot) ? process.env.SystemRoot : 'C:\\Windows', 'System32', 'wscript.exe');
    // Electron filters launchItems by executable; delayed entries belong to wscript.exe.
    for (const path of [this.path, helper]) {
      const items = this.app.getLoginItemSettings({ path, args: [STARTUP_ARG] }).launchItems;
      if (!Array.isArray(items)) throw new Error('This Electron version does not expose Windows startup status.');
      item = items.find(candidate => candidate.scope === 'user' && candidate.name.toLowerCase() === STARTUP_NAME.toLowerCase());
      if (item) break;
    }
    const preferences = item && parseOwnedStartupCommand(this.readCommand(), this.path, this.storage);
    if (item && !preferences) throw new Error('The named Windows startup entry is not owned by this plugin.');
    return { registered: Boolean(item), enabled: item?.enabled ?? false, ...(preferences ?? fallback) };
  }

  write(registered: boolean, enabled: boolean, preferences: StartupPreferences): StartupState {
    // Reject a same-name entry before Electron can replace it.
    const previous = this.read(preferences);
    const previousCommand = previous.registered ? tokenizeWindowsCommand(this.readCommand()) : undefined;
    if (!registered) {
      this.app.setLoginItemSettings({ openAtLogin: false, enabled: false, name: STARTUP_NAME, path: this.path, args: [STARTUP_ARG] });
      const actual = this.read(preferences);
      if (actual.registered || actual.enabled) throw new Error('Windows did not apply the startup change. Check permissions and Windows Startup settings.');
      return actual;
    }
    const launch = commandFor(this.path, preferences, this.storage);
    try {
      this.app.setLoginItemSettings({ openAtLogin: true, enabled, name: STARTUP_NAME, path: launch.path, args: launch.args });
      const actual = this.read(preferences);
      if (actual.registered !== registered || actual.enabled !== enabled ||
        actual.minimized !== preferences.minimized || actual.tray !== preferences.tray ||
        actual.delaySeconds !== preferences.delaySeconds || actual.defaultVault !== preferences.defaultVault) {
        throw new Error('Windows did not apply the startup change. Check permissions and Windows Startup settings.');
      }
      return actual;
    } catch (error) {
      try {
        launch.rollback();
        this.app.setLoginItemSettings({
          openAtLogin: previous.registered, enabled: previous.enabled, name: STARTUP_NAME,
          path: previousCommand?.[0] ?? this.path, args: previousCommand?.slice(1) ?? [STARTUP_ARG],
        });
      } catch (rollbackError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} Previous startup settings could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw error;
    }
  }
}

export interface StartupWindow { isDestroyed(): boolean; minimize(): void; }
export interface StartupSession { hasSwitch(name: string): boolean; removeSwitch(name: string): void; }

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
    // Consume failed attempts so a plugin reload cannot unexpectedly hide the window.
    session.removeSwitch(traySwitch);
  }
  return minimizeStartupWindow(argv, session, win) ? 'minimized' : false;
}
