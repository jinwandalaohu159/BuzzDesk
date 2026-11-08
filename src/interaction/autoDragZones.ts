// Geometry of auto-layout dragging: the drag state, the zones a point falls in
// (merge core, icon cell, open space) and the slot a point or a release maps
// to. Pure functions over layout coordinates: no DOM, no store, no timing.
import { pointInMergeRect, type Rect } from "../app/support/geometry";
import type { DesktopNode, LayoutSlot } from "../types";
import type { PointerVelocity } from "./pointerVelocity";
import { cellPadXRatio, cellPadYRatio, headingMinCosine, headingMinSpeed, mergeCoreInset, mergeExitPaddingPx } from "./autoDragTuning";

export type DragTargetIntent = "merge" | "trash";

export interface DragTargetSnapshot {
  id: string;
  intent: DragTargetIntent;
  rect: DOMRect;
  hitRect: Rect;
  // Icon box relative to the tile's top-left, used to locate the merge core
  // wherever the tile is currently displayed (it may be shuffled aside).
  icon: { x: number; y: number; width: number; height: number };
}

export interface AutoDragState {
  movingIds: string[];
  movingNodes: DesktopNode[];
  remainingIds: string[];
  // Index in remainingIds where the dragged block's placeholder sits, or null
  // while no slot has been opened yet (group / folder-child drags).
  insertAt: number | null;
  // Where every tile is currently displayed (layout coordinates).
  layout: Map<string, LayoutSlot>;
  lastAppliedAt: number;
}

export function createAutoDragState(
  nodes: DesktopNode[],
  movingNodes: DesktopNode[],
  layout: Map<string, LayoutSlot>,
  singleDesktopSource: boolean
): AutoDragState | null {
  if (movingNodes.length === 0) {
    return null;
  }

  const movingIdSet = new Set(movingNodes.map((node) => node.id));
  const originalIndex =
    singleDesktopSource && movingNodes.length === 1
      ? nodes.findIndex((node) => node.id === movingNodes[0].id)
      : -1;

  return {
    movingIds: movingNodes.map((node) => node.id),
    movingNodes,
    remainingIds: nodes.filter((node) => !movingIdSet.has(node.id)).map((node) => node.id),
    insertAt: originalIndex >= 0 ? originalIndex : null,
    layout: new Map(layout),
    lastAppliedAt: 0
  };
}

