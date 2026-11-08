import { desktopIndexForPoint } from "../../layout/grid";
import { desktopTileMetrics } from "../../settings/desktopSettings";
import { desktopViewport } from "../../system/desktopViewport";
import { dropInsertionIndex } from "../../interaction/autoDragIntent";
import { clampScroll, clientToLayout, layoutToFree } from "../support/geometry";
import type { DesktopApp } from "../DesktopApp";
import { desktopDragSourceIds, freeDragMovedItems, isDesktopGroupDrag } from "./dragSource";
import { aimPoint, type ActiveDrag, type DragGroupItem } from "./dragTypes";

export type DragDropHost = Pick<
  DesktopApp,
  "freePlacement"
  | "freeReorder"
  | "rename"
  | "root"
  | "selection"
  | "settingsActions"
  | "store"
  | "suppressStoreRender"
>;

// Where a released drag lands and committing it to the store: the drop slot in
// the auto layout, positions in the free layout, and icons dragged out of a
// folder onto the desktop. Merge / trash drops are DragMerge's.
export class DragDrop {
  constructor(private readonly app: DragDropHost) {}

  // Commits a normal (non-merge) drop and selects what was dropped. Returns
  // whether the store changed and which tile should take focus.
  commitDrop(drag: ActiveDrag) {
    const aim = aimPoint(drag);
    let changed = false;
    let focusAfterRender: string | null = null;
    this.app.suppressStoreRender = true;
    try {
      if (this.app.store.getSettings().layoutMode === "free" && drag.source.type === "desktop") {
        changed = this.commitFreeDesktopDrag(drag);
        this.app.selection.setDesktopSelection(desktopDragSourceIds(drag), drag.source.nodeId);
        focusAfterRender = drag.source.nodeId;
      } else if (isDesktopGroupDrag(drag)) {
        const groupIds = drag.groupItems.map((item) => item.id);
        this.app.selection.setDesktopSelection(groupIds, drag.source.type === "desktop" ? drag.source.nodeId : groupIds[0]);
        focusAfterRender = this.app.selection.selectedId;
        const index = this.dropIndex(drag, aim);
        changed = index !== null && this.app.store.placeDesktopNodes(groupIds, index);
      } else if (drag.source.type === "folder") {
        this.app.selection.selectSingleDesktopNode(drag.source.childId);
        this.app.rename.renamingFolderChild = null;
        focusAfterRender = drag.source.childId;
        if (this.app.store.getSettings().layoutMode === "free") {
          changed = this.app.store.moveFolderChildToDesktop(
            drag.source.folderId,
            drag.source.childId,
            this.app.store.getNodes().length,
            this.freeFolderChildDropPosition(drag)
          );
        } else {
          // The child is not among the desktop nodes, so both index spaces agree.
          changed = this.app.store.moveFolderChildToDesktop(
            drag.source.folderId,
            drag.source.childId,
            this.dropIndex(drag, aim) ?? this.desktopInsertionIndex(aim.x, aim.y)
          );
        }
      } else {
        this.app.selection.selectSingleDesktopNode(drag.source.nodeId);
        const index = this.dropIndex(drag, aim);
        changed = index !== null && this.app.store.placeDesktopNodes([drag.source.nodeId], index);
      }
    } finally {
      this.app.suppressStoreRender = false;
    }

    return { changed, focusAfterRender };
  }

  // The dropped icon's position at release, aligned like a desktop tile.
  dropRect(drag: ActiveDrag) {
    const rect = drag.element.getBoundingClientRect();
    const scale = rect.width / Math.max(1, drag.width);
    return {
      left: rect.left + rect.width / 2 - drag.width / 2,
      top: rect.top + rect.height / 2 - drag.height / 2,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1
    };
  }

  // Where a release lands, as an index among the nodes that are not moving
  // (what placeDesktopNodes expects); null means "stay where you are". In the
  // auto layout the intent engine already knows the open slot.
  private dropIndex(drag: ActiveDrag, aim: { x: number; y: number }): number | null {
    if (drag.auto) {
      const point = clientToLayout(this.app.root, aim.x, aim.y);
      return dropInsertionIndex(point.x, point.y, drag.auto, drag.targetSnapshots);
    }

    const fullIndex = this.desktopInsertionIndex(aim.x, aim.y);
    const moving = new Set(desktopDragSourceIds(drag));
    const movingBefore = this.app.store.getNodes().slice(0, fullIndex).filter((node) => moving.has(node.id)).length;
    return fullIndex - movingBefore;
  }

