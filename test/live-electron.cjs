// Disposable integration harness. Requires Electron + @electron/remote installed outside the repo.
// Run: node test/live-electron.cjs <external-dependencies-directory>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
assert.equal(process.platform, 'win32', 'This integration test requires Windows');
assert(process.argv[2], 'Usage: node test/live-electron.cjs <external-dependencies-directory>');
const dependencies = path.resolve(process.argv[2]);
assert(fs.existsSync(path.join(dependencies, 'package.json')), 'External dependencies directory must contain package.json');
const externalRequire = createRequire(path.join(dependencies, 'package.json'));
const electron = externalRequire('electron');
const { chromium } = externalRequire('playwright-core');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'obsidian-startup-live-'));
const repo = path.resolve(__dirname, '..');
const name = 'Obsidian Windows Startup';
const run = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run';
const keys = [run, 'HKCU:/Software/Microsoft/Windows/CurrentVersion/RunOnce', 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/Run', 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/Run32', 'HKLM:/Software/Microsoft/Windows/CurrentVersion/Run', 'HKLM:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/Run'];
function ps(code) { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8' }).trim(); }
function absent() { return ps(`$found=$false; foreach($k in @(${keys.map(k => `'${k}'`).join(',')})){if(Test-Path $k){if((Get-Item $k).GetValueNames() -contains '${name}'){$found=$true}}}; [Console]::WriteLine($found)`) === 'False'; }
function registry() { return JSON.parse(ps(`$v=(Get-Item '${run}').GetValue('${name}'); if($null -eq $v){[Console]::WriteLine('null')}else{[Console]::WriteLine((ConvertTo-Json -Compress -InputObject $v))}`)); }
const oldPids = JSON.parse(ps(`ConvertTo-Json -Compress -InputObject @(Get-Process Obsidian -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)`));
// Compare hashes only; never print unrelated startup commands or values.
function unrelatedRegistryHash() {
 return ps(`$entries=@(); foreach($k in @(${keys.map(k=>`'${k}'`).join(',')})){if(Test-Path $k){$item=Get-Item $k; foreach($n in ($item.GetValueNames() | Sort-Object)){if($n -ne '${name}'){$entries+=[ordered]@{key=$k;name=$n;kind=$item.GetValueKind($n).ToString();value=$item.GetValue($n)}}}}}; $json=ConvertTo-Json -Depth 10 -Compress -InputObject $entries; $sha=[Security.Cryptography.SHA256]::Create(); [Console]::WriteLine([Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json))))`);
}
const unrelatedBefore = unrelatedRegistryHash();
let owned = false;
let pid;
let browser;
const outputs = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pluginDir = path.join(root, 'vault/.obsidian/plugins/windows-startup');
fs.mkdirSync(pluginDir, { recursive: true });
fs.copyFileSync(path.join(repo, 'main.js'), path.join(pluginDir, 'main.js'));
fs.copyFileSync(path.join(repo, 'manifest.json'), path.join(pluginDir, 'manifest.json'));
const bundle = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');
assert(bundle.includes('removeSwitch') && bundle.includes('commandLine'), 'Rebuild main.js with commandLine claim first');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'disposable-startup-test', main: 'harness.cjs' }));
fs.writeFileSync(path.join(root, 'harness.cjs'), `
const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
const remote=require(${JSON.stringify(path.join(dependencies, 'node_modules/@electron/remote/main'))});
remote.initialize();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});
 remote.enable(win.webContents);
 await win.loadFile(${JSON.stringify(path.join(root, 'index.html'))});
 win.showInactive();
});
app.on('window-all-closed',()=>app.quit());
`);
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Disposable Windows Startup test</title><p>Temporary integration harness</p>');
async function evaluate(page, fn, arg) { return page.evaluate(fn, arg); }
async function stop() {
 if (pid) {
  ps(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){if($p.Path -ne [IO.Path]::GetFullPath('${electron.replace(/\\/g, '/').replace(/'/g,"''")}')){throw 'Test PID executable mismatch'}; & taskkill.exe /PID ${pid} /T /F | Out-Null; for($i=0;$i -lt 20;$i++){if(-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)){break}; Start-Sleep -Milliseconds 250}; if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){throw 'Test process cleanup failed'}}`);
  pid = undefined;
 }
 if (browser) { try { await browser.close(); } catch {} browser = undefined; }
}
(async()=>{
 try {
  assert(absent(), 'Named startup entry already exists; registry test aborted without modifications');
  owned = true;
  outputs.push({ bundleSha256: crypto.createHash('sha256').update(bundle).digest('hex'), runtime: 'Electron 40.10.2 / remote 2.1.3', isolation: 'temporary Electron, not installed Obsidian' });
  for (const [label, markers, expected] of [
   ['normal', [], false],
   ['startup-normal', ['--obsidian-windows-startup'], false],
   ['minimized-only', ['--obsidian-windows-startup-minimized'], false],
   ['startup-minimized', ['--obsidian-windows-startup', '--obsidian-windows-startup-minimized'], true],
  ]) {
   const server = require('node:net').createServer();
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   const port = server.address().port;
   await new Promise(resolve=>server.close(resolve));
   pid = Number(ps(`$p=Start-Process -FilePath '${electron.replace(/\\/g, '/').replace(/'/g,"''")}' -ArgumentList @('"${root.replace(/\\/g, '/').replace(/'/g,"''")}"', '"--user-data-dir=${path.join(root, 'profile').replace(/\\/g, '/').replace(/'/g,"''")}"', '--remote-debugging-port=${port}', '--remote-debugging-address=127.0.0.1'${markers.map(m => `, '${m}'`).join('')}) -WindowStyle Minimized -PassThru; [Console]::WriteLine($p.Id)`));
   let connected = false;
   for(let i=0;i<80;i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); connected=true; break; } catch { await sleep(250); } }
   assert(connected, 'CDP did not become ready');
   let page;
   for(let i=0;i<40;i++) { page=browser.contexts()[0]?.pages().find(p=>p.url().startsWith('file:')); if(page)break; await sleep(100); }
   assert(page, 'Harness page unavailable');
   assert.equal(require('node:url').fileURLToPath(page.url()),path.join(root,'index.html'),'CDP target is not this disposable harness');
   await page.waitForLoadState();
   const info = await evaluate(page, async ({ pluginDir, dependencies, root }) => {
    const fs=require('fs');const Module=require('module');
    const remote=require(dependencies+'/node_modules/@electron/remote');
    window.testRemote=remote;const win=remote.getCurrentWindow();win.restore();
    window.controls={};
    const dataFile=pluginDir+'/data.json';
    class Plugin { constructor(){this.app={vault:{getName:()=> 'Disposable Vault'},workspace:{onLayoutReady:fn=>fn(),on:()=>({})}};} async loadData(){return fs.existsSync(dataFile)?JSON.parse(fs.readFileSync(dataFile,'utf8')):null;} async saveData(data){fs.writeFileSync(dataFile,JSON.stringify(data));} addSettingTab(tab){this.tab=tab;} registerEvent(){} }
    class PluginSettingTab {constructor(app,plugin){this.containerEl={empty(){window.controls={};},createEl(){},querySelectorAll(){return[];}};} }
    class Setting {setName(n){this.name=n;return this;}setDesc(){return this;}addToggle(fn){const control={setValue(v){this.value=v;return this;},setDisabled(){return this;},onChange(fn){this.change=fn;return this;}};window.controls[this.name]=control;fn(control);return this;}addButton(fn){fn({setButtonText(){return this;},onClick(){return this;}});return this;} }
    window.notices=[];
    const original=Module._load;
    Module._load=function(id,...args){if(id==='obsidian')return{Plugin,PluginSettingTab,Setting,Platform:{isDesktopApp:true},Notice:class{constructor(msg){window.notices.push(msg);}}};if(id==='@electron/remote')return remote;return original.call(this,id,...args);};
    window.reloadPlugin=async()=>{if(window.plugin)window.plugin.onunload();delete require.cache[require.resolve(pluginDir+'/main.js')];const C=require(pluginDir+'/main.js').default;window.plugin=new C();await window.plugin.onload();window.plugin.tab.display();};
    await window.reloadPlugin();
    return {userData:remote.app.getPath('userData'),electron:remote.process.versions.electron,remoteApis:!!(remote.app.getLoginItemSettings&&remote.app.setLoginItemSettings&&remote.app.commandLine.hasSwitch&&remote.app.commandLine.removeSwitch),unavailable:window.plugin.unavailable,minimized:win.isMinimized()};
   }, { pluginDir, dependencies, root });
   assert.equal(path.resolve(info.userData), path.resolve(root, 'profile'));
   assert.equal(info.remoteApis, true);assert.equal(info.unavailable, '');assert.equal(info.minimized, expected);
   outputs.push({launch:label,...info});
   if(label==='normal') {
    const initial=await evaluate(page,()=>window.plugin.startup.read(false));
    assert.deepEqual(initial,{registered:false,enabled:false,minimized:false,tray:false});
    await evaluate(page,()=>window.controls['Start with Windows'].change(true));
    const enabled=await evaluate(page,()=>window.plugin.startup.read(false));
    assert.deepEqual(enabled,{registered:true,enabled:true,minimized:false,tray:false});
    assert(registry().includes('--obsidian-windows-startup'));
    await evaluate(page,async()=>await window.controls['Start minimized'].change(true));
    const minimized=await evaluate(page,()=>window.plugin.startup.read(false));
    outputs.push({minimizedToggleDiagnostic:minimized,notices:await evaluate(page,()=>window.notices),namedRegistryCommand:registry(),launchItems:await evaluate(page,()=>window.testRemote.app.getLoginItemSettings({path:window.plugin.startup.path,args:['--obsidian-windows-startup']}).launchItems.filter(i=>i.name==='Obsidian Windows Startup'))});
    const minimizedPass = minimized.registered && minimized.enabled && minimized.minimized;
    assert(registry().includes('--obsidian-windows-startup-minimized'));
    const preferenceSaved = fs.existsSync(path.join(pluginDir,'data.json')) && JSON.parse(fs.readFileSync(path.join(pluginDir,'data.json'),'utf8')).startMinimized === true;
    const approved = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/Run';
    ps(`New-Item -Path '${approved}' -Force | Out-Null; New-ItemProperty -LiteralPath '${approved}' -Name '${name}' -PropertyType Binary -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0)) -Force | Out-Null`);
    const externalDisabled = await evaluate(page,()=>{window.plugin.tab.display();return {state:window.plugin.startup.read(false),toggle:window.controls['Start with Windows'].value};});
    assert.deepEqual(externalDisabled,{state:{registered:true,enabled:false,minimized:true,tray:false},toggle:false});
    await evaluate(page,async()=>await window.controls['Start minimized'].change(false));
    assert.deepEqual(await evaluate(page,()=>window.plugin.startup.read(false)),{registered:true,enabled:false,minimized:false,tray:false});
    await evaluate(page,async()=>await window.controls['Start minimized'].change(true));
    assert.deepEqual(await evaluate(page,()=>window.plugin.startup.read(false)),{registered:true,enabled:false,minimized:true,tray:false});
    await evaluate(page,()=>window.controls['Start with Windows'].change(true));
    assert.deepEqual(await evaluate(page,()=>window.plugin.startup.read(false)),{registered:true,enabled:true,minimized:true,tray:false});
    assert.deepEqual(await evaluate(page,()=>window.notices),[]);
    outputs.push({nativeExternalDisabled:'PASS',disabledStatusShownInToggle:'PASS',minimizedChangePreservesDisabled:'PASS',reenable:'PASS'});
    await evaluate(page,()=>window.controls['Start with Windows'].change(false));
    const disabled=await evaluate(page,()=>window.plugin.startup.read(true));
    assert.equal(disabled.registered,false);assert.equal(disabled.enabled,false);assert.equal(registry(),null);
    outputs.push({toggles:minimizedPass?'PASS':'FAIL: minimized readback',initial,enabled,minimized,disabled,registryWriteReadRemove:'PASS',preferenceSaved:preferenceSaved?'PASS':'FAIL'});
    if (!minimizedPass || !preferenceSaved) process.exitCode=1;
   }
   if(expected){
    const reload=await evaluate(page,async()=>{const remote=window.testRemote;const w=remote.getCurrentWindow();w.restore();await window.reloadPlugin();return{minimized:w.isMinimized(),switchConsumed:!remote.app.commandLine.hasSwitch('obsidian-windows-startup-minimized')};});
    assert.deepEqual(reload,{minimized:false,switchConsumed:true});outputs.push({reloadAfterRestore:'PASS',...reload});
   }
   await stop();
  }
 } catch (error) {
  outputs.push({failure:error.message});
  throw error;
 } finally {
  let stopError;
  try { await stop(); } catch (error) { stopError=error; }
  if(owned){
   ps(`foreach($k in @(${[run, 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/Run'].map(k=>`'${k}'`).join(',')})){if((Test-Path $k) -and ((Get-Item $k).GetValueNames() -contains '${name}')){Remove-ItemProperty -LiteralPath $k -Name '${name}' -ErrorAction Stop}}`);
   assert(absent(), 'Registry cleanup failed');outputs.push({registryCleanup:'PASS'});
  }
  assert.equal(unrelatedRegistryHash(),unrelatedBefore,'Unrelated startup registry values changed');outputs.push({unrelatedStartupRegistryValuesUnchanged:'PASS'});
  const stillAlive=JSON.parse(ps(`ConvertTo-Json -Compress -InputObject @(${oldPids.join(',')} | ForEach-Object {if(Get-Process -Id $_ -ErrorAction SilentlyContinue){$_}})`));
  assert.deepEqual(stillAlive,oldPids);outputs.push({existingObsidianProcessesUntouched:'PASS',count:oldPids.length});
  console.log(JSON.stringify(outputs,null,2));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  if(stopError) throw stopError;
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
