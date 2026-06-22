import { captureRects, playFlip } from "../animation/flip";
import { dragAutoScrollDelta, dragFrameTransform, toTransformStyle } from "../animation/drag";
import { playFolderClose, playFolderOpen } from "../animation/folderPanel";
import { playFolderBirth, playMergeGroupIntoTarget, playMergeIntoTarget } from "../animation/merge";
import { desktopFallbackMenuItems, itemFallbackMenuItems, folderContextMenuItems } from "./contextMenuModel";
import { computeDesktopLayout, desktopIndexForPoint, panelSizeFor } from "../layout/grid";
import {
  renderContextMenu,
  renderDesktopNode,
  applyFolderTileShellStyle,
  renderFolderCover,
  renderFolderLayerContent,
  renderIcon,
  renderSettingsLayer,
  renderRatioDialog
} from "../render/components";
import {
  applyDesktopSettings,
  defaultDesktopSettings,
  desktopTileMetrics,
  fitDesktopSettings,
  folderRatioMax,
  folderRatioMin,
  folderTileMetrics,
  normalizeFolderAppearance
} from "../settings/desktopSettings";
import { DesktopStore } from "../state/store";
import {
  getDesktopDiagnostics,
  isDesktopRuntime,
  attachDesktopLayerWindow,
  prepareDesktopLayer,
  showDesktopLayerWindow,
  restoreNativeDesktopIcons,
  createDesktopFolder,
  copyDesktopItem,
  deleteDesktopItem,
  listenForSettingsRequests,
  openDesktopItem,
  pasteDesktopItems,
  renameDesktopItem,
  scanDesktopItems,
  setAppProcessPriority,
  showDesktopItemProperties,
  showNativeDesktopContextMenu,
  showNativeItemContextMenu
} from "../system/desktopApi";
import { desktopViewport } from "../system/desktopViewport";
import { warmIconImages } from "../system/iconWarmup";
import type {
  AppNode,
  AppProcessPriority,
  DesktopContextMenuAction,
  DesktopNode,
  DesktopPosition,
  DesktopSettings,
  FolderAppearanceSettings,
  FolderNode,
  LayoutSlot
} from "../types";

const defaultFolderName = "\u6587\u4ef6\u5939";
const folderPagerHeight = 30;

// Owns desktop interaction orchestration; visual rendering, layout math, state
// mutation, and platform calls stay in their own modules.
type DragSource =
  | { type: "desktop"; nodeId: string }
  | { type: "folder"; folderId: string; childId: string };

interface ActiveDrag {
  source: DragSource;
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startScrollLeft: number;
  startScrollTop: number;
  baseX: number;
  baseY: number;
  width: number;
  height: number;
  element: HTMLElement;
  floating: boolean;
  started: boolean;
  frame: number | null;
  targetId: string | null;
  targetRect: DOMRect | null;
  targetElement: HTMLElement | null;
  targetSnapshots: DragTargetSnapshot[];
  groupItems: DragGroupItem[];
  lastTransformStyle: string;
  lastPullX: number;
  lastPullY: number;
  committing: boolean;
}

interface DragGroupItem {
  id: string;
  element: HTMLElement;
  baseX: number;
  baseY: number;
  width: number;
  height: number;
  lastTransformStyle?: string;
}

interface DragTargetSnapshot {
  id: string;
  rect: DOMRect;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface FolderSwipe {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  page: number;
  pageCount: number;
  width: number;
  started: boolean;
}

interface MarqueeSelection {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  started: boolean;
  additive: boolean;
  initialSelection: Set<string>;
}

type ContextMenuState =
  | { type: "desktop"; x: number; y: number }
  | { type: "item"; x: number; y: number; nodeId: string }
  | { type: "folderItem"; x: number; y: number; folderId: string; childId: string };

interface FolderOpenOrigin {
  x: number;
  y: number;
  scale: number;
}

export class DesktopApp {
  private readonly store = new DesktopStore();
  private readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly folderLayer: HTMLElement;
  private readonly settingsLayer: HTMLElement;
  private readonly contextMenuLayer: HTMLElement;
  private readonly selectionMarquee: HTMLElement;
  private layout = new Map<string, LayoutSlot>();
  private selectedId: string | null = null;
  private selectedIds = new Set<string>();
  private openFolderId: string | null = null;
  private renderedFolderId: string | null = null;
  private hiddenOpenFolderTileId: string | null = null;
  private openFolderPage = 0;
  private folderOpenOrigin: FolderOpenOrigin | null = null;
  private editingFolder = false;
  private folderClosing = false;
  private settingsOpen = false;
  private settingsView: "main" | "layout" = "main";
  private ratioDialogTargetId: string | null = null;
  private contextMenu: ContextMenuState | null = null;
  private renamingId: string | null = null;
  private renamingFolderChild: { folderId: string; childId: string } | null = null;
  private selectedFolderChild: { folderId: string; childId: string } | null = null;
  private lastActivation: { id: string; time: number } | null = null;
  private lastOpenRequest: { id: string; time: number } | null = null;
  private openingIds = new Set<string>();
  private openingTimers = new Map<string, number>();
  private pendingRefreshTimers: number[] = [];
  private deferredRefreshTimer: number | null = null;
  private desktopScanSignature: string | null = null;
  private autoSyncTimer: number | null = null;
  private autoSyncInFlight = false;
  private fullDesktopLoadScheduled = false;
  private fullDesktopLoadInFlight = false;
  private drag: ActiveDrag | null = null;
  private folderSwipe: FolderSwipe | null = null;
  private marquee: MarqueeSelection | null = null;
  private suppressNextClick = false;
  private suppressStoreRender = false;
  private settingsPreviewFrame: number | null = null;
  private pendingSettingsPreview: (() => void) | null = null;
  private contextOverlayVersion = 0;

  constructor(root: HTMLElement) {
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
      const items = await scanDesktopItems({ includeIcons: false });
      if (items.length === 0) {
        await this.logDesktopDiagnostics("scan returned no desktop items");
        await restoreNativeDesktopIcons();
        this.renderStartupError("\u672a\u626b\u63cf\u5230\u684c\u9762\u9879\u76ee\uff0c\u5df2\u6062\u590d Windows \u539f\u751f\u684c\u9762\u56fe\u6807\u3002");
        return;
      }

      this.store.hydrate(items);
      void this.applyAppPrioritySetting(this.store.getSettings().appPriority);
      this.desktopScanSignature = desktopItemsSignature(items);

      const desktopLayerAttached = await attachDesktopLayerWindow();
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

      this.render();
      await waitForPaint();
      await this.logDesktopDiagnostics("desktop layer shown");
      this.startDesktopAutoSync();
      this.scheduleFullDesktopItemLoad();
    } catch (error) {
      console.error("Desktop layer failed to boot", error);
      await this.logDesktopDiagnostics("boot failed");
      await restoreNativeDesktopIcons();
      this.renderStartupError("\u542f\u52a8\u5931\u8d25\uff0c\u5df2\u5c1d\u8bd5\u6062\u590d Windows \u539f\u751f\u684c\u9762\u56fe\u6807\u3002");
    }
  }

  private async logDesktopDiagnostics(reason: string) {
    if (!isDesktopRuntime()) {
      return;
    }

    const diagnostics = await getDesktopDiagnostics();
    console.info("Desktop Layer diagnostics", { reason, diagnostics });
  }

  private installNativeIconSafetyHooks() {
    const restore = () => {
      this.stopDesktopAutoSync();
      void restoreNativeDesktopIcons();
    };

    window.addEventListener("pagehide", restore);
    window.addEventListener("beforeunload", restore);
    window.addEventListener("error", restore);
    window.addEventListener("unhandledrejection", restore);

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
    this.root.addEventListener("pointerdown", (event) => this.onDesktopPointerDown(event));
    this.root.addEventListener("dblclick", (event) => this.onDesktopDoubleClick(event));
    this.root.addEventListener("click", (event) => this.onDesktopClick(event));
    this.root.addEventListener("contextmenu", (event) => this.onDesktopContextMenu(event));
    this.grid.addEventListener("focusout", (event) => void this.onRenameFocusOut(event));
    this.grid.addEventListener("keydown", (event) => void this.onGridKeyDown(event));
    this.folderLayer.addEventListener("click", (event) => this.onFolderLayerClick(event));
    this.folderLayer.addEventListener("dblclick", (event) => this.onFolderLayerDoubleClick(event));
    this.folderLayer.addEventListener("pointerdown", (event) => this.onFolderPointerDown(event));
    this.folderLayer.addEventListener("contextmenu", (event) => this.onFolderContextMenu(event));
    this.settingsLayer.addEventListener("click", (event) => this.onSettingsClick(event));
    this.settingsLayer.addEventListener("input", (event) => this.onSettingsInput(event));
    this.settingsLayer.addEventListener("change", (event) => this.onSettingsChange(event));
    this.contextMenuLayer.addEventListener("click", (event) => {
      if (this.ratioDialogTargetId) {
        this.onRatioDialogClick(event);
      } else {
        void this.onContextMenuClick(event);
      }
    });
    this.contextMenuLayer.addEventListener("keydown", (event) => this.onContextOverlayKeyDown(event));

    window.addEventListener("resize", () => this.renderWithFlip());
    window.addEventListener("pointerdown", (event) => this.onGlobalPointerDown(event), true);
    window.addEventListener("keydown", (event) => void this.onWindowKeyDown(event));
  }

  private isDesktopSurfaceEvent(event: Event) {
    const target = event.target as HTMLElement | null;
    return Boolean(
      target &&
        this.root.contains(target) &&
        !target.closest(".folder-layer, .settings-layer, .context-menu-layer, .startup-error")
    );
  }

  private async installTraySettingsHook() {
    await listenForSettingsRequests(() => {
      this.clearContextOverlay();
      this.closeFolderNow();
      this.settingsOpen = true;
      this.settingsView = "main";
      this.renderSettingsLayer();
    });
  }

  private renderWithFlip() {
    const before = captureRects(this.grid);
    this.render();
    playFlip(this.grid, before);
  }

  private render() {
    this.pruneDetachedUiState();
    const nodes = this.store.getNodes();
    const viewport = desktopViewport();
    const settings = this.effectiveDesktopSettings(this.store.getSettings(), nodes, viewport);
    applyDesktopSettings(settings);
    this.layout = computeDesktopLayout(
      nodes,
      viewport.width,
      viewport.height,
      settings,
      viewport.offsetX,
      viewport.offsetY
    );
    const selectedIds = this.desktopSelectionForRender();
    this.grid.replaceChildren(
      ...nodes.map((node) =>
        renderDesktopNode(node, this.layout.get(node.id)!, selectedIds, this.renamingId, this.openingIds, settings)
      )
    );
    this.renderFolderLayer();
    this.renderSettingsLayer();
    this.renderContextMenu();
  }

  private renderFolderLayer(
    settingsOverride?: DesktopSettings,
    folderAppearanceOverride?: FolderAppearanceSettings
  ) {
    if (this.folderClosing) {
      return;
    }

    const folder = this.getOpenFolder();
    this.syncOpenFolderTileState(folder?.id ?? null);
    this.folderLayer.classList.toggle("is-open", Boolean(folder));
    this.folderLayer.classList.remove("is-closing");

    if (!folder) {
      this.folderOpenOrigin = null;
      this.renamingFolderChild = null;
      this.selectedFolderChild = null;
      this.openFolderId = null;
      this.renderedFolderId = null;
      this.folderLayer.replaceChildren();
      return;
    }

    const animate = this.renderedFolderId !== folder.id;
    this.renderedFolderId = folder.id;
    const appearance = folderAppearanceOverride ?? folder.appearance;
    const size = this.folderPanelSize(folder, appearance);
    const pageSize = Math.max(1, size.columns * size.rows);
    const pageCount = Math.max(1, Math.ceil(folder.children.length / pageSize));
    this.openFolderPage = clampScroll(this.openFolderPage, 0, pageCount - 1);
    this.folderLayer.replaceChildren(
      ...renderFolderLayerContent(folder, {
        editing: this.editingFolder,
        renamingChildId:
          this.renamingFolderChild?.folderId === folder.id ? this.renamingFolderChild.childId : null,
        selectedChildId:
          this.selectedFolderChild?.folderId === folder.id ? this.selectedFolderChild.childId : null,
        openingIds: this.openingIds,
        origin: this.folderOpenOrigin,
        size,
        page: this.openFolderPage,
        pageCount,
        pageSize,
        animate
      })
    );
    this.bindFolderNameInput(folder);
    this.bindFolderChildRenameInput(folder);
    if (animate) {
      const panel = this.folderLayer.querySelector<HTMLElement>(".folder-panel");
      const backdrop = this.folderLayer.querySelector<HTMLElement>(".folder-backdrop");
      if (panel) {
        void playFolderOpen(panel, backdrop, this.folderOpenOrigin).then(() => {
          if (this.openFolderId === folder.id && !this.folderClosing && this.folderLayer.contains(panel)) {
            this.settleFolderAnimation(panel, backdrop);
          }
        });
      }
    }
  }

