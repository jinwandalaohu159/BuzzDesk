import { captureRects, playFlip } from "../animation/flip";
import { dragAutoScrollDelta, dragFrameTransform, toTransformStyle } from "../animation/drag";
import { playFolderClose, playFolderOpen } from "../animation/folderPanel";
import {
  playFolderBirth,
  playMergeGroupIntoTarget,
  playMergeIntoTarget,
  playTrashGroupIntoTarget
} from "../animation/merge";
import {
  desktopContextMenuPool,
  desktopContextMenuSettingsItems,
  desktopMenuItems,
  itemFallbackMenuItems,
  folderContextMenuItems,
  reorderContextMenuItem,
  resetContextMenuSettings,
  toggleContextMenuSeparator,
  updateContextMenuItemPlacement
} from "./contextMenuModel";
import {
  computeDesktopLayout,
  desktopIndexForPoint,
  nearbyFreeDesktopLayoutPositions,
  panelSizeFor,
  snapFreeDesktopLayoutPosition
} from "../layout/grid";
import {
  renderContextMenu,
  renderDesktopNode,
  applyFolderTileShellStyle,
  renderFolderCover,
  renderFolderLayerContent,
  renderIcon,
  renderSettingsPriorityPopover,
  renderSettingsLayer,
  renderRatioDialog
} from "../render/components";
import {
  applyDesktopSettings,
  defaultDesktopSettings,
  desktopTileMetrics,
  desktopSystemIconIdFromNodeId,
  fitDesktopSettings,
  folderRatioMax,
  folderRatioMin,
  folderTileMetrics,
  isDesktopSystemIconId,
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
  getStartupEnabled,
  loadDesktopState,
  logStartupEvent,
  setStartupEnabled,
  showDesktopItemProperties,
  invokeNativeDesktopContextMenuCommand,
  listNativeDesktopContextMenu,
  showNativeItemContextMenu
} from "../system/desktopApi";
import { desktopViewport } from "../system/desktopViewport";
import { warmIconImages } from "../system/iconWarmup";
import type {
  AppNode,
  AppProcessPriority,
  DesktopContextMenuAction,
  DesktopContextMenuPlacement,
  DesktopNode,
  DesktopPosition,
  DesktopSettings,
  DesktopSystemIconId,
  FolderAppearanceSettings,
  FolderNode,
  LayoutSlot,
  NativeContextMenuItem,
  SettingsView
} from "../types";

const defaultFolderName = "\u6587\u4ef6\u5939";
const folderPagerHeight = 30;
const dragStartDistancePx = 7;
const mergeIntentDelayMs = 400;
const trashIntentDelayMs = 30;

// Owns desktop interaction orchestration; visual rendering, layout math, state
// mutation, and platform calls stay in their own modules.
type DragSource =
  | { type: "desktop"; nodeId: string }
  | { type: "folder"; folderId: string; childId: string };

type DragTargetIntent = "merge" | "trash";

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
  targetIntent: DragTargetIntent | null;
  targetRect: DOMRect | null;
  targetHitRect: Rect | null;
  targetElement: HTMLElement | null;
  candidateTargetId: string | null;
  candidateTargetIntent: DragTargetIntent | null;
  candidateTargetRect: DOMRect | null;
  candidateTargetHitRect: Rect | null;
  mergeIntentTimer: number | null;
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
  intent: DragTargetIntent;
  rect: DOMRect;
  hitRect: Rect;
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
  | { type: "desktop"; x: number; y: number; nativeItems?: NativeContextMenuItem[] }
  | { type: "item"; x: number; y: number; nodeId: string }
  | { type: "folderItem"; x: number; y: number; folderId: string; childId: string };

interface FolderOpenOrigin {
  x: number;
  y: number;
  scale: number;
}

interface SettingsContextMenuDropTarget {
  list: HTMLElement;
  row: HTMLElement | null;
  targetKey: string | null;
  position: "before" | "after" | "end";
}

interface SettingsContextMenuDragState {
  key: string;
  placement: Exclude<DesktopContextMenuPlacement, "hidden">;
  pointerId: number;
  startX: number;
  startY: number;
  startRect: DOMRect;
  row: HTMLElement;
  active: boolean;
  lastTarget: SettingsContextMenuDropTarget | null;
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
  private settingsView: SettingsView = "main";
  private renderedSettingsView: SettingsView | null = null;
  private renderedSettingsContextMenuParentKey: string | null = null;
  private settingsContextMenuParentKey: string | null = null;
  private settingsSystemIconAddOpen = false;
  private settingsPriorityMenuOpen = false;
  private settingsContextMenuDrag: SettingsContextMenuDragState | null = null;
  private settingsContextMenuPaintedDrop: SettingsContextMenuDropTarget | null = null;
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
  private cachedDesktopNativeMenuItems: NativeContextMenuItem[] | null = null;
  private desktopNativeMenuLoad: Promise<NativeContextMenuItem[]> | null = null;

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
      void logStartupEvent("frontend:boot_enter");
      const nativeState = loadDesktopState();
      const attachLayer = this.attachDesktopLayerWithRetry(40, 150);
      const items = await scanDesktopItems({ includeIcons: false });
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
      this.desktopScanSignature = desktopItemsSignature(items);
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

