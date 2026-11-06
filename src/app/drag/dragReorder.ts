import { computeDesktopLayout, desktopIndexForPoint } from "../../layout/grid";
import { desktopViewport } from "../../system/desktopViewport";
import { type FreeReorderPlan, type FreeReorderRect } from "../freePlacement";
import {
  isInsideActiveMergeTarget,
  mergeCoreRect,
  mergeExitPaddingPx,
  previewNodeOrder,
  type AutoDragState,
  type DragTargetSnapshot
} from "../../interaction/autoDragIntent";
import {
  clientToLayout,
  expandedRect,
  layoutToClient,
  pointInMergeRect,
  tileTransform,
  type Rect
} from "../support/geometry";
import type { DesktopNode } from "../../types";
import { aimPoint, type ActiveDrag, type DragGroupItem } from "./dragTypes";
import type { DesktopApp } from "../DesktopApp";

const reorderPreviewDelayMs = 60;
const reorderPreviewMoveTolerancePx = 20;
const reorderPreviewSettleMs = 270;
const reorderVisualPaddingX = 6;
const reorderVisualPaddingY = 5;

interface DragReorderIntent {
  key: string;
  startX: number;
  startY: number;
  since: number;
}

interface DragReorderPreviewTarget {
  id: string;
  x: number;
  y: number;
}

interface DragReorderCandidate {
  key: string;
  preview: DragReorderPreviewTarget[];
  freePlan?: FreeReorderPlan;
}

export type DragReorderHost = Pick<
  DesktopApp,
  "dragging"
  | "findFolderChild"
  | "freePlacement"
  | "layout"
  | "merge"
  | "root"
  | "settingsActions"
  | "store"
  | "tileElement"
  | "tiles"
>;

// Make-room reordering while dragging: intent detection, preview offsets of
// the other tiles, and free-layout reorder plans.
export class DragReorder {
  private dragReorderIntent: DragReorderIntent | null = null;
  dragReorderActiveKey: string | null = null;
  private dragReorderPreviewIds = new Set<string>();
  dragReorderFreePlan: FreeReorderPlan | null = null;
  private dragReorderWakeTimer: number | null = null;

  constructor(private readonly app: DragReorderHost) {}

  updateDragReorderPreview(drag: ActiveDrag) {
    if (
      !drag.started ||
      drag.targetId ||
      drag.candidateTargetId ||
      !this.isPointerInReorderGap(drag)
    ) {
      this.clearDragReorderPreview();
      return;
    }

    // Only the free layout previews here; auto-layout drags go through the
    // intent engine (updateAutoDragIntent).
    const candidate = this.freeReorderCandidate(drag);
    if (!candidate) {
      this.clearDragReorderPreview();
      return;
    }

    const now = performance.now();
    const intent = this.dragReorderIntent;
    const activeForCandidate = this.dragReorderActiveKey === candidate.key;
    const movedTooFar =
      intent &&
      !activeForCandidate &&
      Math.hypot(drag.currentX - intent.startX, drag.currentY - intent.startY) > reorderPreviewMoveTolerancePx;

    if (!intent || intent.key !== candidate.key || movedTooFar) {
      this.dragReorderIntent = {
        key: candidate.key,
        startX: drag.currentX,
        startY: drag.currentY,
        since: now
      };
      this.clearDragReorderPreview(false);
      this.scheduleDragReorderWake(reorderPreviewDelayMs);
      return;
    }

    const elapsed = now - intent.since;
    if (elapsed < reorderPreviewDelayMs) {
      this.clearDragReorderPreview(false);
      this.scheduleDragReorderWake(reorderPreviewDelayMs - elapsed);
      return;
    }

    this.clearDragReorderWake();
    this.dragReorderActiveKey = candidate.key;
    this.dragReorderFreePlan = candidate.freePlan ?? null;
    this.applyDragReorderPreview(candidate.preview);
  }

