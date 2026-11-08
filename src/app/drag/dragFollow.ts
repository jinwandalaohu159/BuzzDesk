import { dragAutoScrollDelta, dragFrameTransform, toTransformStyle } from "../../animation/drag";
import { desktopTileMetrics } from "../../settings/desktopSettings";
import { desktopViewport } from "../../system/desktopViewport";
import { clampScroll, tileTransform } from "../support/geometry";
import type { DesktopApp } from "../DesktopApp";
import { isDesktopGroupDrag } from "./dragSource";
import type { ActiveDrag, DragGroupItem } from "./dragTypes";

export type DragFollowHost = Pick<DesktopApp, "grid" | "layout" | "merge" | "root" | "store" | "tileElement">;

// Keeps dragged icons under the pointer: picking tiles up (wherever they are
// seen mid-glide), writing their per-frame transforms, edge auto-scroll, and
// putting tiles back on their slots.
export class DragFollow {
  constructor(private readonly app: DragFollowHost) {}

  // How far a tile currently is (visually) from the slot it is laid out at;
  // non-zero only while an animation or transition is moving it.
  visualOffset(element: HTMLElement, baseX: number, baseY: number) {
    if (element.parentElement !== this.app.grid || element.getAnimations().length === 0) {
      return { x: 0, y: 0 };
    }

    const grid = this.app.grid.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - (grid.left + baseX + element.offsetWidth / 2),
      y: rect.top + rect.height / 2 - (grid.top + baseY + element.offsetHeight / 2)
    };
  }

  // From here on the pointer alone moves the tile: stop any glide still
  // running on it, or it would override the drag position and lag behind.
  liftForDrag(element: HTMLElement) {
    element.getAnimations().forEach((animation) => animation.cancel());
    element.classList.remove("is-reorder-preview");
    element.classList.add("is-dragging");
  }

  captureDesktopDragGroup(nodeIds: string[]) {
    const uniqueIds = Array.from(new Set(nodeIds));
    if (uniqueIds.length <= 1) {
      return [];
    }

    return uniqueIds
      .map((id): DragGroupItem | null => {
        const element = this.app.tileElement(id);
        const slot = this.app.layout.get(id);
        if (!element || !slot) {
          return null;
        }

        const grabbed = this.visualOffset(element, slot.x, slot.y);
        return {
          id,
          element,
          baseX: slot.x + grabbed.x,
          baseY: slot.y + grabbed.y,
          width: slot.width,
          height: slot.height
        };
      })
      .filter((item): item is DragGroupItem => Boolean(item));
  }

  // Places the dragged icon(s) under the pointer.
  writeFollowFrame(drag: ActiveDrag) {
    if (isDesktopGroupDrag(drag)) {
      this.writeGroupFollowFrame(drag);
      return;
    }

    const mergeTarget = drag.targetId && drag.targetRect ? drag.targetRect : null;
    const transform = dragFrameTransform({
      currentX: drag.currentX,
      currentY: drag.currentY,
      startX: drag.startX,
      startY: drag.startY,
      baseX: drag.baseX,
      baseY: drag.baseY,
      sourceLayoutOffsetX: drag.floating ? 0 : this.app.root.scrollLeft - drag.startScrollLeft,
      sourceLayoutOffsetY: drag.floating ? 0 : this.app.root.scrollTop - drag.startScrollTop,
      width: drag.width,
      height: drag.height,
      targetRect: mergeTarget
    });

    if (mergeTarget && drag.targetElement) {
      this.app.merge.writeMergePull(drag, transform.targetPullX, transform.targetPullY);
    }
    writeTransform(drag, drag.element, toTransformStyle(transform));
  }

  // A selected group moves as one block, kept inside the desktop's padding.
  private writeGroupFollowFrame(drag: ActiveDrag) {
    let dx = drag.currentX - drag.startX;
    let dy = drag.currentY - drag.startY;
    const offsetX = this.app.root.scrollLeft - drag.startScrollLeft;
    const offsetY = this.app.root.scrollTop - drag.startScrollTop;
    const viewport = desktopViewport();
    const minX = Math.min(...drag.groupItems.map((item) => item.baseX - viewport.offsetX));
    const minY = Math.min(...drag.groupItems.map((item) => item.baseY - viewport.offsetY));
    const maxX = Math.max(...drag.groupItems.map((item) => item.baseX - viewport.offsetX + item.width));
    const maxY = Math.max(...drag.groupItems.map((item) => item.baseY - viewport.offsetY + item.height));
    const metrics = desktopTileMetrics(this.app.store.getSettings());
    dx = clampScroll(dx + offsetX, metrics.paddingX - minX, viewport.width - metrics.paddingX - maxX) - offsetX;
    dy = clampScroll(dy + offsetY, metrics.paddingY - minY, viewport.height - metrics.paddingY - maxY) - offsetY;

    drag.groupItems.forEach((item) => {
      writeTransform(item, item.element, toTransformStyle({
        x: item.baseX + dx + offsetX,
        y: item.baseY + dy + offsetY,
        scale: 1
      }));
    });
  }

  // Scrolls the desktop while a dragged icon nears a screen edge (only when the
  // desktop is larger than the screen).
  autoScrollDrag(drag: ActiveDrag) {
    const delta = dragAutoScrollDelta(drag.currentX, drag.currentY, window.innerWidth, window.innerHeight);
    if (delta.x === 0 && delta.y === 0) {
      return false;
    }

    const root = this.app.root;
    const beforeLeft = root.scrollLeft;
    const beforeTop = root.scrollTop;
    root.scrollLeft = clampScroll(beforeLeft + delta.x, 0, root.scrollWidth - root.clientWidth);
    root.scrollTop = clampScroll(beforeTop + delta.y, 0, root.scrollHeight - root.clientHeight);
    return root.scrollLeft !== beforeLeft || root.scrollTop !== beforeTop;
  }

  // Put a tile back on its layout slot. Clearing the transform instead would
  // park it at the grid origin, and any animation captured from there would
  // fly in from the top-left corner.
  restoreSlotTransform(id: string, element: HTMLElement) {
    const slot = element.parentElement === this.app.grid ? this.app.layout.get(id) : undefined;
    element.style.transform = slot ? tileTransform(slot.x, slot.y) : "";
  }
}

// Skips the style write when nothing changed since the last frame.
function writeTransform(cache: { lastTransformStyle?: string }, element: HTMLElement, transform: string) {
  if (cache.lastTransformStyle === transform) {
    return;
  }

  cache.lastTransformStyle = transform;
  element.style.transform = transform;
}
