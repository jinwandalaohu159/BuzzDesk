import { playFolderClose, playFolderOpen } from "../../animation/folderPanel";
import { panelSizeFor } from "../../layout/grid";
import { renderFolderLayerContent } from "../../render/folderLayerView";
import { folderTileMetrics } from "../../settings/desktopSettings";
import { desktopViewport } from "../../system/desktopViewport";
import { clampScroll, layoutToClient } from "../support/geometry";
import type {
  DesktopSettings,
  FolderAppearanceSettings,
  FolderNode,
  LayoutSlot
} from "../../types";
import type { FolderOpenOrigin } from "../../render/folderLayerView";
import type { DesktopApp } from "../DesktopApp";

const defaultFolderName = "\u6587\u4ef6\u5939";
const folderPagerHeight = 30;

export type FolderPanelHost = Pick<
  DesktopApp,
  "findFolder"
  | "folderInput"
  | "folderLayer"
  | "freePlacement"
  | "items"
  | "keyboard"
  | "layout"
  | "root"
  | "rename"
  | "selection"
  | "settings"
  | "settingsActions"
  | "store"
  | "tileElement"
>;

// The open-folder panel: open / close animations, rendering, paging and name editing.
export class FolderPanel {
  openFolderId: string | null = null;
  renderedFolderId: string | null = null;
  private hiddenOpenFolderTileId: string | null = null;
  private openFolderPage = 0;
  folderOpenOrigin: FolderOpenOrigin | null = null;
  editingFolder = false;
  folderClosing = false;
  // A folder clicked while another one is still closing opens right after.
  private queuedOpenFolderId: string | null = null;
  selectedFolderChild: { folderId: string; childId: string } | null = null;

  constructor(private readonly app: FolderPanelHost) {}

  renderFolderLayer(
    settingsOverride?: DesktopSettings,
    folderAppearanceOverride?: FolderAppearanceSettings
  ) {
    if (this.folderClosing) {
      // The closing panel still shrinks into its tile: keep that tile hidden
      // even if the desktop was re-rendered meanwhile.
      this.syncOpenFolderTileState(this.openFolderId);
      return;
    }

    const folder = this.getOpenFolder();
    this.syncOpenFolderTileState(folder?.id ?? null);
    this.app.folderLayer.classList.toggle("is-open", Boolean(folder));
    this.app.folderLayer.classList.remove("is-closing");

    if (!folder) {
      this.folderOpenOrigin = null;
      this.app.rename.renamingFolderChild = null;
      this.selectedFolderChild = null;
      this.openFolderId = null;
      this.renderedFolderId = null;
      this.app.folderLayer.replaceChildren();
      return;
    }

    const animate = this.renderedFolderId !== folder.id;
    this.renderedFolderId = folder.id;
    const appearance = folderAppearanceOverride ?? folder.appearance;
    const size = this.folderPanelSize(folder, appearance);
    const pageSize = Math.max(1, size.columns * size.rows);
    const pageCount = Math.max(1, Math.ceil(folder.children.length / pageSize));
    this.openFolderPage = clampScroll(this.openFolderPage, 0, pageCount - 1);
    this.app.folderLayer.replaceChildren(
      ...renderFolderLayerContent(folder, {
        editing: this.editingFolder,
        renamingChildId:
          this.app.rename.renamingFolderChild?.folderId === folder.id ? this.app.rename.renamingFolderChild.childId : null,
        selectedChildId:
          this.selectedFolderChild?.folderId === folder.id ? this.selectedFolderChild.childId : null,
        openingIds: this.app.items.openingIds,
        origin: this.folderOpenOrigin,
        size,
        page: this.openFolderPage,
        pageCount,
        pageSize,
        animate
      })
    );
    this.bindFolderNameInput(folder);
    this.app.rename.bindFolderChildRenameInput(folder);
    if (animate) {
      const panel = this.app.folderLayer.querySelector<HTMLElement>(".folder-panel");
      const backdrop = this.app.folderLayer.querySelector<HTMLElement>(".folder-backdrop");
      if (panel) {
        void playFolderOpen(panel, backdrop, this.folderOpenOrigin).then(() => {
          if (this.openFolderId === folder.id && !this.folderClosing && this.app.folderLayer.contains(panel)) {
            this.settleFolderAnimation(panel, backdrop);
          }
        });
      }
    }
  }