  autoReorderMovingNodes(drag: ActiveDrag, nodes: DesktopNode[]) {
    if (drag.source.type === "folder") {
      const child = this.app.findFolderChild(drag.source.folderId, drag.source.childId);
      return child ? [child] : [];
    }

    const movingIds = new Set(this.app.dragging.desktopDragSourceIds(drag));
    return nodes.filter((node) => movingIds.has(node.id));
  }

  freeReorderCandidate(drag: ActiveDrag): DragReorderCandidate | null {
    if (this.app.store.getSettings().layoutMode !== "free" || drag.source.type !== "desktop") {
      return null;
    }

    const plan = this.freeReorderPlan(drag);
    if (!plan) {
      return null;
    }

    const viewport = desktopViewport();
    const preview = plan.positions
      .filter((entry) => !plan.movingIds.has(entry.id))
      .map((entry) =>
        this.dragReorderPreviewTarget(
          entry.id,
          viewport.offsetX + entry.position.x,
          viewport.offsetY + entry.position.y
        )
      )
      .filter((target): target is DragReorderPreviewTarget => Boolean(target));

    if (preview.length === 0) {
      return null;
    }

    return {
      key: `free:${plan.key}`,
      preview,
      freePlan: plan
    };
  }

  private dragReorderPreviewTarget(id: string, x: number, y: number): DragReorderPreviewTarget | null {
    const current = this.app.layout.get(id);
    if (!current || (Math.abs(current.x - x) < 0.5 && Math.abs(current.y - y) < 0.5)) {
      return null;
    }

    return { id, x, y };
  }

  private freeReorderPlan(drag: ActiveDrag): FreeReorderPlan | null {
    const movingRects = this.freeReorderMovingRects(drag);
    if (movingRects.length === 0) {
      return null;
    }

    return this.app.freePlacement.resolveFreeReorderPlan(movingRects);
  }

  private freeReorderMovingRects(drag: ActiveDrag): FreeReorderRect[] {
    const movedItems = this.app.dragging.freeDragMovedItems(drag);
    if (movedItems.length === 0) {
      return [];
    }

    const viewport = desktopViewport();
    const { dx, dy } = this.app.dragging.freeDragDelta(drag, movedItems, viewport);
    if (movedItems.length > 1) {
      return this.freeGroupReorderRects(movedItems, dx, dy);
    }

    return movedItems.map((item) => {
      const compactPlacement = this.app.freePlacement.isCompactPlacementFolder(item.id);
      const position = this.app.freePlacement.snapDesktopPosition(
        item.baseX + dx - viewport.offsetX,
        item.baseY + dy - viewport.offsetY,
        item.width,
        item.height,
        viewport,
        compactPlacement
      );

      return {
        id: item.id,
        x: position.x,
        y: position.y,
        width: item.width,
        height: item.height,
        compactPlacement
      };
    });
  }

  private freeGroupReorderRects(
    movedItems: Array<Pick<DragGroupItem, "id" | "baseX" | "baseY" | "width" | "height">>,
    dx: number,
    dy: number
  ): FreeReorderRect[] {
    const viewport = desktopViewport();
    const groupLeft = Math.min(...movedItems.map((item) => item.baseX - viewport.offsetX));
    const groupTop = Math.min(...movedItems.map((item) => item.baseY - viewport.offsetY));
    const groupRight = Math.max(...movedItems.map((item) => item.baseX - viewport.offsetX + item.width));
    const groupBottom = Math.max(...movedItems.map((item) => item.baseY - viewport.offsetY + item.height));
    const groupWidth = groupRight - groupLeft;
    const groupHeight = groupBottom - groupTop;
    const position = this.app.freePlacement.snapDesktopPosition(groupLeft + dx, groupTop + dy, groupWidth, groupHeight, viewport);

    return movedItems.map((item) => ({
      id: item.id,
      x: position.x + (item.baseX - viewport.offsetX - groupLeft),
      y: position.y + (item.baseY - viewport.offsetY - groupTop),
      width: item.width,
      height: item.height,
      compactPlacement: this.app.freePlacement.isCompactPlacementFolder(item.id)
    }));
  }

