import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyStartupWindow, commandStartsInTray, commandStartsMinimized, LaunchItem, LoginApp, MINIMIZED_ARG,
  minimizeStartupWindow, STARTUP_ARG, STARTUP_NAME, TRAY_ARG, WindowsStartup,
} from '../startup';

function fixture() {
  let items: LaunchItem[] = [];
  const writes: Parameters<LoginApp['setLoginItemSettings']>[0][] = [];
  const app: LoginApp = {
    getLoginItemSettings: () => ({ launchItems: items.map(item => ({ ...item, args: [] })) }),
    setLoginItemSettings(settings) {
      writes.push(settings);
      items = items.filter(item => item.scope !== 'user' || item.name !== settings.name);
      if (settings.openAtLogin) items.push({ ...settings, scope: 'user' });
    },
  };
  return {
    app, writes, startup: new WindowsStartup(app, 'C:\\Obsidian\\Obsidian.exe', () =>
      '"C:\\Obsidian\\Obsidian.exe" ' + items.find(item => item.scope === 'user' &&
        item.name.toLowerCase() === STARTUP_NAME.toLowerCase())?.args.join(' ')),
    setItems(value: LaunchItem[]) { items = value; },
    getItems: () => items,
  };
}

test('registry switch detection rejects prefixes and executable-name lookalikes', () => {
  assert.equal(commandStartsMinimized('"C:\\Program Files\\Obsidian.exe" ' + MINIMIZED_ARG), true);
  assert.equal(commandStartsInTray('"C:\\Program Files\\Obsidian.exe" ' + TRAY_ARG), true);
  assert.equal(commandStartsMinimized('"C:\\' + MINIMIZED_ARG + '.exe"'), false);
  assert.equal(commandStartsMinimized(MINIMIZED_ARG + '-other'), false);
  assert.equal(commandStartsInTray(TRAY_ARG + '-other'), false);
  assert.equal(commandStartsMinimized(STARTUP_ARG), false);
});

test('enabling creates named entry and disabling removes it despite Electron omitting switches', () => {
  const f = fixture();
  assert.deepEqual(f.startup.read(false), { registered: false, enabled: false, minimized: false, tray: false });
  assert.deepEqual(f.startup.write(true, true, true), { registered: true, enabled: true, minimized: true, tray: false });
  assert.deepEqual(f.writes[0].args, [STARTUP_ARG, MINIMIZED_ARG]);
  f.startup.write(false, false, true);
  assert.equal(f.getItems().length, 0);
});

test('normal startup contains only the startup marker', () => {
  const f = fixture();
  f.startup.write(true, true, false);
  assert.deepEqual(f.writes[0].args, [STARTUP_ARG]);
});

test('Windows disable is authoritative and minimized changes do not re-enable it', () => {
  const f = fixture();
  f.startup.write(true, true, false);
  f.getItems()[0].enabled = false;
  const state = f.startup.read(true);
  assert.deepEqual(state, { registered: true, enabled: false, minimized: false, tray: false });
  f.startup.write(state.registered, state.enabled, true);
  assert.equal(f.startup.read(false).enabled, false);
});

test('other names and machine entries are ignored and never removed', () => {
  const f = fixture();
  const other: LaunchItem = { name: 'Other Obsidian', path: f.startup.path, args: [], scope: 'user', enabled: true };
  f.setItems([other, { ...other, name: STARTUP_NAME, scope: 'machine' }]);
  assert.equal(f.startup.read(false).enabled, false);
  f.startup.write(true, true, false);
  f.startup.write(false, false, false);
  assert.ok(f.getItems().includes(other));
  assert.ok(f.getItems().some(item => item.scope === 'machine' && item.name === STARTUP_NAME));
});

test('read handles case-insensitive Windows paths and names', () => {
  const f = fixture();
  f.setItems([{ name: STARTUP_NAME.toUpperCase(), path: f.startup.path.toUpperCase(), args: [STARTUP_ARG, MINIMIZED_ARG], scope: 'user', enabled: true }]);
  assert.equal(f.startup.read(false).minimized, true);
});

test('silent OS write failures are reported', () => {
  const f = fixture();
  f.app.setLoginItemSettings = () => {};
  assert.throws(() => f.startup.write(true, true, false), /did not apply/);
});

