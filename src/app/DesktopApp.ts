import { captureRects, playFlip } from "../animation/flip";
import { renderDesktopNode, updateDesktopNodeElement, desktopTileContentKey } from "../render/desktopTile";
import { applyDesktopSettings } from "../settings/desktopSettings";
import { DesktopStore } from "../state/store";
import {
  getDesktopDiagnostics,
  isDesktopRuntime,
  attachDesktopLayerWindow,
  prepareDesktopLayer,
  showDesktopLayerWindow,
  restoreNativeDesktopIcons,
  listenForSettingsRequests,
  scanDesktopItems,
  setAppProcessPriority,
  getStartupEnabled,
  loadDesktopState,
  logStartupEvent,
  repairStartupEntry
} from "../system/desktopApi";
import { desktopViewport } from "../system/desktopViewport";
import { UpdateController } from "./updateController";
import { computeDesktopLayoutWithContent } from "../layout/grid";
import { DesktopSync } from "./desktopSync";
import { FreePlacement } from "./freePlacement";
import { waitForPaint, wait } from "../shared/timing";
import { installSpringCssVariables } from "../animation/spring";
import { anchorGlassSurfaces, onWallpaperGlassChange, startWallpaperGlass } from "../system/wallpaperGlass";
import type {
  AppNode,
  DesktopNode,
  FolderNode,
  LayoutSlot
} from "../types";
import { SelectionController } from "./desktop/selectionController";
import { DesktopInput } from "./desktop/desktopInput";
import { ItemActions } from "./desktop/itemActions";
import { KeyboardController } from "./desktop/keyboardController";
import { RenameController } from "./desktop/renameController";
import { DragController } from "./drag/dragController";
import { DragReorder } from "./drag/dragReorder";
import { DragMerge } from "./drag/dragMerge";
import { MergeCommit } from "./drag/dragMergeCommit";
import { AutoReorder } from "./drag/dragAutoReorder";
import { FreeReorder } from "./drag/dragFreeReorder";
import { FolderPanel } from "./folder/folderPanel";
import { FolderInput } from "./folder/folderInput";
import { SettingsPanel } from "./settings/settingsPanel";
import { SettingsActions } from "./settings/settingsActions";
import { ContextMenuController } from "./overlay/contextMenuController";
import { DialogController } from "./overlay/dialogController";

// Composition root of the desktop overlay: owns the DOM layers, the store and
// the render loop, and wires the controllers to each other and to DOM events.
export class DesktopApp {
  readonly store = new DesktopStore();
  readonly root: HTMLElement;
  readonly grid: HTMLElement;
  readonly folderLayer: HTMLElement;
  readonly settingsLayer: HTMLElement;
  readonly contextMenuLayer: HTMLElement;
  readonly selectionMarquee: HTMLElement;
  layout = new Map<string, LayoutSlot>();
  // Rendered tiles by node id, with the content key they were built from.
  tiles = new Map<string, { key: string; element: HTMLElement }>();
  readonly desktopSync = new DesktopSync({
    syncScannedItems: (items) => this.store.syncScannedItems(items),
    refreshKnownItems: (items) => this.store.refreshKnownItems(items),
    isBusy: () => this.isRefreshInteractionBusy(),
    isHardBusy: () => this.isHardRefreshInteractionBusy(),
    isFolderOpen: () => Boolean(this.folder.openFolderId || this.folder.folderClosing)
  });
  readonly freePlacement = new FreePlacement({
    getNodes: () => this.store.getNodes(),
    getViewport: () => desktopViewport(),
    getSettings: () => this.store.getSettings(),
    getLayout: () => this.layout,
    findNode: (id) => this.findNode(id),
    findFolder: (id) => this.findFolder(id)
  });
  private suppressNextClick = false;
  suppressStoreRender = false;
  // A render was asked for while a drag owned the tiles (see render()).
  private renderDeferred = false;
  readonly updates = new UpdateController({
    getSettingsLayer: () => this.settingsLayer,
    getSettings: () => this.store.getSettings(),
    isSettingsOpen: () => this.settings.settingsOpen,
    renderSettings: () => this.settings.renderSettingsLayer(),
    confirmUpdate: (state) => this.dialogs.confirmUpdateRelease(state)
  });
  // Controllers, one per responsibility; each sees the app through a narrow host type.
  readonly selection: SelectionController = new SelectionController(this);
  readonly desktopInput: DesktopInput = new DesktopInput(this);
  readonly items: ItemActions = new ItemActions(this);
  readonly keyboard: KeyboardController = new KeyboardController(this);
  readonly rename: RenameController = new RenameController(this);
  readonly dragging: DragController = new DragController(this);
  readonly reorder: DragReorder = new DragReorder(this);
  readonly autoReorder: AutoReorder = new AutoReorder(this);
  readonly freeReorder: FreeReorder = new FreeReorder(this);
  readonly merge: DragMerge = new DragMerge(this);
  readonly mergeCommit: MergeCommit = new MergeCommit(this);
  readonly folder: FolderPanel = new FolderPanel(this);
  readonly folderInput: FolderInput = new FolderInput(this);
  readonly settings: SettingsPanel = new SettingsPanel(this);
  readonly settingsActions: SettingsActions = new SettingsActions(this);
  readonly menus: ContextMenuController = new ContextMenuController(this);
  readonly dialogs: DialogController = new DialogController(this);

