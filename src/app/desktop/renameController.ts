import { renameDesktopItem } from "../../system/desktopApi";
import type { FolderNode } from "../../types";
import type { DesktopApp } from "../DesktopApp";

export type RenameControllerHost = Pick<
  DesktopApp,
  "desktopSync"
  | "findFolderChild"
  | "findNode"
  | "folder"
  | "folderLayer"
  | "grid"
  | "items"
  | "render"
  | "selection"
  | "store"
>;

// Inline renaming of desktop items and folder children.
export class RenameController {
  renamingId: string | null = null;
  renamingFolderChild: { folderId: string; childId: string } | null = null;

  constructor(private readonly app: RenameControllerHost) {}

  bindFolderChildRenameInput(folder: FolderNode) {
    const input = this.app.folderLayer.querySelector<HTMLInputElement>("[data-folder-child-rename-id]");
    if (!input) {
      return;
    }

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        input.blur();
      } else if (event.key === "Escape") {
        this.renamingFolderChild = null;
        this.app.folder.renderFolderLayer();
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

  // A press outside the rename box ends the rename and keeps what was typed.
  // It runs before the press handlers, which reset rename state (and would make
  // the input's later blur commit nothing).
  commitPendingRenames(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    if (this.renamingId && !element?.closest("[data-rename-id]")) {
      const nodeId = this.renamingId;
      const input = this.app.grid.querySelector<HTMLInputElement>(`[data-rename-id="${CSS.escape(nodeId)}"]`);
      if (input) {
        this.commitRename(nodeId, input.value).catch((error) => console.warn("Rename failed", error));
      }
    }

    const child = this.renamingFolderChild;
    if (child && !element?.closest("[data-folder-child-rename-id]")) {
      const input = this.app.folderLayer.querySelector<HTMLInputElement>("[data-folder-child-rename-id]");
      if (input) {
        this.commitFolderChildRename(child.folderId, child.childId, input.value).catch((error) =>
          console.warn("Rename failed", error)
        );
      }
    }
  }

  startRename(nodeId: string) {
    this.renamingId = nodeId;
    this.renamingFolderChild = null;
    this.app.selection.selectSingleDesktopNode(nodeId);
    this.app.render();
    requestAnimationFrame(() => {
      const input = this.app.grid.querySelector<HTMLInputElement>(`[data-rename-id="${CSS.escape(nodeId)}"]`);
      input?.focus();
      input?.select();
    });
  }

  startFolderChildRename(folderId: string, childId: string) {
    this.renamingId = null;
    this.app.selection.clearDesktopSelection();
    this.renamingFolderChild = { folderId, childId };
    this.app.folder.selectedFolderChild = { folderId, childId };
    this.app.folder.renderFolderLayer();
  }

  async onRenameFocusOut(event: FocusEvent) {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-rename-id]");
    if (!input) {
      return;
    }

    await this.commitRename(input.dataset.renameId ?? "", input.value);
  }

  async onGridKeyDown(event: KeyboardEvent) {
    const renameInput = (event.target as HTMLElement).closest<HTMLInputElement>("[data-rename-id]");
    if (renameInput) {
      if (event.key === "Enter") {
        event.preventDefault();
        await this.commitRename(renameInput.dataset.renameId ?? "", renameInput.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.renamingId = null;
        this.app.render();
      }
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const node = this.app.findNode(tile?.dataset.nodeId ?? "");
    if (!tile || !node) {
      return;
    }

    if (node.type === "item") {
      await this.app.items.openItem(node);
    } else {
      this.app.folder.openFolderFromElement(node, tile);
    }
  }

  private async commitRename(nodeId: string, rawName: string) {
    if (this.renamingId !== nodeId) {
      return;
    }

    const node = this.app.findNode(nodeId);
    const name = rawName.trim();
    this.renamingId = null;

    if (!node || !name || name === node.name) {
      this.app.render();
      return;
    }

    try {
      if (node.type === "folder") {
        this.app.store.renameFolder(node.id, name);
      } else {
        const renamed = await renameDesktopItem(node, name);
        if (renamed) {
          this.app.store.replaceItem(node.id, renamed);
          this.app.selection.selectSingleDesktopNode(renamed.id);
          this.app.render();
        } else {
          await this.app.desktopSync.refreshDesktopItems();
        }
      }
    } catch (error) {
      console.warn("Unable to rename desktop item", node.name, error);
      this.app.render();
    }
  }

  private async commitFolderChildRename(folderId: string, childId: string, rawName: string) {
    if (
      this.renamingFolderChild?.folderId !== folderId ||
      this.renamingFolderChild?.childId !== childId
    ) {
      return;
    }

    const child = this.app.findFolderChild(folderId, childId);
    const name = rawName.trim();
    this.renamingFolderChild = null;

    if (!child || !name || name === child.name) {
      this.app.folder.renderFolderLayer();
      return;
    }

    try {
      const renamed = await renameDesktopItem(child, name);
      if (renamed) {
        this.app.store.replaceItem(child.id, renamed);
        this.app.folder.selectedFolderChild = { folderId, childId: renamed.id };
        this.app.folder.renderFolderLayer();
      } else {
        await this.app.desktopSync.refreshDesktopItems();
      }
    } catch (error) {
      console.warn("Unable to rename folder child", child.name, error);
      this.app.folder.renderFolderLayer();
    }
  }
}
