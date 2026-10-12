export interface NativeImageLike { isEmpty(): boolean; }

export interface ElectronEventLike { preventDefault(): void; }

type Listener = (...args: unknown[]) => void;

export interface ElectronWindowLike {
  id: number;
  hide(): void;
  show(): void;
  showInactive?(): void;
  focus(): void;
  restore(): void;
  close(): void;
  isVisible(): boolean;
  isMinimized(): boolean;
  isDestroyed(): boolean;
  on(event: 'close', listener: (event: ElectronEventLike) => void): void;
  on(event: 'query-session-end' | 'session-end', listener: () => void): void;
  removeListener(event: string, listener: Listener): void;
}

export interface ElectronTrayLike {
  setToolTip(tooltip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
}

interface TrayAppLike {
  getFileIcon?(path: string, options: { size: 'small' | 'normal' | 'large' }): Promise<NativeImageLike>;
  on(event: 'before-quit', listener: () => void): void;
  removeListener(event: 'before-quit', listener: Listener): void;
}

export interface TrayRemote {
  app: TrayAppLike;
  Tray?: new (icon: NativeImageLike) => ElectronTrayLike;
  Menu?: { buildFromTemplate(template: Array<Record<string, unknown>>): unknown };
}

interface RendererEventLike {
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

interface RendererWindowLike {
  addEventListener(type: 'beforeunload', listener: (event: RendererEventLike) => void,
    options: { capture: true }): void;
  removeEventListener(type: 'beforeunload', listener: (event: RendererEventLike) => void,
    options: { capture: true }): void;
  setTimeout(handler: () => void, timeout: number): number;
}

type DomWindowLike = Window & {
  electronWindow?: ElectronWindowLike;
  require?: (id: string) => { getCurrentWindow(): ElectronWindowLike };
};

export class TrayController {
  private tray: ElectronTrayLike | undefined;
  private trayGeneration = 0;
  private configurationGeneration = 0;
  private pendingTray?: { generation: number; promise: Promise<boolean> };
  private closeToTray = false;
  private hiddenByTray = false;
  private quitting = false;
  private readonly trackedWindows = new Set<Window>();
  private readonly hiddenWindows = new Set<ElectronWindowLike>();
  private closeHandler?: (event: ElectronEventLike) => void;
  private beforeUnloadHandler?: (event: RendererEventLike) => void;
  private quitHandler?: () => void;
  private sessionHandler?: () => void;

  constructor(private readonly remote: TrayRemote, private readonly win: ElectronWindowLike,
    private readonly renderer: RendererWindowLike, private readonly executable: string,
    private readonly vaultName: () => string, private readonly existingWindows: () => Window[],
    private readonly report: (error: unknown) => void) {}

  get ready(): boolean { return Boolean(this.tray); }

  trackWindow(win: Window): void { this.trackedWindows.add(win); }

  async configure(closeToTray: boolean, trayEnabled: boolean): Promise<boolean> {
    const configuration = ++this.configurationGeneration;
    const restore = this.closeToTray && !closeToTray;
    this.closeToTray = closeToTray;
    if (!trayEnabled) {
      this.disable();
      return false;
    }
    if (restore) this.restoreOwnedWindows();
    const ready = await this.ensureTray();
    if (configuration === this.configurationGeneration) this.updateCloseInterception(ready && closeToTray);
    return ready;
  }

  async ensureTray(): Promise<boolean> {
    if (this.tray) return true;
    const generation = this.trayGeneration;
    if (this.pendingTray?.generation === generation) return this.pendingTray.promise;
    const promise = this.createTray(generation);
    this.pendingTray = { generation, promise };
    try { return await promise; }
    finally { if (this.pendingTray?.promise === promise) this.pendingTray = undefined; }
  }

  private async createTray(generation: number): Promise<boolean> {
    let candidate: ElectronTrayLike | undefined;
    try {
      const { app, Tray, Menu } = this.remote;
      if (!Tray || !Menu || !app.getFileIcon) throw new Error('This Electron version does not expose the tray APIs.');
      const icon = await app.getFileIcon(this.executable, { size: 'small' });
      if (generation !== this.trayGeneration) return false;
      if (icon.isEmpty()) throw new Error('Windows returned an empty Obsidian tray icon.');
      candidate = new Tray(icon);
      candidate.setToolTip(`${this.vaultName() || 'Obsidian'} — Obsidian`.slice(0, 127));
      candidate.setContextMenu(Menu.buildFromTemplate([
        { label: this.vaultName() || 'Obsidian', enabled: false },
        { type: 'separator' },
        { label: 'Show / Hide', click: () => this.toggle() },
        { type: 'separator' },
        { label: 'Quit this vault', click: () => this.quit() },
      ]));
      candidate.on('click', () => this.toggle());
      if (generation !== this.trayGeneration) {
        candidate.destroy();
        return false;
      }
      this.tray = candidate;
      return true;
    } catch (error) {
      try { candidate?.destroy(); } catch { /* Candidate never became usable. */ }
      this.report(error);
      return false;
    }
  }

