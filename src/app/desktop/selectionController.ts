import { normalizedRect, rectsIntersect, type Rect } from "../support/geometry";
import type { DesktopApp } from "../DesktopApp";

interface MarqueeSelection {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  started: boolean;
  additive: boolean;
  initialSelection: Set<string>;
}

export type SelectionControllerHost = Pick<
  DesktopApp,
  "folder"
  | "grid"
  | "menus"
  | "rename"
  | "root"
  | "selectionMarquee"
  | "store"
  | "suppressClickOnce"
>;

// Desktop icon selection: single / toggle / marquee selection and its DOM state.
export class SelectionController {
  selectedId: string | null = null;
  selectedIds = new Set<string>();
  marquee: MarqueeSelection | null = null;

  constructor(private readonly app: SelectionControllerHost) {}

  desktopSelectionForRender() {
    const selected = new Set(this.selectedIds);
    if (this.selectedId) {
      selected.add(this.selectedId);
    }
    return selected;
  }

  setDesktopSelection(ids: Iterable<string>, primaryId?: string | null) {
    const nodes = new Set(this.app.store.getNodes().map((node) => node.id));
    const next = Array.from(new Set(ids)).filter((id) => nodes.has(id));
    this.selectedIds = new Set(next);
    this.selectedId =
      primaryId && this.selectedIds.has(primaryId)
        ? primaryId
        : next.length > 0
          ? next[next.length - 1]
          : null;
    this.app.folder.selectedFolderChild = null;
  }

  selectSingleDesktopNode(id: string | null) {
    if (!id) {
      this.clearDesktopSelection();
      return;
    }

    this.setDesktopSelection([id], id);
  }

  toggleDesktopNodeSelection(id: string) {
    const selected = this.desktopSelectionForRender();
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
    }

    this.setDesktopSelection(selected, selected.has(id) ? id : null);
  }

  clearDesktopSelection() {
    this.selectedId = null;
    this.selectedIds.clear();
  }

  clearAllSelection() {
    this.clearDesktopSelection();
    this.app.folder.selectedFolderChild = null;
  }

  beginDesktopMarquee(event: PointerEvent) {
    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    this.app.menus.closeContextMenu();
    this.app.rename.renamingId = null;
    this.app.folder.selectedFolderChild = null;
    this.marquee = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      started: false,
      additive: event.ctrlKey || event.shiftKey,
      initialSelection: new Set(this.desktopSelectionForRender())
    };

    try {
      this.app.root.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners below keep the marquee alive if capture is unavailable.
    }

    window.addEventListener("pointermove", this.onMarqueePointerMove);
    window.addEventListener("pointerup", this.onMarqueePointerUp, { once: true });
    window.addEventListener("pointercancel", this.onMarqueePointerCancel, { once: true });
    window.addEventListener("blur", this.onMarqueeWindowBlur, { once: true });
  }

  private readonly onMarqueePointerMove = (event: PointerEvent) => {
    const marquee = this.marquee;
    if (!marquee || event.pointerId !== marquee.pointerId) {
      return;
    }

    marquee.currentX = event.clientX;
    marquee.currentY = event.clientY;
    const moved = Math.hypot(marquee.currentX - marquee.startX, marquee.currentY - marquee.startY);
    if (!marquee.started) {
      if (moved < 1) {
        return;
      }

      marquee.started = true;
      if (!marquee.additive) {
        this.clearDesktopSelection();
      }
      this.app.selectionMarquee.hidden = false;
    }

    event.preventDefault();
    const rect = normalizedRect(marquee.startX, marquee.startY, marquee.currentX, marquee.currentY);
    this.paintSelectionMarquee(rect);
    this.updateMarqueeSelection(rect, marquee);
  };

  private readonly onMarqueePointerUp = (event: PointerEvent) => {
    const marquee = this.marquee;
    if (!marquee || event.pointerId !== marquee.pointerId) {
      return;
    }

    this.removeMarqueeListeners();
    const wasStarted = marquee.started;
    this.marquee = null;
    this.hideSelectionMarquee();
    if (wasStarted) {
      this.app.suppressClickOnce();
    }
  };

  private readonly onMarqueePointerCancel = () => {
    this.cancelDesktopMarquee();
  };

  private readonly onMarqueeWindowBlur = () => {
    this.cancelDesktopMarquee();
  };

  cancelDesktopMarquee() {
    this.removeMarqueeListeners();
    this.marquee = null;
    this.hideSelectionMarquee();
  }

  private removeMarqueeListeners() {
    window.removeEventListener("pointermove", this.onMarqueePointerMove);
    window.removeEventListener("pointerup", this.onMarqueePointerUp);
    window.removeEventListener("pointercancel", this.onMarqueePointerCancel);
    window.removeEventListener("blur", this.onMarqueeWindowBlur);
  }

  private paintSelectionMarquee(rect: Rect) {
    this.app.selectionMarquee.style.left = `${rect.left}px`;
    this.app.selectionMarquee.style.top = `${rect.top}px`;
    this.app.selectionMarquee.style.width = `${rect.width}px`;
    this.app.selectionMarquee.style.height = `${rect.height}px`;
  }

  private hideSelectionMarquee() {
    this.app.selectionMarquee.hidden = true;
    this.app.selectionMarquee.removeAttribute("style");
  }

  private updateMarqueeSelection(rect: Rect, marquee: MarqueeSelection) {
    const selected = new Set(marquee.additive ? marquee.initialSelection : []);
    let primaryId: string | null = null;

    this.app.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((tile) => {
      const id = tile.dataset.nodeId;
      if (!id) {
        return;
      }

      if (rectsIntersect(rect, tile.getBoundingClientRect())) {
        selected.add(id);
        primaryId = id;
      }
    });

    this.setDesktopSelection(selected, primaryId);
    this.applyDesktopSelectionToDom();
  }

  applyDesktopSelectionToDom() {
    const selected = this.desktopSelectionForRender();
    this.app.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((tile) => {
      const id = tile.dataset.nodeId;
      tile.classList.toggle("is-selected", Boolean(id && selected.has(id)));
    });
  }
}
