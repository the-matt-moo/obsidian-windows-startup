import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { SettingDefinitionItem } from 'obsidian';
import type WindowsStartupPlugin from '../main';
import type { StartupState } from '../startup';

// Evaluate the real entry point without loading Obsidian or touching Windows startup.
const bundle = buildSync({
  entryPoints: ['main.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['obsidian'],
}).outputFiles[0].text;
const nodeRequire = createRequire(import.meta.url);

interface SettingsTab {
  getSettingDefinitions(): SettingDefinitionItem[];
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): Promise<void>;
  updates: number;
  refreshes: number;
}

async function fixture(bridge: 'modern' | 'throws' | 'missing' | 'unavailable' = 'modern', data: unknown = null) {
  const notices: string[] = [];
  const saved: unknown[] = [];
  const loaded: string[] = [];
  const remote = {
    app: {
      getLoginItemSettings: () => ({ launchItems: [] }), setLoginItemSettings() {},
      commandLine: { hasSwitch: () => false, removeSwitch() {} },
    },
    process: { execPath: 'C:/Obsidian/Obsidian.exe', argv: [] },
    getCurrentWindow: () => ({ isDestroyed: () => false }),
  };
  const window = {
    require(id: string) {
      loaded.push(id);
      if (id === '@electron/remote') {
        if (bridge === 'throws' || bridge === 'unavailable') throw new Error('Module unavailable');
        return bridge === 'modern' ? remote : undefined;
      }
      if (id === 'electron') return { remote: bridge === 'unavailable' ? undefined : remote };
      throw new Error(`Unexpected runtime module: ${id}`);
    },
  };
  class Plugin {
    app = { vault: { getName: () => 'Test' }, workspace: { on: () => ({}), onLayoutReady() {} } };
    async loadData() { return data; }
    async saveData(data: unknown) { saved.push(JSON.parse(JSON.stringify(data))); }
    addSettingTab(tab: SettingsTab) { Object.assign(this, { tab }); }
    registerEvent() {}
  }
  class PluginSettingTab {
    updates = 0;
    refreshes = 0;
    update() { this.updates++; (this as unknown as SettingsTab).getSettingDefinitions(); }
    refreshDomState() { this.refreshes++; }
  }
  const module: { exports: { default?: new () => WindowsStartupPlugin & { tab: SettingsTab } } } = { exports: {} };
  runInNewContext(bundle, {
    module, window, process: { platform: 'win32' },
    require(id: string) {
      if (id === 'obsidian') return {
        Plugin, PluginSettingTab, Platform: { isDesktopApp: true },
        Notice: class { constructor(message: string) { notices.push(message); } },
      };
      if (id === 'node:fs') return { existsSync: () => false };
      if (id === 'node:child_process') return { execFileSync() { throw new Error('Registry access in unit test'); } };
      if (id === 'node:path') return nodeRequire(id);
      throw new Error(`Unexpected bundled module: ${id}`);
    },
  });
  assert.ok(module.exports.default);
  const plugin = new module.exports.default();
  await plugin.onload();
  return { plugin, tab: plugin.tab, notices, saved, loaded };
}

for (const bridge of ['modern', 'throws', 'missing'] as const) {
  test(`window.require uses ${bridge === 'modern' ? '@electron/remote' : `electron.remote when modern bridge ${bridge}`}`, async () => {
    const f = await fixture(bridge);
    assert.equal(f.plugin.unavailable, '');
    assert.ok(f.plugin.startup);
    assert.deepEqual(f.loaded, bridge === 'modern' ? ['@electron/remote'] : ['@electron/remote', 'electron']);
  });
}

test('unavailable bridges disable controls and display an explanation', async () => {
  const f = await fixture('unavailable');
  assert.match(f.plugin.unavailable, /does not expose the Electron APIs/);
  assert.equal(f.plugin.startup, undefined);
  const controls = f.tab.getSettingDefinitions().filter(item => 'control' in item);
  assert.equal(controls.length, 6);
  for (const item of controls) {
    assert.ok('control' in item && item.control);
    assert.equal(typeof item.control.disabled === 'function' && item.control.disabled(), true);
  }
});

