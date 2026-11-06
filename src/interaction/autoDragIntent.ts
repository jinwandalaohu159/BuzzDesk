// Intent engine for dragging in the auto-arranged grid (iOS-style).
//
// Every frame the dragged icon's centre is classified against where tiles are
// *displayed* (including tiles already shuffled aside), not where they were at
// drag start:
//   - over the centre of a mergeable icon -> folder intent (quick)
//   - around an icon (its rim and a margin) -> the user is aiming at it, so it
//     must not be shoved away; only a long, still hold there makes room
//   - in the gaps between icons -> claim that slot (make room)
// Making room and forming a folder start with the same motion, so the icon you
// are heading for stays put until you either reach its centre or clearly stop
// beside it. An intent only commits once the icon has stayed on it and is
// moving slowly, so sweeping across icons never triggers anything — the same
// "pause to act" rule iOS uses. Pure logic: no DOM, no store.
import { pointInMergeRect, type Rect } from "../app/support/geometry";
import type { DesktopNode, LayoutSlot } from "../types";
import type { PointerVelocity } from "./pointerVelocity";

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

export type AutoDragDecision =
  | { kind: "none" }
  // `armed`: a folder is about to form with this target (show it right away).
  | { kind: "wait"; delayMs: number; armed?: DragTargetSnapshot }
  | { kind: "merge"; target: DragTargetSnapshot }
  | { kind: "reorder"; insertAt: number };

const mergeCoreInset = 0.16;
export const mergeExitPaddingPx = 12;
// Margin around an icon (share of its size) treated as "aiming at it".
const approachPadRatio = 0.32;
const mergeDwellMs = 180;
const trashDwellMs = 60;
const reorderDwellMs = 130;
// Beside an icon, making room needs a deliberate, nearly still hold.
const approachReorderDwellMs = 460;
const mergeMaxSpeed = 0.24;
const trashMaxSpeed = 0.6;
const reorderMaxSpeed = 0.18;
const approachReorderMaxSpeed = 0.06;
const reorderCooldownMs = 140;

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

// The icon whose surroundings (icon box plus a margin) contain the point.
function approachedTarget(x: number, y: number, state: AutoDragState, snapshots: DragTargetSnapshot[]) {
  for (const snapshot of snapshots) {
    const slot = state.layout.get(snapshot.id);
    if (!slot) {
      continue;
    }
    const padX = snapshot.icon.width * approachPadRatio;
    const padY = snapshot.icon.height * approachPadRatio;
    const left = slot.x + snapshot.icon.x - padX;
    const top = slot.y + snapshot.icon.y - padY;
    const right = slot.x + snapshot.icon.x + snapshot.icon.width + padX;
    const bottom = slot.y + snapshot.icon.y + snapshot.icon.height + padY;
    if (x >= left && x <= right && y >= top && y <= bottom) {
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
  if (velocity.speed < 0.04) {
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
    return cosine > 0.6;
  }

  return false;
}

// Slot the dragged block should occupy for a pointer at (x, y), as an index
// into remainingIds. Hovering a tile claims that tile's slot; hovering the open
// placeholder keeps it.
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

  const remainingIndex = state.remainingIds.indexOf(id);
  if (state.insertAt === null) {
    const slot = state.layout.get(id);
    return slot && x > slot.x + slot.width / 2 ? remainingIndex + 1 : remainingIndex;
  }

  return best < state.insertAt ? remainingIndex : remainingIndex + 1;
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

export class AutoDragIntentTracker {
  private pending: { key: string; since: number } | null = null;

  reset() {
    this.pending = null;
  }

  // Decides what (if anything) the drag should do now. The caller applies
  // "merge"/"reorder" and re-runs after `delayMs` for "wait".
  decide(
    x: number,
    y: number,
    now: number,
    velocity: PointerVelocity,
    state: AutoDragState,
    snapshots: DragTargetSnapshot[]
  ): AutoDragDecision {
    const hit = findMergeHit(x, y, state, snapshots);
    let key: string;
    let insertAt = -1;
    let near = false;
    if (hit) {
      key = `merge:${hit.id}`;
    } else {
      const next = insertionIndexForPoint(x, y, state);
      if (next === null || next === state.insertAt || isHeadingIntoMergeCore(x, y, velocity, state, snapshots)) {
        this.pending = null;
        return { kind: "none" };
      }
      near = approachedTarget(x, y, state, snapshots) !== null;
      key = `${near ? "reorder-near" : "reorder"}:${next}`;
      insertAt = next;
    }

    const dwell = hit
      ? hit.intent === "trash"
        ? trashDwellMs
        : mergeDwellMs
      : near
        ? approachReorderDwellMs
        : reorderDwellMs;
    const armed = hit ?? undefined;
    if (!this.pending || this.pending.key !== key) {
      this.pending = { key, since: now };
      return { kind: "wait", delayMs: dwell + 8, armed };
    }

    const elapsed = now - this.pending.since;
    const maxSpeed = hit
      ? hit.intent === "trash"
        ? trashMaxSpeed
        : mergeMaxSpeed
      : near
        ? approachReorderMaxSpeed
        : reorderMaxSpeed;
    const cooldown = hit ? 0 : Math.max(0, state.lastAppliedAt + reorderCooldownMs - now);
    if (elapsed < dwell || cooldown > 0 || velocity.speed > maxSpeed) {
      return { kind: "wait", delayMs: Math.max(24, dwell - elapsed, cooldown), armed };
    }

    this.pending = null;
    return hit ? { kind: "merge", target: hit } : { kind: "reorder", insertAt };
  }
}
