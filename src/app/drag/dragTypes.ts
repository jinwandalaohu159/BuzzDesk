import type {
  AutoDragIntentTracker,
  AutoDragState,
  DragTargetIntent,
  DragTargetSnapshot
} from "../../interaction/autoDragIntent";
import type { PointerVelocityTracker } from "../../interaction/pointerVelocity";
import { type Rect } from "../support/geometry";

// Drag state shared by the drag controllers and the controllers that start or
// observe a drag.
export type DragSource =
  | { type: "desktop"; nodeId: string }
  | { type: "folder"; folderId: string; childId: string };

export interface ActiveDrag {
  source: DragSource;
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startScrollLeft: number;
  startScrollTop: number;
  // From the pointer to the dragged icon's centre. Intent (merge, make room,
  // drop slot) is judged where the icon is, not where the pointer happens to
  // hold it: a user aims the icon, and may have grabbed it by its label.
  aimOffsetX: number;
  aimOffsetY: number;
  baseX: number;
  baseY: number;
  width: number;
  height: number;
  element: HTMLElement;
  floating: boolean;
  started: boolean;
  frame: number | null;
  targetId: string | null;
  targetIntent: DragTargetIntent | null;
  targetRect: DOMRect | null;
  targetHitRect: Rect | null;
  targetElement: HTMLElement | null;
  candidateTargetId: string | null;
  candidateTargetIntent: DragTargetIntent | null;
  candidateTargetRect: DOMRect | null;
  candidateTargetHitRect: Rect | null;
  mergeIntentTimer: number | null;
  targetSnapshots: DragTargetSnapshot[];
  groupItems: DragGroupItem[];
  lastTransformStyle: string;
  lastPullX: number;
  lastPullY: number;
  toggleSelection: boolean;
  committing: boolean;
  // Engines owned by this one drag (never shared with the next): a merge or
  // trash commit that finishes late cannot reset a drag that started since.
  auto: AutoDragState | null;
  intent: AutoDragIntentTracker;
  pointer: PointerVelocityTracker;
  // Icon+label hit boxes relative to each tile's origin, measured once.
  visualOffsets: Map<string, Rect> | null;
}

export interface DragGroupItem {
  id: string;
  element: HTMLElement;
  baseX: number;
  baseY: number;
  width: number;
  height: number;
  lastTransformStyle?: string;
}

// Client-space point the dragged icon is aimed at (its icon centre).
export function aimPoint(drag: Pick<ActiveDrag, "currentX" | "currentY" | "aimOffsetX" | "aimOffsetY">) {
  return { x: drag.currentX + drag.aimOffsetX, y: drag.currentY + drag.aimOffsetY };
}