      void logStartupEvent("frontend:shown");
      await this.logDesktopDiagnostics("desktop layer shown");
      this.startDesktopAutoSync();
      this.scheduleFullDesktopItemLoad();
      window.setTimeout(() => void this.loadNativeDesktopMenuItems(), 300);
    } catch (error) {
      console.error("BuzzDesk failed to boot", error);
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
    const enabled = await getStartupEnabled();
    if (enabled !== null && enabled !== this.store.getSettings().startWithWindows) {
      this.store.updateSettings({ startWithWindows: enabled });
    }
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
    this.settingsLayer.addEventListener("pointerdown", (event) => this.onSettingsContextMenuPointerDown(event));
    this.settingsLayer.addEventListener("input", (event) => this.onSettingsInput(event));
    this.settingsLayer.addEventListener("change", (event) => this.onSettingsChange(event));
    this.settingsLayer.addEventListener("scroll", () => this.renderSettingsPriorityMenu(), true);
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
    const wasOpen = this.settingsLayer.classList.contains("is-open");
    const preserveScroll =
      wasOpen &&
      this.renderedSettingsView === this.settingsView &&
      this.renderedSettingsContextMenuParentKey === this.settingsContextMenuParentKey;
    const previousControls = this.settingsLayer.querySelector<HTMLElement>(".settings-controls");
    const scrollLeft = preserveScroll ? previousControls?.scrollLeft ?? 0 : 0;
    const scrollTop = preserveScroll ? previousControls?.scrollTop ?? 0 : 0;
    this.settingsLayer.classList.toggle("is-open", this.settingsOpen);

    if (!this.settingsOpen) {
      this.settingsPriorityMenuOpen = false;
      this.settingsSystemIconAddOpen = false;
      this.settingsContextMenuParentKey = null;
      this.renderedSettingsView = null;
      this.renderedSettingsContextMenuParentKey = null;
      this.settingsLayer.classList.remove("is-settings-dark");
      this.settingsLayer.replaceChildren();
      return;
    }

    const settings = this.store.getSettings();
    const contextMenuParentLabel = this.contextMenuParentLabel();
    this.settingsLayer.classList.toggle("is-settings-dark", settings.settingsDarkMode);

    this.settingsLayer.replaceChildren(
      ...renderSettingsLayer({
        settings,
        view: this.settingsView,
        systemIconItems: this.store.getScannedItems().filter((item) => desktopSystemIconIdFromNodeId(item.id)),
        systemIconAddOpen: this.settingsSystemIconAddOpen,
        contextMenuItems: this.contextMenuSettingsItems(this.settingsContextMenuParentKey),
        contextMenuTitle: this.settingsView === "contextMenu" ? contextMenuParentLabel ?? undefined : undefined,
        contextMenuParentLabel,
        animate: !wasOpen
      })
    );
    this.renderedSettingsView = this.settingsView;
    this.renderedSettingsContextMenuParentKey = this.settingsContextMenuParentKey;
    const nextControls = this.settingsLayer.querySelector<HTMLElement>(".settings-controls");
    if (nextControls) {
      nextControls.scrollLeft = scrollLeft;
      nextControls.scrollTop = scrollTop;
      requestAnimationFrame(() => {
        nextControls.scrollLeft = scrollLeft;
        nextControls.scrollTop = scrollTop;
      });
    }
    this.renderSettingsPriorityMenu();
  }

  private renderSettingsPriorityMenu() {
    this.settingsLayer.querySelector("[data-setting-priority-popover]")?.remove();

    const trigger = this.settingsLayer.querySelector<HTMLElement>("[data-setting-priority-trigger]");
    trigger?.classList.toggle("is-open", this.settingsPriorityMenuOpen);
    trigger?.setAttribute("aria-expanded", String(this.settingsPriorityMenuOpen));

    if (!this.settingsPriorityMenuOpen || !trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const popover = renderSettingsPriorityPopover(this.store.getSettings().appPriority);
    const width = Math.max(168, rect.width);
    const gap = 8;
    const edge = 10;
    const estimatedHeight = 126;
    const left = Math.min(Math.max(edge, rect.left), Math.max(edge, window.innerWidth - width - edge));
    const below = rect.bottom + gap;
    const top =
      below + estimatedHeight > window.innerHeight - edge
        ? Math.max(edge, rect.top - estimatedHeight - gap)
        : below;

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.style.width = `${Math.round(width)}px`;
    this.settingsLayer.append(popover);
  }

  private playSettingsToggleGhost(
    button: HTMLButtonElement,
    nextEnabled: boolean,
    nextLayerDark = this.settingsLayer.classList.contains("is-settings-dark")
  ) {
    const knob = button.querySelector<HTMLElement>("span");
    if (!knob) {
      return;
    }

    document.querySelectorAll(".settings-toggle-ghost").forEach((node) => node.remove());

    const buttonRect = button.getBoundingClientRect();
    const knobRect = knob.getBoundingClientRect();
    const buttonStyle = getComputedStyle(button);
    const knobStyle = getComputedStyle(knob);
    const layerHadDark = this.settingsLayer.classList.contains("is-settings-dark");
    this.settingsLayer.classList.toggle("is-settings-dark", nextLayerDark);
    const finalLayerStyle = getComputedStyle(this.settingsLayer);
    const finalTrackBg = (
      nextEnabled
        ? finalLayerStyle.getPropertyValue("--settings-toggle-on")
        : finalLayerStyle.getPropertyValue("--settings-control-bg")
    ).trim();
    const finalKnobBg = finalLayerStyle.getPropertyValue("--settings-toggle-knob").trim();
    this.settingsLayer.classList.toggle("is-settings-dark", layerHadDark);

    const paddingLeft = Number.parseFloat(buttonStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(buttonStyle.paddingRight) || 0;
    const startX = knobRect.left - buttonRect.left;
    const endX = nextEnabled
      ? buttonRect.width - knobRect.width - paddingRight
      : paddingLeft;

    const ghost = document.createElement("div");
    ghost.className = "settings-toggle-ghost";
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${buttonRect.left}px`,
      top: `${buttonRect.top}px`,
      width: `${buttonRect.width}px`,
      height: `${buttonRect.height}px`,
      borderRadius: buttonStyle.borderRadius,
      backgroundColor: buttonStyle.backgroundColor,
      boxShadow: buttonStyle.boxShadow,
      pointerEvents: "none",
      zIndex: "2147483647",
      overflow: "hidden",
      transition: "background-color 220ms cubic-bezier(.22, 1, .36, 1), box-shadow 220ms ease"
    });

    const ghostKnob = document.createElement("span");
    Object.assign(ghostKnob.style, {
      position: "absolute",
      left: "0",
      top: `${knobRect.top - buttonRect.top}px`,
      width: `${knobRect.width}px`,
      height: `${knobRect.height}px`,
      borderRadius: knobStyle.borderRadius,
      backgroundColor: knobStyle.backgroundColor,
      boxShadow: knobStyle.boxShadow,
      transform: `translate3d(${startX}px, 0, 0)`,
      transition:
        "transform 300ms cubic-bezier(.18, 1.05, .22, 1), background-color 220ms ease, box-shadow 220ms ease",
      willChange: "transform"
    });

    ghost.append(ghostKnob);
    document.body.append(ghost);

    requestAnimationFrame(() => {
      ghost.style.backgroundColor = finalTrackBg;
      ghostKnob.style.backgroundColor = finalKnobBg;
      ghostKnob.style.transform = `translate3d(${Math.max(0, endX)}px, 0, 0)`;
      ghostKnob.style.boxShadow = "0 6px 16px rgba(15, 23, 42, 0.24)";
    });

    window.setTimeout(() => ghost.remove(), 340);
  }

  private updateSettingsToggleRow(button: HTMLButtonElement, enabled: boolean) {
    button.setAttribute("aria-pressed", String(enabled));
    const row = button.closest(".settings-toggle-row");
    const output = row?.querySelector("output");
    if (output) {
      output.textContent = enabled ? "\u5f00" : "\u5173";
    }
  }

  private updateStartupSettingState(enabled: boolean) {
    const previousSuppress = this.suppressStoreRender;
    this.suppressStoreRender = true;

    try {
      this.store.updateSettings({ startWithWindows: enabled });
    } finally {
      this.suppressStoreRender = previousSuppress;
    }
  }

  private contextMenuSettingsItems(parentKey: string | null = null) {
    return desktopContextMenuSettingsItems(
      this.cachedDesktopNativeMenuItems ?? [],
      this.store.getSettings().contextMenu,
      parentKey
    );
  }

  private contextMenuParentLabel() {
    const parentKey = this.settingsContextMenuParentKey;
    if (!parentKey) {
      return null;
    }

    return desktopContextMenuPool(this.cachedDesktopNativeMenuItems ?? []).find((item) => item.key === parentKey)?.label ?? null;
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
      items = this.decorateDesktopContextMenuItems(
        desktopMenuItems(this.contextMenu.nativeItems, this.store.getSettings().contextMenu)
      );
    } else if (node?.type === "folder") {
      const appearance = normalizeFolderAppearance(node.appearance);
      items = folderContextMenuItems(appearance.folderCoverSize, appearance.compactPlacement);
    } else {
      items = itemFallbackMenuItems(node, this.contextMenu.type === "item" ? "desktop" : "folder");
    }

    this.contextMenuLayer.replaceChildren(
      renderContextMenu({
        x: this.contextMenu.x,
        y: this.contextMenu.y,
        items,
        bounds: this.contextMenuSafeArea()
      })
    );
    this.clampContextSubmenus();
  }

  private decorateDesktopContextMenuItems(
    items: ReturnType<typeof desktopMenuItems>
  ): ReturnType<typeof desktopMenuItems> {
    const hideAutoArrange = this.store.getSettings().layoutMode !== "free";
    return this.compactContextMenuItems(items.flatMap((item) => {
      if (hideAutoArrange && item.action === "autoArrange") {
        return [];
      }

      const submenu = item.submenu ? this.decorateDesktopContextMenuItems(item.submenu) : undefined;
      if (item.submenu && submenu?.length === 0) {
        return [];
      }

      return [{ ...item, submenu }];
    }));
  }

  private compactContextMenuItems(
    items: ReturnType<typeof desktopMenuItems>
  ): ReturnType<typeof desktopMenuItems> {
    const compact: ReturnType<typeof desktopMenuItems> = [];
    let previousSeparator = true;

    for (const item of items) {
      if (item.separator) {
        if (!previousSeparator) {
          compact.push(item);
        }
        previousSeparator = true;
        continue;
      }

      compact.push(item);
      previousSeparator = false;
    }

    while (compact.at(-1)?.separator) {
      compact.pop();
    }

    return compact;
  }

  private clampContextSubmenus() {
    const bounds = this.contextMenuSafeArea();
    const submenuGap = 4;
    const submenus = Array.from(this.contextMenuLayer.querySelectorAll<HTMLElement>(".context-submenu"));
    const previousSubmenuStyles = submenus.map((submenu) => ({
      submenu,
      display: submenu.style.display,
      visibility: submenu.style.visibility,
      pointerEvents: submenu.style.pointerEvents
    }));

    submenus.forEach((submenu) => {
      submenu.style.display = "grid";
      submenu.style.visibility = "hidden";
      submenu.style.pointerEvents = "none";
    });

    this.contextMenuLayer.querySelectorAll<HTMLElement>(".context-menu-item.has-submenu").forEach((item) => {
      const submenu = Array.from(item.children).find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.classList.contains("context-submenu")
      );
      if (!submenu) {
        return;
      }

      const floating = submenu.classList.contains("is-floating");
      item.classList.remove("opens-left");
      submenu.classList.remove("is-left");

      const itemRect = item.getBoundingClientRect();
      let submenuRect = submenu.getBoundingClientRect();

      if (floating) {
        const floatingGap = -1;
        let left = itemRect.right + floatingGap;
        if (
          left + submenuRect.width > bounds.right &&
          itemRect.left - submenuRect.width - floatingGap >= bounds.left
        ) {
          item.classList.add("opens-left");
          submenu.classList.add("is-left");
          left = itemRect.left - submenuRect.width - floatingGap;
        }
        left = clampScroll(left, bounds.left, Math.max(bounds.left, bounds.right - submenuRect.width));

        let top = itemRect.top - 8;
        if (top + submenuRect.height > bounds.bottom) {
          top -= top + submenuRect.height - bounds.bottom;
        }
        top = clampScroll(top, bounds.top, Math.max(bounds.top, bounds.bottom - submenuRect.height));

        submenu.style.left = `${Math.round(left)}px`;
        submenu.style.top = `${Math.round(top)}px`;
        return;
      }

      if (
        submenuRect.right > bounds.right &&
        itemRect.left - submenuRect.width - submenuGap >= bounds.left
      ) {
        item.classList.add("opens-left");
        submenu.classList.add("is-left");
        submenuRect = submenu.getBoundingClientRect();
      }

      let top = Number.parseFloat(submenu.style.top);
      if (!Number.isFinite(top)) {
        top = 0;
      }

      const bottomOverflow = submenuRect.bottom - bounds.bottom;
      if (bottomOverflow > 0) {
        top -= bottomOverflow;
      }

      const projectedTop = itemRect.top + top;
      if (projectedTop < bounds.top) {
        top += bounds.top - projectedTop;
      }

      submenu.style.top = `${Math.round(top)}px`;
    });

    previousSubmenuStyles.forEach(({ submenu, display, visibility, pointerEvents }) => {
      submenu.style.display = display;
      submenu.style.visibility = visibility;
      submenu.style.pointerEvents = pointerEvents;
    });
  }

  private contextMenuSafeArea() {
    const edge = 8;
    const fallback = {
      left: edge,
      top: edge,
      right: Math.max(edge, window.innerWidth - edge),
      bottom: Math.max(edge, window.innerHeight - edge)
    };
    const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
    const availLeft = Number.isFinite(screen.availLeft) ? Number(screen.availLeft) : window.screenX;
    const availTop = Number.isFinite(screen.availTop) ? Number(screen.availTop) : window.screenY;
    const availWidth = Number.isFinite(screen.availWidth) ? screen.availWidth : window.innerWidth;
    const availHeight = Number.isFinite(screen.availHeight) ? screen.availHeight : window.innerHeight;
    const screenX = Number.isFinite(window.screenX) ? window.screenX : 0;
    const screenY = Number.isFinite(window.screenY) ? window.screenY : 0;
    const left = Math.max(fallback.left, Math.round(availLeft - screenX + edge));
    const top = Math.max(fallback.top, Math.round(availTop - screenY + edge));
    const right = Math.min(fallback.right, Math.round(availLeft + availWidth - screenX - edge));
    const bottom = Math.min(fallback.bottom, Math.round(availTop + availHeight - screenY - edge));

    if (right - left < 240 || bottom - top < 160) {
      return fallback;
    }

    return { left, top, right, bottom };
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
    void this.openCustomDesktopContextMenu(event.clientX, event.clientY);
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
      targetIntent: null,
      targetRect: null,
      targetHitRect: null,
      targetElement: null,
      candidateTargetId: null,
      candidateTargetIntent: null,
      candidateTargetRect: null,
      candidateTargetHitRect: null,
      mergeIntentTimer: null,
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
      if (moved < dragStartDistancePx) {
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

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;

    if (drag.started && drag.targetId) {
      if (drag.targetHitRect && pointInMergeRect(drag.currentX, drag.currentY, drag.targetHitRect)) {
        this.suppressNextClick = true;
        window.setTimeout(() => {
          this.suppressNextClick = false;
        }, 0);
        if (drag.targetIntent === "trash") {
          void this.commitTrash(drag.targetId);
        } else {
          void this.commitMerge(drag.targetId);
        }
        return;
      }

      this.setMergeTarget(null);
    }

    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);
    this.clearMergeCandidate(drag);

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
        this.clearMergeCandidate(active);
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
              new Set([item.id]),
              [],
              this.isCompactPlacementFolder(item.id)
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
    viewport = desktopViewport(),
    compactPlacement = false
  ): DesktopPosition {
    return snapFreeDesktopLayoutPosition(
      x,
      y,
      width,
      height,
      viewport.width,
      viewport.height,
      this.store.getSettings(),
      compactPlacement
    );
  }

  private nearbySnapCandidates(
    preferred: DesktopPosition,
    width: number,
    height: number,
    viewport = desktopViewport(),
    compactPlacement = false
  ) {
    return nearbyFreeDesktopLayoutPositions(
      preferred,
      width,
      height,
      viewport.width,
      viewport.height,
      this.store.getSettings(),
      compactPlacement
    );
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
    extraOccupied: Array<{ x: number; y: number; width: number; height: number }> = [],
    compactPlacement = false
  ): DesktopPosition {
    const viewport = desktopViewport();
    const occupied = [...this.desktopOccupiedRects(excludeIds), ...extraOccupied];
    const snapped = this.snapDesktopPosition(preferred.x, preferred.y, width, height, viewport, compactPlacement);
    const candidates = uniqueDesktopPositions([
      ...this.compactPlacementEdgeCandidates(width, height, excludeIds, viewport, compactPlacement),
      ...this.nearbySnapCandidates(snapped, width, height, viewport, compactPlacement)
    ]).sort((a, b) => desktopPositionDistance(a, preferred) - desktopPositionDistance(b, preferred));

    for (const candidate of candidates) {
      const rect = { ...candidate, width, height };
      if (!occupied.some((occupiedRect) => rectsOverlapWithMargin(rect, occupiedRect, 8))) {
        return candidate;
      }
    }

    return snapped;
  }

  private compactPlacementEdgeCandidates(
    width: number,
    height: number,
    excludeIds: ReadonlySet<string>,
    viewport: ReturnType<typeof desktopViewport>,
    movingCompactFolder: boolean
  ) {
    const metrics = desktopTileMetrics(this.store.getSettings());
    const candidates: DesktopPosition[] = [];

    const pushCandidate = (x: number, y: number) => {
      candidates.push(this.clampedDesktopPosition(x, y, width, height, viewport));
    };

    for (const node of this.store.getNodes()) {
      if (excludeIds.has(node.id)) {
        continue;
      }

      const targetCompactFolder =
        node.type === "folder" && normalizeFolderAppearance(node.appearance).compactPlacement;
      if (!movingCompactFolder && !targetCompactFolder) {
        continue;
      }

      const slot = this.layout.get(node.id);
      if (!slot) {
        continue;
      }

      const target = {
        x: slot.x - viewport.offsetX,
        y: slot.y - viewport.offsetY,
        width: slot.width,
        height: slot.height
      };
      const verticalPositions = edgeAxisPositions(target.y, target.height, height, metrics.height + metrics.gapY);
      const horizontalPositions = edgeAxisPositions(target.x, target.width, width, metrics.width + metrics.gapX);

      verticalPositions.forEach((y) => {
        pushCandidate(target.x - metrics.gapX - width, y);
        pushCandidate(target.x + target.width + metrics.gapX, y);
      });
      horizontalPositions.forEach((x) => {
        pushCandidate(x, target.y - metrics.gapY - height);
        pushCandidate(x, target.y + target.height + metrics.gapY);
      });
    }

    return candidates;
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

    if (drag.targetHitRect && pointInMergeRect(x, y, drag.targetHitRect)) {
      return;
    }

    const hit = this.hitTestMergeTarget(x, y, drag.targetSnapshots);

    if (!hit) {
      this.clearMergeCandidate(drag);
      this.setMergeTarget(null);
      return;
    }

    if (drag.targetId === hit.id) {
      drag.targetIntent = hit.intent;
      drag.targetRect = hit.rect;
      drag.targetHitRect = hit.hitRect;
      return;
    }

    this.setMergeTarget(null);
    this.setMergeCandidate(drag, hit);
  }

  private setMergeCandidate(drag: ActiveDrag, candidate: DragTargetSnapshot) {
    if (drag.candidateTargetId === candidate.id) {
      drag.candidateTargetIntent = candidate.intent;
      drag.candidateTargetRect = candidate.rect;
      drag.candidateTargetHitRect = candidate.hitRect;
      return;
    }

    this.clearMergeCandidate(drag);
    drag.candidateTargetId = candidate.id;
    drag.candidateTargetIntent = candidate.intent;
    drag.candidateTargetRect = candidate.rect;
    drag.candidateTargetHitRect = candidate.hitRect;
    drag.mergeIntentTimer = window.setTimeout(() => {
      const active = this.drag;
      if (
        active !== drag ||
        active.committing ||
        active.candidateTargetId !== candidate.id ||
        active.candidateTargetIntent !== candidate.intent ||
        !active.candidateTargetRect ||
        !active.candidateTargetHitRect
      ) {
        return;
      }

      if (!pointInMergeRect(active.currentX, active.currentY, active.candidateTargetHitRect)) {
        this.clearMergeCandidate(active);
        return;
      }

      const targetRect = active.candidateTargetRect;
      const targetHitRect = active.candidateTargetHitRect;
      const targetIntent = active.candidateTargetIntent ?? "merge";
      this.clearMergeCandidate(active);
      this.setMergeTarget(candidate.id, targetRect, targetHitRect, targetIntent);
      this.scheduleDragFrame();
    }, candidate.intent === "trash" ? trashIntentDelayMs : mergeIntentDelayMs);
  }

  private clearMergeCandidate(drag: ActiveDrag | null = this.drag) {
    if (!drag) {
      return;
    }

    if (drag.mergeIntentTimer !== null) {
      window.clearTimeout(drag.mergeIntentTimer);
      drag.mergeIntentTimer = null;
    }
    drag.candidateTargetId = null;
    drag.candidateTargetIntent = null;
    drag.candidateTargetRect = null;
    drag.candidateTargetHitRect = null;
  }

  private captureMergeTargets(drag: ActiveDrag): DragTargetSnapshot[] {
    const sourceIds = this.desktopDragSourceIds(drag);
    const nodes = this.store.getNodes();
    const sourceItems = this.dragSourceItems(drag);
    if (!sourceItems) {
      return [];
    }
    const canTrashSource = sourceItems.length > 0 && sourceItems.every((item) => Boolean(item.path));

    const excludedIds = new Set(sourceIds);
    if (drag.source.type === "folder") {
      excludedIds.add(drag.source.folderId);
    }

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const snapshots: DragTargetSnapshot[] = [];
    this.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
      const id = element.dataset.nodeId;
      if (!id) {
        return;
      }

      const node = nodeById.get(id);
      if (!node || excludedIds.has(id)) {
        return;
      }

      const systemIconId = desktopSystemIconIdFromNodeId(node.id);
      const intent: DragTargetIntent | null =
        systemIconId === "recycleBin"
          ? (canTrashSource ? "trash" : null)
          : (node.type === "item" || node.type === "folder" ? "merge" : null);
      if (!intent) {
        return;
      }

      const rect = element.getBoundingClientRect();
      snapshots.push({
        id,
        intent,
        rect,
        hitRect: mergeHitRectForElement(element, rect)
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

  private dragSourceItems(drag: ActiveDrag): AppNode[] | null {
    if (drag.source.type === "folder") {
      const child = this.findFolderChild(drag.source.folderId, drag.source.childId);
      return child ? [child] : null;
    }

    const nodes = this.desktopDragSourceIds(drag).map((id) => this.findNode(id));
    if (nodes.length === 0 || nodes.some((node) => !node || node.type !== "item")) {
      return null;
    }

    return nodes as AppNode[];
  }

  private trashableDragSourceItems(drag: ActiveDrag) {
    const items = this.dragSourceItems(drag);
    return items && items.every((item) => Boolean(item.path)) ? items : [];
  }

  private hitTestMergeTarget(x: number, y: number, snapshots: DragTargetSnapshot[]) {
    let best: DragTargetSnapshot | null = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    for (const snapshot of snapshots) {
      const rect = snapshot.hitRect;
      if (!pointInMergeRect(x, y, rect)) {
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

  private setMergeTarget(
    targetId: string | null,
    targetRect: DOMRect | null = null,
    targetHitRect: Rect | null = null,
    targetIntent: DragTargetIntent = "merge"
  ) {
    const drag = this.drag;
    if (!drag) {
      return;
    }

    if (targetId) {
      this.clearMergeCandidate(drag);
    }

    if (drag.targetId === targetId) {
      drag.targetIntent = targetId ? targetIntent : null;
      if (targetRect) {
        drag.targetRect = targetRect;
      }
      return;
    }

    this.clearTargetStyles();
    drag.targetId = targetId;
    drag.targetIntent = null;
    drag.targetRect = null;
    drag.targetHitRect = null;
    drag.targetElement = null;

    if (!targetId) {
      return;
    }

    const target = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(targetId)}"]`);
    target?.classList.add("is-merge-target");
    target?.classList.toggle("is-trash-target", targetIntent === "trash");
    drag.lastPullX = 0;
    drag.lastPullY = 0;
    target?.style.setProperty("--merge-pull-x", "0px");
    target?.style.setProperty("--merge-pull-y", "0px");
    const resolvedTargetRect = targetRect ?? target?.getBoundingClientRect() ?? null;
    drag.targetIntent = targetIntent;
    drag.targetRect = resolvedTargetRect;
    drag.targetHitRect = targetHitRect ?? (target && resolvedTargetRect ? mergeHitRectForElement(target, resolvedTargetRect) : null);
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

  private async commitTrash(targetId: string) {
    const drag = this.drag;
    if (!drag || drag.committing) {
      return;
    }

    const trashItems = this.trashableDragSourceItems(drag);
    if (trashItems.length === 0) {
      this.setMergeTarget(null);
      return;
    }

    const targetElement = this.grid.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(targetId)}"]`);

    drag.committing = true;
    this.clearMergeCandidate(drag);
    if (drag.frame !== null) {
      cancelAnimationFrame(drag.frame);
      drag.frame = null;
    }
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);

    const trashSources = this.isDesktopGroupDrag(drag)
      ? drag.groupItems.map((item) => item.element)
      : [drag.element];
    const trashAnimation = targetElement
      ? playTrashGroupIntoTarget(trashSources, targetElement).catch((error) => {
          console.warn("Unable to play trash animation", error);
        })
      : Promise.resolve();
    if (targetElement) {
      this.clearMergeTargetElement(targetElement);
    }

    const deleteResults = Promise.all(trashItems.map(async (item) => {
      try {
        await deleteDesktopItem(item);
        return true;
      } catch (error) {
        console.warn("Unable to move item to recycle bin", item.name, error);
        return false;
      }
    }));

    const [, results] = await Promise.all([trashAnimation, deleteResults]);
    const deletedItems = trashItems.filter((_, index) => results[index]);
    if (deletedItems.length > 0) {
      await this.waitForDeletedItemsToLeaveScan(deletedItems);
    }

    this.clearDragVisualState(drag);
    if (drag.floating) {
      drag.element.remove();
    }

    this.drag = null;
    this.clearTargetStyles();

    if (deletedItems.length === 0) {
      this.renderWithFlip();
      return;
    }

    try {
      await this.refreshDesktopItems();
    } catch (error) {
      console.warn("Unable to refresh desktop after recycle bin drop", error);
      this.renderWithFlip();
    }
  }

  private async waitForDeletedItemsToLeaveScan(items: AppNode[], timeoutMs = 1000) {
    const deletedKeys = desktopItemIdentityKeys(items);
    const deadline = performance.now() + timeoutMs;
    let delayMs = 35;

    while (true) {
      const scanned = await scanDesktopItems({ includeIcons: false });
      if (!scanned.some((item) => desktopItemMatchesIdentityKeys(item, deletedKeys))) {
        return;
      }

      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        return;
      }

      await wait(Math.min(delayMs, remainingMs));
      delayMs = Math.min(Math.round(delayMs * 1.6), 180);
    }
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
    this.clearMergeCandidate(drag);
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
    this.clearMergeCandidate(drag);

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
    node.classList.remove("is-trash-target");
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
    if (this.consumeSuppressedClick()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const close = (event.target as HTMLElement).closest("[data-settings-close]");
    const reset = (event.target as HTMLElement).closest("[data-settings-reset]");
    const viewButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-settings-view]");
    const stepButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-step]");
    const layoutModeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-layout-mode]");
    const darkModeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-dark-mode]");
    const startupButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-start-with-windows]");
    const systemIconAddTrigger = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-system-icon-add-trigger]");
    const systemIconAddButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-system-icon-add]");
    const systemIconRemoveButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-system-icon-remove]");
    const contextMenuSubmenuTarget = (event.target as HTMLElement).closest<HTMLElement>("[data-setting-context-menu-submenu]");
    const contextMenuPlacementButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-context-menu-placement]");
    const contextMenuSeparatorButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-context-menu-separator]");
    const contextMenuResetButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-context-menu-reset]");
    const priorityTrigger = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-priority-trigger]");
    const priorityButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-app-priority]");
    const priorityPopover = (event.target as HTMLElement).closest<HTMLElement>("[data-setting-priority-popover]");

    if (!priorityTrigger && !priorityPopover && this.settingsPriorityMenuOpen) {
      this.settingsPriorityMenuOpen = false;
      this.renderSettingsPriorityMenu();
    }

    if (reset) {
      this.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      this.settingsSystemIconAddOpen = false;
      this.store.updateSettings(defaultDesktopSettings);
      void setAppProcessPriority(defaultDesktopSettings.appPriority);
      void setStartupEnabled(defaultDesktopSettings.startWithWindows);
      return;
    }

    const nextSettingsView = viewButton?.dataset.settingsView;
    if (isSettingsView(nextSettingsView)) {
      if (this.settingsView === "contextMenu" && this.settingsContextMenuParentKey && nextSettingsView === "main") {
        this.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.settingsContextMenuParentKey = null;
        this.renderSettingsLayer();
        return;
      }

      this.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      this.settingsSystemIconAddOpen = false;
      this.settingsContextMenuParentKey = null;
      this.settingsView = nextSettingsView;
      this.renderSettingsLayer();
      if (nextSettingsView === "system") {
        this.scheduleFullDesktopItemLoad(120);
      } else if (nextSettingsView === "contextMenu") {
        void this.refreshContextMenuSettingsPool();
      }
      return;
    }

    if (layoutModeButton?.dataset.settingLayoutMode === "auto" || layoutModeButton?.dataset.settingLayoutMode === "free") {
      this.cancelSettingsPreview();
      this.switchDesktopLayoutMode(layoutModeButton.dataset.settingLayoutMode);
      return;
    }

    if (darkModeButton) {
      this.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      const nextEnabled = this.store.getSettings().settingsDarkMode !== true;
      this.playSettingsToggleGhost(darkModeButton, nextEnabled, nextEnabled);
      this.store.updateSettings({ settingsDarkMode: nextEnabled });
      return;
    }

    if (startupButton) {
      this.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      const nextEnabled = this.store.getSettings().startWithWindows !== true;
      this.playSettingsToggleGhost(startupButton, nextEnabled);
      this.updateSettingsToggleRow(startupButton, nextEnabled);
      this.updateStartupSettingState(nextEnabled);
      void setStartupEnabled(nextEnabled).catch((error) => {
        console.warn("Unable to update startup setting", error);
        this.updateSettingsToggleRow(startupButton, !nextEnabled);
        this.updateStartupSettingState(!nextEnabled);
      });
      return;
    }

    if (systemIconAddTrigger) {
      this.settingsPriorityMenuOpen = false;
      this.settingsSystemIconAddOpen = !this.settingsSystemIconAddOpen;
      this.renderSettingsLayer();
      this.scheduleFullDesktopItemLoad(80);
      return;
    }

    if (systemIconAddButton) {
      const systemIconId = systemIconAddButton.dataset.settingSystemIconAdd;
      if (isDesktopSystemIconId(systemIconId)) {
        this.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.settingsSystemIconAddOpen = false;
        this.setSystemIconVisibility(systemIconId, true);
      }
      return;
    }

    if (systemIconRemoveButton) {
      const systemIconId = systemIconRemoveButton.dataset.settingSystemIconRemove;
      if (isDesktopSystemIconId(systemIconId)) {
        this.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.setSystemIconVisibility(systemIconId, false);
      }
      return;
    }

    if (contextMenuSubmenuTarget) {
      const key = contextMenuSubmenuTarget.dataset.settingContextMenuSubmenu;
      if (key) {
        this.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.settingsContextMenuParentKey = key;
        this.renderSettingsLayer();
      }
      return;
    }

    if (contextMenuPlacementButton) {
      const key = contextMenuPlacementButton.dataset.menuKey;
      const placement = contextMenuPlacementButton.dataset.settingContextMenuPlacement;
      if (key && isContextMenuPlacement(placement)) {
        this.cancelSettingsPreview();
        this.store.updateSettings({
          contextMenu: updateContextMenuItemPlacement(
            this.store.getSettings().contextMenu,
            this.cachedDesktopNativeMenuItems ?? [],
            key,
            placement,
            this.settingsContextMenuParentKey
          )
        });
      }
      return;
    }

    if (contextMenuSeparatorButton) {
      const key = contextMenuSeparatorButton.dataset.menuKey;
      if (key) {
        this.cancelSettingsPreview();
        this.store.updateSettings({
          contextMenu: toggleContextMenuSeparator(
            this.store.getSettings().contextMenu,
            this.cachedDesktopNativeMenuItems ?? [],
            key,
            this.settingsContextMenuParentKey
          )
        });
      }
      return;
    }

    if (contextMenuResetButton) {
      this.cancelSettingsPreview();
      this.store.updateSettings({ contextMenu: resetContextMenuSettings() });
      void this.refreshContextMenuSettingsPool();
      return;
    }

    if (priorityTrigger) {
      this.settingsPriorityMenuOpen = !this.settingsPriorityMenuOpen;
      this.renderSettingsPriorityMenu();
      return;
    }

    if (priorityButton) {
      const appPriority = priorityButton.dataset.settingAppPriority;
      if (isAppProcessPriority(appPriority)) {
        this.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.store.updateSettings({ appPriority });
        void setAppProcessPriority(appPriority);
      }
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
    this.settingsPriorityMenuOpen = false;
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

  private onSettingsContextMenuPointerDown(event: PointerEvent) {
    if (event.button !== 0 || this.settingsView !== "contextMenu") {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select")) {
      return;
    }

    const row = target.closest<HTMLElement>("[data-setting-context-menu-drag]");
    const key = row?.dataset.settingContextMenuDrag;
    const placement = row?.dataset.settingContextMenuPlacement;
    if (!row || !key || !isEditableContextMenuPlacement(placement)) {
      return;
    }

    event.preventDefault();
    this.settingsContextMenuDrag = {
      key,
      placement,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: row.getBoundingClientRect(),
      row,
      active: false,
      lastTarget: null
    };

    try {
      row.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level listeners keep the drag alive if capture is unavailable.
    }

    window.addEventListener("pointermove", this.onSettingsContextMenuPointerMove);
    window.addEventListener("pointerup", this.onSettingsContextMenuPointerUp, { once: true });
    window.addEventListener("pointercancel", this.onSettingsContextMenuPointerCancel, { once: true });
    window.addEventListener("blur", this.onSettingsContextMenuPointerCancel, { once: true });
  }

  private readonly onSettingsContextMenuPointerMove = (event: PointerEvent) => {
    const drag = this.settingsContextMenuDrag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 2) {
        return;
      }

      drag.active = true;
      drag.row.classList.add("is-dragging");
      this.settingsLayer.classList.add("is-menu-dragging");
    }

    event.preventDefault();
    drag.row.style.setProperty("--settings-menu-drag-y", `${dy}px`);
    const target = this.settingsContextMenuDropTargetAt(event.clientX, event.clientY, drag);
    drag.lastTarget = target;
    this.paintSettingsContextMenuDropTarget(target);
  };

  private readonly onSettingsContextMenuPointerUp = (event: PointerEvent) => {
    const drag = this.settingsContextMenuDrag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const target = drag.active
      ? this.settingsContextMenuDropTargetAt(event.clientX, event.clientY, drag) ?? drag.lastTarget
      : null;
    const shouldCommit = drag.active && target && target.targetKey !== drag.key;
    const key = drag.key;
    const placement = drag.placement;
    this.clearSettingsContextMenuDropState();
    this.removeSettingsContextMenuDragListeners();

    if (!shouldCommit) {
      return;
    }

    event.preventDefault();
    this.suppressNextClick = true;
    window.setTimeout(() => {
      this.suppressNextClick = false;
    }, 0);
    this.store.updateSettings({
      contextMenu: reorderContextMenuItem(
        this.store.getSettings().contextMenu,
        this.cachedDesktopNativeMenuItems ?? [],
        key,
        target.targetKey,
        placement,
        target.position,
        this.settingsContextMenuParentKey
      )
    });
  };

  private readonly onSettingsContextMenuPointerCancel = () => {
    this.clearSettingsContextMenuDropState();
    this.removeSettingsContextMenuDragListeners();
  };

  private removeSettingsContextMenuDragListeners() {
    window.removeEventListener("pointermove", this.onSettingsContextMenuPointerMove);
    window.removeEventListener("pointerup", this.onSettingsContextMenuPointerUp);
    window.removeEventListener("pointercancel", this.onSettingsContextMenuPointerCancel);
    window.removeEventListener("blur", this.onSettingsContextMenuPointerCancel);
  }

  private settingsContextMenuDropTargetAt(
    clientX: number,
    clientY: number,
    drag: SettingsContextMenuDragState
  ): SettingsContextMenuDropTarget | null {
    if (
      clientX >= drag.startRect.left &&
      clientX <= drag.startRect.right &&
      clientY >= drag.startRect.top &&
      clientY <= drag.startRect.bottom
    ) {
      return null;
    }

    const previousPointerEvents = drag.row.style.pointerEvents;
    drag.row.style.pointerEvents = "none";
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    drag.row.style.pointerEvents = previousPointerEvents;
    return target ? this.settingsContextMenuDropTargetForElement(target, clientY, drag) : null;
  }

  private settingsContextMenuDropTargetForElement(
    target: HTMLElement,
    clientY: number,
    drag: SettingsContextMenuDragState
  ): SettingsContextMenuDropTarget | null {
    const list = target.closest<HTMLElement>("[data-setting-context-menu-list]");
    const placement = list?.dataset.settingContextMenuList;
    if (!list || placement !== drag.placement) {
      return null;
    }

    const divider = target.closest<HTMLElement>("[data-setting-context-menu-drop-after]");
    if (divider && list.contains(divider)) {
      const targetKey = divider.dataset.settingContextMenuDropAfter ?? null;
      return targetKey && targetKey !== drag.key ? { list, row: divider, targetKey, position: "after" } : null;
    }

    const row = target.closest<HTMLElement>("[data-setting-context-menu-drag]");
    if (row && list.contains(row)) {
      const targetKey = row.dataset.settingContextMenuDrag ?? null;
      if (targetKey === drag.key) {
        return null;
      }

      const rect = row.getBoundingClientRect();
      const position = clientY > rect.top + rect.height / 2 ? "after" : "before";
      return { list, row, targetKey, position };
    }

    return { list, row: null, targetKey: null, position: "end" };
  }

  private paintSettingsContextMenuDropTarget(target: SettingsContextMenuDropTarget | null) {
    if (sameSettingsContextMenuDropTarget(this.settingsContextMenuPaintedDrop, target)) {
      return;
    }

    this.clearSettingsContextMenuDropMarker(this.settingsContextMenuPaintedDrop);
    this.settingsContextMenuPaintedDrop = target;
    if (!target) {
      return;
    }

    if (target.row) {
      target.row.classList.add(target.position === "after" ? "is-drop-after" : "is-drop-before");
    } else {
      target.list.classList.add("is-drop-end");
    }
  }

  private clearSettingsContextMenuDropMarkers() {
    this.clearSettingsContextMenuDropMarker(this.settingsContextMenuPaintedDrop);
    this.settingsContextMenuPaintedDrop = null;
  }

  private clearSettingsContextMenuDropMarker(target: SettingsContextMenuDropTarget | null) {
    if (!target) {
      return;
    }

    target.row?.classList.remove("is-drop-before", "is-drop-after");
    target.list.classList.remove("is-drop-end");
  }

  private clearSettingsContextMenuDropState() {
    this.clearSettingsContextMenuDropMarkers();
    this.settingsLayer.querySelectorAll(".is-dragging").forEach((element) => {
      (element as HTMLElement).style.removeProperty("--settings-menu-drag-y");
      element.classList.remove("is-dragging");
    });
    this.settingsLayer.classList.remove("is-menu-dragging");
    this.settingsContextMenuDrag = null;
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
      this.commitSettingValue(key, next, false);
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
    const currentLayoutMode = this.store.getSettings().layoutMode;
    if (layoutMode === currentLayoutMode) {
      return;
    }

    const previousSuppress = this.suppressStoreRender;
    this.suppressStoreRender = true;

    try {
      if (layoutMode === "free" && currentLayoutMode !== "free") {
        this.seedFreeLayoutPositions();
      }
      this.store.updateSettings({ layoutMode });
    } finally {
      this.suppressStoreRender = previousSuppress;
    }

    this.renderWithFlip();
  }

  private seedFreeLayoutPositions() {
    const viewport = desktopViewport();
    const positions = this.store.getNodes()
      .map((node) => {
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

  private autoArrangeFreeDesktop() {
    const nodes = this.store.getNodes();
    const settings = this.store.getSettings();
    if (settings.layoutMode !== "free" || nodes.length === 0) {
      return;
    }

    const viewport = desktopViewport();
    const arrangedSettings: DesktopSettings = { ...settings, layoutMode: "auto" };
    const orderedNodes = this.freeLayoutVisualNodes(nodes);
    const arrangedLayout = computeDesktopLayout(
      orderedNodes,
      viewport.width,
      viewport.height,
      arrangedSettings,
      viewport.offsetX,
      viewport.offsetY
    );
    const positions = orderedNodes
      .map((node) => {
        const slot = arrangedLayout.get(node.id);
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

    this.store.updateNodeOrderAndPositions(orderedNodes.map((node) => node.id), positions);
  }

  private freeLayoutVisualNodes(nodes: DesktopNode[]) {
    const metrics = desktopTileMetrics(this.store.getSettings());
    const rowTolerance = Math.max(18, Math.round(metrics.height * 0.45));
    const entries = nodes.map((node, index) => ({
      node,
      index,
      slot: this.layout.get(node.id) ?? null
    }));
    const rows: Array<{
      y: number;
      entries: Array<{ node: DesktopNode; index: number; slot: LayoutSlot }>;
    }> = [];
    const missing: Array<{ node: DesktopNode; index: number }> = [];

    entries
      .sort(
        (a, b) =>
          (a.slot?.y ?? Number.POSITIVE_INFINITY) - (b.slot?.y ?? Number.POSITIVE_INFINITY) ||
          (a.slot?.x ?? 0) - (b.slot?.x ?? 0) ||
          a.index - b.index
      )
      .forEach((entry) => {
        if (!entry.slot) {
          missing.push({ node: entry.node, index: entry.index });
          return;
        }

        const row = rows.at(-1);
        if (row && Math.abs(entry.slot.y - row.y) <= rowTolerance) {
          row.entries.push({ node: entry.node, index: entry.index, slot: entry.slot });
          row.y = Math.round((row.y * (row.entries.length - 1) + entry.slot.y) / row.entries.length);
          return;
        }

        rows.push({
          y: entry.slot.y,
          entries: [{ node: entry.node, index: entry.index, slot: entry.slot }]
        });
      });

    return [
      ...rows.flatMap((row) =>
        row.entries
          .sort((a, b) => a.slot.x - b.slot.x || a.index - b.index)
          .map((entry) => entry.node)
      ),
      ...missing
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.node)
    ];
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

  private setSystemIconVisibility(systemIconId: DesktopSystemIconId, visible: boolean) {
    const current = this.store.getSettings().systemIcons;
    if (current[systemIconId] === visible) {
      return;
    }

    this.store.updateSettings({
      systemIcons: {
        ...current,
        [systemIconId]: visible
      }
    });
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
      this.setContextSubmenuOpen(submenuButton, true);
      return;
    }

    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-context-action], [data-native-command-id]");
    const action = button?.dataset.contextAction as DesktopContextMenuAction | undefined;
    const nativeCommandId = Number(button?.dataset.nativeCommandId);
    if ((!action && !Number.isFinite(nativeCommandId)) || !this.contextMenu) {
      return;
    }

    const menu = this.contextMenu;
    this.closeContextMenu();

    try {
      if (Number.isFinite(nativeCommandId) && menu.type === "desktop") {
        const result = await invokeNativeDesktopContextMenuCommand(nativeCommandId);
        if (result.invoked) {
          await this.syncAfterNativeShellCommand();
        }
        return;
      }

      if (action === "refresh") {
        await this.refreshDesktopItems();
        return;
      }

      if (action === "autoArrange") {
        this.autoArrangeFreeDesktop();
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

      if (action === "settings") {
        this.settingsOpen = true;
        this.settingsView = "main";
        this.renderSettingsLayer();
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
      } else if (action === "folderCompactPlacement") {
        if (node.type === "folder") {
          const appearance = normalizeFolderAppearance(node.appearance);
          this.store.updateFolderAppearance(node.id, {
            compactPlacement: !appearance.compactPlacement
          });
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

  private handleContextMenuAccessKey(event: KeyboardEvent) {
    if (!this.contextMenu || this.ratioDialogTargetId || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
      return false;
    }

    const key = event.key.toLowerCase();
    const button = this.contextMenuAccessKeyButton(key);
    if (!button) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.contextSubmenu) {
      this.setContextSubmenuOpen(button, false);
    } else {
      button.click();
    }
    return true;
  }

  private contextMenuAccessKeyButton(key: string) {
    const root = this.contextMenuLayer.querySelector<HTMLElement>(".context-menu");
    if (!root) {
      return null;
    }

    const openSubmenus = Array.from(this.contextMenuLayer.querySelectorAll<HTMLElement>(".context-menu-item.is-submenu-open > .context-submenu"));
    const scopes = [...openSubmenus.reverse(), root];
    for (const scope of scopes) {
      const button = directContextMenuButtons(scope).find(
        (candidate) => candidate.dataset.contextAccessKey === key && !candidate.disabled
      );
      if (button) {
        return button;
      }
    }

    return null;
  }

  private setContextSubmenuOpen(button: HTMLButtonElement, toggle: boolean) {
    const item = button.closest<HTMLElement>(".context-menu-item");
    const parent = item?.parentElement;
    if (!item || !parent) {
      return;
    }

    Array.from(parent.children).forEach((child) => {
      if (child !== item && child instanceof HTMLElement && child.classList.contains("context-menu-item")) {
        child.classList.remove("is-submenu-open");
      }
    });

    item.classList.toggle("is-submenu-open", toggle ? !item.classList.contains("is-submenu-open") : true);
    this.clampContextSubmenus();
  }

  private findNode(id: string): DesktopNode | null {
    return this.store.getNodes().find((node) => node.id === id) ?? null;
  }

  private findFolder(id: string): FolderNode | null {
    const node = this.findNode(id);
    return node?.type === "folder" ? node : null;
  }

  private isCompactPlacementFolder(id: string) {
    const folder = this.findFolder(id);
    return Boolean(folder && normalizeFolderAppearance(folder.appearance).compactPlacement);
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

  private async openCustomDesktopContextMenu(x: number, y: number) {
    const requestVersion = this.beginContextOverlayRequest();
    if (this.cachedDesktopNativeMenuItems) {
      this.contextMenu = {
        type: "desktop",
        x,
        y,
        nativeItems: this.cachedDesktopNativeMenuItems
      };
      this.renderContextMenu();
      void this.loadNativeDesktopMenuItems().catch((error) => {
        console.warn("Unable to refresh native desktop context menu", error);
      });
      return;
    }

    try {
      const nativeItems = await this.loadNativeDesktopMenuItems();
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      this.contextMenu = { type: "desktop", x, y, nativeItems };
      this.renderContextMenu();
    } catch (error) {
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      console.warn("Unable to list native desktop context menu", error);
      this.contextMenu = { type: "desktop", x, y };
      this.renderContextMenu();
    }
  }

  private loadNativeDesktopMenuItems() {
    if (this.desktopNativeMenuLoad) {
      return this.desktopNativeMenuLoad;
    }

    this.desktopNativeMenuLoad = listNativeDesktopContextMenu()
      .then((items) => {
        this.cachedDesktopNativeMenuItems = items;
        return items;
      })
      .finally(() => {
        this.desktopNativeMenuLoad = null;
      });

    return this.desktopNativeMenuLoad;
  }

  private async refreshContextMenuSettingsPool() {
    try {
      await this.loadNativeDesktopMenuItems();
    } catch (error) {
      console.warn("Unable to refresh context menu settings pool", error);
      return;
    }

    if (this.settingsOpen && this.settingsView === "contextMenu") {
      this.renderSettingsLayer();
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

    if (this.handleContextMenuAccessKey(event)) {
      return;
    }

    if (event.key === "Escape") {
      if (this.contextMenu || this.ratioDialogTargetId) {
        this.clearContextOverlay();
        return;
      }

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

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
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

function sameSettingsContextMenuDropTarget(
  a: SettingsContextMenuDropTarget | null,
  b: SettingsContextMenuDropTarget | null
) {
  return a?.list === b?.list && a?.row === b?.row && a?.targetKey === b?.targetKey && a?.position === b?.position;
}

function directContextMenuButtons(scope: HTMLElement) {
  return Array.from(scope.children)
    .map((child) => {
      if (!(child instanceof HTMLElement) || !child.classList.contains("context-menu-item")) {
        return null;
      }

      const button = child.firstElementChild;
      return button instanceof HTMLButtonElement ? button : null;
    })
    .filter((button): button is HTMLButtonElement => Boolean(button));
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

function desktopItemIdentityKeys(items: AppNode[]) {
  const keys = new Set<string>();
  items.forEach((item) => addDesktopItemIdentityKeys(keys, item));
  return keys;
}

function desktopItemMatchesIdentityKeys(item: AppNode, keys: Set<string>) {
  if (keys.has(`id:${item.id}`)) {
    return true;
  }

  return desktopItemPathKeys(item).some((key) => keys.has(key));
}

function addDesktopItemIdentityKeys(keys: Set<string>, item: AppNode) {
  keys.add(`id:${item.id}`);
  desktopItemPathKeys(item).forEach((key) => keys.add(key));
}

function desktopItemPathKeys(item: AppNode) {
  return [item.path, item.launchId]
    .filter((value): value is string => Boolean(value))
    .map((value) => `path:${normalizeDesktopItemPathKey(value)}`);
}

function normalizeDesktopItemPathKey(value: string) {
  let path = value.trim();
  if (path.startsWith("\\\\?\\UNC\\")) {
    path = `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  } else if (path.startsWith("\\\\?\\")) {
    path = path.slice("\\\\?\\".length);
  }

  return path.replace(/\//g, "\\").replace(/\\+$/g, "").toLocaleLowerCase();
}

function isNavigationKey(key: string) {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End";
}

type NumericDesktopSettingKey = Exclude<
  keyof DesktopSettings,
  "layoutMode" | "appPriority" | "settingsDarkMode" | "startWithWindows" | "systemIcons" | "contextMenu"
>;

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

function isContextMenuPlacement(value: unknown): value is DesktopContextMenuPlacement {
  return value === "main" || value === "more" || value === "hidden";
}

function isEditableContextMenuPlacement(value: unknown): value is Exclude<DesktopContextMenuPlacement, "hidden"> {
  return value === "main" || value === "more";
}

function isSettingsView(value: unknown): value is SettingsView {
  return value === "main" || value === "layout" || value === "system" || value === "contextMenu";
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

function mergeHitRectForElement(element: HTMLElement, tileRect: DOMRect): Rect {
  const iconRect = element.querySelector<HTMLElement>(".icon-shell")?.getBoundingClientRect() ?? tileRect;
  const padX = Math.max(6, Math.min(10, tileRect.width * 0.09));
  const padY = Math.max(6, Math.min(10, tileRect.height * 0.08));
  return expandedRect(iconRect, padX, padY);
}

function expandedRect(rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">, padX: number, padY: number): Rect {
  const left = rect.left - padX;
  const top = rect.top - padY;
  const right = rect.right + padX;
  const bottom = rect.bottom + padY;

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

function edgeAxisPositions(start: number, size: number, itemSize: number, pitch: number) {
  const positions: number[] = [];
  const maxStart = start + Math.max(0, size - itemSize);
  const safePitch = Math.max(1, pitch);
  const push = (value: number) => {
    const rounded = Math.round(value);
    if (!positions.some((position) => Math.abs(position - rounded) < 1)) {
      positions.push(rounded);
    }
  };

  push(start);
  for (let position = start + safePitch; position < maxStart - 0.5; position += safePitch) {
    push(position);
  }
  push(maxStart);

  return positions;
}

function uniqueDesktopPositions(positions: DesktopPosition[]) {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = `${Math.round(position.x)}:${Math.round(position.y)}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function desktopPositionDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointInMergeRect(x: number, y: number, rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
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