test('declarative settings persist preferences separately and preserve Windows-disabled state', async () => {
  const f = await fixture();
  let state: StartupState = { registered: true, enabled: false, minimized: false, tray: false, delaySeconds: 0, defaultVault: '' };
  const writes: StartupState[] = [];
  let reads = 0;
  f.plugin.startup!.read = preferences => { reads++; return state.registered ? { ...state } : { ...state, ...preferences }; };
  f.plugin.startup!.write = (registered, enabled, preferences) => {
    state = { registered, enabled, ...preferences };
    writes.push({ ...state });
    return state;
  };
  let trayRefreshes = 0;
  f.plugin.refreshTray = async () => { trayRefreshes++; };
  f.tab.getSettingDefinitions();
  assert.equal(f.tab.getControlValue('startWithWindows'), false);
  assert.equal(f.tab.getControlValue('unknown'), undefined);
  await f.tab.setControlValue('startMinimized', true);
  await f.tab.setControlValue('startInTray', true);
  assert.equal(writes.length, 2);
  assert.ok(writes.every(write => write.registered && !write.enabled));
  await f.tab.setControlValue('closeToTray', true);
  assert.equal(writes.length, 2, 'close-to-tray must not write login settings');
  assert.deepEqual(f.saved.at(-1), { startMinimized: true, startInTray: true, closeToTray: true, delaySeconds: 0, defaultVault: '' });
  assert.equal(trayRefreshes, 2);
  assert.equal(f.tab.getControlValue('startMinimized'), true);
  assert.equal(f.tab.getControlValue('startInTray'), true);
  assert.equal(f.tab.getControlValue('closeToTray'), true);
  await f.tab.setControlValue('startWithWindows', true);
  assert.deepEqual(writes.at(-1), { registered: true, enabled: true, minimized: true, tray: true, delaySeconds: 0, defaultVault: '' });
  assert.equal(f.saved.length, 3, 'login toggle must not save vault preferences');
  await f.tab.setControlValue('startWithWindows', false);
  assert.deepEqual(writes.at(-1), { registered: false, enabled: false, minimized: true, tray: true, delaySeconds: 0, defaultVault: '' });
  await f.tab.setControlValue('delaySeconds', 15);
  await f.tab.setControlValue('defaultVault', 'my vault');
  assert.equal(f.tab.getControlValue('delaySeconds'), 15);
  assert.equal(f.tab.getControlValue('defaultVault'), 'my vault');
  assert.deepEqual(f.saved.at(-1), { startMinimized: true, startInTray: true, closeToTray: true, delaySeconds: 15, defaultVault: 'my vault' });
  assert.equal(f.tab.updates, 7);
  assert.equal(f.tab.refreshes, 7);
  assert.ok(reads > 5, 'definitions and changes must reread Windows state');
  assert.deepEqual(f.notices, []);
});

test('legacy, missing, and invalid saved startup settings retain safe defaults', async () => {
  for (const data of [null, {}, { startMinimized: true }, { delaySeconds: -1, defaultVault: 123 }, { delaySeconds: 1.5 }, { delaySeconds: '250' }, { delaySeconds: Infinity }, { defaultVault: '   ' }]) {
    const f = await fixture('modern', data);
    assert.equal(f.plugin.delaySeconds, 0);
    assert.equal(f.plugin.defaultVault, '');
    assert.equal(f.plugin.unavailable, '');
  }
  const fLegacy = await fixture('modern', { delayMs: 5000, defaultVault: ' Moo ' });
  assert.equal(fLegacy.plugin.delaySeconds, 5);
  assert.equal(fLegacy.plugin.defaultVault, 'Moo');

  const f = await fixture('modern', { delaySeconds: 12, defaultVault: ' Moo ' });
  assert.equal(f.plugin.delaySeconds, 12);
  assert.equal(f.plugin.defaultVault, 'Moo');
});

test('editing delay and vault preserves registered Windows-disabled startup state', async () => {
  const f = await fixture();
  let state: StartupState = { registered: true, enabled: false, minimized: true, tray: true, delaySeconds: 5, defaultVault: 'old' };
  f.plugin.startup!.read = () => ({ ...state });
  f.plugin.startup!.write = (registered, enabled, preferences) => (state = { registered, enabled, ...preferences });
  f.tab.getSettingDefinitions();
  assert.equal(f.tab.getControlValue('delaySeconds'), 5);
  assert.equal(f.tab.getControlValue('defaultVault'), 'old');
  await f.tab.setControlValue('delaySeconds', 30);
  await f.tab.setControlValue('defaultVault', ' Moo ');
  assert.deepEqual(state, { registered: true, enabled: false, minimized: true, tray: true, delaySeconds: 30, defaultVault: 'Moo' });
  await f.tab.setControlValue('delaySeconds', -1);
  assert.equal(state.delaySeconds, 30);
  await f.tab.setControlValue('defaultVault', '   ');
  assert.equal(state.defaultVault, '');
});

test('failed preference save reports error and restores settings availability', async () => {
  const f = await fixture();
  f.tab.getSettingDefinitions();
  f.plugin.savePreferences = async () => { throw new Error('Save denied'); };
  await f.tab.setControlValue('closeToTray', true);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /Save denied/);
  const control = f.tab.getSettingDefinitions().find(item => 'control' in item && item.control?.key === 'startMinimized');
  assert.ok(control && 'control' in control && control.control);
  assert.equal(typeof control.control.disabled === 'function' && control.control.disabled(), false);
  assert.equal(f.tab.updates, 1);
});

test('registry read errors disable startup controls and refresh can recover', async () => {
  const f = await fixture();
  const read = f.plugin.startup!.read.bind(f.plugin.startup);
  f.plugin.startup!.read = () => { throw new Error('Registry denied'); };
  const definitions = f.tab.getSettingDefinitions();
  const control = definitions.find(item => 'control' in item && item.control?.key === 'startWithWindows');
  assert.ok(control && 'control' in control && control.control);
  assert.equal(typeof control.control.disabled === 'function' && control.control.disabled(), true);
  f.plugin.startup!.read = read;
  const refresh = definitions.find(item => 'name' in item && item.name === 'Refresh Windows status');
  assert.ok(refresh && 'action' in refresh && refresh.action);
  Reflect.apply(refresh.action, undefined, []);
  assert.equal(typeof control.control.disabled === 'function' && control.control.disabled(), false);
  assert.equal(f.tab.updates, 1);
});
