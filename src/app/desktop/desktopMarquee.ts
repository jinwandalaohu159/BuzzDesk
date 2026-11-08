import { normalizedRect, rectsIntersect, type Rect } from "../support/geometry";
import type { DesktopApp } from "../DesktopApp";
import type { SelectionController } from "./selectionController";
import { tileContentRects } from "./tileHitArea";

interface MarqueeState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  started: boolean;
  additive: boolean;
  initialSelection: Set<string>;
  // Tiles and their visible content, measured once when the box appears.
  targets: MarqueeTarget[];
  frame: number | null;
}

interface MarqueeTarget {
  id: string;
  element: HTMLElement;
  rects: Rect[];
  selected: boolean;
}

export type MarqueeHost = Pick<
  DesktopApp,
  "folder"
  | "grid"
  | "menus"
  | "rename"
  | "root"
  | "selectionMarquee"
  | "suppressClickOnce"
>;

// Rubber-band selection on the empty desktop: draws the box and selects every
// tile whose icon or name it touches (Ctrl / Shift add to the selection).
export class DesktopMarquee {
  private state: MarqueeState | null = null;

  constructor(
    private readonly app: MarqueeHost,
    private readonly selection: SelectionController
  ) {}

  get active() {
    return this.state !== null;
  }

  begin(event: PointerEvent) {
    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    // A release we never heard about (focus stolen mid-drag) must not leave an
    // old marquee hanging around.
    this.finish();
    this.app.menus.closeContextMenu();
    this.app.rename.renamingId = null;
    this.app.folder.selectedFolderChild = null;
    this.state = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      started: false,
      additive: event.ctrlKey || event.shiftKey,
      initialSelection: new Set(this.selection.desktopSelectionForRender()),
      targets: [],
      frame: null
    };

    try {
      this.app.root.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners below keep the marquee alive if capture is unavailable.
    }

    this.app.root.classList.add("is-marquee-active");
    window.addEventListener("pointermove", this.onMarqueePointerMove);
    window.addEventListener("pointerup", this.onMarqueePointerUp);
    window.addEventListener("pointercancel", this.onMarqueePointerUp);
  }

  // Pointer events can arrive many times per frame; they only record where the
  // pointer is. The box and the selection follow once per frame from cached
  // tile rects, so a fast sweep never queues up layout work and lags behind.
  private readonly onMarqueePointerMove = (event: PointerEvent) => {
    const marquee = this.state;
    if (!marquee || event.pointerId !== marquee.pointerId) {
      return;
    }

    // The button is already up: the release went somewhere else.
    if ((event.buttons & 1) === 0) {
      this.finish();
      return;
    }

    marquee.currentX = event.clientX;
    marquee.currentY = event.clientY;
    if (!marquee.started) {
      if (Math.hypot(marquee.currentX - marquee.startX, marquee.currentY - marquee.startY) < 1) {
        return;
      }

      marquee.started = true;
      if (!marquee.additive) {
        this.selection.clearDesktopSelection();
        this.selection.applyDesktopSelectionToDom();
      }
      marquee.targets = this.collectMarqueeTargets();
      this.app.selectionMarquee.hidden = false;
    }

    event.preventDefault();
    if (marquee.frame === null) {
      marquee.frame = requestAnimationFrame(() => {
        marquee.frame = null;
        this.updateMarquee(marquee);
      });
    }
  };

  private readonly onMarqueePointerUp = (event: PointerEvent) => {
    if (this.state && event.pointerId === this.state.pointerId) {
      this.finish();
    }
  };

  // Ends the marquee keeping whatever it selected.
  private finish() {
    const marquee = this.state;
    if (!marquee) {
      return;
    }

    if (marquee.frame !== null) {
      cancelAnimationFrame(marquee.frame);
      marquee.frame = null;
    }
    if (marquee.started) {
      // Land on exactly where the pointer was released.
      this.updateMarquee(marquee);
      this.app.suppressClickOnce();
    }
    this.cancel();
  }

  private cancel() {
    if (this.state?.frame != null) {
      cancelAnimationFrame(this.state.frame);
    }
    window.removeEventListener("pointermove", this.onMarqueePointerMove);
    window.removeEventListener("pointerup", this.onMarqueePointerUp);
    window.removeEventListener("pointercancel", this.onMarqueePointerUp);
    this.app.root.classList.remove("is-marquee-active");
    this.state = null;
    this.app.selectionMarquee.hidden = true;
    this.app.selectionMarquee.removeAttribute("style");
  }

  private collectMarqueeTargets(): MarqueeTarget[] {
    return Array.from(this.app.grid.querySelectorAll<HTMLElement>("[data-node-id]")).flatMap((element) => {
      const id = element.dataset.nodeId;
      return id
        ? [{ id, element, rects: tileContentRects(element), selected: element.classList.contains("is-selected") }]
        : [];
    });
  }

  private updateMarquee(marquee: MarqueeState) {
    if (this.state !== marquee || !marquee.started) {
      return;
    }

    // The desktop re-rendered underneath (an icon appeared, the layout moved):
    // measure again.
    if (marquee.targets.some((target) => !target.element.isConnected)) {
      marquee.targets = this.collectMarqueeTargets();
    }

    const rect = normalizedRect(marquee.startX, marquee.startY, marquee.currentX, marquee.currentY);
    const style = this.app.selectionMarquee.style;
    style.left = `${rect.left}px`;
    style.top = `${rect.top}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;

    const selected = new Set(marquee.additive ? marquee.initialSelection : []);
    let primaryId: string | null = null;
    let changed = false;
    for (const target of marquee.targets) {
      const hit = target.rects.some((content) => rectsIntersect(rect, content));
      if (hit) {
        selected.add(target.id);
        primaryId = target.id;
      }
      const shown = selected.has(target.id);
      if (shown !== target.selected) {
        target.selected = shown;
        target.element.classList.toggle("is-selected", shown);
        changed = true;
      }
    }

    if (changed || primaryId !== this.selection.selectedId) {
      this.selection.setDesktopSelection(selected, primaryId);
    }
  }
}