  hide(): boolean {
    const hiddenNow: ElectronWindowLike[] = [];
    try {
      if (!this.tray || this.win.isDestroyed()) return false;
      for (const secondary of this.collectSecondaryWindows()) {
        if (!secondary.isVisible()) continue;
        secondary.hide();
        this.hiddenWindows.add(secondary);
        hiddenNow.push(secondary);
      }
      this.win.hide();
      this.hiddenByTray = true;
      return true;
    } catch (error) {
      for (const secondary of hiddenNow) this.restoreWindow(secondary);
      this.report(error);
      return false;
    }
  }

  show(): void {
    try {
      if (!this.win.isDestroyed()) {
        if (this.win.isMinimized()) this.win.restore();
        this.win.show();
      }
      this.hiddenByTray = false;
    } catch (error) { this.report(error); }
    this.restoreSecondaries();
    try { if (!this.win.isDestroyed()) this.win.focus(); } catch { /* Window closed between checks. */ }
  }

  toggle(): void {
    try {
      if (this.win.isVisible() && !this.win.isMinimized()) this.hide();
      else this.show();
    } catch (error) { this.report(error); }
  }

  quit(): void {
    this.quitting = true;
    try {
      this.win.close();
      this.renderer.setTimeout(() => {
        try {
          if (!this.win.isDestroyed()) {
            this.quitting = false;
            this.show();
          }
        } catch { /* The window completed closing. */ }
      }, 500);
    } catch (error) {
      this.quitting = false;
      this.show();
      this.report(error);
    }
  }

  unload(): void {
    this.configurationGeneration++;
    this.removeCloseInterception();
    if (!this.quitting) this.restoreOwnedWindows();
    this.destroyTray();
    this.trackedWindows.clear();
  }

  private updateCloseInterception(enabled: boolean): void {
    this.removeCloseInterception();
    if (!enabled) return;
    this.beforeUnloadHandler = event => {
      if (!this.closeToTray || this.quitting || !this.hide()) return;
      event.preventDefault();
      (event as unknown as { returnValue: boolean }).returnValue = false;
      event.stopImmediatePropagation();
    };
    this.closeHandler = event => {
      if (!this.closeToTray || this.quitting || !this.hide()) return;
      // Renderer beforeunload is the primary synchronous veto; remote preventDefault is fallback only.
      event.preventDefault();
    };
    this.quitHandler = () => { this.quitting = true; };
    this.sessionHandler = () => { this.quitting = true; };
    this.renderer.addEventListener('beforeunload', this.beforeUnloadHandler, { capture: true });
    this.win.on('close', this.closeHandler);
    this.win.on('query-session-end', this.sessionHandler);
    this.win.on('session-end', this.sessionHandler);
    this.remote.app.on('before-quit', this.quitHandler);
  }

  private removeCloseInterception(): void {
    if (this.beforeUnloadHandler) {
      this.renderer.removeEventListener('beforeunload', this.beforeUnloadHandler, { capture: true });
    }
    try { if (this.closeHandler) this.win.removeListener('close', this.closeHandler as Listener); } catch { /* Already removed. */ }
    try { if (this.sessionHandler) this.win.removeListener('query-session-end', this.sessionHandler as Listener); } catch { /* Already removed. */ }
    try { if (this.sessionHandler) this.win.removeListener('session-end', this.sessionHandler as Listener); } catch { /* Already removed. */ }
    try { if (this.quitHandler) this.remote.app.removeListener('before-quit', this.quitHandler as Listener); } catch { /* Already removed. */ }
    this.beforeUnloadHandler = undefined;
    this.closeHandler = undefined;
    this.quitHandler = undefined;
    this.sessionHandler = undefined;
  }

  private disable(): void {
    this.removeCloseInterception();
    this.restoreOwnedWindows();
    this.destroyTray();
  }

  private restoreOwnedWindows(): void {
    if (this.hiddenByTray) this.show();
    else this.restoreSecondaries();
  }

  private destroyTray(): void {
    this.trayGeneration++;
    try { this.tray?.destroy(); } catch { /* Already destroyed. */ }
    this.tray = undefined;
  }

  private collectSecondaryWindows(): ElectronWindowLike[] {
    const domWindows = new Set([...this.trackedWindows, ...this.existingWindows()]);
    const result: ElectronWindowLike[] = [];
    const seen = new Set<number>([this.win.id]);
    for (const domWindow of domWindows) {
      try {
        if (domWindow.closed) {
          this.trackedWindows.delete(domWindow);
          continue;
        }
        const electronWindow = this.electronWindowOf(domWindow as DomWindowLike);
        if (!electronWindow || electronWindow.isDestroyed() || seen.has(electronWindow.id)) continue;
        seen.add(electronWindow.id);
        result.push(electronWindow);
      } catch { /* Window closed or became inaccessible. */ }
    }
    return result;
  }

  private electronWindowOf(win: DomWindowLike): ElectronWindowLike | undefined {
    try { if (win.electronWindow) return win.electronWindow; } catch { /* Try the window's bridge. */ }
    try { return win.require?.('@electron/remote').getCurrentWindow(); } catch { return undefined; }
  }

  private restoreSecondaries(): void {
    for (const win of this.hiddenWindows) this.restoreWindow(win);
    this.hiddenWindows.clear();
  }

  private restoreWindow(win: ElectronWindowLike): void {
    try {
      if (win.isDestroyed()) return;
      if (win.showInactive) win.showInactive();
      else win.show();
    } catch { /* Window closed while hidden. */ }
  }
}
