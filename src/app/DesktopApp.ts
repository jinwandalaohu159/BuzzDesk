import { captureRects, playFlip } from "../animation/flip";
import { captureFolderItemRects, playFolderClose, playFolderLayerMorph } from "../animation/folderPanel";
import { playFolderBirth, playMergeIntoTarget } from "../animation/merge";
import { desktopFallbackMenuItems, itemFallbackMenuItems } from "./contextMenuModel";
import { computeDesktopLayout, desktopIndexForPoint, panelSizeFor } from "../layout/grid";
import {
  renderContextMenu,
  renderDesktopNode,
  renderFolderCover,
  renderFolderLayerContent,
  renderIcon,
  renderSettingsLayer
} from "../render/components";
import {
  applyDesktopSettings,
  createDefaultFolderAppearance,
  defaultDesktopSettings,
  fitDesktopSettings,
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
  showDesktopItemProperties,
  showNativeDesktopContextMenu,
  showNativeItemContextMenu
} from "../system/desktopApi";
import { warmIconImages } from "../system/iconWarmup";
import type {
  AppNode,
  DesktopContextMenuAction,
  DesktopNode,
  DesktopSettings,
  FolderAppearanceSettings,
  FolderNode,
  LayoutSlot
} from "../types";

const defaultFolderName = "\u6587\u4ef6\u5939";

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
  targetSnapshots: DragTargetSnapshot[];
  committing: boolean;
}