  // Auto-layout drags: classify the pointer every frame and apply the intent
  // the engine settles on (see interaction/autoDragIntent).
  updateAutoDragIntent(drag: ActiveDrag, state: AutoDragState) {
    const now = performance.now();
    const aimed = aimPoint(drag);
    const { x, y } = clientToLayout(this.app.root, aimed.x, aimed.y);

    if (drag.targetId) {
      const active = drag.targetSnapshots.find((entry) => entry.id === drag.targetId);
      if (active && isInsideActiveMergeTarget(x, y, state, active)) {
        this.syncAutoMergeGeometry(drag, state, active);
        return;
      }

      this.app.merge.setMergeTarget(null);
    }

    const decision = drag.intent.decide(x, y, now, drag.pointer.velocity(now), state, drag.targetSnapshots);
    this.app.merge.setMergeArmed(decision.kind === "wait" ? decision.armed?.id ?? null : null);
    if (decision.kind === "wait") {
      this.scheduleDragReorderWake(decision.delayMs);
    } else if (decision.kind === "merge") {
      this.app.merge.setMergeTarget(decision.target.id, null, null, decision.target.intent);
      this.syncAutoMergeGeometry(drag, state, decision.target);
      this.app.dragging.scheduleDragFrame();
    } else if (decision.kind === "reorder") {
      this.applyAutoReorder(state, decision.insertAt);
    }
  }