test('unsupported Electron and permission errors are reported', () => {
  const f = fixture();
  f.app.getLoginItemSettings = () => ({ launchItems: undefined as unknown as LaunchItem[] });
  assert.throws(() => f.startup.read(false), /does not expose/);
  f.app.getLoginItemSettings = () => { throw new Error('Access denied'); };
  assert.throws(() => f.startup.read(false), /Access denied/);
});

test('only a marked minimized launch minimizes, once across plugin reloads', () => {
  let calls = 0;
  const win = { isDestroyed: () => false, minimize: () => { calls++; } };
  let available = true;
  const session = {
    hasSwitch: (name: string) => name === MINIMIZED_ARG.slice(2) && available,
    removeSwitch: (name: string) => { assert.equal(name, MINIMIZED_ARG.slice(2)); available = false; },
  };
  assert.equal(minimizeStartupWindow([], session, win), false);
  assert.equal(minimizeStartupWindow([STARTUP_ARG], session, win), false);
  assert.equal(minimizeStartupWindow([MINIMIZED_ARG], session, win), false);
  assert.equal(minimizeStartupWindow([STARTUP_ARG, MINIMIZED_ARG], session, win), true);
  assert.equal(minimizeStartupWindow([STARTUP_ARG, MINIMIZED_ARG], session, win), false);
  assert.equal(calls, 1);
});

test('tray preference persists in the owned command while preserving disabled state', () => {
  const f = fixture();
  f.startup.write(true, true, true, true);
  assert.deepEqual(f.writes[0].args, [STARTUP_ARG, MINIMIZED_ARG, TRAY_ARG]);
  f.getItems()[0].enabled = false;
  const state = f.startup.read(false, false);
  assert.deepEqual(state, { registered: true, enabled: false, minimized: true, tray: true });
  f.startup.write(state.registered, state.enabled, false, true);
  assert.equal(f.startup.read(true, false).enabled, false);
});

test('marked tray startup takes priority, consumes both switches, and runs once', () => {
  const available = new Set([TRAY_ARG.slice(2), MINIMIZED_ARG.slice(2)]);
  const session = {
    hasSwitch: (name: string) => available.has(name),
    removeSwitch: (name: string) => { available.delete(name); },
  };
  let hidden = 0;
  let minimized = 0;
  const args = [STARTUP_ARG, MINIMIZED_ARG, TRAY_ARG];
  const win = { isDestroyed: () => false, minimize: () => { minimized++; } };
  assert.equal(applyStartupWindow(args, session, win, () => { hidden++; return true; }), 'tray');
  assert.equal(applyStartupWindow(args, session, win, () => { hidden++; return true; }), false);
  assert.deepEqual({ hidden, minimized }, { hidden: 1, minimized: 0 });
});

test('failed tray creation never hides and falls back to marked minimization once', () => {
  const available = new Set([TRAY_ARG.slice(2), MINIMIZED_ARG.slice(2)]);
  const session = {
    hasSwitch: (name: string) => available.has(name),
    removeSwitch: (name: string) => { available.delete(name); },
  };
  let minimized = 0;
  const action = applyStartupWindow([STARTUP_ARG, MINIMIZED_ARG, TRAY_ARG], session,
    { isDestroyed: () => false, minimize: () => { minimized++; } }, () => false);
  assert.equal(action, 'minimized');
  assert.equal(minimized, 1);
  assert.equal(available.size, 0);
});

test('tray marker without the common startup marker is ignored', () => {
  const session = { hasSwitch: () => true, removeSwitch: () => assert.fail() };
  assert.equal(applyStartupWindow([TRAY_ARG], session,
    { isDestroyed: () => false, minimize: () => assert.fail() }, () => { assert.fail(); }), false);
});

test('destroyed windows and failed minimization do not claim the session', () => {
  const args = [STARTUP_ARG, MINIMIZED_ARG];
  const session = { hasSwitch: () => true, removeSwitch: () => assert.fail('must not consume switch') };
  assert.equal(minimizeStartupWindow(args, session, { isDestroyed: () => true, minimize: () => assert.fail() }), false);
  assert.throws(() => minimizeStartupWindow(args, session, { isDestroyed: () => false, minimize: () => { throw new Error('gone'); } }), /gone/);
  assert.equal(session.hasSwitch(), true);
});
