import { tileTransform } from "../support/geometry";
import type { DesktopApp } from "../DesktopApp";

const reorderPreviewSettleMs = 270;

export interface DragReorderPreviewTarget {
  id: string;
  x: number;
  y: number;
}

export type DragReorderHost = Pick<DesktopApp, "autoReorder" | "dragging" | "freeReorder" | "layout" | "tileElement">;

// The make-room preview both layouts share: other tiles shifted to where a
// reorder would put them, and the timer that re-runs the drag frame while an
// intent is pending. Deciding what to preview is AutoReorder's (auto layout)
// and FreeReorder's (free layout).
export class DragReorder {
  private dragReorderPreviewIds = new Set<string>();
  private dragReorderWakeTimer: number | null = null;

  constructor(private readonly app: DragReorderHost) {}

  // Whether a tile is currently shifted aside by the preview.
  isPreviewed(id: string) {
    return this.dragReorderPreviewIds.has(id);
  }

  // A preview entry for a tile, or null if it would not move.
  dragReorderPreviewTarget(id: string, x: number, y: number): DragReorderPreviewTarget | null {
    const current = this.app.layout.get(id);
    if (!current || (Math.abs(current.x - x) < 0.5 && Math.abs(current.y - y) < 0.5)) {
      return null;
    }

    return { id, x, y };
  }

  applyDragReorderPreview(targets: DragReorderPreviewTarget[]) {
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

  // Drops every preview (and the make-room lean) and puts the tiles back on
  // their slots. `resetIntent: false` keeps the free layout's pending intent.
  clearDragReorderPreview(resetIntent = true) {
    this.app.autoReorder.clearMakeRoomHint(null);
    this.dragReorderPreviewIds.forEach((id) => {
      this.clearDragReorderPreviewElement(id);
    });
    this.dragReorderPreviewIds.clear();
    this.app.freeReorder.resetPreviewState(resetIntent);
    this.clearDragReorderWake();
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

  clearDragReorderWake() {
    if (this.dragReorderWakeTimer !== null) {
      window.clearTimeout(this.dragReorderWakeTimer);
      this.dragReorderWakeTimer = null;
    }
  }
}
