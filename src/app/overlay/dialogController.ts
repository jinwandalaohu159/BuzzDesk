import { renderDeleteConfirmDialog, renderUpdateConfirmDialog, renderRatioDialog } from "../../render/dialogsView";
import { folderRatioMax, folderRatioMin, normalizeFolderAppearance } from "../../settings/desktopSettings";
import type { AppNode, FolderNode, UpdateCheckState } from "../../types";
import type { DesktopApp } from "../DesktopApp";

export type DialogControllerHost = Pick<
  DesktopApp,
  "contextMenuLayer"
  | "menus"
  | "store"
>;

// Modal dialogs on the overlay layer: confirmations and the folder ratio dialog.
export class DialogController {
  ratioDialogTargetId: string | null = null;
  confirmDialogResolve: ((confirmed: boolean) => void) | null = null;

  constructor(private readonly app: DialogControllerHost) {}

  showRatioDialog(folder: FolderNode, x: number, y: number) {
    this.app.menus.beginContextOverlayRequest();
    this.ratioDialogTargetId = folder.id;
    const appearance = normalizeFolderAppearance(folder.appearance);
    this.app.contextMenuLayer.classList.add("is-open");
    this.app.contextMenuLayer.replaceChildren(
      renderRatioDialog({
        x,
        y,
        columns: appearance.folderPanelColumns,
        rows: appearance.folderPanelRows
      })
    );
    requestAnimationFrame(() => {
      this.app.contextMenuLayer.querySelector<HTMLInputElement>("[data-ratio-rows]")?.focus();
    });
  }

  closeRatioDialog() {
    if (!this.ratioDialogTargetId) {
      return;
    }

    this.app.menus.invalidateContextOverlay();
    this.ratioDialogTargetId = null;
    this.app.contextMenuLayer.classList.remove("is-open");
    this.app.contextMenuLayer.replaceChildren();
  }

  confirmDeleteItem(node: AppNode) {
    return this.showConfirmDialog(renderDeleteConfirmDialog(node.name));
  }

  confirmUpdateRelease(updateState: UpdateCheckState) {
    if (!updateState.latestVersion) {
      return Promise.resolve(false);
    }

    return this.showConfirmDialog(renderUpdateConfirmDialog(updateState.currentVersion, updateState.latestVersion));
  }

  private showConfirmDialog(dialog: HTMLElement) {
    this.app.menus.beginContextOverlayRequest();
    return new Promise<boolean>((resolve) => {
      this.confirmDialogResolve = resolve;
      this.app.contextMenuLayer.classList.add("is-open");
      this.app.contextMenuLayer.replaceChildren(dialog);
      requestAnimationFrame(() => {
        this.app.contextMenuLayer.querySelector<HTMLButtonElement>("[data-confirm-accept]")?.focus();
      });
    });
  }

  closeConfirmDialog(confirmed: boolean) {
    if (!this.confirmDialogResolve) {
      return;
    }

    this.app.menus.invalidateContextOverlay();
    this.app.contextMenuLayer.classList.remove("is-open");
    this.app.contextMenuLayer.replaceChildren();
    this.resolveConfirmDialog(confirmed);
  }

  onConfirmDialogClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("[data-confirm-accept]")) {
      this.closeConfirmDialog(true);
      return;
    }

    if (target.closest("[data-confirm-cancel]")) {
      this.closeConfirmDialog(false);
    }
  }

  private onRatioDialogConfirm() {
    if (!this.ratioDialogTargetId) {
      return;
    }

    const colInput = this.app.contextMenuLayer.querySelector<HTMLInputElement>("[data-ratio-columns]");
    const rowInput = this.app.contextMenuLayer.querySelector<HTMLInputElement>("[data-ratio-rows]");
    if (!colInput || !rowInput) {
      this.closeRatioDialog();
      return;
    }

    const folderId = this.ratioDialogTargetId;
    const columns = Math.max(folderRatioMin, Math.min(folderRatioMax, Math.round(Number(colInput.value) || 3)));
    const rows = Math.max(folderRatioMin, Math.min(folderRatioMax, Math.round(Number(rowInput.value) || 3)));
    this.closeRatioDialog();
    this.app.store.updateFolderAppearance(folderId, {
      folderPanelColumns: columns,
      folderPanelRows: rows
    });
  }

  onRatioDialogClick(event: MouseEvent) {
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

  onContextOverlayKeyDown(event: KeyboardEvent) {
    if (this.handleConfirmDialogKeyDown(event)) {
      return;
    }

    if (!this.ratioDialogTargetId) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.onRatioDialogConfirm();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeRatioDialog();
    }
  }

  handleConfirmDialogKeyDown(event: KeyboardEvent) {
    if (!this.confirmDialogResolve) {
      return false;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.closeConfirmDialog(true);
      return true;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeConfirmDialog(false);
      return true;
    }

    if (event.key === "Tab") {
      const buttons = Array.from(
        this.app.contextMenuLayer.querySelectorAll<HTMLButtonElement>("[data-confirm-cancel], [data-confirm-accept]")
      );
      const currentIndex = buttons.findIndex((button) => button === document.activeElement);
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex =
        currentIndex >= 0
          ? (currentIndex + direction + buttons.length) % buttons.length
          : (event.shiftKey ? buttons.length - 1 : 0);

      event.preventDefault();
      event.stopPropagation();
      buttons[nextIndex]?.focus();
      return true;
    }

    event.stopPropagation();
    return true;
  }

  resolveConfirmDialog(confirmed: boolean) {
    const resolve = this.confirmDialogResolve;
    if (!resolve) {
      return;
    }

    this.confirmDialogResolve = null;
    resolve(confirmed);
  }
}