  private syncOpenFolderTileState(folderId: string | null) {
    if (this.hiddenOpenFolderTileId && this.hiddenOpenFolderTileId !== folderId) {
      this.app.tileElement(this.hiddenOpenFolderTileId)?.classList.remove("is-folder-open");
    }

    this.hiddenOpenFolderTileId = folderId;

    if (!folderId) {
      return;
    }

    const current = this.app.tileElement(folderId);
    current?.classList.add("is-folder-open");
  }

  private bindFolderNameInput(folder: FolderNode) {
    const input = this.app.folderLayer.querySelector<HTMLInputElement>("[data-folder-name-input]");
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
      this.app.store.renameFolder(folder.id, nextName);
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

  getOpenFolder() {
    if (!this.openFolderId) {
      return null;
    }

    return this.app.findFolder(this.openFolderId);
  }

  folderPaging(folder: FolderNode) {
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

  setOpenFolderPage(page: number, transitionStart?: { dragX: number; width: number }) {
    const folder = this.getOpenFolder();
    if (!folder) {
      return;
    }

    const paging = this.folderPaging(folder);
    const nextPage = clampScroll(Math.round(page), 0, paging.pageCount - 1);
    const currentPage = paging.page;
    if (nextPage === currentPage) {
      this.app.folderInput.settleFolderPageDragStyle();
      return;
    }

    this.openFolderPage = nextPage;
    this.selectedFolderChild = null;
    this.app.rename.renamingFolderChild = null;
    this.app.folderLayer.querySelectorAll<HTMLElement>(".folder-item.is-selected").forEach((item) => {
      item.classList.remove("is-selected");
    });

    const panel = this.app.folderLayer.querySelector<HTMLElement>(".folder-panel");
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

    this.app.folderInput.clearFolderPageDragStyle();
    this.updateFolderPageView(nextPage);
  }

  private updateFolderPageView(page: number) {
    const pages = this.app.folderLayer.querySelector<HTMLElement>(".folder-pages");
    pages?.style.setProperty("--folder-page-offset", `${page * -100}%`);

    const previousPage = this.app.folderLayer.querySelector<HTMLElement>(".folder-items.is-current-page");
    const currentPage = this.app.folderLayer.querySelector<HTMLElement>(`.folder-items[data-folder-page="${page}"]`);
    if (previousPage && previousPage !== currentPage) {
      this.updateFolderPageAccessibility(previousPage, false);
    }
    if (currentPage) {
      this.updateFolderPageAccessibility(currentPage, true);
    }

    this.app.folderLayer.querySelectorAll<HTMLElement>("[data-folder-page-index]").forEach((dot) => {
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

  async closeFolder() {
    if (!this.openFolderId || this.folderClosing) {
      return;
    }

    const panel = this.app.folderLayer.querySelector<HTMLElement>(".folder-panel");
    const backdrop = this.app.folderLayer.querySelector<HTMLElement>(".folder-backdrop");
    if (!panel) {
      this.closeFolderNow();
      return;
    }

    const origin = this.refreshFolderCloseOrigin() ?? this.folderOpenOrigin;
    this.editingFolder = false;
    this.folderClosing = true;
    this.app.folderLayer.classList.add("is-closing");
    panel.classList.add("is-performance-animating");

    try {
      await playFolderClose(panel, backdrop, origin);
    } finally {
      const queued = this.queuedOpenFolderId;
      this.folderClosing = false;
      this.closeFolderNow();
      const next = queued ? this.app.findFolder(queued) : null;
      if (next) {
        this.openFolderFromNode(next);
      }
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

  moveFolderChildOut(folderId: string, childId: string) {
    const folder = this.app.findFolder(folderId);
    const nodes = this.app.store.getNodes();
    const folderIndex = nodes.findIndex((node) => node.id === folderId);
    const targetIndex = folderIndex >= 0 ? folderIndex + 1 : nodes.length;
    const position = folder ? this.app.freePlacement.freeFolderChildPosition(folder, childId) : null;

    this.app.selection.selectSingleDesktopNode(childId);
    this.app.rename.renamingFolderChild = null;
    const changed = this.app.store.moveFolderChildToDesktop(folderId, childId, targetIndex, position);
    if (!changed) {
      this.renderFolderLayer();
      return;
    }

    if (!this.app.findFolder(folderId)) {
      this.closeFolderNow();
    }
    this.app.keyboard.focusDesktopNode(childId);
  }

  openFolderFromNode(node: FolderNode) {
    if (this.folderClosing) {
      this.queuedOpenFolderId = node.id;
      return;
    }

    const element = this.app.tileElement(node.id);
    if (element) {
      this.openFolderFromElement(node, element);
      return;
    }

    this.folderOpenOrigin = this.currentFolderOpenOrigin(node);
    this.openFolderId = node.id;
    this.openFolderPage = 0;
    this.editingFolder = false;
    this.app.rename.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  openFolderFromElement(node: FolderNode, element: HTMLElement) {
    if (this.folderClosing) {
      this.queuedOpenFolderId = node.id;
      return;
    }

    this.app.settings.settingsOpen = false;
    this.app.settings.renderSettingsLayer();

    const cover = element.querySelector<HTMLElement>(".folder-cover");
    const rect = cover?.getBoundingClientRect() ?? element.getBoundingClientRect();
    this.folderOpenOrigin = this.folderOpenOriginForRect(node, rect);
    this.openFolderId = node.id;
    this.openFolderPage = 0;
    this.editingFolder = false;
    this.app.rename.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }

  private currentFolderOpenOrigin(node: FolderNode): FolderOpenOrigin | null {
    const element = this.app.tileElement(node.id);
    if (element) {
      const cover = element.querySelector<HTMLElement>(".folder-cover");
      const rect = cover?.getBoundingClientRect() ?? element.getBoundingClientRect();
      return this.folderOpenOriginForRect(node, rect);
    }

    const slot = this.app.layout.get(node.id);
    return slot ? this.folderOpenOriginForRect(node, this.folderCoverRectForSlot(node, slot)) : null;
  }

  private folderCoverRectForSlot(
    node: FolderNode,
    slot: LayoutSlot
  ): Pick<DOMRect, "left" | "top" | "width" | "height"> {
    const viewport = desktopViewport();
    const settings = this.app.settingsActions.effectiveDesktopSettings(
      this.app.store.getSettings(),
      this.app.store.getNodes(),
      viewport
    );
    const metrics = folderTileMetrics(settings, node.appearance);
    const coverWidth = metrics.iconShellWidth;
    const coverHeight = metrics.iconShellHeight;

    const origin = layoutToClient(this.app.root, slot.x, slot.y);
    return {
      left: origin.x + slot.width / 2 - coverWidth / 2,
      top: origin.y + 8,
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

  closeFolderNow() {
    this.queuedOpenFolderId = null;
    this.folderClosing = false;
    this.openFolderId = null;
    this.renderedFolderId = null;
    this.folderOpenOrigin = null;
    this.openFolderPage = 0;
    this.app.folderInput.cancelFolderSwipe();
    this.editingFolder = false;
    this.app.rename.renamingFolderChild = null;
    this.selectedFolderChild = null;
    this.renderFolderLayer();
  }
}