  // Keeps the active merge target's geometry (client coordinates) in sync with
  // where the target tile is displayed, for the magnet effect and drop test.
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
        return slot ? this.dragReorderPreviewTarget(node.id, slot.x, slot.y) : null;
      })
      .filter((target): target is DragReorderPreviewTarget => Boolean(target));

    this.applyDragReorderPreview(targets);
    state.layout = previewLayout;
    state.insertAt = preview.insertAt;
    state.lastAppliedAt = performance.now();
  }

  isPointerInReorderGap(drag: ActiveDrag) {
    return !this.isPointerOverMergeTarget(drag) && !this.isPointerOverDesktopVisualContent(drag);
  }

  private isPointerOverMergeTarget(drag: ActiveDrag) {
    const aim = aimPoint(drag);
    return drag.targetSnapshots.some((snapshot) => pointInMergeRect(aim.x, aim.y, snapshot.hitRect));
  }

  private isPointerOverDesktopVisualContent(drag: ActiveDrag) {
    const excludedIds = new Set(this.app.dragging.desktopDragSourceIds(drag));
    if (drag.source.type === "folder") {
      excludedIds.add(drag.source.folderId);
    }

    // Runs every frame: measure the DOM once per drag, then it's pure math.
    drag.visualOffsets ??= this.captureTileVisualOffsets();
    const aimed = aimPoint(drag);
    const { x, y } = clientToLayout(this.app.root, aimed.x, aimed.y);
    for (const [id, offset] of drag.visualOffsets) {
      if (excludedIds.has(id) || this.dragReorderPreviewIds.has(id)) {
        continue;
      }

      const slot = this.app.layout.get(id);
      if (
        slot &&
        x >= slot.x + offset.left &&
        x <= slot.x + offset.right &&
        y >= slot.y + offset.top &&
        y <= slot.y + offset.bottom
      ) {
        return true;
      }
    }

    return false;
  }

  private captureTileVisualOffsets() {
    const offsets = new Map<string, Rect>();
    this.app.tiles.forEach(({ element }, id) => {
      const visual = this.desktopTileVisualRect(element);
      if (!visual) {
        return;
      }

      const tileRect = element.getBoundingClientRect();
      offsets.set(id, {
        left: visual.left - tileRect.left,
        top: visual.top - tileRect.top,
        right: visual.right - tileRect.left,
        bottom: visual.bottom - tileRect.top,
        width: visual.width,
        height: visual.height
      });
    });
    return offsets;
  }

  private desktopTileVisualRect(element: HTMLElement) {
    const icon = element.querySelector<HTMLElement>(".folder-cover")
      ?? element.querySelector<HTMLElement>(".app-icon")
      ?? element.querySelector<HTMLElement>(".fallback-icon")
      ?? element.querySelector<HTMLElement>(".icon-shell");
    const label = element.querySelector<HTMLElement>(".tile-rename")
      ?? element.querySelector<HTMLElement>(".tile-name");
    const rects = [
      icon?.getBoundingClientRect() ?? null,
      this.tileLabelVisualRect(label)
    ].filter((rect): rect is DOMRect => Boolean(rect && rect.width > 0 && rect.height > 0));

    if (rects.length === 0) {
      return null;
    }

    return expandedRect({
      left: Math.min(...rects.map((rect) => rect.left)),
      top: Math.min(...rects.map((rect) => rect.top)),
      right: Math.max(...rects.map((rect) => rect.right)),
      bottom: Math.max(...rects.map((rect) => rect.bottom))
    }, reorderVisualPaddingX, reorderVisualPaddingY);
  }

  private tileLabelVisualRect(label: HTMLElement | null) {
    if (!label) {
      return null;
    }

    if (!label.classList.contains("tile-name")) {
      return label.getBoundingClientRect();
    }

    const range = document.createRange();
    range.selectNodeContents(label);
    const rect = range.getBoundingClientRect();
    range.detach();
    return rect.width > 0 && rect.height > 0 ? rect : label.getBoundingClientRect();
  }

  private applyDragReorderPreview(targets: DragReorderPreviewTarget[]) {
    const nextIds = new Set(targets.map((target) => target.id));

    this.dragReorderPreviewIds.forEach((id) => {
      if (!nextIds.has(id)) {
        this.clearDragReorderPreviewElement(id);
      }
    });

    targets.forEach((target) => {
      const element = this.app.tileElement(target.id);
      if (!element || element.classList.contains("is-dragging")) {
        return;
      }

      const transform = tileTransform(target.x, target.y);
      element.classList.add("is-reorder-preview");
      if (element.style.transform !== transform) {
        element.style.transform = transform;
      }
    });

    this.dragReorderPreviewIds = nextIds;
  }

  clearDragReorderPreview(resetIntent = true) {
    this.dragReorderPreviewIds.forEach((id) => {
      this.clearDragReorderPreviewElement(id);
    });
    this.dragReorderPreviewIds.clear();
    this.dragReorderActiveKey = null;
    this.dragReorderFreePlan = null;
    this.clearDragReorderWake();
    if (resetIntent) {
      this.dragReorderIntent = null;
    }
  }

  private clearDragReorderPreviewElement(id: string) {
    const element = this.app.tileElement(id);
    if (!element) {
      return;
    }

    const slot = this.app.layout.get(id);
    if (!slot) {
      element.classList.remove("is-reorder-preview");
      element.style.transform = "";
      return;
    }

    element.style.transform = tileTransform(slot.x, slot.y);
    window.setTimeout(() => {
      if (!this.dragReorderPreviewIds.has(id)) {
        element.classList.remove("is-reorder-preview");
      }
    }, reorderPreviewSettleMs);
  }

  scheduleDragReorderWake(delayMs: number) {
    this.clearDragReorderWake();
    this.dragReorderWakeTimer = window.setTimeout(() => {
      this.dragReorderWakeTimer = null;
      if (this.app.dragging.drag?.started && !this.app.dragging.drag.committing) {
        this.app.dragging.scheduleDragFrame();
      }
    }, Math.max(0, Math.ceil(delayMs)));
  }

  private clearDragReorderWake() {
    if (this.dragReorderWakeTimer !== null) {
      window.clearTimeout(this.dragReorderWakeTimer);
      this.dragReorderWakeTimer = null;
    }
  }

  // Index into the full node list for a point (fallback when no auto-drag
  // state exists; DragController converts it for placeDesktopNodes).
  desktopInsertionIndex(clientX: number, clientY: number) {
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
}
