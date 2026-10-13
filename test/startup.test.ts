import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyStartupWindow, createDelayedVbs, DelayedLaunch, LaunchItem, LauncherStorage, LoginApp, MAX_DELAY_SECONDS,
  MINIMIZED_ARG, minimizeStartupWindow, STARTUP_ARG, STARTUP_NAME, StartupPreferences, TRAY_ARG, WindowsStartup,
} from '../startup';

const defaults: StartupPreferences = { minimized: false, tray: false, delaySeconds: 0, defaultVault: '' };

function quoted(path: string, args: string[]): string { return [path, ...args].map(value => `"${value}"`).join(' '); }

function fixture() {
  let items: LaunchItem[] = [];
  let launch: DelayedLaunch | undefined;
  const storage: LauncherStorage = {
    scriptPath: () => 'C:\\Temp\\obsidian-startup.vbs',
    write(value) { const before = launch; launch = value; return () => { launch = before; }; },
    read: () => launch,
  };
  const writes: Parameters<LoginApp['setLoginItemSettings']>[0][] = [];
  const app: LoginApp = {
    getLoginItemSettings: ({ path }) => ({
      launchItems: items.filter(item => item.path.toLowerCase() === path.toLowerCase())
        .map(item => ({ ...item, args: [] })),
    }),
    setLoginItemSettings(settings) {
      writes.push(settings);
      items = items.filter(item => item.scope !== 'user' || item.name !== settings.name);
      if (settings.openAtLogin) items.push({ ...settings, scope: 'user' });
    },
  };
  const path = 'C:\\Obsidian\\Obsidian.exe';
  return {
    app, writes, storage, startup: new WindowsStartup(app, path, () => {
      const item = items.find(candidate => candidate.scope === 'user' && candidate.name.toLowerCase() === STARTUP_NAME.toLowerCase());
      return item ? quoted(item.path, item.args) : '';
    }, storage),
    setItems(value: LaunchItem[]) { items = value; }, getItems: () => items,
  };
}

test('zero delay uses Obsidian directly, encodes the vault URI, and preserves flags', () => {
  const f = fixture();
  const preferences = { minimized: true, tray: true, delaySeconds: 0, defaultVault: 'my vault&x' };
  assert.deepEqual(f.startup.write(true, true, preferences), { registered: true, enabled: true, ...preferences });
  assert.deepEqual(f.writes[0].args, [STARTUP_ARG, MINIMIZED_ARG, TRAY_ARG, 'obsidian://open?vault=my%20vault%26x']);
  assert.equal(f.writes[0].path, f.startup.path);
});

test('delay uses the hidden Windows Script Host helper and preserves a Windows-disabled entry', () => {
  const f = fixture();
  const preferences = { minimized: false, tray: false, delaySeconds: 5, defaultVault: 'vault' };
  f.startup.write(true, true, preferences);
  assert.match(f.writes[0].path, /\\System32\\wscript\.exe$/i);
  assert.deepEqual(f.writes[0].args.slice(0, 2), ['//B', '//Nologo']);
  f.getItems()[0].enabled = false;
  assert.deepEqual(f.startup.read(defaults), { registered: true, enabled: false, ...preferences });
  f.startup.write(true, false, { ...preferences, minimized: true });
  assert.equal(f.startup.read(defaults).enabled, false);
});

test('direct to delayed to direct startup retains flags, vault, and disabled status', () => {
  const f = fixture();
  const direct = { ...defaults, minimized: true, tray: true, defaultVault: 'Moo' };
  f.startup.write(true, false, direct);
  const delayed = { ...direct, delaySeconds: 10 };
  assert.deepEqual(f.startup.write(true, false, delayed), { registered: true, enabled: false, ...delayed });
  assert.deepEqual(f.startup.read(defaults), { registered: true, enabled: false, ...delayed });
  assert.deepEqual(f.startup.write(true, false, direct), { registered: true, enabled: false, ...direct });
  assert.equal(f.getItems()[0].path, f.startup.path);
});

test('invalid delay, oversized direct Run command, and same-name unowned entries are rejected', () => {
  const f = fixture();
  assert.throws(() => f.startup.write(true, true, { ...defaults, delaySeconds: -1 }), /whole number/);
  assert.throws(() => f.startup.write(true, true, { ...defaults, defaultVault: 'a'.repeat(300) }), /too long/);
  const helper = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  f.setItems([{ name: STARTUP_NAME, path: helper, args: ['C:\\Other.vbs'], scope: 'user', enabled: true }]);
  assert.throws(() => f.startup.write(false, false, defaults), /not owned/);
});

test('a failed delayed registration restores the previous launcher payload', () => {
  const f = fixture();
  f.startup.write(true, true, { ...defaults, delaySeconds: 10, defaultVault: 'old' });
  f.app.setLoginItemSettings = () => { throw new Error('denied'); };
  assert.throws(() => f.startup.write(true, true, { ...defaults, delaySeconds: 20, defaultVault: 'new' }), /denied/);
  assert.equal(f.storage.read()?.delaySeconds, 10);
  assert.equal(f.storage.read()?.args.at(-1), 'obsidian://open?vault=old');
});

test('verification failure restores both the previous registry entry and delayed payload', () => {
  const f = fixture();
  const previous = { ...defaults, delaySeconds: 10, defaultVault: 'old' };
  f.startup.write(true, true, previous);
  const set = f.app.setLoginItemSettings;
  let writes = 0;
  f.app.setLoginItemSettings = settings => {
    set(settings);
    if (writes++ === 0) f.getItems()[0].enabled = false;
  };
  assert.throws(() => f.startup.write(true, true, { ...defaults, delaySeconds: 20, defaultVault: 'new' }), /did not apply/);
  assert.deepEqual(f.startup.read(defaults), { registered: true, enabled: true, ...previous });
  assert.equal(f.storage.read()?.delaySeconds, 10);
});

