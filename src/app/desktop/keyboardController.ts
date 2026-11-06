import { copyDesktopItem, pasteDesktopItems } from "../../system/desktopApi";
import { desktopNavigationNode } from "../../interaction/keyboardNavigation";
import { isNavigationKey, nextGridIndex } from "../support/guards";
import type { DesktopApp } from "../DesktopApp";

export type KeyboardControllerHost = Pick<
  DesktopApp,
  "desktopSync"
  | "dialogs"
  | "findFolderChild"
  | "findNode"
  | "folder"
  | "folderLayer"
  | "items"
  | "layout"
  | "menus"
  | "rename"
  | "render"
  | "selection"
  | "settings"
  | "store"
  | "tileElement"
>;

// Global keyboard handling: shortcuts, arrow-key navigation on the desktop and
// inside an open folder.
export class KeyboardController {

  constructor(private readonly app: KeyboardControllerHost) {}

  async onWindowKeyDown(event: KeyboardEvent) {
    if (this.app.dialogs.handleConfirmDialogKeyDown(event)) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest("input, textarea")) {
      return;
    }

    if (this.app.menus.handleContextMenuAccessKey(event)) {
      return;
    }

    if (event.key === "Escape") {
      if (this.app.menus.contextMenu || this.app.dialogs.ratioDialogTargetId) {
        this.app.menus.clearContextOverlay();
        return;
      }

      if (this.app.settings.settingsOpen) {
        this.app.settings.settingsOpen = false;
        this.app.settings.renderSettingsLayer();
        return;
      }

      void this.app.folder.closeFolder();
      return;
    }

    if (this.app.folder.openFolderId) {
      if (await this.onOpenFolderKeyDown(event)) {
        return;
      }

      return;
    }

    if (this.app.settings.settingsOpen) {
      return;
    }

    if (this.handleDesktopNavigationKey(event)) {
      return;
    }

    if (event.key === "F5") {
      event.preventDefault();
      await this.app.desktopSync.refreshDesktopItems();
      return;
    }

    const selected = this.app.selection.selectedId ? this.app.findNode(this.app.selection.selectedId) : null;
    const key = event.key.toLowerCase();

    if (event.ctrlKey && key === "v") {
      event.preventDefault();
      try {
        await pasteDesktopItems();
      } catch (error) {
        // Nothing to paste (or the shell refused): nothing to do.
        console.info("Paste skipped", error);
        return;
      }
      await this.app.desktopSync.refreshDesktopItems();
      return;
    }

    if (!selected) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (selected.type === "folder") {
        this.app.folder.openFolderFromNode(selected);
      } else {
        await this.app.items.openItem(selected);
      }
      return;
    }

    if (event.ctrlKey && key === "c" && selected.type === "item" && selected.path) {
      event.preventDefault();
      try {
        await copyDesktopItem(selected);
      } catch (error) {
        console.warn("Copy failed", error);
      }
      return;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      try {
        await this.app.items.deleteNode(selected);
      } catch (error) {
        console.warn("Delete failed", error);
      }
      return;
    }

    if (event.key === "F2") {
      const canRename = selected.type === "folder" || (selected.type === "item" && Boolean(selected.path));
      if (canRename) {
        event.preventDefault();
        this.app.rename.startRename(selected.id);
      }
    }
  }

  private async onOpenFolderKeyDown(event: KeyboardEvent) {
    if (event.key === "F5") {
      event.preventDefault();
      await this.app.desktopSync.refreshDesktopItems();
      return true;
    }

    if (this.handleOpenFolderNavigationKey(event)) {
      return true;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const childId = item?.dataset.folderChildId ?? this.app.folder.selectedFolderChild?.childId;
    const folderId = item?.dataset.parentFolderId ?? this.app.folder.selectedFolderChild?.folderId;
    const child = this.app.findFolderChild(folderId ?? "", childId ?? "");
    if (!folderId || !childId || !child) {
      return false;
    }

    const key = event.key.toLowerCase();
    if (event.key === "Enter") {
      event.preventDefault();
      await this.app.items.openItem(child);
      return true;
    }

    if (event.key === "F2" && child.path) {
      event.preventDefault();
      this.app.rename.startFolderChildRename(folderId, childId);
      return true;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      this.app.folder.moveFolderChildOut(folderId, childId);
      return true;
    }

    if (event.ctrlKey && key === "c" && child.path) {
      event.preventDefault();
      try {
        await copyDesktopItem(child);
      } catch (error) {
        console.warn("Copy failed", error);
      }
      return true;
    }

    return false;
  }

  private handleDesktopNavigationKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isNavigationKey(event.key)) {
      return false;
    }

    const nodes = this.app.store.getNodes();
    if (nodes.length === 0) {
      return false;
    }

    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const activeId = focused?.dataset.nodeId ?? this.app.selection.selectedId;
    const next = desktopNavigationNode(event.key, activeId, nodes, this.app.layout);
    if (!next) {
      return false;
    }

    event.preventDefault();
    this.app.selection.selectSingleDesktopNode(next.id);
    this.app.rename.renamingId = null;
    this.app.menus.closeContextMenu();
    this.app.render();
    this.focusDesktopNode(next.id);
    return true;
  }

  private handleOpenFolderNavigationKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isNavigationKey(event.key)) {
      return false;
    }

    const folder = this.app.folder.getOpenFolder();
    if (!folder || folder.children.length === 0) {
      return false;
    }

    const paging = this.app.folder.folderPaging(folder);
    if (paging.pageCount > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      this.app.folder.selectedFolderChild = null;
      this.app.rename.renamingFolderChild = null;
      this.app.menus.closeContextMenu();
      this.app.folder.setOpenFolderPage(paging.page + (event.key === "ArrowRight" ? 1 : -1));
      return true;
    }

    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-child-id]");
    const selectedChildId = focused?.dataset.folderChildId ?? this.app.folder.selectedFolderChild?.childId ?? null;
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
    this.app.selection.clearDesktopSelection();
    this.app.rename.renamingFolderChild = null;
    this.app.folder.selectedFolderChild = { folderId: folder.id, childId: next.id };
    this.app.menus.closeContextMenu();
    this.app.folder.renderFolderLayer();
    this.focusFolderChild(folder.id, next.id);
    return true;
  }

  focusDesktopNode(nodeId: string) {
    requestAnimationFrame(() => {
      const item = this.app.tileElement(nodeId);
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
      item?.focus({ preventScroll: true });
    });
  }

  private focusFolderChild(folderId: string, childId: string) {
    requestAnimationFrame(() => {
      const item = this.app.folderLayer.querySelector<HTMLElement>(
        `[data-parent-folder-id="${CSS.escape(folderId)}"][data-folder-child-id="${CSS.escape(childId)}"]`
      );
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
      item?.focus({ preventScroll: true });
    });
  }
}