  private syncOpenFolderTileState(folderId: string | null) {
    if (this.hiddenOpenFolderTileId && this.hiddenOpenFolderTileId !== folderId) {
      const previous = this.grid.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(this.hiddenOpenFolderTileId)}"]`
      );
      previous?.classList.remove("is-folder-open");
    }

    this.hiddenOpenFolderTileId = folderId;

    if (!folderId) {
      return;
    }

    const current = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(folderId)}"]`);
    current?.classList.add("is-folder-open");
  }

  private bindFolderNameInput(folder: FolderNode) {
    const input = this.folderLayer.querySelector<HTMLInputElement>("[data-folder-name-input]");
    if (!input) {
      return;
    }

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      const nextName = input.value.trim() || defaultFolderName;
      this.editingFolder = false;
      this.store.renameFolder(folder.id, nextName);
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  private settleFolderAnimation(panel: HTMLElement, backdrop: HTMLElement | null) {
    panel.classList.add("is-static");
    backdrop?.classList.add("is-static");
    requestAnimationFrame(() => {
      panel.classList.remove("is-performance-animating");
    });
  }

  private bindFolderChildRenameInput(folder: FolderNode) {
    const input = this.folderLayer.querySelector<HTMLInputElement>("[data-folder-child-rename-id]");
    if (!input) {
      return;
    }

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        input.blur();
      } else if (event.key === "Escape") {
        this.renamingFolderChild = null;
        this.renderFolderLayer();
      }
    });
    input.addEventListener("blur", () => {
      void this.commitFolderChildRename(
        input.dataset.parentFolderId ?? folder.id,
        input.dataset.folderChildRenameId ?? "",
        input.value
      );
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  private renderStartupError(message: string) {
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

  private renderSettingsLayer() {
    this.settingsLayer.classList.toggle("is-open", this.settingsOpen);

    if (!this.settingsOpen) {
      this.settingsLayer.replaceChildren();
      return;
    }

    this.settingsLayer.replaceChildren(
      ...renderSettingsLayer({
        settings: this.store.getSettings(),
        view: this.settingsView
      })
    );
  }

  private renderContextMenu() {
    if (this.ratioDialogTargetId) {
      this.contextMenuLayer.classList.add("is-open");
      return;
    }

    this.contextMenuLayer.classList.toggle("is-open", Boolean(this.contextMenu));

    if (!this.contextMenu) {
      this.contextMenuLayer.replaceChildren();
      return;
    }

    const node = this.contextMenuTargetNode(this.contextMenu);
    let items;

    if (this.contextMenu.type === "desktop") {
      items = desktopFallbackMenuItems();
    } else if (node?.type === "folder") {
      items = folderContextMenuItems(node.appearance.folderCoverSize);
    } else {
      items = itemFallbackMenuItems(node, this.contextMenu.type === "item" ? "desktop" : "folder");
    }

    this.contextMenuLayer.replaceChildren(
      renderContextMenu({
        x: this.contextMenu.x,
        y: this.contextMenu.y,
        items
      })
    );
  }

  private desktopSelectionForRender() {
    const selected = new Set(this.selectedIds);
    if (this.selectedId) {
      selected.add(this.selectedId);
    }
    return selected;
  }

  private setDesktopSelection(ids: Iterable<string>, primaryId?: string | null) {
    const nodes = new Set(this.store.getNodes().map((node) => node.id));
    const next = Array.from(new Set(ids)).filter((id) => nodes.has(id));
    this.selectedIds = new Set(next);
    this.selectedId =
      primaryId && this.selectedIds.has(primaryId)
        ? primaryId
        : next.length > 0
          ? next[next.length - 1]
          : null;
    this.selectedFolderChild = null;
  }

  private selectSingleDesktopNode(id: string | null) {
    if (!id) {
      this.clearDesktopSelection();
      return;
    }

    this.setDesktopSelection([id], id);
  }

  private clearDesktopSelection() {
    this.selectedId = null;
    this.selectedIds.clear();
  }

  private clearAllSelection() {
    this.clearDesktopSelection();
    this.selectedFolderChild = null;
  }

  private onDesktopClick(event: MouseEvent) {
    if (!this.isDesktopSurfaceEvent(event)) {
      return;
    }

    if (this.consumeSuppressedClick()) {
      return;
    }

    if (this.drag?.started) {
      return;
    }

    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    this.closeContextMenu();

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    if (!tile) {
      this.clearDesktopSelection();
      this.render();
    }
  }

  private onDesktopDoubleClick(event: MouseEvent) {
    if (!this.isDesktopSurfaceEvent(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const node = this.findNode(tile?.dataset.nodeId ?? "");
    if (!tile || !node) {
      return;
    }

    if (node.type === "folder") {
      this.openFolderFromElement(node, tile);
      return;
    }

    void this.openItem(node);
  }

  private onDesktopPointerDown(event: PointerEvent) {
    if (!this.isDesktopSurfaceEvent(event)) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const id = tile?.dataset.nodeId;
    const node = this.findNode(id ?? "");
    const slot = id ? this.layout.get(id) : null;
    if (!tile || !id || !node || !slot) {
      this.beginDesktopMarquee(event);
      return;
    }

    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    const groupNodeIds = this.desktopDragGroupForNode(id);
    if (groupNodeIds.length <= 1) {
      this.previewDesktopPress(node, tile);
    }
    this.beginDrag({
      source: { type: "desktop", nodeId: id },
      event,
      element: tile,
      baseX: slot.x,
      baseY: slot.y,
      floating: false,
      groupNodeIds
    });
  }

  private desktopDragGroupForNode(nodeId: string) {
    if (this.selectedIds.size <= 1 || !this.selectedIds.has(nodeId)) {
      return [nodeId];
    }

    return this.store
      .getNodes()
      .map((node) => node.id)
      .filter((id) => this.selectedIds.has(id));
  }

  private previewDesktopPress(node: DesktopNode, tile: HTMLElement) {
    this.closeContextMenu();
    this.selectedFolderChild = null;
    this.renamingId = null;
    this.selectSingleDesktopNode(node.id);
    this.grid.querySelectorAll(".desktop-tile.is-selected").forEach((element) => {
      if (element !== tile) {
        element.classList.remove("is-selected");
      }
    });
    tile.classList.add("is-selected");
  }

  private beginDesktopMarquee(event: PointerEvent) {
    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    this.closeContextMenu();
    this.renamingId = null;
    this.selectedFolderChild = null;
    this.marquee = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      started: false,
      additive: event.ctrlKey || event.shiftKey,
      initialSelection: new Set(this.desktopSelectionForRender())
    };

    try {
      this.root.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners below keep the marquee alive if capture is unavailable.
    }

    window.addEventListener("pointermove", this.onMarqueePointerMove);
    window.addEventListener("pointerup", this.onMarqueePointerUp, { once: true });
    window.addEventListener("pointercancel", this.onMarqueePointerCancel, { once: true });
    window.addEventListener("blur", this.onMarqueeWindowBlur, { once: true });
  }

  private readonly onMarqueePointerMove = (event: PointerEvent) => {
    const marquee = this.marquee;
    if (!marquee || event.pointerId !== marquee.pointerId) {
      return;
    }

    marquee.currentX = event.clientX;
    marquee.currentY = event.clientY;
    const moved = Math.hypot(marquee.currentX - marquee.startX, marquee.currentY - marquee.startY);
    if (!marquee.started) {
      if (moved < 1) {
        return;
      }

      marquee.started = true;
      if (!marquee.additive) {
        this.clearDesktopSelection();
      }
      this.selectionMarquee.hidden = false;
    }

    event.preventDefault();
    const rect = normalizedRect(marquee.startX, marquee.startY, marquee.currentX, marquee.currentY);
    this.paintSelectionMarquee(rect);
    this.updateMarqueeSelection(rect, marquee);
  };

  private readonly onMarqueePointerUp = (event: PointerEvent) => {
    const marquee = this.marquee;
    if (!marquee || event.pointerId !== marquee.pointerId) {
      return;
    }

    this.removeMarqueeListeners();
    const wasStarted = marquee.started;
    this.marquee = null;
    this.hideSelectionMarquee();
    if (wasStarted) {
      this.suppressNextClick = true;
      window.setTimeout(() => {
        this.suppressNextClick = false;
      }, 0);
    }
  };

  private readonly onMarqueePointerCancel = () => {
    this.cancelDesktopMarquee();
  };

  private readonly onMarqueeWindowBlur = () => {
    this.cancelDesktopMarquee();
  };

  private cancelDesktopMarquee() {
    this.removeMarqueeListeners();
    this.marquee = null;
    this.hideSelectionMarquee();
  }

  private removeMarqueeListeners() {
    window.removeEventListener("pointermove", this.onMarqueePointerMove);
    window.removeEventListener("pointerup", this.onMarqueePointerUp);
    window.removeEventListener("pointercancel", this.onMarqueePointerCancel);
    window.removeEventListener("blur", this.onMarqueeWindowBlur);
  }

  private paintSelectionMarquee(rect: Rect) {
    this.selectionMarquee.style.left = `${rect.left}px`;
    this.selectionMarquee.style.top = `${rect.top}px`;
    this.selectionMarquee.style.width = `${rect.width}px`;
    this.selectionMarquee.style.height = `${rect.height}px`;
  }

  private hideSelectionMarquee() {
    this.selectionMarquee.hidden = true;
    this.selectionMarquee.removeAttribute("style");
  }

  private updateMarqueeSelection(rect: Rect, marquee: MarqueeSelection) {
    const selected = new Set(marquee.additive ? marquee.initialSelection : []);
    let primaryId: string | null = null;

    this.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((tile) => {
      const id = tile.dataset.nodeId;
      if (!id) {
        return;
      }

      if (rectsIntersect(rect, tile.getBoundingClientRect())) {
        selected.add(id);
        primaryId = id;
      }
    });

    this.setDesktopSelection(selected, primaryId);
    this.applyDesktopSelectionToDom();
  }

  private applyDesktopSelectionToDom() {
    const selected = this.desktopSelectionForRender();
    this.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((tile) => {
      const id = tile.dataset.nodeId;
      tile.classList.toggle("is-selected", Boolean(id && selected.has(id)));
    });
  }

  private previewFolderChildPress(folderId: string, childId: string, item: HTMLElement) {
    this.closeContextMenu();
    this.clearDesktopSelection();
    this.renamingFolderChild = null;
    this.selectedFolderChild = { folderId, childId };
    this.folderLayer.querySelectorAll(".folder-item.is-selected").forEach((element) => {
      if (element !== item) {
        element.classList.remove("is-selected");
      }
    });
    item.classList.add("is-selected");
  }

  private onDesktopContextMenu(event: MouseEvent) {
    if (!this.isDesktopSurfaceEvent(event)) {
      return;
    }

    event.preventDefault();
    this.settingsOpen = false;
    this.clearContextOverlay();
    this.renderSettingsLayer();

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    if (tile?.dataset.nodeId) {
      const node = this.findNode(tile.dataset.nodeId);
      if (node?.type === "item") {
        this.selectSingleDesktopNode(node.id);
        this.contextMenu = null;
        this.render();
        void this.openNativeContextMenu(node, event.clientX, event.clientY, {
          type: "item",
          x: event.clientX,
          y: event.clientY,
          nodeId: node.id
        });
        return;
      }

      this.selectSingleDesktopNode(tile.dataset.nodeId);
      this.contextMenu = { type: "item", x: event.clientX, y: event.clientY, nodeId: tile.dataset.nodeId };
      this.render();
      return;
    }

    this.clearDesktopSelection();
    this.contextMenu = null;
    this.render();
    void this.openNativeDesktopContextMenu(event.clientX, event.clientY);
  }

  private onFolderPointerDown(event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("[data-folder-child-rename-id]")) {
      return;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const childId = item?.dataset.folderChildId;
    const folderId = item?.dataset.parentFolderId;
    const child = this.findFolder(folderId ?? "")?.children.find((node) => node.id === childId);
    if (item && child && folderId && childId) {
      this.previewFolderChildPress(folderId, childId, item);
      const rect = item.getBoundingClientRect();
      this.beginDrag({
        source: { type: "folder", folderId, childId },
        event,
        element: item,
        baseX: rect.left,
        baseY: rect.top,
        floating: false
      });
      return;
    }

    if (
      !(event.target as HTMLElement).closest("button, input, [data-folder-title]") &&
      (event.target as HTMLElement).closest(".folder-panel")
    ) {
      this.beginFolderSwipe(event);
    }
  }

  private beginFolderSwipe(event: PointerEvent, origin?: { startX: number; startY: number }) {
    const folder = this.getOpenFolder();
    if (!folder) {
      return;
    }

    const paging = this.folderPaging(folder);
    if (paging.pageCount <= 1) {
      return;
    }

    const viewport = this.folderLayer.querySelector<HTMLElement>(".folder-items-viewport");
    const width = viewport?.getBoundingClientRect().width ?? window.innerWidth;
    this.folderSwipe = {
      pointerId: event.pointerId,
      startX: origin?.startX ?? event.clientX,
      startY: origin?.startY ?? event.clientY,
      currentX: event.clientX,
      page: paging.page,
      pageCount: paging.pageCount,
      width: Math.max(1, width),
      started: false
    };

    try {
      this.folderLayer.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners below keep the swipe alive if capture is unavailable.
    }

    window.addEventListener("pointermove", this.onFolderSwipeMove);
    window.addEventListener("pointerup", this.onFolderSwipeEnd, { once: true });
    window.addEventListener("pointercancel", this.onFolderSwipeCancel, { once: true });
  }

  private promoteFolderDragToPageSwipe(drag: ActiveDrag, event: PointerEvent) {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);

    if (drag.frame !== null) {
      cancelAnimationFrame(drag.frame);
    }

    drag.element.classList.remove("is-selected");
    this.clearAllSelection();
    this.drag = null;
    this.beginFolderSwipe(event, { startX: drag.startX, startY: drag.startY });
    this.onFolderSwipeMove(event);
  }

  private readonly onFolderSwipeMove = (event: PointerEvent) => {
    const swipe = this.folderSwipe;
    if (!swipe || event.pointerId !== swipe.pointerId) {
      return;
    }

    swipe.currentX = event.clientX;
    const dx = swipe.currentX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (!swipe.started) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
        return;
      }

      if (Math.abs(dy) > Math.abs(dx) * 1.25) {
        this.cancelFolderSwipe();
        return;
      }

      swipe.started = true;
    }

    event.preventDefault();
    const blocked =
      (dx > 0 && swipe.page <= 0) || (dx < 0 && swipe.page >= swipe.pageCount - 1);
    const resisted = blocked ? dx * 0.28 : dx;
    const translate = clampScroll(resisted, -swipe.width * 0.36, swipe.width * 0.36);
    const panel = this.folderLayer.querySelector<HTMLElement>(".folder-panel");
    panel?.classList.add("is-page-dragging");
    panel?.style.setProperty("--folder-page-drag-x", `${translate}px`);
  };

  private readonly onFolderSwipeEnd = (event: PointerEvent) => {
    const swipe = this.folderSwipe;
    if (!swipe || event.pointerId !== swipe.pointerId) {
      return;
    }

    this.removeFolderSwipeListeners();
    this.folderSwipe = null;

    const dx = swipe.currentX - swipe.startX;
    const threshold = Math.min(120, Math.max(54, swipe.width * 0.18));
    if (swipe.started && dx <= -threshold) {
      this.setOpenFolderPage(swipe.page + 1, { dragX: dx, width: swipe.width });
      return;
    }

    if (swipe.started && dx >= threshold) {
      this.setOpenFolderPage(swipe.page - 1, { dragX: dx, width: swipe.width });
      return;
    }

    this.settleFolderPageDragStyle();
  };

  private readonly onFolderSwipeCancel = () => {
    this.cancelFolderSwipe();
  };

  private cancelFolderSwipe() {
    this.removeFolderSwipeListeners();
    this.folderSwipe = null;
    this.clearFolderPageDragStyle();
  }

  private removeFolderSwipeListeners() {
    window.removeEventListener("pointermove", this.onFolderSwipeMove);
    window.removeEventListener("pointerup", this.onFolderSwipeEnd);
    window.removeEventListener("pointercancel", this.onFolderSwipeCancel);
  }

  private clearFolderPageDragStyle() {
    const panel = this.folderLayer.querySelector<HTMLElement>(".folder-panel");
    panel?.classList.remove("is-page-dragging");
    panel?.style.removeProperty("--folder-page-drag-x");
  }

  private settleFolderPageDragStyle() {
    const panel = this.folderLayer.querySelector<HTMLElement>(".folder-panel");
    if (!panel) {
      return;
    }

    if (!panel.style.getPropertyValue("--folder-page-drag-x")) {
      panel.classList.remove("is-page-dragging");
      return;
    }

    requestAnimationFrame(() => {
      panel.classList.remove("is-page-dragging");
      panel.style.setProperty("--folder-page-drag-x", "0px");
      window.setTimeout(() => {
        panel.style.removeProperty("--folder-page-drag-x");
      }, 320);
    });
  }

  private onFolderContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.clearContextOverlay();

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const childId = item?.dataset.folderChildId;
    const folderId = item?.dataset.parentFolderId;
    const child = this.findFolderChild(folderId ?? "", childId ?? "");
    if (!item || !folderId || !childId || !child) {
      return;
    }

    this.settingsOpen = false;
    this.renderSettingsLayer();
    this.clearDesktopSelection();
    this.selectedFolderChild = { folderId, childId };
    this.renderFolderLayer();
    void this.openNativeContextMenu(child, event.clientX, event.clientY, {
      type: "folderItem",
      x: event.clientX,
      y: event.clientY,
      folderId,
      childId
    });
  }

  private beginDrag(options: {
    source: DragSource;
    event: PointerEvent;
    element: HTMLElement;
    baseX: number;
    baseY: number;
    floating: boolean;
    groupNodeIds?: string[];
  }) {
    try {
      (options.event.currentTarget as HTMLElement | null)?.setPointerCapture?.(options.event.pointerId);
    } catch {
      // Pointer capture is optional; window-level events keep dragging alive.
    }

    const rect = options.element.getBoundingClientRect();
    const groupItems =
      options.source.type === "desktop"
        ? this.captureDesktopDragGroup(options.groupNodeIds ?? [options.source.nodeId])
        : [];
    this.drag = {
      source: options.source,
      pointerId: options.event.pointerId,
      startX: options.event.clientX,
      startY: options.event.clientY,
      currentX: options.event.clientX,
      currentY: options.event.clientY,
      startScrollLeft: this.root.scrollLeft,
      startScrollTop: this.root.scrollTop,
      baseX: options.baseX,
      baseY: options.baseY,
      width: rect.width,
      height: rect.height,
      element: options.element,
      floating: options.floating,
      started: false,
      frame: null,
      targetId: null,
      targetRect: null,
      targetElement: null,
      targetSnapshots: [],
      groupItems,
      lastTransformStyle: "",
      lastPullX: 0,
      lastPullY: 0,
      committing: false
    };

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp, { once: true });
    window.addEventListener("pointercancel", this.onPointerCancel, { once: true });
    window.addEventListener("blur", this.onWindowBlur, { once: true });
  }

  private captureDesktopDragGroup(nodeIds: string[]) {
    const uniqueIds = Array.from(new Set(nodeIds));
    if (uniqueIds.length <= 1) {
      return [];
    }

    return uniqueIds
      .map((id): DragGroupItem | null => {
        const element = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
        const slot = this.layout.get(id);
        if (!element || !slot) {
          return null;
        }

        return {
          id,
          element,
          baseX: slot.x,
          baseY: slot.y,
          width: slot.width,
          height: slot.height
        };
      })
      .filter((item): item is DragGroupItem => Boolean(item));
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId || drag.committing) {
      return;
    }

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;

    if (!drag.started) {
      const dx = drag.currentX - drag.startX;
      const dy = drag.currentY - drag.startY;
      const moved = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
      if (moved < 4) {
        return;
      }

      if (drag.source.type === "folder" && Math.abs(dx) >= 10 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        const sourceFolder = this.findFolder(drag.source.folderId);
        if (sourceFolder && this.folderPaging(sourceFolder).pageCount > 1) {
          event.preventDefault();
          this.promoteFolderDragToPageSwipe(drag, event);
          return;
        }
      }

      event.preventDefault();
      if (drag.source.type === "folder" && !drag.floating) {
        this.promoteFolderDrag(drag);
      }
      drag.started = true;
      this.root.classList.add("is-drag-active");
      drag.targetSnapshots = this.captureMergeTargets(drag);
      if (this.isDesktopGroupDrag(drag)) {
        drag.groupItems.forEach((item) => item.element.classList.add("is-dragging"));
      } else {
        this.clearAllSelection();
        drag.element.classList.remove("is-selected");
        drag.element.classList.add("is-dragging");
      }
    }

    this.scheduleDragFrame();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId || drag.committing) {
      return;
    }

    if (drag.started && drag.targetId) {
      this.suppressNextClick = true;
      window.setTimeout(() => {
        this.suppressNextClick = false;
      }, 0);
      void this.commitMerge(drag.targetId);
      return;
    }

    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);

    if (drag.frame !== null) {
      cancelAnimationFrame(drag.frame);
    }

    if (!drag.started) {
      this.suppressNextClick = true;
      window.setTimeout(() => {
        this.suppressNextClick = false;
      }, 0);

      const source = drag.source;
      const element = drag.element;
      const floating = drag.floating;
      this.drag = null;
      this.clearTargetStyles();

      if (source.type === "desktop") {
        this.activateDesktopNode(source.nodeId, element);
      } else {
        void this.activateFolderChild(source.folderId, source.childId);
      }

      if (floating) {
        element.remove();
      }

      return;
    }

    const before = captureRects(this.grid);
    let changed = false;
    let focusAfterRender: string | null = null;
    this.suppressStoreRender = true;
    try {
      if (this.store.getSettings().layoutMode === "free" && drag.source.type === "desktop") {
        changed = this.commitFreeDesktopDrag(drag);
        focusAfterRender = drag.source.nodeId;
      } else if (this.isDesktopGroupDrag(drag)) {
        const groupIds = drag.groupItems.map((item) => item.id);
        this.setDesktopSelection(groupIds, drag.source.type === "desktop" ? drag.source.nodeId : groupIds[0]);
        focusAfterRender = this.selectedId;
        changed = this.store.moveDesktopNodes(groupIds, this.desktopInsertionIndex(drag.currentX, drag.currentY));
      } else if (drag.started && drag.source.type === "folder") {
        this.selectSingleDesktopNode(drag.source.childId);
        this.renamingFolderChild = null;
        focusAfterRender = drag.source.childId;
        if (this.store.getSettings().layoutMode === "free") {
          const viewport = desktopViewport();
          const position = this.clampedDesktopPosition(
            drag.currentX - viewport.offsetX - drag.width / 2,
            drag.currentY - viewport.offsetY - drag.height / 2,
            drag.width,
            drag.height,
            viewport
          );
          changed = this.store.moveFolderChildToDesktop(
            drag.source.folderId,
            drag.source.childId,
            this.store.getNodes().length,
            position
          );
        } else {
          changed = this.store.moveFolderChildToDesktop(
            drag.source.folderId,
            drag.source.childId,
            this.desktopInsertionIndex(drag.currentX, drag.currentY)
          );
        }
      } else if (drag.started && drag.source.type === "desktop") {
        this.selectSingleDesktopNode(drag.source.nodeId);
        changed = this.store.moveDesktopNode(
          drag.source.nodeId,
          this.desktopInsertionIndex(drag.currentX, drag.currentY)
        );
      }
    } finally {
      this.suppressStoreRender = false;
    }

    if (drag.started) {
      this.suppressNextClick = true;
      window.setTimeout(() => {
        this.suppressNextClick = false;
      }, 0);
    }

    this.clearDragVisualState(drag);
    if (drag.floating) {
      drag.element.remove();
    }

    this.drag = null;
    this.clearTargetStyles();
    if (drag.started && changed) {
      this.render();
      playFlip(this.grid, before);
      if (focusAfterRender) {
        this.focusDesktopNode(focusAfterRender);
      }
    } else if (drag.started) {
      this.renderWithFlip();
    }
  };

  private readonly onPointerCancel = () => {
    this.cancelDrag();
  };

  private readonly onWindowBlur = () => {
    this.cancelDrag();
  };

  private scheduleDragFrame() {
    const drag = this.drag;
    if (!drag || drag.frame !== null) {
      return;
    }

    drag.frame = requestAnimationFrame(() => {
      if (!this.drag) {
        return;
      }

      const active = this.drag;
      active.frame = null;
      const didAutoScroll = this.autoScrollDrag(active);
      if (didAutoScroll) {
        active.targetSnapshots = this.captureMergeTargets(active);
        active.targetRect = null;
      }

      if (this.isDesktopGroupDrag(active)) {
        this.updateDesktopGroupDragFrame(active);
        this.updateMergeTarget(active.currentX, active.currentY);
        if (didAutoScroll && this.drag === active) {
          this.scheduleDragFrame();
        }
        return;
      }

      this.updateMergeTarget(active.currentX, active.currentY);
      const magneticTarget = active.targetId && active.targetRect ? active.targetRect : null;
      const transform = dragFrameTransform({
        currentX: active.currentX,
        currentY: active.currentY,
        startX: active.startX,
        startY: active.startY,
        baseX: active.baseX,
        baseY: active.baseY,
        sourceLayoutOffsetX: active.floating ? 0 : this.root.scrollLeft - active.startScrollLeft,
        sourceLayoutOffsetY: active.floating ? 0 : this.root.scrollTop - active.startScrollTop,
        width: active.width,
        height: active.height,
        targetRect: magneticTarget,
        targetLayoutOffsetX: active.floating ? 0 : this.root.scrollLeft,
        targetLayoutOffsetY: active.floating ? 0 : this.root.scrollTop
      });

      if (magneticTarget && active.targetElement) {
        this.writeMergePull(active, transform.targetPullX, transform.targetPullY);
      }
      this.writeDragTransform(active, toTransformStyle(transform));

      if (didAutoScroll && this.drag === active) {
        this.scheduleDragFrame();
      }
    });
  }

  private updateDesktopGroupDragFrame(drag: ActiveDrag) {
    let dx = drag.currentX - drag.startX;
    let dy = drag.currentY - drag.startY;
    const offsetX = this.root.scrollLeft - drag.startScrollLeft;
    const offsetY = this.root.scrollTop - drag.startScrollTop;
    const viewport = desktopViewport();
    const minX = Math.min(...drag.groupItems.map((item) => item.baseX - viewport.offsetX));
    const minY = Math.min(...drag.groupItems.map((item) => item.baseY - viewport.offsetY));
    const maxX = Math.max(...drag.groupItems.map((item) => item.baseX - viewport.offsetX + item.width));
    const maxY = Math.max(...drag.groupItems.map((item) => item.baseY - viewport.offsetY + item.height));
    const metrics = desktopTileMetrics(this.store.getSettings());
    dx = clampScroll(dx + offsetX, metrics.paddingX - minX, viewport.width - metrics.paddingX - maxX) - offsetX;
    dy = clampScroll(dy + offsetY, metrics.paddingY - minY, viewport.height - metrics.paddingY - maxY) - offsetY;

    drag.groupItems.forEach((item) => {
      this.writeGroupDragTransform(item, toTransformStyle({
        x: item.baseX + dx + offsetX,
        y: item.baseY + dy + offsetY,
        scale: 1.025
      }));
    });
  }

  private autoScrollDrag(drag: ActiveDrag) {
    const delta = dragAutoScrollDelta(
      drag.currentX,
      drag.currentY,
      window.innerWidth,
      window.innerHeight
    );

    if (delta.x === 0 && delta.y === 0) {
      return false;
    }

    const beforeLeft = this.root.scrollLeft;
    const beforeTop = this.root.scrollTop;
    this.root.scrollLeft = clampScroll(beforeLeft + delta.x, 0, this.root.scrollWidth - this.root.clientWidth);
    this.root.scrollTop = clampScroll(beforeTop + delta.y, 0, this.root.scrollHeight - this.root.clientHeight);

    return this.root.scrollLeft !== beforeLeft || this.root.scrollTop !== beforeTop;
  }

  private isDesktopGroupDrag(drag: ActiveDrag) {
    return drag.source.type === "desktop" && drag.groupItems.length > 1;
  }

  private commitFreeDesktopDrag(drag: ActiveDrag) {
    let dx = drag.currentX - drag.startX + this.root.scrollLeft - drag.startScrollLeft;
    let dy = drag.currentY - drag.startY + this.root.scrollTop - drag.startScrollTop;
    const viewport = desktopViewport();
    const movedItems =
      this.isDesktopGroupDrag(drag)
        ? drag.groupItems
        : [{
            id: drag.source.type === "desktop" ? drag.source.nodeId : "",
            baseX: drag.baseX,
            baseY: drag.baseY,
            width: drag.width,
            height: drag.height
          }];

    if (movedItems.length > 1) {
      const minX = Math.min(...movedItems.map((item) => item.baseX - viewport.offsetX));
      const minY = Math.min(...movedItems.map((item) => item.baseY - viewport.offsetY));
      const maxX = Math.max(...movedItems.map((item) => item.baseX - viewport.offsetX + item.width));
      const maxY = Math.max(...movedItems.map((item) => item.baseY - viewport.offsetY + item.height));
      const metrics = desktopTileMetrics(this.store.getSettings());
      dx = clampScroll(dx, metrics.paddingX - minX, viewport.width - metrics.paddingX - maxX);
      dy = clampScroll(dy, metrics.paddingY - minY, viewport.height - metrics.paddingY - maxY);
    }

    const positions = movedItems.length > 1
      ? this.resolveFreeGroupPositions(movedItems, dx, dy)
      : movedItems
          .filter((item) => item.id)
          .map((item) => ({
            id: item.id,
            position: this.findOpenDesktopPosition(
              {
                x: item.baseX + dx - viewport.offsetX,
                y: item.baseY + dy - viewport.offsetY
              },
              item.width,
              item.height,
              new Set([item.id])
            )
          }));

    if (positions.length === 0) {
      return false;
    }

    return this.store.updateNodePositions(positions);
  }

  private clampedDesktopPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    viewport = desktopViewport()
  ): DesktopPosition {
    const metrics = desktopTileMetrics(this.store.getSettings());
    const maxAvailableX = Math.max(0, viewport.width - width);
    const maxAvailableY = Math.max(0, viewport.height - height);
    const minX = Math.min(metrics.paddingX, maxAvailableX);
    const minY = Math.min(metrics.paddingY, maxAvailableY);
    const maxX = Math.max(minX, maxAvailableX - metrics.paddingX);
    const maxY = Math.max(minY, maxAvailableY - metrics.paddingY);

    return {
      x: Math.round(clampScroll(x, minX, maxX)),
      y: Math.round(clampScroll(y, minY, maxY))
    };
  }

  private resolveFreeGroupPositions(
    movedItems: Array<Pick<DragGroupItem, "id" | "baseX" | "baseY" | "width" | "height">>,
    dx: number,
    dy: number
  ) {
    const viewport = desktopViewport();
    const movingIds = new Set(movedItems.map((item) => item.id));
    const occupied = this.desktopOccupiedRects(movingIds);
    const groupLeft = Math.min(...movedItems.map((item) => item.baseX - viewport.offsetX));
    const groupTop = Math.min(...movedItems.map((item) => item.baseY - viewport.offsetY));
    const groupRight = Math.max(...movedItems.map((item) => item.baseX - viewport.offsetX + item.width));
    const groupBottom = Math.max(...movedItems.map((item) => item.baseY - viewport.offsetY + item.height));
    const groupWidth = groupRight - groupLeft;
    const groupHeight = groupBottom - groupTop;
    const preferred = this.snapDesktopPosition(groupLeft + dx, groupTop + dy, groupWidth, groupHeight, viewport);
    const candidates = this.nearbySnapCandidates(preferred, groupWidth, groupHeight, viewport);

    for (const candidate of candidates) {
      const rects = movedItems.map((item) => ({
        id: item.id,
        x: candidate.x + (item.baseX - viewport.offsetX - groupLeft),
        y: candidate.y + (item.baseY - viewport.offsetY - groupTop),
        width: item.width,
        height: item.height
      }));

      if (!rects.some((rect) => occupied.some((occupiedRect) => rectsOverlapWithMargin(rect, occupiedRect, 8)))) {
        return rects.map((rect) => ({
          id: rect.id,
          position: { x: Math.round(rect.x), y: Math.round(rect.y) }
        }));
      }
    }

    return movedItems.map((item) => ({
      id: item.id,
      position: this.clampedDesktopPosition(
        item.baseX + dx - viewport.offsetX,
        item.baseY + dy - viewport.offsetY,
        item.width,
        item.height,
        viewport
      )
    }));
  }

  private snapDesktopPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    viewport = desktopViewport()
  ): DesktopPosition {
    const step = this.desktopSnapStep();
    return this.clampedDesktopPosition(
      Math.round(x / step) * step,
      Math.round(y / step) * step,
      width,
      height,
      viewport
    );
  }

  private nearbySnapCandidates(
    preferred: DesktopPosition,
    width: number,
    height: number,
    viewport = desktopViewport()
  ) {
    const step = this.desktopSnapStep();
    const candidates: DesktopPosition[] = [preferred];
    const seen = new Set([`${preferred.x}:${preferred.y}`]);

    for (let radius = 1; radius <= 48; radius += 1) {
      for (let row = -radius; row <= radius; row += 1) {
        for (let column = -radius; column <= radius; column += 1) {
          if (Math.abs(row) !== radius && Math.abs(column) !== radius) {
            continue;
          }

          const candidate = this.clampedDesktopPosition(
            preferred.x + column * step,
            preferred.y + row * step,
            width,
            height,
            viewport
          );
          const key = `${candidate.x}:${candidate.y}`;
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push(candidate);
          }
        }
      }
    }

    return candidates.sort(
      (a, b) =>
        Math.hypot(a.x - preferred.x, a.y - preferred.y) -
        Math.hypot(b.x - preferred.x, b.y - preferred.y)
    );
  }

  private desktopSnapStep() {
    const metrics = desktopTileMetrics(this.store.getSettings());
    return Math.max(6, Math.round(Math.min(metrics.width, metrics.height) / 10));
  }

  private freeFolderChildPositions(folder: FolderNode) {
    if (this.store.getSettings().layoutMode !== "free") {
      return undefined;
    }

    const slot = this.layout.get(folder.id);
    if (!slot) {
      return undefined;
    }

    const viewport = desktopViewport();
    const metrics = desktopTileMetrics(this.store.getSettings());
    const excludeIds = new Set([folder.id, ...folder.children.map((child) => child.id)]);
    const assigned: Array<{ x: number; y: number; width: number; height: number }> = [];
    const startX = slot.x - viewport.offsetX;
    const startY = slot.y - viewport.offsetY;

    return folder.children.map((child, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const position = this.findOpenDesktopPosition(
        {
          x: startX + column * (metrics.width + metrics.gapX),
          y: startY + row * (metrics.height + metrics.gapY)
        },
        metrics.width,
        metrics.height,
        excludeIds,
        assigned
      );
      assigned.push({ ...position, width: metrics.width, height: metrics.height });
      return { id: child.id, position };
    });
  }

  private freeFolderChildPosition(folder: FolderNode, childId: string) {
    if (this.store.getSettings().layoutMode !== "free") {
      return null;
    }

    const slot = this.layout.get(folder.id);
    if (!slot) {
      return null;
    }

    const viewport = desktopViewport();
    const metrics = desktopTileMetrics(this.store.getSettings());
    return this.findOpenDesktopPosition(
      {
        x: slot.x - viewport.offsetX + slot.width + metrics.gapX,
        y: slot.y - viewport.offsetY
      },
      metrics.width,
      metrics.height,
      new Set([childId])
    );
  }

  private findOpenDesktopPosition(
    preferred: { x: number; y: number },
    width: number,
    height: number,
    excludeIds: ReadonlySet<string>,
    extraOccupied: Array<{ x: number; y: number; width: number; height: number }> = []
  ): DesktopPosition {
    const viewport = desktopViewport();
    const occupied = [...this.desktopOccupiedRects(excludeIds), ...extraOccupied];
    const snapped = this.snapDesktopPosition(preferred.x, preferred.y, width, height, viewport);
    const candidates = this.nearbySnapCandidates(snapped, width, height, viewport);

    for (const candidate of candidates) {
      const rect = { ...candidate, width, height };
      if (!occupied.some((occupiedRect) => rectsOverlapWithMargin(rect, occupiedRect, 8))) {
        return candidate;
      }
    }

    return snapped;
  }

  private desktopOccupiedRects(excludeIds: ReadonlySet<string>) {
    const viewport = desktopViewport();
    return this.store.getNodes()
      .filter((node) => !excludeIds.has(node.id))
      .map((node) => this.layout.get(node.id))
      .filter((slot): slot is LayoutSlot => Boolean(slot))
      .map((slot) => ({
        x: slot.x - viewport.offsetX,
        y: slot.y - viewport.offsetY,
        width: slot.width,
        height: slot.height
      }));
  }

  private promoteFolderDrag(drag: ActiveDrag) {
    if (drag.source.type !== "folder") {
      return;
    }

    const child = this.findFolderChild(drag.source.folderId, drag.source.childId);
    if (!child) {
      return;
    }

    const rect = drag.element.getBoundingClientRect();
    const floating = document.createElement("div");
    floating.className = "floating-drag";
    floating.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1)`;
    floating.append(renderIcon(child));
    const label = document.createElement("span");
    label.className = "tile-name";
    label.textContent = child.name;
    floating.append(label);
    document.body.append(floating);

    drag.element = floating;
    drag.baseX = rect.left;
    drag.baseY = rect.top;
    drag.width = floating.offsetWidth || rect.width;
    drag.height = floating.offsetHeight || rect.height;
    drag.floating = true;
    void this.closeFolder();
  }

  private updateMergeTarget(x: number, y: number) {
    const drag = this.drag;
    if (!drag) {
      return;
    }

    if (drag.targetRect && pointInMergeRect(x, y, drag.targetRect)) {
      return;
    }

    const hit = this.hitTestMergeTarget(x, y, drag.targetSnapshots);

    if (!hit) {
      this.setMergeTarget(null);
      return;
    }

    this.setMergeTarget(hit.id, hit.rect);
  }

  private captureMergeTargets(drag: ActiveDrag): DragTargetSnapshot[] {
    const sourceIds = this.desktopDragSourceIds(drag);
    const nodes = this.store.getNodes();
    const source =
      drag.source.type === "desktop"
        ? sourceIds.map((id) => this.findNode(id))
        : [this.findFolderChild(drag.source.folderId, drag.source.childId)];
    if (source.some((node) => !node || node.type === "folder")) {
      return [];
    }

    const excludedIds = new Set(sourceIds);
    if (drag.source.type === "folder") {
      excludedIds.add(drag.source.folderId);
    }

    const targetIds = new Set(
      nodes
        .filter((node) => !excludedIds.has(node.id) && (node.type === "item" || node.type === "folder"))
        .map((node) => node.id)
    );
    const snapshots: DragTargetSnapshot[] = [];
    this.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
      const id = element.dataset.nodeId;
      if (!id) {
        return;
      }

      if (!targetIds.has(id)) {
        return;
      }

      snapshots.push({
        id,
        rect: element.getBoundingClientRect()
      });
    });

    return snapshots;
  }

  private desktopDragSourceIds(drag: ActiveDrag) {
    if (drag.source.type !== "desktop") {
      return [];
    }

    return this.isDesktopGroupDrag(drag)
      ? drag.groupItems.map((item) => item.id)
      : [drag.source.nodeId];
  }

  private hitTestMergeTarget(x: number, y: number, snapshots: DragTargetSnapshot[]) {
    let best: DragTargetSnapshot | null = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    for (const snapshot of snapshots) {
      const rect = snapshot.rect;
      const slopX = Math.min(12, rect.width * 0.08);
      const slopY = Math.min(12, rect.height * 0.08);
      const left = rect.left - slopX;
      const right = rect.right + slopX;
      const top = rect.top - slopY;
      const bottom = rect.bottom + slopY;

      if (x < left || x > right || y < top || y > bottom) {
        continue;
      }

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distanceSquared = (x - centerX) ** 2 + (y - centerY) ** 2;
      if (distanceSquared < bestDistanceSquared) {
        best = snapshot;
        bestDistanceSquared = distanceSquared;
      }
    }

    return best;
  }

  private setMergeTarget(targetId: string | null, targetRect: DOMRect | null = null) {
    const drag = this.drag;
    if (!drag) {
      return;
    }

    if (drag.targetId === targetId) {
      if (targetRect) {
        drag.targetRect = targetRect;
      }
      return;
    }

    this.clearTargetStyles();
    drag.targetId = targetId;
    drag.targetRect = null;
    drag.targetElement = null;

    if (!targetId) {
      return;
    }

    const target = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(targetId)}"]`);
    target?.classList.add("is-merge-target");
    drag.lastPullX = 0;
    drag.lastPullY = 0;
    target?.style.setProperty("--merge-pull-x", "0px");
    target?.style.setProperty("--merge-pull-y", "0px");
    drag.targetRect = targetRect ?? target?.getBoundingClientRect() ?? null;
    drag.targetElement = target ?? null;
  }

  private writeMergePull(drag: ActiveDrag, x: number, y: number) {
    if (!drag.targetElement) {
      return;
    }

    if (Math.abs(x - drag.lastPullX) < 0.2 && Math.abs(y - drag.lastPullY) < 0.2) {
      return;
    }

    drag.lastPullX = x;
    drag.lastPullY = y;
    drag.targetElement.style.setProperty("--merge-pull-x", `${roundFrameValue(x)}px`);
    drag.targetElement.style.setProperty("--merge-pull-y", `${roundFrameValue(y)}px`);
  }

  private writeDragTransform(drag: ActiveDrag, transform: string) {
    if (drag.lastTransformStyle === transform) {
      return;
    }

    drag.lastTransformStyle = transform;
    drag.element.style.transform = transform;
  }

  private writeGroupDragTransform(item: DragGroupItem, transform: string) {
    if (item.lastTransformStyle === transform) {
      return;
    }

    item.lastTransformStyle = transform;
    item.element.style.transform = transform;
  }

  private async commitMerge(targetId: string) {
    const drag = this.drag;
    if (!drag || drag.committing) {
      return;
    }

    const target = this.findNode(targetId);
    const targetElement = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(targetId)}"]`);
    let changed = false;
    let newFolderId: string | null = null;

    drag.committing = true;
    if (drag.frame !== null) {
      cancelAnimationFrame(drag.frame);
      drag.frame = null;
    }
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);

    const before = captureRects(this.grid);
    const targetRect = drag.targetRect ?? targetElement?.getBoundingClientRect() ?? null;
    const mergeSources = this.isDesktopGroupDrag(drag)
      ? drag.groupItems.map((item) => item.element)
      : [drag.element];
    const mergeAnimation = targetElement
      ? (mergeSources.length > 1
          ? playMergeGroupIntoTarget(mergeSources, targetElement, { restoreOriginals: false })
          : playMergeIntoTarget(drag.element, targetElement, { restoreOriginals: false })
        ).catch((error) => {
          console.warn("Unable to play merge animation", error);
        })
      : Promise.resolve();
    if (targetElement) {
      this.clearMergeTargetElement(targetElement);
    }

    await mergeAnimation;

    this.suppressStoreRender = true;
    try {
      if (drag.source.type === "desktop") {
        const sourceIds = this.desktopDragSourceIds(drag);
        if (target?.type === "folder") {
          changed = this.store.addDesktopItemsToFolder(sourceIds, target.id);
        } else if (target?.type === "item") {
          const result = this.store.createFolderFromItems(sourceIds, target.id);
          changed = result.changed;
          newFolderId = result.folderId;
        }
      } else if (target?.type === "folder") {
        changed = this.store.addFolderChildToFolder(drag.source.folderId, drag.source.childId, target.id);
      } else if (target?.type === "item") {
        const result = this.store.createFolderFromChild(drag.source.folderId, drag.source.childId, target.id);
        changed = result.changed;
        newFolderId = result.folderId;
      }
    } finally {
      this.suppressStoreRender = false;
    }

    this.clearDragVisualState(drag);
    if (drag.floating) {
      drag.element.remove();
    }

    this.drag = null;
    this.clearTargetStyles();
    if (changed) {
      const revealedTargetId = newFolderId ?? (target?.type === "folder" ? target.id : null);
      this.render();
      const skipFlipIds = revealedTargetId ? new Set([revealedTargetId]) : undefined;
      playFlip(this.grid, before, {
        skipIds: skipFlipIds,
        skipNewIds: skipFlipIds
      });
      if (revealedTargetId && targetRect) {
        this.playFolderBirthById(revealedTargetId, targetRect);
      }
    } else {
      this.renderWithFlip();
    }

  }

  private playFolderBirthById(folderId: string, originRect: DOMRect) {
    const folderElement = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(folderId)}"]`);
    if (folderElement) {
      playFolderBirth(folderElement, originRect);
    }
  }

  private cancelDrag() {
    const drag = this.drag;
    if (!drag) {
      return;
    }

    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);

    if (drag.frame !== null) {
      cancelAnimationFrame(drag.frame);
    }

    this.clearDragVisualState(drag);
    if (drag.floating) {
      drag.element.remove();
    }

    this.drag = null;
    this.clearTargetStyles();
    if (drag.started) {
      this.renderWithFlip();
    }
  }

  private clearDragVisualState(drag: ActiveDrag) {
    this.root.classList.remove("is-drag-active");

    if (this.isDesktopGroupDrag(drag)) {
      drag.groupItems.forEach((item) => {
        item.element.classList.remove("is-dragging");
        item.element.style.transform = "";
      });
      return;
    }

    drag.element.classList.remove("is-dragging");
    drag.element.style.transform = "";
  }

  private clearTargetStyles() {
    this.grid.querySelectorAll<HTMLElement>(".is-merge-target").forEach((node) => {
      this.clearMergeTargetElement(node);
    });
  }

  private clearMergeTargetElement(node: HTMLElement) {
    node.classList.remove("is-merge-target");
    node.style.removeProperty("--merge-pull-x");
    node.style.removeProperty("--merge-pull-y");
  }

  private onFolderLayerClick(event: MouseEvent) {
    if (this.consumeSuppressedClick()) {
      return;
    }

    const pageButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-folder-page-index]");
    if (pageButton) {
      event.preventDefault();
      event.stopPropagation();
      const page = Number(pageButton.dataset.folderPageIndex);
      if (Number.isFinite(page)) {
        this.setOpenFolderPage(page);
      }
      return;
    }

    if ((event.target as HTMLElement).classList.contains("folder-backdrop")) {
      void this.closeFolder();
    }
  }

  private onFolderLayerDoubleClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest("[data-folder-child-rename-id]")) {
      return;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    if (item) {
      event.preventDefault();
      event.stopPropagation();

      const child = this.findFolderChild(item.dataset.parentFolderId ?? "", item.dataset.folderChildId ?? "");
      if (child) {
        void this.openItem(child);
      }
      return;
    }

    const title = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-title]");
    if (!title) {
      return;
    }

    this.editingFolder = true;
    this.renderFolderLayer();
  }

  private onSettingsClick(event: MouseEvent) {
    const close = (event.target as HTMLElement).closest("[data-settings-close]");
    const reset = (event.target as HTMLElement).closest("[data-settings-reset]");
    const viewButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-settings-view]");
    const stepButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-step]");
    const layoutModeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-layout-mode]");

    if (reset) {
      this.cancelSettingsPreview();
      this.store.updateSettings(defaultDesktopSettings);
      void this.applyAppPrioritySetting(defaultDesktopSettings.appPriority);
      return;
    }

    if (viewButton?.dataset.settingsView === "main" || viewButton?.dataset.settingsView === "layout") {
      this.cancelSettingsPreview();
      this.settingsView = viewButton.dataset.settingsView;
      this.renderSettingsLayer();
      return;
    }

    if (layoutModeButton?.dataset.settingLayoutMode === "auto" || layoutModeButton?.dataset.settingLayoutMode === "free") {
      this.cancelSettingsPreview();
      this.switchDesktopLayoutMode(layoutModeButton.dataset.settingLayoutMode);
      return;
    }

    if (stepButton) {
      const key = stepButton.dataset.settingKey;
      const step = Number(stepButton.dataset.settingStep);
      const min = Number(stepButton.dataset.settingMin);
      const max = Number(stepButton.dataset.settingMax);
      const current = this.getSettingsValueSource();
      if (key && isDesktopSettingKey(key) && Number.isFinite(step) && Number.isFinite(min) && Number.isFinite(max)) {
        const value = Math.min(max, Math.max(min, current[key] + step));
        this.commitSettingValue(key, value);
      }
      return;
    }

    if (!close) {
      return;
    }

    this.cancelSettingsPreview();
    this.settingsOpen = false;
    this.settingsView = "main";
    this.renderSettingsLayer();
  }

  private onSettingsInput(event: Event) {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-setting-range]");
    if (!input) {
      return;
    }

    this.updateSettingControlVisual(input);
    this.previewSettingInput(input);
  }

  private onSettingsChange(event: Event) {
    const prioritySelect = (event.target as HTMLElement).closest<HTMLSelectElement>("[data-setting-app-priority]");
    if (prioritySelect) {
      const appPriority = prioritySelect.value;
      if (isAppProcessPriority(appPriority)) {
        this.cancelSettingsPreview();
        this.store.updateSettings({ appPriority });
        void this.applyAppPrioritySetting(appPriority);
      }
      return;
    }

    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-setting-range]");
    const key = input?.dataset.settingRange;
    if (!input || !key || !(key in this.getSettingsValueSource())) {
      return;
    }

    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }

    this.commitSettingValue(key, Math.min(max, Math.max(min, Math.round(value))));
  }

  private updateSettingControlVisual(input: HTMLInputElement) {
    const key = input.dataset.settingRange;
    const unit = input.dataset.settingUnit ?? "";
    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    if (!key || !Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }

    input.style.setProperty("--setting-progress", `${((value - min) / (max - min)) * 100}%`);
    const row = input.closest(".settings-row");
    const output = row?.querySelector<HTMLOutputElement>(`[data-setting-value="${CSS.escape(key)}"]`);
    if (output) {
      output.textContent = `${Math.round(value)}${unit}`;
    }
  }

  private previewSettingInput(input: HTMLInputElement) {
    const key = input.dataset.settingRange;
    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    const current = this.getSettingsValueSource();
    if (!key || !(key in current) || !Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }

    const next = Math.min(max, Math.max(min, Math.round(value)));

    if (isDesktopSettingKey(key)) {
      const settings = { ...this.store.getSettings(), [key]: next };
      this.scheduleSettingsPreview(() => this.previewDesktopSettings(settings));
    }
  }

  private scheduleSettingsPreview(preview: () => void) {
    this.pendingSettingsPreview = preview;
    if (this.settingsPreviewFrame !== null) {
      return;
    }

    this.settingsPreviewFrame = requestAnimationFrame(() => {
      this.settingsPreviewFrame = null;
      const nextPreview = this.pendingSettingsPreview;
      this.pendingSettingsPreview = null;
      nextPreview?.();
    });
  }

  private cancelSettingsPreview() {
    if (this.settingsPreviewFrame !== null) {
      cancelAnimationFrame(this.settingsPreviewFrame);
      this.settingsPreviewFrame = null;
    }

    this.pendingSettingsPreview = null;
  }

  private previewDesktopSettings(settings: DesktopSettings) {
    const nodes = this.store.getNodes();
    const viewport = desktopViewport();
    const fitted = this.effectiveDesktopSettings(settings, nodes, viewport);
    applyDesktopSettings(fitted);
    this.layout = computeDesktopLayout(
      nodes,
      viewport.width,
      viewport.height,
      fitted,
      viewport.offsetX,
      viewport.offsetY
    );

    for (const node of nodes) {
      const slot = this.layout.get(node.id);
      const tile = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
      if (!slot || !tile) {
        continue;
      }

      tile.style.width = `${slot.width}px`;
      tile.style.height = `${slot.height}px`;
      tile.style.transform = `translate3d(${slot.x}px, ${slot.y}px, 0)`;

      if (node.type === "folder") {
        applyFolderTileShellStyle(tile, node, fitted);
        this.replaceTileIcon(tile, renderFolderCover(node, fitted));
      }
    }

    this.renderFolderLayer(fitted);
  }

  private switchDesktopLayoutMode(layoutMode: DesktopSettings["layoutMode"]) {
    const previousSuppress = this.suppressStoreRender;
    this.suppressStoreRender = true;

    try {
      if (layoutMode === "free") {
        this.seedFreeLayoutPositions();
      }
      this.store.updateSettings({ layoutMode });
    } finally {
      this.suppressStoreRender = previousSuppress;
    }

    this.renderWithFlip();
  }

  private async applyAppPrioritySetting(priority: AppProcessPriority) {
    await setAppProcessPriority(priority);
  }

  private seedFreeLayoutPositions() {
    const viewport = desktopViewport();
    const positions = this.store.getNodes()
      .map((node) => {
        if (node.position) {
          return null;
        }

        const slot = this.layout.get(node.id);
        if (!slot) {
          return null;
        }

        return {
          id: node.id,
          position: this.clampedDesktopPosition(
            slot.x - viewport.offsetX,
            slot.y - viewport.offsetY,
            slot.width,
            slot.height,
            viewport
          )
        };
      })
      .filter((entry): entry is { id: string; position: DesktopPosition } => Boolean(entry));

    this.store.updateNodePositions(positions);
  }

  private getSettingsValueSource(): DesktopSettings {
    return this.store.getSettings();
  }

  private effectiveDesktopSettings(
    settings: DesktopSettings,
    nodes: DesktopNode[],
    viewport = desktopViewport()
  ): DesktopSettings {
    return settings.layoutMode === "free"
      ? settings
      : fitDesktopSettings(settings, nodes, viewport.width, viewport.height);
  }

  private commitSettingValue(key: string, value: number, render = true) {
    this.cancelSettingsPreview();
    const previousSuppress = this.suppressStoreRender;
    this.suppressStoreRender = !render || previousSuppress;

    try {
      if (isDesktopSettingKey(key)) {
        this.store.updateSettings({ [key]: value });
      }
    } finally {
      this.suppressStoreRender = previousSuppress;
    }
  }

  private replaceTileIcon(tile: HTMLElement, icon: HTMLElement) {
    const currentIcon = Array.from(tile.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("icon-shell")
    );
    currentIcon?.replaceWith(icon);
  }

  private async onContextMenuClick(event: MouseEvent) {
    const submenuButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-context-submenu]");
    if (submenuButton) {
      const item = submenuButton.closest<HTMLElement>(".context-menu-item");
      this.contextMenuLayer.querySelectorAll(".context-menu-item.is-submenu-open").forEach((element) => {
        if (element !== item) {
          element.classList.remove("is-submenu-open");
        }
      });
      item?.classList.toggle("is-submenu-open");
      return;
    }

    const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-context-action]")?.dataset
      .contextAction as DesktopContextMenuAction | undefined;
    if (!action || !this.contextMenu) {
      return;
    }

    const menu = this.contextMenu;
    this.closeContextMenu();

    try {
      if (action === "refresh") {
        await this.refreshDesktopItems();
        return;
      }

      if (action === "paste") {
        await pasteDesktopItems();
        await this.refreshDesktopItems();
        return;
      }

      if (action === "newFolder") {
        await createDesktopFolder();
        await this.refreshDesktopItems();
        return;
      }

      if (menu.type === "desktop") {
        return;
      }

      const node = this.contextMenuTargetNode(menu);
      if (!node) {
        return;
      }

      if (action === "folderRatio") {
        if (node.type === "folder") {
          this.showRatioDialog(node, menu.x, menu.y);
        }
      } else if (action === "folderIconSmall") {
        if (node.type === "folder") {
          this.store.updateFolderAppearance(node.id, { folderCoverSize: "small" });
        }
      } else if (action === "folderIconMedium") {
        if (node.type === "folder") {
          this.store.updateFolderAppearance(node.id, { folderCoverSize: "medium" });
        }
      } else if (action === "folderIconLarge") {
        if (node.type === "folder") {
          this.store.updateFolderAppearance(node.id, { folderCoverSize: "large" });
        }
      } else if (action === "open") {
        if (node.type === "item") {
          await this.openItem(node);
        } else {
          this.openFolderFromNode(node);
        }
      } else if (action === "rename") {
        if (menu.type !== "folderItem") {
          this.startRename(node.id);
        }
      } else if (action === "delete") {
        if (menu.type === "folderItem" && node.type === "item") {
          this.moveFolderChildOut(menu.folderId, node.id);
          return;
        }

        await this.deleteNode(node);
      } else if (action === "properties" && node.type === "item") {
        await showDesktopItemProperties(node);
      } else if (action === "copy" && node.type === "item") {
        await copyDesktopItem(node);
      }
    } catch (error) {
      console.warn("Desktop context menu action failed", action, error);
    }
  }

  private showRatioDialog(folder: FolderNode, x: number, y: number) {
    this.beginContextOverlayRequest();
    this.ratioDialogTargetId = folder.id;
    const appearance = normalizeFolderAppearance(folder.appearance);
    this.contextMenuLayer.classList.add("is-open");
    this.contextMenuLayer.replaceChildren(
      renderRatioDialog({
        x,
        y,
        columns: appearance.folderPanelColumns,
        rows: appearance.folderPanelRows
      })
    );
    requestAnimationFrame(() => {
      this.contextMenuLayer.querySelector<HTMLInputElement>("[data-ratio-rows]")?.focus();
    });
  }

  private closeRatioDialog() {
    if (!this.ratioDialogTargetId) {
      return;
    }

    this.invalidateContextOverlay();
    this.ratioDialogTargetId = null;
    this.contextMenuLayer.classList.remove("is-open");
    this.contextMenuLayer.replaceChildren();
  }

  private onRatioDialogConfirm() {
    if (!this.ratioDialogTargetId) {
      return;
    }

    const colInput = this.contextMenuLayer.querySelector<HTMLInputElement>("[data-ratio-columns]");
    const rowInput = this.contextMenuLayer.querySelector<HTMLInputElement>("[data-ratio-rows]");
    if (!colInput || !rowInput) {
      this.closeRatioDialog();
      return;
    }

    const folderId = this.ratioDialogTargetId;
    const columns = Math.max(folderRatioMin, Math.min(folderRatioMax, Math.round(Number(colInput.value) || 3)));
    const rows = Math.max(folderRatioMin, Math.min(folderRatioMax, Math.round(Number(rowInput.value) || 3)));
    this.closeRatioDialog();
    this.store.updateFolderAppearance(folderId, {
      folderPanelColumns: columns,
      folderPanelRows: rows
    });
  }

  private onRatioDialogClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("[data-ratio-confirm]")) {
      this.onRatioDialogConfirm();
      return;
    }

    if (target.closest("[data-ratio-cancel]")) {
      this.closeRatioDialog();
      return;
    }
  }

  private onContextOverlayKeyDown(event: KeyboardEvent) {
    if (!this.ratioDialogTargetId) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      this.onRatioDialogConfirm();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this.closeRatioDialog();
    }
  }

  private findNode(id: string): DesktopNode | null {
    return this.store.getNodes().find((node) => node.id === id) ?? null;
  }

  private findFolder(id: string): FolderNode | null {
    const node = this.findNode(id);
    return node?.type === "folder" ? node : null;
  }

  private findFolderChild(folderId: string, childId: string): AppNode | null {
    return this.findFolder(folderId)?.children.find((node) => node.id === childId) ?? null;
  }

  private contextMenuTargetNode(menu: ContextMenuState): DesktopNode | AppNode | null {
    if (menu.type === "item") {
      return this.findNode(menu.nodeId);
    }

    if (menu.type === "folderItem") {
      return this.findFolderChild(menu.folderId, menu.childId);
    }

    return null;
  }

  private getOpenFolder() {
    if (!this.openFolderId) {
      return null;
    }

    return this.findFolder(this.openFolderId);
  }

  private folderPaging(folder: FolderNode) {
    const size = this.folderPanelSize(folder);
    const pageSize = Math.max(1, size.columns * size.rows);
    const pageCount = Math.max(1, Math.ceil(folder.children.length / pageSize));
    const page = clampScroll(this.openFolderPage, 0, pageCount - 1);

    return { page, pageCount, pageSize, size };
  }

  private folderPanelSize(folder: FolderNode, appearance: FolderAppearanceSettings = folder.appearance) {
    const viewport = desktopViewport();
    const firstPass = panelSizeFor(viewport.width, viewport.height, appearance);
    const firstPageSize = Math.max(1, firstPass.columns * firstPass.rows);
    if (folder.children.length <= firstPageSize) {
      return firstPass;
    }

    return panelSizeFor(viewport.width, viewport.height, appearance, folderPagerHeight);
  }

  private setOpenFolderPage(page: number, transitionStart?: { dragX: number; width: number }) {
    const folder = this.getOpenFolder();
    if (!folder) {
      return;
    }

    const paging = this.folderPaging(folder);
    const nextPage = clampScroll(Math.round(page), 0, paging.pageCount - 1);
    const currentPage = paging.page;
    if (nextPage === currentPage) {
      this.settleFolderPageDragStyle();
      return;
    }

    this.openFolderPage = nextPage;
    this.selectedFolderChild = null;
    this.renamingFolderChild = null;
    this.folderLayer.querySelectorAll<HTMLElement>(".folder-item.is-selected").forEach((item) => {
      item.classList.remove("is-selected");
    });

    const panel = this.folderLayer.querySelector<HTMLElement>(".folder-panel");
    if (transitionStart && panel) {
      const continuityX = transitionStart.dragX + (nextPage - currentPage) * transitionStart.width;
      panel.style.setProperty("--folder-page-drag-x", `${continuityX}px`);
      this.updateFolderPageView(nextPage);
      requestAnimationFrame(() => {
        panel.classList.remove("is-page-dragging");
        panel.style.setProperty("--folder-page-drag-x", "0px");
        window.setTimeout(() => {
          panel.style.removeProperty("--folder-page-drag-x");
        }, 320);
      });
      return;
    }

    this.clearFolderPageDragStyle();
    this.updateFolderPageView(nextPage);
  }

  private updateFolderPageView(page: number) {
    const pages = this.folderLayer.querySelector<HTMLElement>(".folder-pages");
    pages?.style.setProperty("--folder-page-offset", `${page * -100}%`);

    const previousPage = this.folderLayer.querySelector<HTMLElement>(".folder-items.is-current-page");
    const currentPage = this.folderLayer.querySelector<HTMLElement>(`.folder-items[data-folder-page="${page}"]`);
    if (previousPage && previousPage !== currentPage) {
      this.updateFolderPageAccessibility(previousPage, false);
    }
    if (currentPage) {
      this.updateFolderPageAccessibility(currentPage, true);
    }

    this.folderLayer.querySelectorAll<HTMLElement>("[data-folder-page-index]").forEach((dot) => {
      const isCurrent = Number(dot.dataset.folderPageIndex) === page;
      dot.classList.toggle("is-current", isCurrent);
      if (isCurrent) {
        dot.setAttribute("aria-current", "page");
      } else {
        dot.removeAttribute("aria-current");
      }
    });
  }

  private updateFolderPageAccessibility(page: HTMLElement, isCurrent: boolean) {
    page.classList.toggle("is-current-page", isCurrent);
    if (isCurrent) {
      page.removeAttribute("aria-hidden");
    } else {
      page.setAttribute("aria-hidden", "true");
    }

    page.querySelectorAll<HTMLElement>("[data-folder-child-id]").forEach((item) => {
      item.tabIndex = isCurrent ? 0 : -1;
    });
  }

  private async closeFolder() {
    if (!this.openFolderId || this.folderClosing) {
      return;
    }

    const panel = this.folderLayer.querySelector<HTMLElement>(".folder-panel");
    const backdrop = this.folderLayer.querySelector<HTMLElement>(".folder-backdrop");
    if (!panel) {
      this.closeFolderNow();
      return;
    }

    const origin = this.refreshFolderCloseOrigin() ?? this.folderOpenOrigin;
    this.editingFolder = false;
    this.folderClosing = true;
    this.folderLayer.classList.add("is-closing");
    panel.classList.add("is-performance-animating");

    try {
      await playFolderClose(panel, backdrop, origin);
    } finally {
      this.folderClosing = false;
      this.closeFolderNow();
    }
  }

  private refreshFolderCloseOrigin() {
    const folder = this.getOpenFolder();
    if (!folder) {
      return null;
    }

    const origin = this.currentFolderOpenOrigin(folder);
    if (!origin) {
      return null;
    }

    this.folderOpenOrigin = origin;
    return origin;
  }

  private closeContextMenu() {
    this.invalidateContextOverlay();
    if (!this.contextMenu) {
      return;
    }

    this.contextMenu = null;
    this.renderContextMenu();
  }

  private clearContextOverlay() {
    this.invalidateContextOverlay();
    this.contextMenu = null;
    this.ratioDialogTargetId = null;
    this.contextMenuLayer.classList.remove("is-open");
    this.contextMenuLayer.replaceChildren();
  }

  private beginContextOverlayRequest() {
    this.invalidateContextOverlay();
    this.contextMenu = null;
    this.ratioDialogTargetId = null;
    this.contextMenuLayer.classList.remove("is-open");
    this.contextMenuLayer.replaceChildren();
    return this.contextOverlayVersion;
  }

  private invalidateContextOverlay() {
    this.contextOverlayVersion += 1;
  }

  private isCurrentContextOverlayRequest(version: number) {
    return this.contextOverlayVersion === version;
  }

  private pruneDetachedUiState() {
    if (this.selectedId && !this.findNode(this.selectedId)) {
      this.selectedId = null;
    }
    for (const id of Array.from(this.selectedIds)) {
      if (!this.findNode(id)) {
        this.selectedIds.delete(id);
      }
    }
    if (!this.selectedId && this.selectedIds.size > 0) {
      this.selectedId = Array.from(this.selectedIds).at(-1) ?? null;
    }

    if (this.renamingId && !this.findNode(this.renamingId)) {
      this.renamingId = null;
    }

    if (this.openFolderId && !this.findFolder(this.openFolderId)) {
      if (!this.folderClosing) {
        this.openFolderId = null;
        this.folderOpenOrigin = null;
        this.editingFolder = false;
        this.renderedFolderId = null;
      }

      this.renamingFolderChild = null;
      this.selectedFolderChild = null;
    }

    if (
      this.renamingFolderChild &&
      !this.findFolderChild(this.renamingFolderChild.folderId, this.renamingFolderChild.childId)
    ) {
      this.renamingFolderChild = null;
    }

    if (
      this.selectedFolderChild &&
      !this.findFolderChild(this.selectedFolderChild.folderId, this.selectedFolderChild.childId)
    ) {
      this.selectedFolderChild = null;
    }

    if (this.contextMenu?.type !== "desktop" && this.contextMenu && !this.contextMenuTargetNode(this.contextMenu)) {
      this.contextMenu = null;
    }
  }

  private onGlobalPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement;

    if (this.ratioDialogTargetId) {
      if (!target.closest(".ratio-dialog")) {
        this.closeRatioDialog();
      }
      return;
    }

    if (!this.contextMenu) {
      return;
    }

    if (target.closest(".context-menu")) {
      return;
    }

    this.closeContextMenu();
  }

  private async refreshDesktopItems(options: { keepPendingRefreshes?: boolean; deferIfBusy?: boolean } = {}) {
    if (!options.keepPendingRefreshes) {
      this.cancelPendingRefreshes();
    }

    if (options.deferIfBusy && this.isRefreshInteractionBusy()) {
      this.scheduleDeferredRefresh();
      return;
    }

    const items = await this.scanAndWarmDesktopItems(48);
    if (items.length === 0) {
      return;
    }

    this.desktopScanSignature = desktopItemsSignature(items);
    this.store.syncScannedItems(items);
  }

  private startDesktopAutoSync() {
    if (!isDesktopRuntime() || this.autoSyncTimer !== null) {
      return;
    }

    this.autoSyncTimer = window.setInterval(() => {
      void this.refreshDesktopItemsIfChanged();
    }, 4500);
  }

  private stopDesktopAutoSync() {
    if (this.autoSyncTimer === null) {
      return;
    }

    window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
  }

  private async refreshDesktopItemsIfChanged() {
    if (this.autoSyncInFlight || this.isRefreshInteractionBusy()) {
      return;
    }

    this.autoSyncInFlight = true;
    try {
      const fastItems = await scanDesktopItems({ includeIcons: false });
      if (fastItems.length === 0) {
        return;
      }

      const signature = desktopItemsSignature(fastItems);
      if (signature === this.desktopScanSignature) {
        return;
      }

      const items = await this.scanAndWarmDesktopItems(12);
      if (items.length === 0) {
        return;
      }

      this.desktopScanSignature = desktopItemsSignature(items);
      this.store.syncScannedItems(items);
    } finally {
      this.autoSyncInFlight = false;
    }
  }

  private async scanAndWarmDesktopItems(iconWarmupBudgetMs = 90) {
    const items = await scanDesktopItems();
    await warmIconImages(items, iconWarmupBudgetMs);
    return items;
  }

  private async loadFullDesktopItemsAfterBoot() {
    if (this.fullDesktopLoadInFlight) {
      return;
    }

    if (this.isHardRefreshInteractionBusy()) {
      this.scheduleFullDesktopItemLoad(700);
      return;
    }

    this.fullDesktopLoadInFlight = true;
    try {
      const items = await this.scanAndWarmDesktopItems(18);
      if (items.length === 0) {
        return;
      }

      this.desktopScanSignature = desktopItemsSignature(items);
      if (this.isHardRefreshInteractionBusy()) {
        this.store.refreshKnownItems(items);
        this.scheduleFullDesktopItemLoad(900);
        return;
      }

      if (this.openFolderId || this.folderClosing) {
        this.store.refreshKnownItems(items);
        this.scheduleDeferredRefresh(900);
        return;
      }

      this.store.syncScannedItems(items);
    } finally {
      this.fullDesktopLoadInFlight = false;
    }
  }

  private scheduleFullDesktopItemLoad(timeout = 900) {
    if (this.fullDesktopLoadScheduled || this.fullDesktopLoadInFlight) {
      return;
    }

    this.fullDesktopLoadScheduled = true;
    scheduleIdleTask(() => {
      this.fullDesktopLoadScheduled = false;
      void this.loadFullDesktopItemsAfterBoot();
    }, timeout);
  }

  private async syncAfterNativeShellCommand() {
    this.cancelPendingRefreshes();
    await this.refreshDesktopItems({ keepPendingRefreshes: true, deferIfBusy: true });

    for (const delayMs of [220, 900, 1800]) {
      const timer = window.setTimeout(() => {
        this.pendingRefreshTimers = this.pendingRefreshTimers.filter((value) => value !== timer);
        void this.refreshDesktopItems({ keepPendingRefreshes: true, deferIfBusy: true });
      }, delayMs);
      this.pendingRefreshTimers.push(timer);
    }
  }

  private cancelPendingRefreshes() {
    for (const timer of this.pendingRefreshTimers) {
      window.clearTimeout(timer);
    }

    this.pendingRefreshTimers = [];
    this.deferredRefreshTimer = null;
  }

  private scheduleDeferredRefresh(delayMs = 650) {
    if (this.deferredRefreshTimer !== null) {
      return;
    }

    const timer = window.setTimeout(() => {
      this.deferredRefreshTimer = null;
      this.pendingRefreshTimers = this.pendingRefreshTimers.filter((value) => value !== timer);
      void this.refreshDesktopItems({ keepPendingRefreshes: true, deferIfBusy: true });
    }, delayMs);

    this.deferredRefreshTimer = timer;
    this.pendingRefreshTimers.push(timer);
  }

  private isRefreshInteractionBusy() {
    return Boolean(
      this.isHardRefreshInteractionBusy() ||
        this.openFolderId ||
        this.folderClosing
    );
  }

  private isHardRefreshInteractionBusy() {
    return Boolean(
      this.drag ||
        this.marquee ||
        this.renamingId ||
        this.renamingFolderChild ||
        this.editingFolder ||
        this.ratioDialogTargetId ||
        this.contextMenu ||
        this.settingsOpen
    );
  }

  private async openItem(node: AppNode) {
    const now = performance.now();
    const recentDuplicate =
      this.lastOpenRequest?.id === node.id && now - this.lastOpenRequest.time < 480;
    if (recentDuplicate) {
      return;
    }

    this.lastOpenRequest = { id: node.id, time: now };
    this.markItemOpening(node.id);

    try {
      await openDesktopItem(node);
    } catch (error) {
      console.warn("Unable to open desktop item", node.name, error);
    }
  }

  private markItemOpening(id: string) {
    this.openingIds.add(id);
    this.applyOpeningState(id, true);

    const existingTimer = this.openingTimers.get(id);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      this.openingTimers.delete(id);
      this.openingIds.delete(id);
      this.applyOpeningState(id, false);
    }, 820);
    this.openingTimers.set(id, timer);
  }

  private applyOpeningState(id: string, opening: boolean) {
    const selector = CSS.escape(id);
    this.grid.querySelector<HTMLElement>(`[data-node-id="${selector}"]`)?.classList.toggle("is-opening", opening);
    this.folderLayer
      .querySelector<HTMLElement>(`[data-folder-child-id="${selector}"]`)
      ?.classList.toggle("is-opening", opening);
  }

  private async openNativeContextMenu(
    node: AppNode,
    x: number,
    y: number,
    fallback: ContextMenuState
  ) {
    const requestVersion = this.beginContextOverlayRequest();

    try {
      const result = await showNativeItemContextMenu(node, x, y);
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      if (result.verb === "rename") {
        if (fallback.type === "folderItem") {
          this.startFolderChildRename(fallback.folderId, fallback.childId);
        } else if (fallback.type === "item") {
          this.startRename(fallback.nodeId);
        }
        return;
      }

      if (result.invoked) {
        await this.syncAfterNativeShellCommand();
      }
    } catch (error) {
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      console.warn("Unable to open native shell context menu", node.name, error);
      this.contextMenu = fallback;
      this.renderContextMenu();
    }
  }

  private async openNativeDesktopContextMenu(x: number, y: number) {
    const requestVersion = this.beginContextOverlayRequest();

    try {
      const result = await showNativeDesktopContextMenu(x, y);
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      if (result.invoked) {
        await this.syncAfterNativeShellCommand();
      }
    } catch (error) {
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      console.warn("Unable to open native desktop context menu", error);
      this.contextMenu = { type: "desktop", x, y };
      this.renderContextMenu();
    }
  }

  private activateDesktopNode(nodeId: string, element: HTMLElement) {
    const node = this.findNode(nodeId);
    if (!node) {
      return;
    }

    this.closeContextMenu();
    if (node.type === "folder") {
      this.lastActivation = null;
      this.openFolderFromElement(node, element);
      return;
    }

    const now = performance.now();
    const isDoubleClick = this.lastActivation?.id === node.id && now - this.lastActivation.time <= 430;
    this.lastActivation = { id: node.id, time: now };

    if (isDoubleClick) {
      this.lastActivation = null;
      void this.openItem(node);
      return;
    }

    this.selectSingleDesktopNode(node.id);
    this.renamingId = null;
    this.render();
  }

  private async activateFolderChild(folderId: string, childId: string) {
    const child = this.findFolderChild(folderId, childId);
    if (!child) {
      return;
    }

    this.closeContextMenu();
    const activationId = `${folderId}:${childId}`;
    const now = performance.now();
    const isDoubleClick = this.lastActivation?.id === activationId && now - this.lastActivation.time <= 430;
    this.lastActivation = { id: activationId, time: now };

    if (!isDoubleClick) {
      this.clearDesktopSelection();
      this.selectedFolderChild = { folderId, childId };
      this.renamingFolderChild = null;
      this.renderFolderLayer();
      return;
    }

    this.lastActivation = null;
    await this.openItem(child);
  }

  private async onWindowKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea")) {
      return;
    }

    if (event.key === "Escape") {
      if (this.settingsOpen) {
        this.settingsOpen = false;
        this.renderSettingsLayer();
        return;
      }

      void this.closeFolder();
      return;
    }

    if (this.openFolderId) {
      if (await this.onOpenFolderKeyDown(event)) {
        return;
      }

      return;
    }

    if (this.settingsOpen) {
      return;
    }

    if (this.handleDesktopNavigationKey(event)) {
      return;
    }

    if (event.key === "F5") {
      event.preventDefault();
      await this.refreshDesktopItems();
      return;
    }

    const selected = this.selectedId ? this.findNode(this.selectedId) : null;
    const key = event.key.toLowerCase();

    if (event.ctrlKey && key === "v") {
      event.preventDefault();
      await pasteDesktopItems();
      await this.refreshDesktopItems();
      return;
    }

    if (!selected) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (selected.type === "folder") {
        this.openFolderFromNode(selected);
      } else {
        await this.openItem(selected);
      }
      return;
    }

    if (event.ctrlKey && key === "c" && selected.type === "item" && selected.path) {
      event.preventDefault();
      await copyDesktopItem(selected);
      return;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      await this.deleteNode(selected);
      return;
    }

    if (event.key === "F2") {
      const canRename = selected.type === "folder" || (selected.type === "item" && Boolean(selected.path));
      if (canRename) {
        event.preventDefault();
        this.startRename(selected.id);
      }
    }
  }

  private async deleteNode(node: DesktopNode) {
    if (node.type === "folder") {
      const childPositions = this.freeFolderChildPositions(node);
      const changed = this.store.dissolveFolder(node.id, childPositions);
      if (changed) {
        if (this.openFolderId === node.id) {
          this.closeFolderNow();
        }
        if (this.selectedId === node.id) {
          this.selectedId = Array.from(this.selectedIds).find((id) => id !== node.id) ?? null;
        }
        this.selectedIds.delete(node.id);
        if (this.renamingId === node.id) {
          this.renamingId = null;
        }
      }
      return;
    }

    if (!node.path) {
      return;
    }

    if (!window.confirm(`\u5220\u9664\u201c${node.name}\u201d\uff1f`)) {
      return;
    }

    await deleteDesktopItem(node);
    await this.refreshDesktopItems();
  }

  private async onOpenFolderKeyDown(event: KeyboardEvent) {
    if (event.key === "F5") {
      event.preventDefault();
      await this.refreshDesktopItems();
      return true;
    }

    if (this.handleOpenFolderNavigationKey(event)) {
      return true;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const childId = item?.dataset.folderChildId ?? this.selectedFolderChild?.childId;
    const folderId = item?.dataset.parentFolderId ?? this.selectedFolderChild?.folderId;
    const child = this.findFolderChild(folderId ?? "", childId ?? "");
    if (!folderId || !childId || !child) {
      return false;
    }

    const key = event.key.toLowerCase();
    if (event.key === "Enter") {
      event.preventDefault();
      await this.openItem(child);
      return true;
    }

    if (event.key === "F2" && child.path) {
      event.preventDefault();
      this.startFolderChildRename(folderId, childId);
      return true;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      this.moveFolderChildOut(folderId, childId);
      return true;
    }

    if (event.ctrlKey && key === "c" && child.path) {
      event.preventDefault();
      await copyDesktopItem(child);
      return true;
    }

    return false;
  }

  private handleDesktopNavigationKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isNavigationKey(event.key)) {
      return false;
    }

    const nodes = this.store.getNodes();
    if (nodes.length === 0) {
      return false;
    }

    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const activeId = focused?.dataset.nodeId ?? this.selectedId;
    const next = this.desktopNavigationNode(event.key, activeId, nodes);
    if (!next) {
      return false;
    }

    event.preventDefault();
    this.selectSingleDesktopNode(next.id);
    this.renamingId = null;
    this.closeContextMenu();
    this.render();
    this.focusDesktopNode(next.id);
    return true;
  }

  private desktopNavigationNode(key: string, activeId: string | null | undefined, nodes: DesktopNode[]) {
    if (nodes.length === 0) {
      return null;
    }

    const currentIndex = nodes.findIndex((node) => node.id === activeId);
    if (key === "Home") {
      return nodes[0];
    }

    if (key === "End") {
      return nodes[nodes.length - 1];
    }

    if (currentIndex < 0) {
      return nodes[0];
    }

    if (key === "ArrowLeft") {
      return nodes[Math.max(0, currentIndex - 1)];
    }

    if (key === "ArrowRight") {
      return nodes[Math.min(nodes.length - 1, currentIndex + 1)];
    }

    return this.desktopVerticalNavigationNode(key, nodes[currentIndex], nodes);
  }

  private desktopVerticalNavigationNode(key: string, current: DesktopNode, nodes: DesktopNode[]) {
    const currentSlot = this.layout.get(current.id);
    if (!currentSlot || (key !== "ArrowUp" && key !== "ArrowDown")) {
      return current;
    }

    const currentCenterX = currentSlot.x + currentSlot.width / 2;
    const currentCenterY = currentSlot.y + currentSlot.height / 2;
    let best: { node: DesktopNode; score: number } | null = null;

    for (const node of nodes) {
      if (node.id === current.id) {
        continue;
      }

      const slot = this.layout.get(node.id);
      if (!slot) {
        continue;
      }

      const centerX = slot.x + slot.width / 2;
      const centerY = slot.y + slot.height / 2;
      const deltaY = centerY - currentCenterY;
      if ((key === "ArrowDown" && deltaY <= 0.5) || (key === "ArrowUp" && deltaY >= -0.5)) {
        continue;
      }

      const score = Math.abs(deltaY) * 1000 + Math.abs(centerX - currentCenterX);
      if (!best || score < best.score) {
        best = { node, score };
      }
    }

    return best?.node ?? current;
  }

  private handleOpenFolderNavigationKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isNavigationKey(event.key)) {
      return false;
    }

    const folder = this.getOpenFolder();
    if (!folder || folder.children.length === 0) {
      return false;
    }

    const paging = this.folderPaging(folder);
    if (paging.pageCount > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      this.selectedFolderChild = null;
      this.renamingFolderChild = null;
      this.closeContextMenu();
      this.setOpenFolderPage(paging.page + (event.key === "ArrowRight" ? 1 : -1));
      return true;
    }

    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const selectedChildId = focused?.dataset.folderChildId ?? this.selectedFolderChild?.childId ?? null;
    const pageStart = paging.page * paging.pageSize;
    const visibleChildren = folder.children.slice(pageStart, pageStart + paging.pageSize);
    const currentIndex = visibleChildren.findIndex((child) => child.id === selectedChildId);
    const columns = paging.size.columns;
    const nextIndex = nextGridIndex(event.key, currentIndex, visibleChildren.length, columns);
    const next = visibleChildren[nextIndex];
    if (!next) {
      return false;
    }

    event.preventDefault();
    this.clearDesktopSelection();
    this.renamingFolderChild = null;
    this.selectedFolderChild = { folderId: folder.id, childId: next.id };
    this.closeContextMenu();
    this.renderFolderLayer();
    this.focusFolderChild(folder.id, next.id);
    return true;
  }

  private focusDesktopNode(nodeId: string) {
    requestAnimationFrame(() => {
      const item = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
      item?.focus({ preventScroll: true });
    });
  }

  private focusFolderChild(folderId: string, childId: string) {
    requestAnimationFrame(() => {
      const item = this.folderLayer.querySelector<HTMLElement>(
        `[data-parent-folder-id="${CSS.escape(folderId)}"][data-folder-child-id="${CSS.escape(childId)}"]`
      );
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
      item?.focus({ preventScroll: true });
    });
  }

  private moveFolderChildOut(folderId: string, childId: string) {
    const folderIndex = this.store.getNodes().findIndex((node) => node.id === folderId);
    const targetIndex = folderIndex >= 0 ? folderIndex + 1 : this.store.getNodes().length;
    const folder = this.findFolder(folderId);
    const position = folder ? this.freeFolderChildPosition(folder, childId) : null;

    this.selectSingleDesktopNode(childId);
    this.renamingFolderChild = null;
    const changed = this.store.moveFolderChildToDesktop(folderId, childId, targetIndex, position);
    if (!changed) {
      this.renderFolderLayer();
      return;
    }

    if (!this.findFolder(folderId)) {
      this.closeFolderNow();
    }
    this.focusDesktopNode(childId);
  }

  private openFolderFromNode(node: FolderNode) {
    const element = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
    if (element) {
      this.openFolderFromElement(node, element);
      return;
    }

    this.folderOpenOrigin = this.currentFolderOpenOrigin(node);
    this.openFolderId = node.id;
    this.openFolderPage = 0;
    this.editingFolder = false;
    this.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  private openFolderFromElement(node: FolderNode, element: HTMLElement) {
    this.settingsOpen = false;
    this.renderSettingsLayer();

    const cover = element.querySelector<HTMLElement>(".folder-cover");
    const rect = cover?.getBoundingClientRect() ?? element.getBoundingClientRect();
    this.folderOpenOrigin = this.folderOpenOriginForRect(node, rect);
    this.openFolderId = node.id;
    this.openFolderPage = 0;
    this.editingFolder = false;
    this.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  private currentFolderOpenOrigin(node: FolderNode): FolderOpenOrigin | null {
    const element = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
    if (element) {
      const cover = element.querySelector<HTMLElement>(".folder-cover");
      const rect = cover?.getBoundingClientRect() ?? element.getBoundingClientRect();
      return this.folderOpenOriginForRect(node, rect);
    }

    const slot = this.layout.get(node.id);
    return slot ? this.folderOpenOriginForRect(node, this.folderCoverRectForSlot(node, slot)) : null;
  }

  private folderCoverRectForSlot(
    node: FolderNode,
    slot: LayoutSlot
  ): Pick<DOMRect, "left" | "top" | "width" | "height"> {
    const viewport = desktopViewport();
    const settings = this.effectiveDesktopSettings(
      this.store.getSettings(),
      this.store.getNodes(),
      viewport
    );
    const metrics = folderTileMetrics(settings, node.appearance);
    const coverWidth = metrics.iconShellWidth;
    const coverHeight = metrics.iconShellHeight;

    return {
      left: slot.x + slot.width / 2 - coverWidth / 2,
      top: slot.y + 8,
      width: coverWidth,
      height: coverHeight
    };
  }

  private folderOpenOriginForRect(
    node: FolderNode,
    rect: Pick<DOMRect, "left" | "top" | "width" | "height">
  ): FolderOpenOrigin {
    const size = this.folderPanelSize(node);
    const scale = Math.max(
      0.08,
      Math.min(0.22, Math.max(rect.width / Math.max(1, size.width), rect.height / Math.max(1, size.height)))
    );

    return {
      x: rect.left + rect.width / 2 - window.innerWidth / 2,
      y: rect.top + rect.height / 2 - window.innerHeight / 2,
      scale
    };
  }

  private startRename(nodeId: string) {
    this.renamingId = nodeId;
    this.renamingFolderChild = null;
    this.selectSingleDesktopNode(nodeId);
    this.render();
    requestAnimationFrame(() => {
      const input = this.grid.querySelector<HTMLInputElement>(`[data-rename-id="${CSS.escape(nodeId)}"]`);
      input?.focus();
      input?.select();
    });
  }

  private startFolderChildRename(folderId: string, childId: string) {
    this.renamingId = null;
    this.clearDesktopSelection();
    this.renamingFolderChild = { folderId, childId };
    this.selectedFolderChild = { folderId, childId };
    this.renderFolderLayer();
  }

  private async onRenameFocusOut(event: FocusEvent) {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-rename-id]");
    if (!input) {
      return;
    }

    await this.commitRename(input.dataset.renameId ?? "", input.value);
  }

  private async onGridKeyDown(event: KeyboardEvent) {
    const renameInput = (event.target as HTMLElement).closest<HTMLInputElement>("[data-rename-id]");
    if (renameInput) {
      if (event.key === "Enter") {
        event.preventDefault();
        await this.commitRename(renameInput.dataset.renameId ?? "", renameInput.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.renamingId = null;
        this.render();
      }
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const node = this.findNode(tile?.dataset.nodeId ?? "");
    if (!tile || !node) {
      return;
    }

    if (node.type === "item") {
      await this.openItem(node);
    } else {
      this.openFolderFromElement(node, tile);
    }
  }

  private async commitRename(nodeId: string, rawName: string) {
    if (this.renamingId !== nodeId) {
      return;
    }

    const node = this.findNode(nodeId);
    const name = rawName.trim();
    this.renamingId = null;

    if (!node || !name || name === node.name) {
      this.render();
      return;
    }

    try {
      if (node.type === "folder") {
        this.store.renameFolder(node.id, name);
      } else {
        const renamed = await renameDesktopItem(node, name);
        if (renamed) {
          this.store.replaceItem(node.id, renamed);
          this.selectSingleDesktopNode(renamed.id);
          this.render();
        } else {
          await this.refreshDesktopItems();
        }
      }
    } catch (error) {
      console.warn("Unable to rename desktop item", node.name, error);
      this.render();
    }
  }

  private async commitFolderChildRename(folderId: string, childId: string, rawName: string) {
    if (
      this.renamingFolderChild?.folderId !== folderId ||
      this.renamingFolderChild?.childId !== childId
    ) {
      return;
    }

    const child = this.findFolderChild(folderId, childId);
    const name = rawName.trim();
    this.renamingFolderChild = null;

    if (!child || !name || name === child.name) {
      this.renderFolderLayer();
      return;
    }

    try {
      const renamed = await renameDesktopItem(child, name);
      if (renamed) {
        this.store.replaceItem(child.id, renamed);
        this.selectedFolderChild = { folderId, childId: renamed.id };
        this.renderFolderLayer();
      } else {
        await this.refreshDesktopItems();
      }
    } catch (error) {
      console.warn("Unable to rename folder child", child.name, error);
      this.renderFolderLayer();
    }
  }

  private closeFolderNow() {
    this.folderClosing = false;
    this.openFolderId = null;
    this.renderedFolderId = null;
    this.folderOpenOrigin = null;
    this.openFolderPage = 0;
    this.cancelFolderSwipe();
    this.editingFolder = false;
    this.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  private desktopInsertionIndex(clientX: number, clientY: number) {
    const scrollLeft = this.root.scrollLeft;
    const scrollTop = this.root.scrollTop;
    const layoutX = clientX + scrollLeft;
    const layoutY = clientY + scrollTop;
    const viewport = desktopViewport();
    const visibleBottom = viewport.offsetY + viewport.height + scrollTop;
    const settings = fitDesktopSettings(
      this.store.getSettings(),
      this.store.getNodes(),
      viewport.width,
      viewport.height
    );

    return desktopIndexForPoint(
      layoutX,
      layoutY,
      viewport.width,
      visibleBottom,
      this.store.getNodes(),
      settings,
      viewport.offsetX,
      viewport.offsetY
    );
  }

  private consumeSuppressedClick() {
    if (!this.suppressNextClick) {
      return false;
    }

    this.suppressNextClick = false;
    return true;
  }
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function scheduleIdleTask(callback: () => void, timeout: number) {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  };

  if (typeof idleWindow.requestIdleCallback === "function") {
    idleWindow.requestIdleCallback(callback, { timeout });
    return;
  }

  window.setTimeout(callback, Math.min(timeout, 220));
}

function desktopItemsSignature(items: AppNode[]) {
  return items
    .map((item) => [
      item.id,
      item.name,
      item.kind,
      item.path ?? "",
      item.launchId,
      item.isVirtual ? "1" : "0"
    ].join("\u001f"))
    .sort()
    .join("\u001e");
}

function isNavigationKey(key: string) {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End";
}

type NumericDesktopSettingKey = Exclude<keyof DesktopSettings, "layoutMode" | "appPriority">;

function isDesktopSettingKey(key: string): key is NumericDesktopSettingKey {
  return (
    key === "appIconSize" ||
    key === "desktopGapPx" ||
    key === "desktopPaddingX" ||
    key === "desktopPaddingY" ||
    key === "folderCoverSmallPx" ||
    key === "folderCoverMediumPx" ||
    key === "folderCoverLargePx"
  );
}

function isAppProcessPriority(value: unknown): value is AppProcessPriority {
  return value === "normal" || value === "aboveNormal" || value === "high";
}

function clampScroll(value: number, min: number, max: number) {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

function normalizedRect(startX: number, startY: number, currentX: number, currentY: number): Rect {
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const right = Math.max(startX, currentX);
  const bottom = Math.max(startY, currentY);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

function rectsIntersect(a: Rect, b: Pick<DOMRect, "left" | "top" | "right" | "bottom">) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function rectsOverlapWithMargin(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  margin: number
) {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

function pointInMergeRect(x: number, y: number, rect: DOMRect) {
  const slopX = Math.min(12, rect.width * 0.08);
  const slopY = Math.min(12, rect.height * 0.08);
  return x >= rect.left - slopX && x <= rect.right + slopX && y >= rect.top - slopY && y <= rect.bottom + slopY;
}

function roundFrameValue(value: number) {
  return Math.round(value * 10) / 10;
}

function nextGridIndex(key: string, currentIndex: number, itemCount: number, columns: number) {
  const lastIndex = Math.max(0, itemCount - 1);
  const safeColumns = Math.max(1, columns);

  if (currentIndex < 0) {
    return key === "End" ? lastIndex : 0;
  }

  switch (key) {
    case "ArrowLeft":
      return Math.max(0, currentIndex - 1);
    case "ArrowRight":
      return Math.min(lastIndex, currentIndex + 1);
    case "ArrowUp":
      return Math.max(0, currentIndex - safeColumns);
    case "ArrowDown":
      return Math.min(lastIndex, currentIndex + safeColumns);
    case "Home":
      return 0;
    case "End":
      return lastIndex;
    default:
      return currentIndex;
  }
}
