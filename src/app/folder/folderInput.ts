import { clampScroll } from "../support/geometry";
import type { ActiveDrag } from "../drag/dragTypes";
import type { DesktopApp } from "../DesktopApp";

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

export type FolderInputHost = Pick<
  DesktopApp,
  "consumeSuppressedClick"
  | "desktopInput"
  | "dragging"
  | "findFolder"
  | "findFolderChild"
  | "folder"
  | "folderLayer"
  | "items"
  | "menus"
  | "selection"
  | "settings"
>;

// Pointer, click and context-menu events inside the open folder, including page swipes.
export class FolderInput {
  private folderSwipe: FolderSwipe | null = null;

  constructor(private readonly app: FolderInputHost) {}

  onFolderPointerDown(event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("[data-folder-child-rename-id]")) {
      return;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const childId = item?.dataset.folderChildId;
    const folderId = item?.dataset.parentFolderId;
    const child = this.app.findFolder(folderId ?? "")?.children.find((node) => node.id === childId);
    if (item && child && folderId && childId) {
      this.app.desktopInput.previewFolderChildPress(folderId, childId, item);
      const rect = item.getBoundingClientRect();
      this.app.dragging.beginDrag({
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
    const folder = this.app.folder.getOpenFolder();
    if (!folder) {
      return;
    }

    const paging = this.app.folder.folderPaging(folder);
    if (paging.pageCount <= 1) {
      return;
    }

    const viewport = this.app.folderLayer.querySelector<HTMLElement>(".folder-items-viewport");
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
      this.app.folderLayer.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners below keep the swipe alive if capture is unavailable.
    }

    window.addEventListener("pointermove", this.onFolderSwipeMove);
    window.addEventListener("pointerup", this.onFolderSwipeEnd, { once: true });
    window.addEventListener("pointercancel", this.onFolderSwipeCancel, { once: true });
  }

  promoteFolderDragToPageSwipe(drag: ActiveDrag, event: PointerEvent) {
    this.app.dragging.releaseDrag(drag);
    drag.element.classList.remove("is-selected");
    this.app.selection.clearAllSelection();
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
    const panel = this.app.folderLayer.querySelector<HTMLElement>(".folder-panel");
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
      this.app.folder.setOpenFolderPage(swipe.page + 1, { dragX: dx, width: swipe.width });
      return;
    }

    if (swipe.started && dx >= threshold) {
      this.app.folder.setOpenFolderPage(swipe.page - 1, { dragX: dx, width: swipe.width });
      return;
    }

    this.settleFolderPageDragStyle();
  };

  private readonly onFolderSwipeCancel = () => {
    this.cancelFolderSwipe();
  };

  cancelFolderSwipe() {
    this.removeFolderSwipeListeners();
    this.folderSwipe = null;
    this.clearFolderPageDragStyle();
  }

  private removeFolderSwipeListeners() {
    window.removeEventListener("pointermove", this.onFolderSwipeMove);
    window.removeEventListener("pointerup", this.onFolderSwipeEnd);
    window.removeEventListener("pointercancel", this.onFolderSwipeCancel);
  }

  clearFolderPageDragStyle() {
    const panel = this.app.folderLayer.querySelector<HTMLElement>(".folder-panel");
    panel?.classList.remove("is-page-dragging");
    panel?.style.removeProperty("--folder-page-drag-x");
  }

  settleFolderPageDragStyle() {
    const panel = this.app.folderLayer.querySelector<HTMLElement>(".folder-panel");
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

  onFolderContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.app.menus.clearContextOverlay();

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const childId = item?.dataset.folderChildId;
    const folderId = item?.dataset.parentFolderId;
    const child = this.app.findFolderChild(folderId ?? "", childId ?? "");
    if (!item || !folderId || !childId || !child) {
      return;
    }

    this.app.settings.settingsOpen = false;
    this.app.settings.renderSettingsLayer();
    this.app.selection.clearDesktopSelection();
    this.app.folder.selectedFolderChild = { folderId, childId };
    this.app.folder.renderFolderLayer();
    void this.app.menus.openNativeContextMenu(child, event.clientX, event.clientY, {
      type: "folderItem",
      x: event.clientX,
      y: event.clientY,
      folderId,
      childId
    });
  }

  onFolderLayerClick(event: MouseEvent) {
    if (this.app.consumeSuppressedClick()) {
      return;
    }

    const pageButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-folder-page-index]");
    if (pageButton) {
      event.preventDefault();
      event.stopPropagation();
      const page = Number(pageButton.dataset.folderPageIndex);
      if (Number.isFinite(page)) {
        this.app.folder.setOpenFolderPage(page);
      }
      return;
    }

    if ((event.target as HTMLElement).classList.contains("folder-backdrop")) {
      void this.app.folder.closeFolder();
    }
  }

  onFolderLayerDoubleClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest("[data-folder-child-rename-id]")) {
      return;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    if (item) {
      event.preventDefault();
      event.stopPropagation();

      const child = this.app.findFolderChild(item.dataset.parentFolderId ?? "", item.dataset.folderChildId ?? "");
      if (child) {
        void this.app.items.openItem(child);
      }
      return;
    }

    const title = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-title]");
    if (!title) {
      return;
    }

    this.app.folder.editingFolder = true;
    this.app.folder.renderFolderLayer();
  }
}