  // Index into the full node list for a point (fallback when no auto-drag
  // state exists; dropIndex converts it for placeDesktopNodes).
  private desktopInsertionIndex(clientX: number, clientY: number) {
    const viewport = desktopViewport();
    const nodes = this.app.store.getNodes();
    const settings = this.app.settingsActions.effectiveDesktopSettings(this.app.store.getSettings(), nodes, viewport);
    const point = clientToLayout(this.app.root, clientX, clientY);
    return desktopIndexForPoint(
      point.x,
      point.y,
      viewport.width,
      viewport.offsetY + viewport.height + this.app.root.scrollTop,
      nodes,
      settings,
      viewport.offsetX,
      viewport.offsetY
    );
  }

  // Free layout: an icon dragged out of a folder lands like any desktop icon:
  // a desktop-sized tile centred where it was dropped, snapped to the grid and
  // moved to the nearest open spot.
  private freeFolderChildDropPosition(drag: ActiveDrag) {
    const viewport = desktopViewport();
    const metrics = desktopTileMetrics(this.app.store.getSettings());
    const rect = drag.element.getBoundingClientRect();
    const center = clientToLayout(this.app.root, rect.left + rect.width / 2, rect.top + rect.height / 2);
    const preferred = layoutToFree(viewport, center.x - metrics.width / 2, center.y - metrics.height / 2);
    return this.app.freePlacement.findOpenDesktopPosition(
      preferred,
      metrics.width,
      metrics.height,
      new Set(drag.source.type === "folder" ? [drag.source.childId] : []),
      [],
      false
    );
  }

  private commitFreeDesktopDrag(drag: ActiveDrag) {
    const reorderPlan = this.app.freeReorder.activeFreeReorderPlan(drag);
    if (reorderPlan) {
      return this.app.store.updateNodePositions(reorderPlan.positions);
    }

    const viewport = desktopViewport();
    const movedItems = freeDragMovedItems(drag);
    if (movedItems.length === 0) {
      return false;
    }

    const { dx, dy } = freeDragDelta(this.app, drag, movedItems, viewport);
    const positions = movedItems.length > 1
      ? this.app.freePlacement.resolveFreeGroupPositions(movedItems, dx, dy)
      : movedItems
          .map((item) => ({
            id: item.id,
            position: this.app.freePlacement.findOpenDesktopPosition(
              {
                x: item.baseX + dx - viewport.offsetX,
                y: item.baseY + dy - viewport.offsetY
              },
              item.width,
              item.height,
              new Set([item.id]),
              [],
              this.app.freePlacement.isCompactPlacementFolder(item.id)
            )
          }));

    if (positions.length === 0) {
      return false;
    }

    return this.app.store.updateNodePositions(positions);
  }
}

// How far a free-layout drag has carried its tiles (scroll included); a group
// is kept inside the desktop's padding.
export function freeDragDelta(
  app: Pick<DesktopApp, "root" | "store">,
  drag: ActiveDrag,
  movedItems: Array<Pick<DragGroupItem, "baseX" | "baseY" | "width" | "height">>,
  viewport: ReturnType<typeof desktopViewport>
) {
  let dx = drag.currentX - drag.startX + app.root.scrollLeft - drag.startScrollLeft;
  let dy = drag.currentY - drag.startY + app.root.scrollTop - drag.startScrollTop;

  if (movedItems.length > 1) {
    const minX = Math.min(...movedItems.map((item) => item.baseX - viewport.offsetX));
    const minY = Math.min(...movedItems.map((item) => item.baseY - viewport.offsetY));
    const maxX = Math.max(...movedItems.map((item) => item.baseX - viewport.offsetX + item.width));
    const maxY = Math.max(...movedItems.map((item) => item.baseY - viewport.offsetY + item.height));
    const metrics = desktopTileMetrics(app.store.getSettings());
    dx = clampScroll(dx, metrics.paddingX - minX, viewport.width - metrics.paddingX - maxX);
    dy = clampScroll(dy, metrics.paddingY - minY, viewport.height - metrics.paddingY - maxY);
  }

  return { dx, dy };
}