  constructor(root: HTMLElement) {
    installSpringCssVariables();
    this.root = root;
    this.root.tabIndex = -1;
    this.root.innerHTML = `
      <section class="desktop-stage">
        <div class="desktop-grid"></div>
      </section>
      <section class="folder-layer"></section>
      <section class="settings-layer"></section>
      <section class="context-menu-layer"></section>
      <div class="selection-marquee" hidden></div>
    `;

    this.grid = this.root.querySelector(".desktop-grid")!;
    this.folderLayer = this.root.querySelector(".folder-layer")!;
    this.settingsLayer = this.root.querySelector(".settings-layer")!;
    this.contextMenuLayer = this.root.querySelector(".context-menu-layer")!;
    this.selectionMarquee = this.root.querySelector(".selection-marquee")!;
    this.store.subscribe(() => {
      if (!this.suppressStoreRender) {
        this.renderWithFlip();
      }
    });
    this.installNativeIconSafetyHooks();
    void this.installTraySettingsHook();
    this.bindEvents();
  }

  async boot() {
    try {
      void logStartupEvent("frontend:boot_enter");
      const nativeState = loadDesktopState();
      const attachLayer = this.attachDesktopLayerWithRetry(40, 150);
      const items = await this.scanDesktopWithRetry();
      void logStartupEvent(`frontend:scan_done count=${items.length}`);
      if (items.length === 0) {
        await this.logDesktopDiagnostics("scan returned no desktop items");
        await restoreNativeDesktopIcons();
        this.renderStartupError("\u672a\u626b\u63cf\u5230\u684c\u9762\u9879\u76ee\uff0c\u5df2\u6062\u590d Windows \u539f\u751f\u684c\u9762\u56fe\u6807\u3002");
        return;
      }

      this.store.hydrate(items, await nativeState);
      void setAppProcessPriority(this.store.getSettings().appPriority);
      void this.syncStartupSetting();
      this.desktopSync.rememberScan(items);
      this.render();
      await waitForPaint();

      let desktopLayerAttached = await attachLayer;
      if (!desktopLayerAttached && isDesktopRuntime()) {
        desktopLayerAttached = await this.attachDesktopLayerWithRetry(20, 250);
      }

      if (!desktopLayerAttached && isDesktopRuntime()) {
        await this.logDesktopDiagnostics("desktop layer window could not attach to shell desktop");
        await restoreNativeDesktopIcons();
        this.renderStartupError("\u65e0\u6cd5\u5c06\u65b0\u684c\u9762\u6302\u8f7d\u5230 Windows Shell \u684c\u9762\uff0c\u5df2\u4fdd\u7559\u539f\u751f\u684c\u9762\u56fe\u6807\u3002");
        return;
      }

      const nativeIconsHidden = await prepareDesktopLayer();
      if (!nativeIconsHidden && isDesktopRuntime()) {
        await restoreNativeDesktopIcons();
        this.renderStartupError("\u65e0\u6cd5\u9690\u85cf Windows \u539f\u751f\u684c\u9762\u56fe\u6807\uff0c\u5df2\u4fdd\u7559\u539f\u751f\u684c\u9762\u3002");
        return;
      }

      const desktopLayerVisible = await showDesktopLayerWindow();
      await waitForPaint();
      if (!desktopLayerVisible && isDesktopRuntime()) {
        await this.logDesktopDiagnostics("desktop layer window could not be shown");
        await restoreNativeDesktopIcons();
        this.renderStartupError("\u65e0\u6cd5\u5c06\u65b0\u684c\u9762\u6302\u8f7d\u5230 Windows Shell \u684c\u9762\uff0c\u5df2\u4fdd\u7559\u539f\u751f\u684c\u9762\u56fe\u6807\u3002");
        return;
      }

      // Diagnostics run full scans; they are only worth it when something failed.
      void logStartupEvent("frontend:shown");
      this.desktopSync.startDesktopAutoSync();
      this.updates.startAutoUpdateLoop();
      window.setTimeout(() => void this.updates.offerLegacyInstallCleanup(), 2500);
      onWallpaperGlassChange(() => anchorGlassSurfaces(this.grid, ".folder-cover"));
      startWallpaperGlass();
      this.desktopSync.scheduleFullDesktopItemLoad();
      window.setTimeout(() => {
        this.menus.loadNativeDesktopMenuItems().catch((error) => {
          console.warn("Unable to load the native desktop menu", error);
        });
      }, 300);
    } catch (error) {
      console.error("BuzzDesk failed to boot", error);
      await this.logDesktopDiagnostics("boot failed");
      await restoreNativeDesktopIcons();
      this.renderStartupError("\u542f\u52a8\u5931\u8d25\uff0c\u5df2\u5c1d\u8bd5\u6062\u590d Windows \u539f\u751f\u684c\u9762\u56fe\u6807\u3002");
    }
  }

