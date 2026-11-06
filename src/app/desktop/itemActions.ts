import { deleteDesktopItem, openDesktopItem } from "../../system/desktopApi";
import type { AppNode, DesktopNode } from "../../types";
import type { DesktopApp } from "../DesktopApp";

export type ItemActionsHost = Pick<
  DesktopApp,
  "desktopSync"
  | "dialogs"
  | "findFolderChild"
  | "findNode"
  | "folder"
  | "folderLayer"
  | "freePlacement"
  | "menus"
  | "rename"
  | "render"
  | "selection"
  | "store"
  | "tileElement"
>;

// Opening, activating and deleting desktop items (with the "opening" feedback).
export class ItemActions {
  private lastActivation: { id: string; time: number } | null = null;
  private lastOpenRequest: { id: string; time: number } | null = null;
  openingIds = new Set<string>();
  private openingTimers = new Map<string, number>();

  constructor(private readonly app: ItemActionsHost) {}

  async openItem(node: AppNode) {
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
    this.app.tileElement(id)?.classList.toggle("is-opening", opening);
    this.app.folderLayer
      .querySelector<HTMLElement>(`[data-folder-child-id="${selector}"]`)
      ?.classList.toggle("is-opening", opening);
  }

  activateDesktopNode(nodeId: string, element: HTMLElement, toggleSelection = false) {
    const node = this.app.findNode(nodeId);
    if (!node) {
      return;
    }

    this.app.menus.closeContextMenu();
    if (toggleSelection) {
      this.lastActivation = null;
      this.app.rename.renamingId = null;
      this.app.selection.toggleDesktopNodeSelection(node.id);
      this.app.selection.applyDesktopSelectionToDom();
      return;
    }

    if (node.type === "folder") {
      this.lastActivation = null;
      this.app.folder.openFolderFromElement(node, element);
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

    this.app.selection.selectSingleDesktopNode(node.id);
    this.app.rename.renamingId = null;
    this.app.render();
  }

  async activateFolderChild(folderId: string, childId: string) {
    const child = this.app.findFolderChild(folderId, childId);
    if (!child) {
      return;
    }

    this.app.menus.closeContextMenu();
    const activationId = `${folderId}:${childId}`;
    const now = performance.now();
    const isDoubleClick = this.lastActivation?.id === activationId && now - this.lastActivation.time <= 430;
    this.lastActivation = { id: activationId, time: now };

    if (!isDoubleClick) {
      this.app.selection.clearDesktopSelection();
      this.app.folder.selectedFolderChild = { folderId, childId };
      this.app.rename.renamingFolderChild = null;
      this.app.folder.renderFolderLayer();
      return;
    }

    this.lastActivation = null;
    await this.openItem(child);
  }

  async deleteNode(node: DesktopNode) {
    if (node.type === "folder") {
      const childPositions = this.app.freePlacement.freeFolderChildPositions(node);
      const changed = this.app.store.dissolveFolder(node.id, childPositions);
      if (changed) {
        if (this.app.folder.openFolderId === node.id) {
          this.app.folder.closeFolderNow();
        }
        if (this.app.selection.selectedId === node.id) {
          this.app.selection.selectedId = Array.from(this.app.selection.selectedIds).find((id) => id !== node.id) ?? null;
        }
        this.app.selection.selectedIds.delete(node.id);
        if (this.app.rename.renamingId === node.id) {
          this.app.rename.renamingId = null;
        }
      }
      return;
    }

    if (!node.path) {
      return;
    }

    if (!(await this.app.dialogs.confirmDeleteItem(node))) {
      return;
    }

    await deleteDesktopItem(node);
    await this.app.desktopSync.refreshDesktopItems();
  }
}
