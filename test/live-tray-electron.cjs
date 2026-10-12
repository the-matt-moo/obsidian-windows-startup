// Disposable tray-only integration harness. It never reads or writes startup registry entries.
// Run: node test/live-tray-electron.cjs <external-dependencies-directory>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
assert.equal(process.platform, 'win32', 'This integration test requires Windows');
assert(process.argv[2], 'Usage: node test/live-tray-electron.cjs <external-dependencies-directory>');
const dependencies = path.resolve(process.argv[2]);
const externalRequire = createRequire(path.join(dependencies, 'package.json'));
const electron = externalRequire('electron');
const { chromium } = externalRequire('playwright-core');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'obsidian-tray-live-'));
const repo = path.resolve(__dirname, '..');
const pluginDir = path.join(root, 'vault/.obsidian/plugins/windows-startup');
fs.mkdirSync(pluginDir, { recursive: true });
fs.copyFileSync(path.join(repo, 'main.js'), path.join(pluginDir, 'main.js'));
fs.copyFileSync(path.join(repo, 'manifest.json'), path.join(pluginDir, 'manifest.json'));
fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify({ startMinimized: true, startInTray: true, closeToTray: true }));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'disposable-tray-test', main: 'harness.cjs' }));
fs.writeFileSync(path.join(root, 'harness.cjs'), `
const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
const remote=require(${JSON.stringify(path.join(dependencies, 'node_modules/@electron/remote/main'))});
remote.initialize();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,webPreferences:{nodeIntegration:true,contextIsolation:false}});
 remote.enable(win.webContents);
 await win.loadFile(${JSON.stringify(path.join(root, 'index.html'))});
});
app.on('window-all-closed',()=>app.quit());
`);
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Disposable tray test</title>');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let browser;
(async () => {
  try {
    const server = require('node:net').createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    child = spawn(electron, [root, `--user-data-dir=${path.join(root, 'profile')}`, `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1', '--obsidian-windows-startup',
      '--obsidian-windows-startup-minimized', '--obsidian-windows-startup-tray'], { stdio: 'ignore' });
    for (let i = 0; i < 80; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; }
      catch { await sleep(250); }
    }
    assert(browser, 'CDP did not become ready');
    let page;
    for (let i = 0; i < 40; i++) {
      page = browser.contexts()[0]?.pages().find(candidate => candidate.url().startsWith('file:'));
      if (page) break;
      await sleep(100);
    }
    assert(page, 'Harness page unavailable');
    const first = await page.evaluate(async ({ pluginDir, dependencies }) => {
      const fs = require('fs');
      const Module = require('module');
      const remote = require(dependencies + '/node_modules/@electron/remote');
      window.testRemote = remote;
      const dataFile = pluginDir + '/data.json';
      class Plugin {
        constructor() { this.app = { vault: { getName: () => 'Disposable Vault' }, workspace: { onLayoutReady: fn => fn(), on: () => ({}) } }; }
        async loadData() { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
        async saveData(data) { fs.writeFileSync(dataFile, JSON.stringify(data)); }
        addSettingTab(tab) { this.tab = tab; }
        registerEvent() {}
      }
      class PluginSettingTab { constructor() { this.containerEl = { empty() {}, createEl() {} }; } }
      class Setting { setName() { return this; } setDesc() { return this; } addToggle() { return this; } addButton() { return this; } }
      const original = Module._load;
      Module._load = function(id, ...args) {
        if (id === 'obsidian') return { Plugin, PluginSettingTab, Setting, Platform: { isDesktopApp: true }, Notice: class {} };
        if (id === '@electron/remote') return remote;
        return original.call(this, id, ...args);
      };
      window.reloadPlugin = async () => {
        if (window.plugin) window.plugin.onunload();
        delete require.cache[require.resolve(pluginDir + '/main.js')];
        const PluginClass = require(pluginDir + '/main.js').default;
        window.plugin = new PluginClass();
        await window.plugin.onload();
      };
      await window.reloadPlugin();
      const win = remote.getCurrentWindow();
      const tray = window.plugin.tray.tray;
      window.nativeTray = tray;
      return {
        trayCreated: Boolean(tray) && !tray.isDestroyed(),
        hidden: !win.isVisible(),
        traySwitchConsumed: !remote.app.commandLine.hasSwitch('obsidian-windows-startup-tray'),
        minimizedSwitchConsumed: !remote.app.commandLine.hasSwitch('obsidian-windows-startup-minimized'),
      };
    }, { pluginDir, dependencies });
    assert.deepEqual(first, { trayCreated: true, hidden: true, traySwitchConsumed: true, minimizedSwitchConsumed: true });

    await page.evaluate(() => window.nativeTray.emit('click'));
    await sleep(300);
    assert.equal(await page.evaluate(() => window.plugin.tray.win.isVisible()), true);
    await page.evaluate(() => window.plugin.tray.win.close());
    await sleep(300);
    assert.equal(await page.evaluate(() => !window.plugin.tray.win.isDestroyed() && !window.plugin.tray.win.isVisible()), true,
      'close-to-tray did not synchronously veto and hide');
    await page.evaluate(() => window.nativeTray.emit('click'));
    await sleep(300);
    assert.equal(await page.evaluate(() => window.plugin.tray.win.isVisible()), true);

    const unload = await page.evaluate(() => {
      const tray = window.nativeTray;
      window.plugin.tray.hide();
      window.plugin.onunload();
      return { visible: window.plugin === undefined ? false : true, trayDestroyed: tray.isDestroyed() };
    });
    assert.equal(unload.trayDestroyed, true);
    assert.equal(await page.evaluate(() => window.testRemote.getCurrentWindow().isVisible()), true);

    const reload = await page.evaluate(async () => {
      await window.reloadPlugin();
      const remote = window.testRemote;
      return { visible: remote.getCurrentWindow().isVisible(), traySwitchConsumed: !remote.app.commandLine.hasSwitch('obsidian-windows-startup-tray') };
    });
    assert.deepEqual(reload, { visible: true, traySwitchConsumed: true });
    await page.evaluate(() => window.plugin.onunload());
    console.log(JSON.stringify({ actualTrayLifecycle: 'PASS', closeToTrayBeforeUnload: 'PASS', startupTrayPriorityAndReloadGuard: 'PASS', registryAccess: 'NONE' }, null, 2));
  } finally {
    if (browser) try { await browser.close(); } catch {}
    if (child && child.pid) try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