  // At logon the desktop folder (OneDrive, a network share) may not be ready
  // yet, and a scan that cannot read it comes back empty. Retry with backoff
  // (5 tries over ~9 s) before giving up; the native icons stay visible
  // meanwhile, since they are only hidden once a real scan succeeded.
  private async scanDesktopWithRetry() {
    let items = await scanDesktopItems({ includeIcons: false });
    for (const delayMs of [800, 1500, 2500, 4000]) {
      if (items.length > 0) {
        break;
      }
      void logStartupEvent(`frontend:scan_empty retry_in_ms=${delayMs}`);
      await wait(delayMs);
      items = await scanDesktopItems({ includeIcons: false });
    }
    return items;
  }

  private async logDesktopDiagnostics(reason: string) {
    if (!isDesktopRuntime()) {
      return;
    }

    const diagnostics = await getDesktopDiagnostics();
    console.info("BuzzDesk diagnostics", { reason, diagnostics });
  }

  private async attachDesktopLayerWithRetry(attempts: number, delayMs: number) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await attachDesktopLayerWindow()) {
        return true;
      }

      if (attempt < attempts - 1) {
        await wait(delayMs);
      }
    }

    return false;
  }

  private async syncStartupSetting() {
    await repairStartupEntry();
    const enabled = await getStartupEnabled();
    if (enabled !== null && enabled !== this.store.getSettings().startWithWindows) {
      this.store.updateSettings({ startWithWindows: enabled });
    }
  }

  // Hand the desktop back to Windows only when this page is really going away.
  // An ordinary runtime error (a failed paste, a shell call that rejects) must
  // not reveal the native icons under a layer that keeps running; boot
  // failures restore them from boot() itself.
  private installNativeIconSafetyHooks() {
    const restore = () => {
      this.desktopSync.stopDesktopAutoSync();
      void restoreNativeDesktopIcons();
    };

    window.addEventListener("pagehide", restore);
    window.addEventListener("beforeunload", restore);
    window.addEventListener("error", (event) => {
      console.error("BuzzDesk error", event.error ?? event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      console.error("BuzzDesk unhandled rejection", event.reason);
      event.preventDefault();
    });

    const hot = (import.meta as ImportMeta & {
      hot?: {
        dispose(callback: () => void): void;
        on(event: string, callback: () => void): void;
      };
    }).hot;
    hot?.dispose(restore);
    hot?.on("vite:beforeFullReload", restore);
  }

  private bindEvents() {
    this.root.addEventListener("pointerdown", (event) => this.desktopInput.onDesktopPointerDown(event));
    this.root.addEventListener("dblclick", (event) => this.desktopInput.onDesktopDoubleClick(event));
    this.root.addEventListener("click", (event) => this.desktopInput.onDesktopClick(event));
    this.root.addEventListener("contextmenu", (event) => this.desktopInput.onDesktopContextMenu(event));
    this.grid.addEventListener("focusout", (event) => logFailure("rename", this.rename.onRenameFocusOut(event)));
    this.grid.addEventListener("keydown", (event) => logFailure("rename", this.rename.onGridKeyDown(event)));
    this.folderLayer.addEventListener("click", (event) => this.folderInput.onFolderLayerClick(event));
    this.folderLayer.addEventListener("dblclick", (event) => this.folderInput.onFolderLayerDoubleClick(event));
    this.folderLayer.addEventListener("pointerdown", (event) => this.folderInput.onFolderPointerDown(event));
    this.folderLayer.addEventListener("contextmenu", (event) => this.folderInput.onFolderContextMenu(event));
    this.settingsLayer.addEventListener("click", (event) => this.settings.onSettingsClick(event));
    this.settingsLayer.addEventListener("pointerdown", (event) => this.settings.contextMenuEditorDrag.onPointerDown(event));
    this.settingsLayer.addEventListener("input", (event) => this.settings.onSettingsInput(event));
    this.settingsLayer.addEventListener("change", (event) => this.settings.onSettingsChange(event));
    this.settingsLayer.addEventListener("scroll", () => this.settings.renderSettingsPriorityMenu(), true);
    this.contextMenuLayer.addEventListener("click", (event) => {
      if (this.dialogs.confirmDialogResolve) {
        this.dialogs.onConfirmDialogClick(event);
      } else if (this.dialogs.ratioDialogTargetId) {
        this.dialogs.onRatioDialogClick(event);
      } else {
        void this.menus.onContextMenuClick(event);
      }
    });
    this.contextMenuLayer.addEventListener("keydown", (event) => this.dialogs.onContextOverlayKeyDown(event));

    window.addEventListener("resize", () => this.renderWithFlip());
    window.addEventListener("pointerdown", (event) => this.onGlobalPointerDown(event), true);
    window.addEventListener("keydown", (event) => logFailure("shortcut", this.keyboard.onWindowKeyDown(event)));
  }

  isDesktopSurfaceEvent(event: Event) {
    const target = event.target as HTMLElement | null;
    return Boolean(
      target &&
        this.root.contains(target) &&
        !target.closest(".folder-layer, .settings-layer, .context-menu-layer, .startup-error")
    );
  }

  private async installTraySettingsHook() {
    await listenForSettingsRequests(() => {
      this.menus.clearContextOverlay();
      this.folder.closeFolderNow();
      this.settings.settingsOpen = true;
      this.settings.settingsView = "main";
      this.settings.renderSettingsLayer();
    });
  }

  tileElement(id: string): HTMLElement | null {
    const element = this.tiles.get(id)?.element ?? null;
    return element && element.parentElement === this.grid ? element : null;
  }

  resumeDeferredRender() {
    if (this.renderDeferred && !this.dragging.drag && this.mergeCommit.trashInFlight === 0) {
      this.render();
    }
  }

  renderWithFlip() {
    const before = captureRects(this.grid);
    this.render();
    playFlip(this.grid, before);
  }

  render() {
    // While an icon is pressed or dragged (or ghosts are flying into the bin)
    // the drag owns the tiles' transforms, classes and elements; rebuilding
    // them now would detach the dragged tile or snap it home. Whatever asked
    // (a resize, an arrow key, a scan) is caught up when the drag ends.
    if (this.dragging.drag || this.mergeCommit.trashInFlight > 0) {
      this.renderDeferred = true;
      return;
    }

    this.renderDeferred = false;
    this.pruneDetachedUiState();
    const nodes = this.store.getNodes();
    const viewport = desktopViewport();
    const settings = this.settingsActions.effectiveDesktopSettings(this.store.getSettings(), nodes, viewport);
    applyDesktopSettings(settings);
    const { slots, contentWidth, contentHeight } = computeDesktopLayoutWithContent(
      nodes,
      viewport.width,
      viewport.height,
      settings,
      viewport.offsetX,
      viewport.offsetY
    );
    this.layout = slots;
    document.documentElement.style.setProperty("--desktop-content-width", `${contentWidth}px`);
    document.documentElement.style.setProperty("--desktop-content-height", `${contentHeight}px`);
    const selectedIds = this.selection.desktopSelectionForRender();
    const settingsKey = JSON.stringify(settings);
    const nextTiles = new Map<string, { key: string; element: HTMLElement }>();
    const elements = nodes.map((node) => {
      const slot = this.layout.get(node.id)!;
      const key = desktopTileContentKey(node, settingsKey, this.rename.renamingId === node.id);
      const cached = this.tiles.get(node.id);
      let element: HTMLElement;
      if (cached && cached.key === key) {
        element = cached.element;
        updateDesktopNodeElement(element, node, slot, selectedIds, this.items.openingIds);
      } else {
        element = renderDesktopNode(node, slot, selectedIds, this.rename.renamingId, this.items.openingIds, settings);
      }
      nextTiles.set(node.id, { key, element });
      return element;
    });
    this.tiles = nextTiles;
    if (!sameChildElements(this.grid, elements)) {
      this.grid.replaceChildren(...elements);
    }
    // Measure before any FLIP/merge animation transforms the covers.
    anchorGlassSurfaces(this.grid, ".folder-cover");
    this.folder.renderFolderLayer();
    this.settings.renderSettingsLayer();
    this.menus.renderContextMenu();
  }

  private renderStartupError(message: string) {
    this.tiles.clear();
    this.grid.replaceChildren();
    this.folderLayer.classList.remove("is-open");
    this.folderLayer.replaceChildren();
    this.settingsLayer.classList.remove("is-open");
    this.settingsLayer.replaceChildren();
    this.root.querySelector(".startup-error")?.remove();

    const error = document.createElement("section");
    error.className = "startup-error";
    error.textContent = message;
    this.root.append(error);
  }

  findNode(id: string): DesktopNode | null {
    return this.store.getNodes().find((node) => node.id === id) ?? null;
  }

  findFolder(id: string): FolderNode | null {
    const node = this.findNode(id);
    return node?.type === "folder" ? node : null;
  }

  findFolderChild(folderId: string, childId: string): AppNode | null {
    return this.findFolder(folderId)?.children.find((node) => node.id === childId) ?? null;
  }

  private pruneDetachedUiState() {
    if (this.selection.selectedId && !this.findNode(this.selection.selectedId)) {
      this.selection.selectedId = null;
    }
    for (const id of Array.from(this.selection.selectedIds)) {
      if (!this.findNode(id)) {
        this.selection.selectedIds.delete(id);
      }
    }
    if (!this.selection.selectedId && this.selection.selectedIds.size > 0) {
      this.selection.selectedId = Array.from(this.selection.selectedIds).at(-1) ?? null;
    }

    if (this.rename.renamingId && !this.findNode(this.rename.renamingId)) {
      this.rename.renamingId = null;
    }

    if (this.folder.openFolderId && !this.findFolder(this.folder.openFolderId)) {
      if (!this.folder.folderClosing) {
        this.folder.openFolderId = null;
        this.folder.folderOpenOrigin = null;
        this.folder.editingFolder = false;
        this.folder.renderedFolderId = null;
      }

      this.rename.renamingFolderChild = null;
      this.folder.selectedFolderChild = null;
    }

    if (
      this.rename.renamingFolderChild &&
      !this.findFolderChild(this.rename.renamingFolderChild.folderId, this.rename.renamingFolderChild.childId)
    ) {
      this.rename.renamingFolderChild = null;
    }

    if (
      this.folder.selectedFolderChild &&
      !this.findFolderChild(this.folder.selectedFolderChild.folderId, this.folder.selectedFolderChild.childId)
    ) {
      this.folder.selectedFolderChild = null;
    }

    if (this.menus.contextMenu?.type !== "desktop" && this.menus.contextMenu && !this.menus.contextMenuTargetNode(this.menus.contextMenu)) {
      this.menus.contextMenu = null;
    }
  }

  private onGlobalPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement;
    this.rename.commitPendingRenames(target);

    if (this.dialogs.confirmDialogResolve) {
      if (!target.closest(".confirm-dialog")) {
        this.dialogs.closeConfirmDialog(false);
      }
      return;
    }

    if (this.dialogs.ratioDialogTargetId) {
      if (!target.closest(".ratio-dialog")) {
        this.dialogs.closeRatioDialog();
      }
      return;
    }

    if (!this.menus.contextMenu) {
      return;
    }

    if (target.closest(".context-menu")) {
      return;
    }

    this.menus.closeContextMenu();
  }

  private isRefreshInteractionBusy() {
    return Boolean(
      this.isHardRefreshInteractionBusy() ||
        this.folder.openFolderId ||
        this.folder.folderClosing
    );
  }

  private isHardRefreshInteractionBusy() {
    return Boolean(
      this.dragging.drag ||
        this.mergeCommit.trashInFlight > 0 ||
        this.selection.marquee ||
        this.rename.renamingId ||
        this.rename.renamingFolderChild ||
        this.folder.editingFolder ||
        this.dialogs.confirmDialogResolve ||
        this.dialogs.ratioDialogTargetId ||
        this.menus.contextMenu ||
        this.settings.settingsOpen
    );
  }

  // Swallow the click the browser fires right after a drag / swipe gesture.
  suppressClickOnce() {
    this.suppressNextClick = true;
    window.setTimeout(() => {
      this.suppressNextClick = false;
    }, 0);
  }

  consumeSuppressedClick() {
    if (!this.suppressNextClick) {
      return false;
    }

    this.suppressNextClick = false;
    return true;
  }
}

// Fire-and-forget handlers: a rejected shell call is logged, never left unhandled.
function logFailure(action: string, task: Promise<unknown>) {
  task.catch((error) => console.warn(`BuzzDesk ${action} failed`, error));
}

function sameChildElements(parent: HTMLElement, elements: HTMLElement[]) {
  const children = parent.children;
  if (children.length !== elements.length) {
    return false;
  }

  for (let index = 0; index < elements.length; index += 1) {
    if (children[index] !== elements[index]) {
      return false;
    }
  }

  return true;
}
