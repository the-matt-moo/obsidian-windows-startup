import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ElectronEventLike, ElectronTrayLike, ElectronWindowLike, NativeImageLike, TrayController, TrayRemote,
} from '../tray';

type Callback = (...args: unknown[]) => void;

class FakeWindow {
  id: number;
  visible = true;
  minimized = false;
  destroyed = false;
  closeCalls = 0;
  showCalls = 0;
  focusCalls = 0;
  restoreCalls = 0;
  listeners = new Map<string, Set<Callback>>();

  constructor(id: number) { this.id = id; }
  hide(): void { this.visible = false; }
  show(): void { this.showCalls++; this.visible = true; }
  showInactive(): void { this.showCalls++; this.visible = true; }
  focus(): void { this.focusCalls++; }
  restore(): void { this.restoreCalls++; this.minimized = false; }
  close(): void { this.closeCalls++; this.emit('close', { preventDefault() {} }); }
  isVisible(): boolean { return this.visible; }
  isMinimized(): boolean { return this.minimized; }
  isDestroyed(): boolean { return this.destroyed; }
  on(event: string, listener: Callback): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeListener(event: string, listener: Callback): void { this.listeners.get(event)?.delete(listener); }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
}

class FakeRenderer {
  beforeUnload = new Set<Callback>();
  timers: Array<() => void> = [];
  addEventListener(_type: 'beforeunload', listener: Callback): void { this.beforeUnload.add(listener); }
  removeEventListener(_type: 'beforeunload', listener: Callback): void { this.beforeUnload.delete(listener); }
  setTimeout(handler: () => void): number { this.timers.push(handler); return this.timers.length; }
  fireBeforeUnload(): { prevented: boolean; stopped: boolean } {
    const result = { prevented: false, stopped: false };
    const event = {
      preventDefault: () => { result.prevented = true; },
      stopImmediatePropagation: () => { result.stopped = true; },
    };
    for (const listener of this.beforeUnload) listener(event);
    return result;
  }
  runTimers(): void { for (const timer of this.timers.splice(0)) timer(); }
}

class FakeTray implements ElectronTrayLike {
  destroyed = false;
  click?: () => void;
  tooltip = '';
  menu: unknown;
  failSetup = false;
  setToolTip(tooltip: string): void { this.tooltip = tooltip; }
  setContextMenu(menu: unknown): void {
    if (this.failSetup) throw new Error('menu failed');
    this.menu = menu;
  }
  on(_event: 'click', listener: () => void): void { this.click = listener; }
  destroy(): void { this.destroyed = true; }
}