interface DragTargetSnapshot {
  id: string;
  rect: DOMRect;
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
  private layout = new Map<string, LayoutSlot>();
  private selectedId: string | null = null;
  private openFolderId: string | null = null;
  private renderedFolderId: string | null = null;
  private folderOpenOrigin: FolderOpenOrigin | null = null;
  private editingFolder = false;
  private folderClosing = false;
  private settingsOpen = false;
  private folderAppearanceTargetId: string | null = null;
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
  private suppressNextClick = false;
  private suppressStoreRender = false;
  private settingsPreviewFrame: number | null = null;
  private pendingSettingsPreview: (() => void) | null = null;

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
    `;

    this.grid = this.root.querySelector(".desktop-grid")!;
    this.folderLayer = this.root.querySelector(".folder-layer")!;
    this.settingsLayer = this.root.querySelector(".settings-layer")!;
    this.contextMenuLayer = this.root.querySelector(".context-menu-layer")!;

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
    console.warn("Desktop Layer diagnostics", { reason, diagnostics });
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
    this.grid.addEventListener("pointerdown", (event) => this.onDesktopPointerDown(event));
    this.grid.addEventListener("dblclick", (event) => this.onDesktopDoubleClick(event));
    this.grid.addEventListener("click", (event) => this.onDesktopClick(event));
    this.grid.addEventListener("contextmenu", (event) => this.onDesktopContextMenu(event));
    this.grid.addEventListener("focusout", (event) => void this.onRenameFocusOut(event));
    this.grid.addEventListener("keydown", (event) => void this.onGridKeyDown(event));
    this.folderLayer.addEventListener("click", (event) => this.onFolderLayerClick(event));
    this.folderLayer.addEventListener("dblclick", (event) => this.onFolderLayerDoubleClick(event));
    this.folderLayer.addEventListener("pointerdown", (event) => this.onFolderPointerDown(event));
    this.folderLayer.addEventListener("contextmenu", (event) => this.onFolderContextMenu(event));
    this.settingsLayer.addEventListener("click", (event) => this.onSettingsClick(event));
    this.settingsLayer.addEventListener("input", (event) => this.onSettingsInput(event));
    this.settingsLayer.addEventListener("change", (event) => this.onSettingsChange(event));
    this.contextMenuLayer.addEventListener("click", (event) => void this.onContextMenuClick(event));

    window.addEventListener("resize", () => this.renderWithFlip());
    window.addEventListener("pointerdown", (event) => this.onGlobalPointerDown(event), true);
    window.addEventListener("keydown", (event) => void this.onWindowKeyDown(event));
  }

  private async installTraySettingsHook() {
    await listenForSettingsRequests(() => {
      this.closeContextMenu();
      this.closeFolderNow();
      this.folderAppearanceTargetId = null;
      this.settingsOpen = true;
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
    const settings = fitDesktopSettings(this.store.getSettings(), nodes.length, window.innerWidth, window.innerHeight);
    applyDesktopSettings(settings);
    this.layout = computeDesktopLayout(nodes, window.innerWidth, window.innerHeight, settings);
    this.grid.replaceChildren(
      ...nodes.map((node) =>
        renderDesktopNode(node, this.layout.get(node.id)!, this.selectedId, this.renamingId, this.openingIds, settings)
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
    const size = panelSizeFor(
      window.innerWidth,
      window.innerHeight,
      appearance
    );
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
        animate
      })
    );
    this.bindFolderNameInput(folder);
    this.bindFolderChildRenameInput(folder);
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
      this.folderAppearanceTargetId = null;
      this.settingsLayer.replaceChildren();
      return;
    }

    const targetFolder = this.getSettingsFolderTarget();
    if (this.folderAppearanceTargetId && !targetFolder) {
      this.folderAppearanceTargetId = null;
    }

    this.settingsLayer.replaceChildren(
      ...renderSettingsLayer({
        settings: this.store.getSettings(),
        folderAppearance: targetFolder?.appearance ?? null,
        folderName: targetFolder?.name ?? null
      })
    );
  }

  private renderContextMenu() {
    this.contextMenuLayer.classList.toggle("is-open", Boolean(this.contextMenu));

    if (!this.contextMenu) {
      this.contextMenuLayer.replaceChildren();
      return;
    }

    const node = this.contextMenuTargetNode(this.contextMenu);
    const items =
      this.contextMenu.type === "desktop"
        ? desktopFallbackMenuItems()
        : itemFallbackMenuItems(node, this.contextMenu.type === "item" ? "desktop" : "folder");

    this.contextMenuLayer.replaceChildren(
      renderContextMenu({
        x: this.contextMenu.x,
        y: this.contextMenu.y,
        items
      })
    );
  }

  private onDesktopClick(event: MouseEvent) {
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
      this.selectedId = null;
      this.render();
    }
  }

  private onDesktopDoubleClick(event: MouseEvent) {
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
    if (event.button !== 0) {
      return;
    }

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const id = tile?.dataset.nodeId;
    const node = this.findNode(id ?? "");
    const slot = id ? this.layout.get(id) : null;
    if (!tile || !id || !node || !slot) {
      return;
    }

    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    this.previewDesktopPress(node, tile);
    this.beginDrag({
      source: { type: "desktop", nodeId: id },
      event,
      element: tile,
      baseX: slot.x,
      baseY: slot.y,
      floating: false
    });
  }

  private previewDesktopPress(node: DesktopNode, tile: HTMLElement) {
    this.closeContextMenu();
    this.selectedFolderChild = null;
    this.renamingId = null;

    if (node.type !== "item") {
      return;
    }

    this.selectedId = node.id;
    this.grid.querySelectorAll(".desktop-tile.is-selected").forEach((element) => {
      if (element !== tile) {
        element.classList.remove("is-selected");
      }
    });
    tile.classList.add("is-selected");
  }

  private previewFolderChildPress(folderId: string, childId: string, item: HTMLElement) {
    this.closeContextMenu();
    this.selectedId = null;
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
    event.preventDefault();
    this.settingsOpen = false;
    this.folderAppearanceTargetId = null;
    this.renderSettingsLayer();

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    if (tile?.dataset.nodeId) {
      const node = this.findNode(tile.dataset.nodeId);
      if (node?.type === "item") {
        this.selectedId = node.id;
        this.render();
        void this.openNativeContextMenu(node, event.clientX, event.clientY, {
          type: "item",
          x: event.clientX,
          y: event.clientY,
          nodeId: node.id
        });
        return;
      }

      this.contextMenu = { type: "item", x: event.clientX, y: event.clientY, nodeId: tile.dataset.nodeId };
      this.selectedId = tile.dataset.nodeId;
      this.render();
      return;
    }

    this.selectedId = null;
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
    if (!item || !child || !folderId || !childId) {
      return;
    }

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
  }

  private onFolderContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const childId = item?.dataset.folderChildId;
    const folderId = item?.dataset.parentFolderId;
    const child = this.findFolderChild(folderId ?? "", childId ?? "");
    if (!item || !folderId || !childId || !child) {
      return;
    }

    this.settingsOpen = false;
    this.folderAppearanceTargetId = null;
    this.renderSettingsLayer();
    this.selectedId = null;
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
  }) {
    try {
      (options.event.currentTarget as HTMLElement | null)?.setPointerCapture?.(options.event.pointerId);
    } catch {
      // Pointer capture is optional; window-level events keep dragging alive.
    }

    const rect = options.element.getBoundingClientRect();
    this.drag = {
      source: options.source,
      pointerId: options.event.pointerId,
      startX: options.event.clientX,
      startY: options.event.clientY,
      currentX: options.event.clientX,
      currentY: options.event.clientY,
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
      targetSnapshots: [],
      committing: false
    };

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp, { once: true });
    window.addEventListener("pointercancel", this.onPointerCancel, { once: true });
    window.addEventListener("blur", this.onWindowBlur, { once: true });
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId || drag.committing) {
      return;
    }

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;

    if (!drag.started) {
      const moved = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
      if (moved < 4) {
        return;
      }

      event.preventDefault();
      if (drag.source.type === "folder" && !drag.floating) {
        this.promoteFolderDrag(drag);
      }
      drag.started = true;
      drag.targetSnapshots = this.captureMergeTargets(drag);
      this.selectedId = null;
      this.selectedFolderChild = null;
      drag.element.classList.remove("is-selected");
      drag.element.classList.add("is-dragging");
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
    this.suppressStoreRender = true;
    try {
      if (drag.started && drag.source.type === "folder") {
        changed = this.store.moveFolderChildToDesktop(
          drag.source.folderId,
          drag.source.childId,
          this.desktopInsertionIndex(drag.currentX, drag.currentY)
        );
      } else if (drag.started && drag.source.type === "desktop") {
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

    drag.element.classList.remove("is-dragging");
    if (drag.floating) {
      drag.element.remove();
    }

    this.drag = null;
    this.clearTargetStyles();
    if (drag.started && changed) {
      this.render();
      playFlip(this.grid, before);
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
      this.updateMergeTarget(active.currentX, active.currentY);
      const dx = active.currentX - active.startX;
      const dy = active.currentY - active.startY;
      const followX = active.baseX + dx;
      const followY = active.baseY + dy;
      const magneticTarget = active.targetId && active.targetRect ? active.targetRect : null;
      const magneticStrength = magneticTarget ? 0.22 : 0;
      const targetX = magneticTarget
        ? magneticTarget.left + magneticTarget.width / 2 - active.width / 2
        : followX;
      const targetY = magneticTarget
        ? magneticTarget.top + magneticTarget.height / 2 - active.height / 2
        : followY;
      const x = followX + (targetX - followX) * magneticStrength;
      const y = followY + (targetY - followY) * magneticStrength;
      const scale = magneticTarget ? 0.88 : 1.035;
      active.element.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    });
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

    const hit = this.hitTestMergeTarget(x, y, drag.targetSnapshots);
    const target = this.findNode(hit?.id ?? "");

    if (!target) {
      this.setMergeTarget(null);
      return;
    }

    if (target.type === "folder" || target.type === "item") {
      this.setMergeTarget(target.id, hit?.rect ?? null);
    }
  }

  private captureMergeTargets(drag: ActiveDrag): DragTargetSnapshot[] {
    const source =
      drag.source.type === "desktop" ? this.findNode(drag.source.nodeId) : this.findFolderChild(drag.source.folderId, drag.source.childId);
    if (!source || source.type === "folder") {
      return [];
    }

    const snapshots: DragTargetSnapshot[] = [];
    this.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
      const id = element.dataset.nodeId;
      if (!id) {
        return;
      }

      if (drag.source.type === "desktop" && id === drag.source.nodeId) {
        return;
      }

      if (drag.source.type === "folder" && id === drag.source.folderId) {
        return;
      }

      const target = this.findNode(id);
      if (!target || (target.type !== "item" && target.type !== "folder")) {
        return;
      }

      snapshots.push({
        id,
        rect: element.getBoundingClientRect()
      });
    });

    return snapshots;
  }

  private hitTestMergeTarget(x: number, y: number, snapshots: DragTargetSnapshot[]) {
    let best: DragTargetSnapshot | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

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
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance < bestDistance) {
        best = snapshot;
        bestDistance = distance;
      }
    }

    return best;
  }

  private setMergeTarget(targetId: string | null, targetRect: DOMRect | null = null) {
    const drag = this.drag;
    if (!drag || drag.targetId === targetId) {
      return;
    }

    this.clearTargetStyles();
    drag.targetId = targetId;
    drag.targetRect = null;

    if (!targetId) {
      return;
    }

    const target = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(targetId)}"]`);
    target?.classList.add("is-merge-target");
    drag.targetRect = targetRect ?? target?.getBoundingClientRect() ?? null;
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
    if (targetElement) {
      void playMergeIntoTarget(drag.element, targetElement).catch((error) => {
        console.warn("Unable to play merge animation", error);
      });
    }

    this.suppressStoreRender = true;
    try {
      if (drag.source.type === "desktop") {
        if (target?.type === "folder") {
          changed = this.store.addDesktopItemToFolder(drag.source.nodeId, target.id);
        } else if (target?.type === "item") {
          const result = this.store.createFolder(drag.source.nodeId, target.id);
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

    drag.element.classList.remove("is-dragging");
    if (drag.floating) {
      drag.element.remove();
    }

    this.drag = null;
    this.clearTargetStyles();
    if (changed) {
      this.render();
      playFlip(this.grid, before, {
        skipNewIds: newFolderId ? new Set([newFolderId]) : undefined
      });
      if (newFolderId && targetRect) {
        this.playFolderBirthById(newFolderId, targetRect);
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

    drag.element.classList.remove("is-dragging");
    if (drag.floating) {
      drag.element.remove();
    }

    this.drag = null;
    this.clearTargetStyles();
    if (drag.started) {
      this.renderWithFlip();
    }
  }

  private clearTargetStyles() {
    this.grid.querySelectorAll(".is-merge-target").forEach((node) => node.classList.remove("is-merge-target"));
  }

  private onFolderLayerClick(event: MouseEvent) {
    if (this.consumeSuppressedClick()) {
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
    const stepButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-step]");

    if (reset) {
      this.cancelSettingsPreview();
      const folder = this.getSettingsFolderTarget();
      if (folder) {
        this.store.updateFolderAppearance(folder.id, createDefaultFolderAppearance());
      } else {
        this.store.updateSettings(defaultDesktopSettings);
      }
      return;
    }

    if (stepButton) {
      const key = stepButton.dataset.settingKey;
      const step = Number(stepButton.dataset.settingStep);
      const min = Number(stepButton.dataset.settingMin);
      const max = Number(stepButton.dataset.settingMax);
      const current = this.getSettingsValueSource();
      if (key && Number.isFinite(step) && Number.isFinite(min) && Number.isFinite(max) && key in current) {
        const value = Math.min(max, Math.max(min, current[key as keyof typeof current] + step));
        this.commitSettingValue(key, value);
      }
      return;
    }

    if (!close) {
      return;
    }

    this.cancelSettingsPreview();
    this.settingsOpen = false;
    this.folderAppearanceTargetId = null;
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
    const folder = this.getSettingsFolderTarget();

    if (folder && isFolderAppearanceKey(key)) {
      const appearance = normalizeFolderAppearance({ ...folder.appearance, [key]: next }, folder.appearance);
      this.scheduleSettingsPreview(() => this.previewFolderAppearance(folder.id, appearance));
      return;
    }

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
    const fitted = fitDesktopSettings(settings, nodes.length, window.innerWidth, window.innerHeight);
    applyDesktopSettings(fitted);
    this.layout = computeDesktopLayout(nodes, window.innerWidth, window.innerHeight, fitted);

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
        this.replaceTileIcon(tile, renderFolderCover(node, fitted));
      }
    }

    this.renderFolderLayer(fitted);
  }

  private previewFolderAppearance(folderId: string, appearance: FolderAppearanceSettings) {
    const folder = this.findFolder(folderId);
    if (!folder) {
      return;
    }

    const nodes = this.store.getNodes();
    const settings = fitDesktopSettings(this.store.getSettings(), nodes.length, window.innerWidth, window.innerHeight);
    const previewFolder = {
      ...folder,
      appearance: normalizeFolderAppearance(appearance, folder.appearance)
    };
    const tile = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(folderId)}"]`);
    if (tile) {
      this.replaceTileIcon(tile, renderFolderCover(previewFolder, settings));
    }

    if (this.openFolderId === folderId) {
      const beforePanel = this.folderLayer.querySelector<HTMLElement>(".folder-panel")?.getBoundingClientRect() ?? null;
      const beforeItems = captureFolderItemRects(this.folderLayer);
      this.renderFolderLayer(settings, previewFolder.appearance);
      playFolderLayerMorph(this.folderLayer, beforePanel, beforeItems);
    }
  }

  private getSettingsFolderTarget() {
    return this.folderAppearanceTargetId ? this.findFolder(this.folderAppearanceTargetId) : null;
  }

  private getSettingsValueSource(): DesktopSettings | FolderAppearanceSettings {
    return this.getSettingsFolderTarget()?.appearance ?? this.store.getSettings();
  }

  private commitSettingValue(key: string, value: number, render = true) {
    this.cancelSettingsPreview();
    const previousSuppress = this.suppressStoreRender;
    this.suppressStoreRender = !render || previousSuppress;

    try {
      const folder = this.getSettingsFolderTarget();
      if (folder && isFolderAppearanceKey(key)) {
        this.store.updateFolderAppearance(folder.id, { [key]: value });
        return;
      }

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

      if (action === "folderAppearance") {
        if (menu.type === "item" && node.type === "folder") {
          this.selectedId = node.id;
          this.folderAppearanceTargetId = node.id;
          this.settingsOpen = true;
          this.render();
        }
      } else if (action === "open") {
        if (node.type === "item") {
          await this.openItem(node);
        } else {
          this.openFolderFromNode(node);
        }
      } else if (action === "rename") {
        if (menu.type === "folderItem" && node.type === "item") {
          this.startFolderChildRename(menu.folderId, node.id);
        } else {
          this.startRename(node.id);
        }
      } else if (action === "delete") {
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

    this.editingFolder = false;
    this.folderClosing = true;
    this.folderLayer.classList.add("is-closing");

    try {
      await playFolderClose(panel, backdrop);
    } finally {
      this.folderClosing = false;
      this.closeFolderNow();
    }
  }

  private closeContextMenu() {
    if (!this.contextMenu) {
      return;
    }

    this.contextMenu = null;
    this.renderContextMenu();
  }

  private pruneDetachedUiState() {
    if (this.selectedId && !this.findNode(this.selectedId)) {
      this.selectedId = null;
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
    if (!this.contextMenu) {
      return;
    }

    if ((event.target as HTMLElement).closest(".context-menu")) {
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
    this.store.hydrate(items);
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
      this.store.hydrate(items);
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

      this.store.hydrate(items);
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
        this.renamingId ||
        this.renamingFolderChild ||
        this.editingFolder ||
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
    this.closeContextMenu();

    try {
      const result = await showNativeItemContextMenu(node, x, y);
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
      console.warn("Unable to open native shell context menu", node.name, error);
      this.contextMenu = fallback;
      this.renderContextMenu();
    }
  }

  private async openNativeDesktopContextMenu(x: number, y: number) {
    this.closeContextMenu();

    try {
      const result = await showNativeDesktopContextMenu(x, y);
      if (result.invoked) {
        await this.syncAfterNativeShellCommand();
      }
    } catch (error) {
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

    this.selectedId = node.id;
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
      this.selectedId = null;
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
      const changed = this.store.dissolveFolder(node.id);
      if (changed) {
        if (this.openFolderId === node.id) {
          this.closeFolderNow();
        }
        if (this.selectedId === node.id) {
          this.selectedId = null;
        }
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

    if (event.key === "Delete" && child.path) {
      event.preventDefault();
      await this.deleteNode(child);
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
    const columns = this.desktopColumnCount(nodes);
    const currentIndex = nodes.findIndex((node) => node.id === activeId);
    const nextIndex = nextGridIndex(event.key, currentIndex, nodes.length, columns);
    const next = nodes[nextIndex];
    if (!next) {
      return false;
    }

    event.preventDefault();
    this.selectedId = next.id;
    this.selectedFolderChild = null;
    this.renamingId = null;
    this.closeContextMenu();
    this.render();
    this.focusDesktopNode(next.id);
    return true;
  }

  private handleOpenFolderNavigationKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isNavigationKey(event.key)) {
      return false;
    }

    const folder = this.getOpenFolder();
    if (!folder || folder.children.length === 0) {
      return false;
    }

    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const selectedChildId = focused?.dataset.folderChildId ?? this.selectedFolderChild?.childId ?? null;
    const currentIndex = folder.children.findIndex((child) => child.id === selectedChildId);
    const columns = panelSizeFor(
      window.innerWidth,
      window.innerHeight,
      folder.appearance
    ).columns;
    const nextIndex = nextGridIndex(event.key, currentIndex, folder.children.length, columns);
    const next = folder.children[nextIndex];
    if (!next) {
      return false;
    }

    event.preventDefault();
    this.selectedId = null;
    this.renamingFolderChild = null;
    this.selectedFolderChild = { folderId: folder.id, childId: next.id };
    this.closeContextMenu();
    this.renderFolderLayer();
    this.focusFolderChild(folder.id, next.id);
    return true;
  }

  private desktopColumnCount(nodes: DesktopNode[]) {
    const firstSlot = this.layout.get(nodes[0]?.id ?? "");
    if (!firstSlot) {
      return 1;
    }

    return Math.max(
      1,
      nodes.filter((node) => {
        const slot = this.layout.get(node.id);
        return slot && Math.abs(slot.y - firstSlot.y) < 0.5;
      }).length
    );
  }

  private focusDesktopNode(nodeId: string) {
    requestAnimationFrame(() => {
      this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`)?.focus({ preventScroll: true });
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

  private openFolderFromNode(node: FolderNode) {
    const element = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
    if (element) {
      this.openFolderFromElement(node, element);
      return;
    }

    const slot = this.layout.get(node.id);
    this.folderOpenOrigin = slot
      ? this.folderOpenOriginForRect(node, {
          left: slot.x,
          top: slot.y,
          width: slot.width,
          height: slot.height
        })
      : null;
    this.openFolderId = node.id;
    this.editingFolder = false;
    this.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  private openFolderFromElement(node: FolderNode, element: HTMLElement) {
    this.settingsOpen = false;
    this.folderAppearanceTargetId = null;
    this.renderSettingsLayer();

    const cover = element.querySelector<HTMLElement>(".folder-cover");
    const rect = cover?.getBoundingClientRect() ?? element.getBoundingClientRect();
    this.folderOpenOrigin = this.folderOpenOriginForRect(node, rect);
    this.openFolderId = node.id;
    this.editingFolder = false;
    this.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  private folderOpenOriginForRect(
    node: FolderNode,
    rect: Pick<DOMRect, "left" | "top" | "width" | "height">
  ): FolderOpenOrigin {
    const size = panelSizeFor(window.innerWidth, window.innerHeight, node.appearance);
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
    this.selectedId = nodeId;
    this.render();
    requestAnimationFrame(() => {
      const input = this.grid.querySelector<HTMLInputElement>(`[data-rename-id="${CSS.escape(nodeId)}"]`);
      input?.focus();
      input?.select();
    });
  }

  private startFolderChildRename(folderId: string, childId: string) {
    this.renamingId = null;
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
          this.selectedId = renamed.id;
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
    this.editingFolder = false;
    this.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  private desktopInsertionIndex(clientX: number, clientY: number) {
    const settings = fitDesktopSettings(
      this.store.getSettings(),
      this.store.getNodes().length,
      window.innerWidth,
      window.innerHeight
    );

    return desktopIndexForPoint(
      clientX,
      clientY,
      window.innerWidth,
      this.store.getNodes().length,
      settings
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

function isFolderAppearanceKey(key: string): key is keyof FolderAppearanceSettings {
  return key === "folderCoverCellSize" || key === "folderPanelColumns" || key === "folderPanelRows";
}

function isDesktopSettingKey(key: string): key is keyof DesktopSettings {
  return key === "appIconSize" || isFolderAppearanceKey(key);
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