// Central part of a tile's icon (layout coordinates) that means "drop into".
// The recycle bin accepts its whole icon so deleting stays easy.
export function mergeCoreRect(
  slot: Pick<LayoutSlot, "x" | "y">,
  snapshot: Pick<DragTargetSnapshot, "icon" | "intent">,
  padding: number
): Rect {
  const inset = snapshot.intent === "trash" ? 0 : mergeCoreInset;
  const insetX = snapshot.icon.width * inset;
  const insetY = snapshot.icon.height * inset;
  const left = slot.x + snapshot.icon.x + insetX - padding;
  const top = slot.y + snapshot.icon.y + insetY - padding;
  const right = slot.x + snapshot.icon.x + snapshot.icon.width - insetX + padding;
  const bottom = slot.y + snapshot.icon.y + snapshot.icon.height - insetY + padding;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function isInsideActiveMergeTarget(x: number, y: number, state: AutoDragState, target: DragTargetSnapshot) {
  const slot = state.layout.get(target.id);
  return Boolean(slot && pointInMergeRect(x, y, mergeCoreRect(slot, target, mergeExitPaddingPx)));
}

export function findMergeHit(x: number, y: number, state: AutoDragState, snapshots: DragTargetSnapshot[]) {
  for (const snapshot of snapshots) {
    const slot = state.layout.get(snapshot.id);
    if (slot && pointInMergeRect(x, y, mergeCoreRect(slot, snapshot, 0))) {
      return snapshot;
    }
  }

  return null;
}

// The icon whose cell (tile plus half the surrounding gap) contains the point.
export function approachedTarget(x: number, y: number, state: AutoDragState, snapshots: DragTargetSnapshot[]) {
  for (const snapshot of snapshots) {
    const slot = state.layout.get(snapshot.id);
    if (!slot) {
      continue;
    }
    const padX = slot.width * cellPadXRatio;
    const padY = slot.height * cellPadYRatio;
    if (x >= slot.x - padX && x <= slot.x + slot.width + padX && y >= slot.y - padY && y <= slot.y + slot.height + padY) {
      return snapshot;
    }
  }
  return null;
}

// While the pointer glides over the rim of an icon towards its centre the user
// is aiming for a folder; don't shuffle that icon out from under them.
export function isHeadingIntoMergeCore(
  x: number,
  y: number,
  velocity: PointerVelocity,
  state: AutoDragState,
  snapshots: DragTargetSnapshot[]
) {
  if (velocity.speed < headingMinSpeed) {
    return false;
  }

  for (const snapshot of snapshots) {
    const slot = state.layout.get(snapshot.id);
    if (!slot || !pointInMergeRect(x, y, { left: slot.x, top: slot.y, right: slot.x + slot.width, bottom: slot.y + slot.height })) {
      continue;
    }

    const core = mergeCoreRect(slot, snapshot, 0);
    const toCoreX = core.left + core.width / 2 - x;
    const toCoreY = core.top + core.height / 2 - y;
    const distance = Math.hypot(toCoreX, toCoreY);
    if (distance < 1) {
      return true;
    }

    const cosine = (velocity.vx * toCoreX + velocity.vy * toCoreY) / (velocity.speed * distance);
    return cosine > headingMinCosine;
  }

  return false;
}

// Slot the dragged block should occupy for a pointer at (x, y), as an index
// into remainingIds: before or after the nearest icon, by side of its centre;
// hovering the open placeholder keeps it.
export function insertionIndexForPoint(x: number, y: number, state: AutoDragState): number | null {
  if (state.remainingIds.length === 0) {
    return 0;
  }

  const movingIds = new Set(state.movingIds);
  const order = displayedOrder(state);

  let best = -1;
  let bestEdgeDistance = Number.POSITIVE_INFINITY;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  order.forEach((id, index) => {
    const slot = state.layout.get(id);
    if (!slot) {
      return;
    }

    const dx = Math.max(slot.x - x, 0, x - (slot.x + slot.width));
    const dy = Math.max(slot.y - y, 0, y - (slot.y + slot.height));
    const edgeDistance = dx * dx + dy * dy;
    const centerDistance = (x - (slot.x + slot.width / 2)) ** 2 + (y - (slot.y + slot.height / 2)) ** 2;
    if (
      edgeDistance < bestEdgeDistance ||
      (edgeDistance === bestEdgeDistance && centerDistance < bestCenterDistance)
    ) {
      best = index;
      bestEdgeDistance = edgeDistance;
      bestCenterDistance = centerDistance;
    }
  });

  if (best < 0) {
    return null;
  }

  const last = state.layout.get(order[order.length - 1]);
  if (last && (y > last.y + last.height || (y >= last.y && x > last.x + last.width))) {
    return state.remainingIds.length;
  }

  const id = order[best];
  if (movingIds.has(id)) {
    return state.insertAt;
  }

  // Go before or after the nearest icon depending on which side of its centre
  // the point is. Anywhere in the gap between A and B therefore means "between
  // A and B" — exactly where the make-room hint parts the icons — no matter
  // which of the two the point happens to be closer to.
  const slot = state.layout.get(id);
  const remainingIndex = state.remainingIds.indexOf(id);
  return slot && x > slot.x + slot.width / 2 ? remainingIndex + 1 : remainingIndex;
}

function displayedOrder(state: AutoDragState) {
  if (state.insertAt === null) {
    return state.remainingIds;
  }

  return [
    ...state.remainingIds.slice(0, state.insertAt),
    ...state.movingIds,
    ...state.remainingIds.slice(state.insertAt)
  ];
}

// Node order the grid should preview with the dragged block at `insertAt`.
export function previewNodeOrder(state: AutoDragState, nodeById: Map<string, DesktopNode>, insertAt: number) {
  const remaining = state.remainingIds
    .map((id) => nodeById.get(id))
    .filter((node): node is DesktopNode => Boolean(node));
  const clamped = Math.min(remaining.length, Math.max(0, insertAt));
  return {
    insertAt: clamped,
    remaining,
    nodes: [...remaining.slice(0, clamped), ...state.movingNodes, ...remaining.slice(clamped)]
  };
}

// Where a release at (x, y) should land, as an index into remainingIds.
export function dropInsertionIndex(x: number, y: number, state: AutoDragState, snapshots: DragTargetSnapshot[]) {
  // Released on an icon's centre without a folder forming: settle into the slot
  // that is already open rather than displacing that icon.
  if (findMergeHit(x, y, state, snapshots)) {
    return state.insertAt;
  }

  return insertionIndexForPoint(x, y, state) ?? state.insertAt;
}
