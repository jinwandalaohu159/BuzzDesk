import { computeDesktopLayout } from "../../layout/grid";
import { desktopViewport } from "../../system/desktopViewport";
import {
  isInsideActiveMergeTarget,
  mergeCoreRect,
  mergeExitPaddingPx,
  previewNodeOrder,
  type AutoDragState,
  type DragTargetSnapshot
} from "../../interaction/autoDragIntent";
import { clientToLayout, layoutToClient, tileTransform } from "../support/geometry";
import type { DesktopNode } from "../../types";
import type { DesktopApp } from "../DesktopApp";
import { desktopDragSourceIds } from "./dragSource";
import { aimPoint, type ActiveDrag } from "./dragTypes";
import type { DragReorderPreviewTarget } from "./dragReorder";

// How far the neighbours lean apart while room is about to open.
const makeRoomHintPx = 12;

export type AutoReorderHost = Pick<
  DesktopApp,
  "dragging"
  | "findFolderChild"
  | "layout"
  | "merge"
  | "reorder"
  | "root"
  | "settingsActions"
  | "store"
  | "tileElement"
>;

// Auto-layout drags: run the intent engine (interaction/autoDragIntent) every
// frame and apply what it settles on — arm / form a folder, lean the
// neighbours apart (make-room hint), or open the slot (preview reorder).
export class AutoReorder {
  // Tiles currently leaning apart to hint that room is about to open.
  private readonly hintIds = new Set<string>();

  constructor(private readonly app: AutoReorderHost) {}

  // The nodes the drag carries, as the intent engine sees them.
  autoReorderMovingNodes(drag: ActiveDrag, nodes: DesktopNode[]) {
    if (drag.source.type === "folder") {
      const child = this.app.findFolderChild(drag.source.folderId, drag.source.childId);
      return child ? [child] : [];
    }

    const movingIds = new Set(desktopDragSourceIds(drag));
    return nodes.filter((node) => movingIds.has(node.id));
  }

  // Classify the pointer and apply the intent the engine settles on.
  updateAutoDragIntent(drag: ActiveDrag, state: AutoDragState) {
    const now = performance.now();
    const aimed = aimPoint(drag);
    const { x, y } = clientToLayout(this.app.root, aimed.x, aimed.y);

    if (drag.targetId) {
      const active = drag.targetSnapshots.find((entry) => entry.id === drag.targetId);
      if (active && isInsideActiveMergeTarget(x, y, state, active)) {
        this.clearMakeRoomHint(state);
        this.syncAutoMergeGeometry(drag, state, active);
        return;
      }

      this.app.merge.setMergeTarget(null);
    }

    const decision = drag.intent.decide(x, y, now, drag.pointer.velocity(now), state, drag.targetSnapshots);
    this.app.merge.setMergeArmed(decision.kind === "wait" ? decision.armed?.id ?? null : null);
    if (decision.kind === "wait" && decision.hint) {
      this.showMakeRoomHint(state, x, y);
    } else {
      // On a reorder this also undoes the lean first: tiles the reorder leaves
      // in place must not stay shifted (it then moves the ones that change slot).
      this.clearMakeRoomHint(state);
    }
    if (decision.kind === "wait") {
      this.app.reorder.scheduleDragReorderWake(decision.delayMs);
    } else if (decision.kind === "merge") {
      this.app.merge.setMergeTarget(decision.target.id, null, null, decision.target.intent);
      this.syncAutoMergeGeometry(drag, state, decision.target);
      this.app.dragging.scheduleDragFrame();
    } else if (decision.kind === "reorder") {
      this.applyAutoReorder(state, decision.insertAt);
    }
  }

  // Resting beside icons: lean the two tiles on either side of the icon's
  // position apart a little. It tells the user room is about to open, while
  // the icon they may be heading for barely moves.
  private showMakeRoomHint(state: AutoDragState, x: number, y: number) {
    const moving = new Set(state.movingIds);
    let left: { id: string; x: number } | null = null;
    let right: { id: string; x: number } | null = null;
    for (const [id, slot] of state.layout) {
      if (moving.has(id) || y < slot.y || y > slot.y + slot.height) {
        continue;
      }
      const center = slot.x + slot.width / 2;
      if (center <= x && (!left || center > left.x)) {
        left = { id, x: center };
      } else if (center > x && (!right || center < right.x)) {
        right = { id, x: center };
      }
    }

    const next = new Map<string, number>();
    if (left) next.set(left.id, -makeRoomHintPx);
    if (right) next.set(right.id, makeRoomHintPx);
    if (next.size === this.hintIds.size && [...next].every(([id]) => this.hintIds.has(id))) {
      return;
    }

    this.clearMakeRoomHint(state);
    next.forEach((shift, id) => {
      const slot = state.layout.get(id);
      const element = this.app.tileElement(id);
      if (!slot || !element) {
        return;
      }
      element.classList.add("is-reorder-preview");
      element.style.transform = tileTransform(slot.x + shift, slot.y);
      this.hintIds.add(id);
    });
  }

  clearMakeRoomHint(state: AutoDragState | null) {
    this.hintIds.forEach((id) => {
      const slot = state?.layout.get(id) ?? this.app.layout.get(id);
      const element = this.app.tileElement(id);
      if (slot && element) {
        element.style.transform = tileTransform(slot.x, slot.y);
      }
    });
    this.hintIds.clear();
  }

  // Keeps the active merge target's geometry (client coordinates) in sync with
  // where the target tile is displayed, for the target pull and drop test.
  private syncAutoMergeGeometry(drag: ActiveDrag, state: AutoDragState, snapshot: DragTargetSnapshot) {
    const slot = state.layout.get(snapshot.id);
    if (!slot) {
      return;
    }

    const origin = layoutToClient(this.app.root, slot.x, slot.y);
    drag.targetRect = new DOMRect(origin.x, origin.y, slot.width, slot.height);
    const core = mergeCoreRect(slot, snapshot, mergeExitPaddingPx);
    const topLeft = layoutToClient(this.app.root, core.left, core.top);
    const bottomRight = layoutToClient(this.app.root, core.right, core.bottom);
    drag.targetHitRect = {
      ...core,
      left: topLeft.x,
      right: bottomRight.x,
      top: topLeft.y,
      bottom: bottomRight.y
    };
  }

  // Opens the slot at `insertAt`: lay the grid out as if the dragged block were
  // there and preview every tile that changes place.
  private applyAutoReorder(state: AutoDragState, insertAt: number) {
    const nodeById = new Map(this.app.store.getNodes().map((node) => [node.id, node]));
    const preview = previewNodeOrder(state, nodeById, insertAt);
    const viewport = desktopViewport();
    const settings = this.app.settingsActions.effectiveDesktopSettings(this.app.store.getSettings(), preview.nodes, viewport);
    const previewLayout = computeDesktopLayout(
      preview.nodes,
      viewport.width,
      viewport.height,
      settings,
      viewport.offsetX,
      viewport.offsetY
    );

    const targets = preview.remaining
      .map((node) => {
        const slot = previewLayout.get(node.id);
        return slot ? this.app.reorder.dragReorderPreviewTarget(node.id, slot.x, slot.y) : null;
      })
      .filter((target): target is DragReorderPreviewTarget => Boolean(target));

    this.app.reorder.applyDragReorderPreview(targets);
    state.layout = previewLayout;
    state.insertAt = preview.insertAt;
    state.lastAppliedAt = performance.now();
  }
}
