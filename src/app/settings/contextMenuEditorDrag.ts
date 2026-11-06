// Drag-to-reorder for the context menu editor in settings: rows can be moved
// within their list (main menu / "more" menu); the drop position is painted as
// a before/after/end marker and committed through the host.
import { isEditableContextMenuPlacement } from "../support/guards";
import type { DesktopContextMenuPlacement } from "../../types";

type EditablePlacement = Exclude<DesktopContextMenuPlacement, "hidden">;

export interface ContextMenuEditorDragHost {
  getLayer(): HTMLElement;
  isEditorVisible(): boolean;
  suppressNextClick(): void;
  move(key: string, targetKey: string | null, placement: EditablePlacement, position: "before" | "after" | "end"): void;
}

interface DropTarget {
  list: HTMLElement;
  row: HTMLElement | null;
  targetKey: string | null;
  position: "before" | "after" | "end";
}

interface DragState {
  key: string;
  placement: EditablePlacement;
  pointerId: number;
  startX: number;
  startY: number;
  startRect: DOMRect;
  row: HTMLElement;
  active: boolean;
  lastTarget: DropTarget | null;
}

export class ContextMenuEditorDrag {
  private drag: DragState | null = null;
  private paintedDrop: DropTarget | null = null;

  constructor(private readonly host: ContextMenuEditorDragHost) {}

  onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !this.host.isEditorVisible()) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select")) {
      return;
    }

    const row = target.closest<HTMLElement>("[data-setting-context-menu-drag]");
    const key = row?.dataset.settingContextMenuDrag;
    const placement = row?.dataset.settingContextMenuRowPlacement;
    if (!row || !key || !isEditableContextMenuPlacement(placement)) {
      return;
    }

    event.preventDefault();
    this.drag = {
      key,
      placement,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: row.getBoundingClientRect(),
      row,
      active: false,
      lastTarget: null
    };

    try {
      row.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level listeners keep the drag alive if capture is unavailable.
    }

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp, { once: true });
    window.addEventListener("pointercancel", this.onPointerCancel, { once: true });
    window.addEventListener("blur", this.onPointerCancel, { once: true });
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 2) {
        return;
      }

      drag.active = true;
      drag.row.classList.add("is-dragging");
      this.host.getLayer().classList.add("is-menu-dragging");
    }

    event.preventDefault();
    drag.row.style.setProperty("--settings-menu-drag-y", `${dy}px`);
    const target = this.dropTargetAt(event.clientX, event.clientY, drag);
    drag.lastTarget = target;
    this.paintDropTarget(target);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const target = drag.active
      ? this.dropTargetAt(event.clientX, event.clientY, drag) ?? drag.lastTarget
      : null;
    const shouldCommit = drag.active && target && target.targetKey !== drag.key;
    const key = drag.key;
    const placement = drag.placement;
    this.clear();
    this.removeListeners();

    if (!shouldCommit) {
      return;
    }

    event.preventDefault();
    this.host.suppressNextClick();
    this.host.move(key, target.targetKey, placement, target.position);
  };

  private readonly onPointerCancel = () => {
    this.clear();
    this.removeListeners();
  };

  private removeListeners() {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onPointerCancel);
  }

  private dropTargetAt(
    clientX: number,
    clientY: number,
    drag: DragState
  ): DropTarget | null {
    if (
      clientX >= drag.startRect.left &&
      clientX <= drag.startRect.right &&
      clientY >= drag.startRect.top &&
      clientY <= drag.startRect.bottom
    ) {
      return null;
    }

    const previousPointerEvents = drag.row.style.pointerEvents;
    drag.row.style.pointerEvents = "none";
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    drag.row.style.pointerEvents = previousPointerEvents;
    return target ? this.dropTargetForElement(target, clientY, drag) : null;
  }

  private dropTargetForElement(
    target: HTMLElement,
    clientY: number,
    drag: DragState
  ): DropTarget | null {
    const list = target.closest<HTMLElement>("[data-setting-context-menu-list]");
    const placement = list?.dataset.settingContextMenuList;
    if (!list || placement !== drag.placement) {
      return null;
    }

    const divider = target.closest<HTMLElement>("[data-setting-context-menu-drop-after]");
    if (divider && list.contains(divider)) {
      const targetKey = divider.dataset.settingContextMenuDropAfter ?? null;
      return targetKey && targetKey !== drag.key ? { list, row: divider, targetKey, position: "after" } : null;
    }

    const row = target.closest<HTMLElement>("[data-setting-context-menu-drag]");
    if (row && list.contains(row)) {
      const targetKey = row.dataset.settingContextMenuDrag ?? null;
      if (targetKey === drag.key) {
        return null;
      }

      const rect = row.getBoundingClientRect();
      const position = clientY > rect.top + rect.height / 2 ? "after" : "before";
      return { list, row, targetKey, position };
    }

    return { list, row: null, targetKey: null, position: "end" };
  }

  private paintDropTarget(target: DropTarget | null) {
    if (sameDropTarget(this.paintedDrop, target)) {
      return;
    }

    this.clearDropMarker(this.paintedDrop);
    this.paintedDrop = target;
    if (!target) {
      return;
    }

    if (target.row) {
      target.row.classList.add(target.position === "after" ? "is-drop-after" : "is-drop-before");
    } else {
      target.list.classList.add("is-drop-end");
    }
  }

  private clearDropMarkers() {
    this.clearDropMarker(this.paintedDrop);
    this.paintedDrop = null;
  }

  private clearDropMarker(target: DropTarget | null) {
    if (!target) {
      return;
    }

    target.row?.classList.remove("is-drop-before", "is-drop-after");
    target.list.classList.remove("is-drop-end");
  }

  clear() {
    this.clearDropMarkers();
    this.host.getLayer().querySelectorAll(".is-dragging").forEach((element) => {
      (element as HTMLElement).style.removeProperty("--settings-menu-drag-y");
      element.classList.remove("is-dragging");
    });
    this.host.getLayer().classList.remove("is-menu-dragging");
    this.drag = null;
  }
}

function sameDropTarget(
  a: DropTarget | null,
  b: DropTarget | null
) {
  return a?.list === b?.list && a?.row === b?.row && a?.targetKey === b?.targetKey && a?.position === b?.position;
}