function fixture(options: { icon?: Promise<NativeImageLike>; failSetup?: boolean } = {}) {
  const main = new FakeWindow(1);
  const secondary = new FakeWindow(2);
  const unrelated = new FakeWindow(3);
  const renderer = new FakeRenderer();
  const trays: FakeTray[] = [];
  const appListeners = new Map<string, Set<Callback>>();
  const app = {
    getFileIcon: () => options.icon ?? Promise.resolve({ isEmpty: () => false }),
    on(event: 'before-quit', listener: Callback) {
      const listeners = appListeners.get(event) ?? new Set();
      listeners.add(listener);
      appListeners.set(event, listeners);
    },
    removeListener(event: 'before-quit', listener: Callback) { appListeners.get(event)?.delete(listener); },
  };
  const remote: TrayRemote = {
    app,
    Tray: class extends FakeTray {
      constructor(_icon: NativeImageLike) {
        super();
        this.failSetup = options.failSetup ?? false;
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: template => template },
  };
  const tagged = { closed: false, electronWindow: secondary as unknown as ElectronWindowLike } as unknown as Window;
  const reports: unknown[] = [];
  const controller = new TrayController(remote, main as unknown as ElectronWindowLike,
    renderer as unknown as Window, 'C:\\Obsidian.exe',
    () => 'Test Vault', () => [tagged], error => reports.push(error));
  return {
    controller, main, secondary, unrelated, renderer, trays, reports,
    emitApp(event: string) { for (const listener of appListeners.get(event) ?? []) listener(); },
  };
}

test('close-to-tray hides only this vault and tray click restores it', async () => {
  const f = fixture();
  assert.equal(await f.controller.configure(true, true), true);
  assert.equal(f.controller.ready, true);
  const event = f.renderer.fireBeforeUnload();
  assert.deepEqual(event, { prevented: true, stopped: true });
  assert.equal(f.main.visible, false);
  assert.equal(f.secondary.visible, false);
  assert.equal(f.unrelated.visible, true);
  f.trays[0].click?.();
  assert.equal(f.main.visible, true);
  assert.equal(f.secondary.visible, true);
});

test('disabled tray unload preserves an ordinary minimized window', async () => {
  const f = fixture();
  f.main.minimized = true;
  await f.controller.configure(false, false);
  f.controller.unload();
  assert.equal(f.main.minimized, true);
  assert.deepEqual({ show: f.main.showCalls, restore: f.main.restoreCalls, focus: f.main.focusCalls },
    { show: 0, restore: 0, focus: 0 });
});

test('failed tray setup destroys its candidate and never intercepts close', async () => {
  const f = fixture({ failSetup: true });
  assert.equal(await f.controller.configure(true, true), false);
  assert.equal(f.trays[0].destroyed, true);
  assert.equal(f.controller.ready, false);
  assert.deepEqual(f.renderer.fireBeforeUnload(), { prevented: false, stopped: false });
  assert.equal(f.main.visible, true);
  assert.equal(f.reports.length, 1);
});

test('disable and unload restore hidden windows, remove listeners, and destroy tray', async () => {
  const f = fixture();
  await f.controller.configure(true, true);
  f.controller.hide();
  await f.controller.configure(false, false);
  assert.equal(f.main.visible, true);
  assert.equal(f.secondary.visible, true);
  assert.equal(f.trays[0].destroyed, true);
  assert.equal(f.renderer.beforeUnload.size, 0);

  await f.controller.configure(true, true);
  f.controller.hide();
  f.controller.unload();
  assert.equal(f.main.visible, true);
  assert.equal(f.secondary.visible, true);
  assert.equal(f.trays[1].destroyed, true);
  assert.equal(f.renderer.beforeUnload.size, 0);
});

test('late and concurrent icon requests cannot recreate or replace a disabled tray', async () => {
  let resolveFirst!: (icon: NativeImageLike) => void;
  let resolveSecond!: (icon: NativeImageLike) => void;
  const icons = [
    new Promise<NativeImageLike>(resolve => { resolveFirst = resolve; }),
    new Promise<NativeImageLike>(resolve => { resolveSecond = resolve; }),
  ];
  const f = fixture();
  let request = 0;
  (f.controller as unknown as { remote: TrayRemote }).remote.app.getFileIcon = () => icons[request++];
  const first = f.controller.configure(true, true);
  await f.controller.configure(false, false);
  const second = f.controller.configure(true, true);
  resolveSecond({ isEmpty: () => false });
  assert.equal(await second, true);
  resolveFirst({ isEmpty: () => false });
  assert.equal(await first, false);
  assert.equal(f.trays.length, 1);
  assert.equal(f.controller.ready, true);
});

test('unload while icon extraction is pending prevents late tray creation', async () => {
  let resolveIcon!: (icon: NativeImageLike) => void;
  const f = fixture({ icon: new Promise(resolve => { resolveIcon = resolve; }) });
  const configuring = f.controller.configure(true, true);
  f.controller.unload();
  resolveIcon({ isEmpty: () => false });
  assert.equal(await configuring, false);
  assert.equal(f.trays.length, 0);
  assert.equal(f.controller.ready, false);
});

test('app quit and Windows session end bypass close-to-tray interception', async () => {
  for (const event of ['before-quit', 'query-session-end'] as const) {
    const f = fixture();
    await f.controller.configure(true, true);
    if (event === 'before-quit') f.emitApp(event);
    else f.main.emit(event);
    assert.deepEqual(f.renderer.fireBeforeUnload(), { prevented: false, stopped: false });
    assert.equal(f.main.visible, true);
  }
});

test('a canceled tray Quit restores access and resumes close interception', async () => {
  const f = fixture();
  await f.controller.configure(true, true);
  f.controller.hide();
  f.controller.quit();
  assert.equal(f.main.closeCalls, 1);
  f.renderer.runTimers();
  assert.equal(f.main.visible, true);
  assert.equal(f.renderer.fireBeforeUnload().prevented, true);
});