test('disabling an owned delayed entry does not rebuild or require its launcher', () => {
  const f = fixture();
  f.startup.write(true, true, { ...defaults, delaySeconds: 10 });
  f.startup.write(false, false, { ...defaults, delaySeconds: MAX_DELAY_SECONDS, defaultVault: 'x'.repeat(10000) });
  assert.equal(f.getItems().length, 0);
});

test('silent OS write failures and unsupported Electron status are reported', () => {
  const f = fixture();
  f.app.setLoginItemSettings = () => {};
  assert.throws(() => f.startup.write(true, true, defaults), /did not apply/);
  f.app.getLoginItemSettings = () => ({ launchItems: undefined as unknown as LaunchItem[] });
  assert.throws(() => f.startup.read(defaults), /does not expose/);
});

test('other names and machine entries are ignored and never removed', () => {
  const f = fixture();
  const other: LaunchItem = { name: 'Other Obsidian', path: f.startup.path, args: [], scope: 'user', enabled: true };
  f.setItems([other, { ...other, name: STARTUP_NAME, scope: 'machine' }]);
  assert.equal(f.startup.read(defaults).enabled, false);
  f.startup.write(true, true, defaults);
  f.startup.write(false, false, defaults);
  assert.ok(f.getItems().includes(other));
  assert.ok(f.getItems().some(item => item.scope === 'machine' && item.name === STARTUP_NAME));
});

test('strictly parsed registry commands reject lookalikes and preserve defaults when absent', () => {
  const f = fixture();
  assert.deepEqual(f.startup.read({ ...defaults, defaultVault: 'saved' }), { registered: false, enabled: false, ...defaults, defaultVault: 'saved' });
  f.setItems([{ name: STARTUP_NAME, path: f.startup.path, args: [], scope: 'user', enabled: true }]);
  assert.throws(() => f.startup.read(defaults), /not owned/);
});

test('the generated delayed launcher waits and passes argv in an isolated harmless process', { timeout: 10000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-startup-delay-'));
  try {
    const output = join(root, 'result.txt');
    const script = join(root, 'launcher.vbs');
    const started = Date.now();
    const expected = [STARTUP_ARG, MINIMIZED_ARG, TRAY_ARG, 'obsidian://open?vault=Moo%20%26%20%E6%97%A5%E6%9C%AC', 'quotes " and spaces'];
    const launch: DelayedLaunch = { path: process.execPath, delaySeconds: 1, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", output, ...expected] };
    writeFileSync(script, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(createDelayedVbs(launch), 'utf16le')]));
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'), ['//B', '//Nologo', script]);
    let result = '';
    for (let i = 0; i < 50; i++) {
      try { result = readFileSync(output, 'utf8'); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
    }
    assert.deepEqual(JSON.parse(result), expected);
    assert.ok(Date.now() - started >= launch.delaySeconds * 1000, 'launcher did not delay');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('marked startup window behavior remains one-time and tray takes priority', () => {
  const available = new Set([TRAY_ARG.slice(2), MINIMIZED_ARG.slice(2)]);
  const session = { hasSwitch: (name: string) => available.has(name), removeSwitch: (name: string) => { available.delete(name); } };
  let minimized = 0;
  const win = { isDestroyed: () => false, minimize: () => { minimized++; } };
  assert.equal(applyStartupWindow([STARTUP_ARG, MINIMIZED_ARG, TRAY_ARG], session, win, () => true), 'tray');
  assert.equal(applyStartupWindow([STARTUP_ARG, MINIMIZED_ARG, TRAY_ARG], session, win, () => true), false);
  assert.equal(minimized, 0);
  const retry = { hasSwitch: () => true, removeSwitch: () => {} };
  assert.equal(minimizeStartupWindow([STARTUP_ARG, MINIMIZED_ARG], retry, win), true);
});

test('ordinary launches stay visible and failed tray startup falls back once to minimize', () => {
  const available = new Set([TRAY_ARG.slice(2), MINIMIZED_ARG.slice(2)]);
  const session = { hasSwitch: (name: string) => available.has(name), removeSwitch: (name: string) => { available.delete(name); } };
  let minimized = 0;
  let trayAttempts = 0;
  const win = { isDestroyed: () => false, minimize: () => { minimized++; } };
  const hide = () => { trayAttempts++; return false; };
  assert.equal(applyStartupWindow([TRAY_ARG, MINIMIZED_ARG], session, win, hide), false);
  assert.equal(trayAttempts, 0);
  assert.equal(minimizeStartupWindow([STARTUP_ARG, MINIMIZED_ARG], session, { ...win, isDestroyed: () => true }), false);
  assert.equal(applyStartupWindow([STARTUP_ARG, TRAY_ARG, MINIMIZED_ARG], session, win, hide), 'minimized');
  assert.equal(applyStartupWindow([STARTUP_ARG, TRAY_ARG, MINIMIZED_ARG], session, win, hide), false);
  assert.equal(trayAttempts, 1);
  assert.equal(minimized, 1);
});

test('delay upper bound is explicit', () => assert.throws(() => fixture().startup.write(true, true, { ...defaults, delaySeconds: MAX_DELAY_SECONDS + 1 }), /whole number/));
