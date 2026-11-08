import { captureRects, playFlip } from "../../animation/flip";
import {
  captureMergeGhosts,
  discardMergeGhosts,
  playMergeMorph,
  playTrashGroupIntoTarget,
  tileIconVisual
} from "../../animation/merge";
import { deleteDesktopItem } from "../../system/desktopApi";
import type { AppNode } from "../../types";
import type { DesktopApp } from "../DesktopApp";
import { desktopDragSourceIds, isDesktopGroupDrag, trashableDragSourceItems } from "./dragSource";

export type MergeCommitHost = Pick<
  DesktopApp,
  "desktopSync"
  | "dragging"
  | "findFolderChild"
  | "findNode"
  | "grid"
  | "merge"
  | "render"
  | "renderWithFlip"
  | "resumeDeferredRender"
  | "store"
  | "suppressStoreRender"
  | "tileElement"
>;

// Drops onto a merge target: forming / filling a folder, or moving the icons
// to the recycle bin, each with its animation. Targeting is DragMerge's.
export class MergeCommit {
  // Recycle-bin drops whose shell delete is still running.
  trashInFlight = 0;

  constructor(private readonly app: MergeCommitHost) {}

  async commitTrash(targetId: string) {
    const drag = this.app.dragging.drag;
    if (!drag || drag.committing) {
      return;
    }

    const trashItems = trashableDragSourceItems(this.app, drag);
    if (trashItems.length === 0) {
      // The source vanished mid-drag (a scan removed it): the release has
      // already happened, so end the drag like any cancelled one.
      this.app.dragging.cancelDrag();
      return;
    }

    const targetElement = this.app.tileElement(targetId);

    drag.committing = true;
    const trashSources = isDesktopGroupDrag(drag)
      ? drag.groupItems.map((item) => item.element)
      : [drag.element];
    const trashAnimation = targetElement
      ? playTrashGroupIntoTarget(trashSources, targetElement).catch((error) => {
          console.warn("Unable to play trash animation", error);
        })
      : Promise.resolve();
    if (targetElement) {
      this.app.merge.clearMergeTargetElement(targetElement);
    }
    // The icons are now ghosts on their way into the bin: the pointer is free
    // for the next drag while the shell deletes. Until the deletes settle,
    // scans and renders hold off (trashInFlight) so the binned icons never
    // pop back into their slots mid-flight.
    this.trashInFlight += 1;
    this.app.dragging.releaseDrag(drag);
    let deletedItems: AppNode[] = [];
    try {
      deletedItems = await this.deleteIntoBin(trashItems, trashAnimation);
    } finally {
      this.trashInFlight -= 1;
    }

    this.app.dragging.settleDragElements(drag);
    this.app.resumeDeferredRender();
    if (deletedItems.length === 0) {
      this.app.renderWithFlip();
      return;
    }

    try {
      await this.app.desktopSync.refreshDesktopItems();
    } catch (error) {
      console.warn("Unable to refresh desktop after recycle bin drop", error);
      this.app.renderWithFlip();
    }
  }

  private async deleteIntoBin(trashItems: AppNode[], trashAnimation: Promise<unknown>) {
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
      await this.app.desktopSync.waitForDeletedItemsToLeaveScan(deletedItems);
    }
    return deletedItems;
  }

  async commitMerge(targetId: string) {
    const drag = this.app.dragging.drag;
    if (!drag || drag.committing) {
      return;
    }

    const target = this.app.findNode(targetId);
    const targetElement = this.app.tileElement(targetId);
    let changed = false;
    let newFolderId: string | null = null;

    drag.committing = true;
    const before = captureRects(this.app.grid);
    const mergeSources = isDesktopGroupDrag(drag)
      ? drag.groupItems.map((item) => item.element)
      : [drag.element];
    // Lift the icons into ghosts first so the store can change and the grid can
    // re-render right away underneath the flight.
    const targetVisual = targetElement && target?.type === "item" ? tileIconVisual(targetElement) : null;
    const growFrom = targetVisual?.getBoundingClientRect() ?? null;
    const sourceVisuals = mergeSources
      .map((element) => tileIconVisual(element))
      .filter((visual): visual is HTMLElement => Boolean(visual));
    const ghosts = captureMergeGhosts(targetVisual ? [targetVisual, ...sourceVisuals] : sourceVisuals);
    const firstSlotIndex = target?.type === "folder" ? target.children.length : 0;
    mergeSources.forEach((element) => {
      element.style.visibility = "hidden";
    });
    if (targetElement) {
      this.app.merge.clearMergeTargetElement(targetElement);
      if (targetVisual) {
        targetElement.style.visibility = "hidden";
      }
    }

    this.app.suppressStoreRender = true;
    try {
      if (drag.source.type === "desktop") {
        const sourceIds = desktopDragSourceIds(drag);
        if (target?.type === "folder") {
          changed = this.app.store.addDesktopItemsToFolder(sourceIds, target.id);
        } else if (target?.type === "item") {
          const result = this.app.store.createFolderFromItems(sourceIds, target.id);
          changed = result.changed;
          newFolderId = result.folderId;
        }
      } else if (target?.type === "folder") {
        changed = this.app.store.addFolderChildToFolder(drag.source.folderId, drag.source.childId, target.id);
      } else if (target?.type === "item") {
        const result = this.app.store.createFolderFromChild(drag.source.folderId, drag.source.childId, target.id);
        changed = result.changed;
        newFolderId = result.folderId;
      }
    } finally {
      this.app.suppressStoreRender = false;
    }

    this.app.dragging.releaseDrag(drag);
    this.app.dragging.settleDragElements(drag);
    if (!changed) {
      discardMergeGhosts(ghosts);
      mergeSources.forEach((element) => {
        element.style.visibility = "";
      });
      if (targetElement) {
        targetElement.style.visibility = "";
      }
      // Glide back from where the icons were released.
      this.app.render();
      playFlip(this.app.grid, before);
      return;
    }

    const revealedTargetId = newFolderId ?? (target?.type === "folder" ? target.id : null);
    this.app.render();
    const skipFlipIds = revealedTargetId ? new Set([revealedTargetId]) : undefined;
    playFlip(this.app.grid, before, {
      skipIds: skipFlipIds,
      skipNewIds: skipFlipIds
    });
    const folderTile = revealedTargetId
      ? this.app.tileElement(revealedTargetId)
      : null;
    await playMergeMorph(ghosts, folderTile, firstSlotIndex, newFolderId ? growFrom : null).catch((error) => {
      console.warn("Unable to play merge animation", error);
      discardMergeGhosts(ghosts);
    });
  }
}
