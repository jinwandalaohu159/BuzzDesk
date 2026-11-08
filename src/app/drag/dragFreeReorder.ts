import { desktopViewport } from "../../system/desktopViewport";
import { type FreeReorderPlan, type FreeReorderRect } from "../support/freePlacement";
import { clientToLayout, expandedRect, pointInMergeRect, type Rect } from "../support/geometry";
import type { DesktopApp } from "../DesktopApp";
import { freeDragDelta } from "./dragDrop";
import { desktopDragSourceIds, freeDragMovedItems } from "./dragSource";
import { aimPoint, type ActiveDrag, type DragGroupItem } from "./dragTypes";
import type { DragReorderPreviewTarget } from "./dragReorder";

const reorderPreviewDelayMs = 60;
const reorderPreviewMoveTolerancePx = 20;
const reorderVisualPaddingX = 6;
const reorderVisualPaddingY = 5;

interface DragReorderIntent {
  key: string;
  startX: number;
  startY: number;
  since: number;
}

interface DragReorderCandidate {
  key: string;
  preview: DragReorderPreviewTarget[];
  freePlan?: FreeReorderPlan;
}

export type FreeReorderHost = Pick<DesktopApp, "freePlacement" | "layout" | "reorder" | "root" | "store" | "tiles">;

// Free-layout drags: when the icon rests in a gap (not over another icon),
// preview the reorder plan that would make room there, and hand that plan to
// the drop if it is still showing on release.
export class FreeReorder {
  private dragReorderIntent: DragReorderIntent | null = null;
  private dragReorderActiveKey: string | null = null;
  private dragReorderFreePlan: FreeReorderPlan | null = null;

  constructor(private readonly app: FreeReorderHost) {}

  updateDragReorderPreview(drag: ActiveDrag) {
    if (
      !drag.started ||
      drag.targetId ||
      drag.candidateTargetId ||
      !this.isPointerInReorderGap(drag)
    ) {
      this.app.reorder.clearDragReorderPreview();
      return;
    }

    // Only the free layout previews here; auto-layout drags go through the
    // intent engine (AutoReorder).
    const candidate = this.freeReorderCandidate(drag);
    if (!candidate) {
      this.app.reorder.clearDragReorderPreview();
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
      this.app.reorder.clearDragReorderPreview(false);
      this.app.reorder.scheduleDragReorderWake(reorderPreviewDelayMs);
      return;
    }

    const elapsed = now - intent.since;
    if (elapsed < reorderPreviewDelayMs) {
      this.app.reorder.clearDragReorderPreview(false);
      this.app.reorder.scheduleDragReorderWake(reorderPreviewDelayMs - elapsed);
      return;
    }

    this.app.reorder.clearDragReorderWake();
    this.dragReorderActiveKey = candidate.key;
    this.dragReorderFreePlan = candidate.freePlan ?? null;
    this.app.reorder.applyDragReorderPreview(candidate.preview);
  }

  // Called when the shared preview is cleared.
  resetPreviewState(resetIntent: boolean) {
    this.dragReorderActiveKey = null;
    this.dragReorderFreePlan = null;
    if (resetIntent) {
      this.dragReorderIntent = null;
    }
  }

  // The reorder plan a free-layout drop should commit, if the preview for the
  // current position is the one on screen.
  activeFreeReorderPlan(drag: ActiveDrag) {
    if (
      this.app.store.getSettings().layoutMode !== "free" ||
      drag.targetId ||
      drag.candidateTargetId ||
      !this.isPointerInReorderGap(drag)
    ) {
      return null;
    }

    const candidate = this.freeReorderCandidate(drag);
    if (!candidate?.freePlan || candidate.key !== this.dragReorderActiveKey) {
      return null;
    }

    return this.dragReorderFreePlan ?? candidate.freePlan;
  }

  private freeReorderCandidate(drag: ActiveDrag): DragReorderCandidate | null {
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
        this.app.reorder.dragReorderPreviewTarget(
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

  private freeReorderPlan(drag: ActiveDrag): FreeReorderPlan | null {
    const movingRects = this.freeReorderMovingRects(drag);
    if (movingRects.length === 0) {
      return null;
    }

    return this.app.freePlacement.resolveFreeReorderPlan(movingRects);
  }

  private freeReorderMovingRects(drag: ActiveDrag): FreeReorderRect[] {
    const movedItems = freeDragMovedItems(drag);
    if (movedItems.length === 0) {
      return [];
    }

    const viewport = desktopViewport();
    const { dx, dy } = freeDragDelta(this.app, drag, movedItems, viewport);
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

  // In a gap: over neither a merge target nor any icon or label.
  private isPointerInReorderGap(drag: ActiveDrag) {
    return !this.isPointerOverMergeTarget(drag) && !this.isPointerOverDesktopVisualContent(drag);
  }

  private isPointerOverMergeTarget(drag: ActiveDrag) {
    const aim = aimPoint(drag);
    return drag.targetSnapshots.some((snapshot) => pointInMergeRect(aim.x, aim.y, snapshot.hitRect));
  }

  private isPointerOverDesktopVisualContent(drag: ActiveDrag) {
    const excludedIds = new Set(desktopDragSourceIds(drag));
    if (drag.source.type === "folder") {
      excludedIds.add(drag.source.folderId);
    }

    // Runs every frame: measure the DOM once per drag, then it's pure math.
    drag.visualOffsets ??= this.captureTileVisualOffsets();
    const aimed = aimPoint(drag);
    const { x, y } = clientToLayout(this.app.root, aimed.x, aimed.y);
    for (const [id, offset] of drag.visualOffsets) {
      if (excludedIds.has(id) || this.app.reorder.isPreviewed(id)) {
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
}
