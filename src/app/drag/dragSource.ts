import type { AppNode } from "../../types";
import type { DesktopApp } from "../DesktopApp";
import type { ActiveDrag, DragGroupItem } from "./dragTypes";

// What a drag is carrying: one desktop tile, a selected group of them, or an
// icon taken out of a folder.

export function isDesktopGroupDrag(drag: ActiveDrag) {
  return drag.source.type === "desktop" && drag.groupItems.length > 1;
}

export function desktopDragSourceIds(drag: ActiveDrag) {
  if (drag.source.type !== "desktop") {
    return [];
  }

  return isDesktopGroupDrag(drag)
    ? drag.groupItems.map((item) => item.id)
    : [drag.source.nodeId];
}

// The desktop tiles a free-layout drag moves, with where each started.
export function freeDragMovedItems(
  drag: ActiveDrag
): Array<Pick<DragGroupItem, "id" | "baseX" | "baseY" | "width" | "height">> {
  if (drag.source.type !== "desktop") {
    return [];
  }

  return isDesktopGroupDrag(drag)
    ? drag.groupItems
    : [{
        id: drag.source.nodeId,
        baseX: drag.baseX,
        baseY: drag.baseY,
        width: drag.width,
        height: drag.height
      }];
}

export function dragSourceItems(
  app: Pick<DesktopApp, "findFolderChild" | "findNode">,
  drag: ActiveDrag
): AppNode[] | null {
  if (drag.source.type === "folder") {
    const child = app.findFolderChild(drag.source.folderId, drag.source.childId);
    return child ? [child] : null;
  }

  const nodes = desktopDragSourceIds(drag).map((id) => app.findNode(id));
  if (nodes.length === 0 || nodes.some((node) => !node || node.type !== "item")) {
    return null;
  }

  return nodes as AppNode[];
}

export function trashableDragSourceItems(app: Pick<DesktopApp, "findFolderChild" | "findNode">, drag: ActiveDrag) {
  const items = dragSourceItems(app, drag);
  return items && items.every((item) => Boolean(item.path)) ? items : [];
}
