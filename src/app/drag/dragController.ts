import { captureRects, playFlip } from "../../animation/flip";
import { renderIcon } from "../../render/desktopTile";
import { AutoDragIntentTracker, createAutoDragState } from "../../interaction/autoDragIntent";
import { PointerVelocityTracker } from "../../interaction/pointerVelocity";
import { pointInMergeRect } from "../support/geometry";
import { aimPoint, type DragSource, type ActiveDrag } from "./dragTypes";
import { isDesktopGroupDrag } from "./dragSource";
import { DragFollow } from "./dragFollow";
import { DragDrop } from "./dragDrop";
import type { DesktopApp } from "../DesktopApp";

const dragStartDistancePx = 7;

export type DragControllerHost = Pick<
  DesktopApp,
  "autoReorder"
  | "findFolder"
  | "findFolderChild"
  | "folder"
  | "folderInput"
  | "freePlacement"
  | "freeReorder"
  | "grid"
  | "items"
  | "keyboard"
  | "layout"
  | "merge"
  | "mergeCommit"
  | "rename"
  | "render"
  | "reorder"
  | "resumeDeferredRender"
  | "root"
  | "selection"
  | "settingsActions"
  | "store"
  | "suppressClickOnce"
  | "suppressStoreRender"
  | "tileElement"
>;

// Icon drag lifecycle: press, pickup, the per-frame loop, release (drop,
// merge / trash hand-off, click) and cancel. Following the pointer is
// DragFollow's, committing a drop DragDrop's; make-room and folder decisions
// live in AutoReorder / FreeReorder / DragMerge.
export class DragController {
  drag: ActiveDrag | null = null;
  private readonly follow: DragFollow;
  private readonly drop: DragDrop;

  constructor(private readonly app: DragControllerHost) {
    this.follow = new DragFollow(app);
    this.drop = new DragDrop(app);
  }

  beginDrag(options: {
    source: DragSource;
    event: PointerEvent;
    element: HTMLElement;
    baseX: number;
    baseY: number;
    floating: boolean;
    groupNodeIds?: string[];
  }) {
    // A drag left behind by another pointer (pen + mouse, a second touch) would
    // otherwise keep its tile lifted forever.
    if (this.drag) {
      this.cancelDrag();
    }

    try {
      (options.event.currentTarget as HTMLElement | null)?.setPointerCapture?.(options.event.pointerId);
    } catch {
      // Pointer capture is optional; window-level events keep dragging alive.
    }

    const rect = options.element.getBoundingClientRect();
    const groupItems =
      options.source.type === "desktop"
        ? this.follow.captureDesktopDragGroup(options.groupNodeIds ?? [options.source.nodeId])
        : [];
    // An icon may be grabbed while it is still gliding (a drop settling, a
    // neighbour making room): follow it from where it is seen, not its slot.
    const grabbed = options.floating ? { x: 0, y: 0 } : this.follow.visualOffset(options.element, options.baseX, options.baseY);
    const icon = (options.element.querySelector<HTMLElement>(".icon-shell") ?? options.element).getBoundingClientRect();
    this.drag = {
      source: options.source,
      pointerId: options.event.pointerId,
      startX: options.event.clientX,
      startY: options.event.clientY,
      currentX: options.event.clientX,
      currentY: options.event.clientY,
      startScrollLeft: this.app.root.scrollLeft,
      startScrollTop: this.app.root.scrollTop,
      aimOffsetX: icon.left + icon.width / 2 - options.event.clientX,
      aimOffsetY: icon.top + icon.height / 2 - options.event.clientY,
      baseX: options.baseX + grabbed.x,
      baseY: options.baseY + grabbed.y,
      // Layout size: a tile caught mid-animation may be scaled.
      width: options.element.offsetWidth || rect.width,
      height: options.element.offsetHeight || rect.height,
      element: options.element,
      floating: options.floating,
      started: false,
      frame: null,
      targetId: null,
      targetIntent: null,
      targetRect: null,
      targetHitRect: null,
      targetElement: null,
      candidateTargetId: null,
      candidateTargetIntent: null,
      candidateTargetRect: null,
      candidateTargetHitRect: null,
      mergeIntentTimer: null,
      targetSnapshots: [],
      groupItems,
      lastTransformStyle: "",
      lastPullX: 0,
      lastPullY: 0,
      toggleSelection: options.source.type === "desktop" && options.event.ctrlKey,
      committing: false,
      auto: null,
      intent: new AutoDragIntentTracker(),
      pointer: new PointerVelocityTracker(),
      visualOffsets: null
    };

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp, { once: true });
    window.addEventListener("pointercancel", this.onPointerCancel, { once: true });
    window.addEventListener("blur", this.onWindowBlur, { once: true });
  }

  readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId || drag.committing) {
      return;
    }

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;
    drag.pointer.record(event.clientX, event.clientY);

    if (!drag.started) {
      const dx = drag.currentX - drag.startX;
      const dy = drag.currentY - drag.startY;
      const moved = Math.hypot(dx, dy);
      if (moved < dragStartDistancePx) {
        return;
      }

      if (drag.source.type === "folder" && Math.abs(dx) >= 10 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        const sourceFolder = this.app.findFolder(drag.source.folderId);
        if (sourceFolder && this.app.folder.folderPaging(sourceFolder).pageCount > 1) {
          event.preventDefault();
          this.app.folderInput.promoteFolderDragToPageSwipe(drag, event);
          return;
        }
      }

      event.preventDefault();
      if (drag.source.type === "folder" && !drag.floating) {
        this.promoteFolderDrag(drag);
      }
      drag.started = true;
      this.app.root.classList.add("is-drag-active");
      drag.targetSnapshots = this.app.merge.captureMergeTargets(drag);
      drag.auto =
        this.app.store.getSettings().layoutMode === "auto"
          ? createAutoDragState(
              this.app.store.getNodes(),
              this.app.autoReorder.autoReorderMovingNodes(drag, this.app.store.getNodes()),
              this.app.layout,
              drag.source.type === "desktop"
            )
          : null;
      if (isDesktopGroupDrag(drag)) {
        drag.groupItems.forEach((item) => this.follow.liftForDrag(item.element));
      } else {
        this.app.selection.clearAllSelection();
        drag.element.classList.remove("is-selected");
        this.follow.liftForDrag(drag.element);
      }
    }

    // Move the icon now, in the same frame as the pointer: intent and reorder
    // work runs afterwards in the frame callback and can never hold it back.
    this.follow.writeFollowFrame(drag);
    this.scheduleDragFrame();
  };

  readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId || drag.committing) {
      return;
    }

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;

    if (drag.started && drag.targetId) {
      const aim = aimPoint(drag);
      if (drag.targetHitRect && pointInMergeRect(aim.x, aim.y, drag.targetHitRect)) {
        this.app.suppressClickOnce();
        if (drag.targetIntent === "trash") {
          void this.app.mergeCommit.commitTrash(drag.targetId);
        } else {
          void this.app.mergeCommit.commitMerge(drag.targetId);
        }
        return;
      }

      this.app.merge.setMergeTarget(null);
    }

    if (!drag.started) {
      this.releaseDrag(drag);
      this.app.suppressClickOnce();

      const source = drag.source;
      const element = drag.element;
      const floating = drag.floating;

      if (source.type === "desktop") {
        this.app.items.activateDesktopNode(source.nodeId, element, drag.toggleSelection);
      } else {
        void this.app.items.activateFolderChild(source.folderId, source.childId);
      }

      if (floating) {
        element.remove();
      }

      return;
    }

    const before = captureRects(this.app.grid);
    const { changed, focusAfterRender } = this.drop.commitDrop(drag);
    this.app.suppressClickOnce();

    // An icon dragged out of a folder becomes a new desktop tile: let it fly
    // from where it was dropped instead of popping up in its slot.
    if (drag.floating && drag.source.type === "folder" && changed) {
      before.set(drag.source.childId, this.drop.dropRect(drag));
    }

    this.releaseDrag(drag);
    this.settleDragElements(drag);
    // Render and animate from where every tile was at release, whether or not
    // the order changed (dropping an icon back in place glides it home).
    this.app.render();
    playFlip(this.app.grid, before);
    if (changed && focusAfterRender) {
      this.app.keyboard.focusDesktopNode(focusAfterRender);
    }
  };

  readonly onPointerCancel = () => {
    this.cancelDrag();
  };

  readonly onWindowBlur = () => {
    this.cancelDrag();
  };

  scheduleDragFrame() {
    const drag = this.drag;
    if (!drag || drag.frame !== null) {
      return;
    }

    drag.frame = requestAnimationFrame(() => {
      if (!this.drag) {
        return;
      }

      const active = this.drag;
      active.frame = null;
      const didAutoScroll = this.follow.autoScrollDrag(active);
      const autoState = active.auto;
      if (didAutoScroll && !autoState) {
        this.app.reorder.clearDragReorderPreview();
        active.targetSnapshots = this.app.merge.captureMergeTargets(active);
        active.targetRect = null;
        this.app.merge.clearMergeCandidate(active);
      }

      if (isDesktopGroupDrag(active)) {
        this.follow.writeFollowFrame(active);
        if (autoState) {
          this.app.autoReorder.updateAutoDragIntent(active, autoState);
        } else {
          const aim = aimPoint(active);
          this.app.merge.updateMergeTarget(aim.x, aim.y);
          this.app.freeReorder.updateDragReorderPreview(active);
        }
        if (didAutoScroll && this.drag === active) {
          this.scheduleDragFrame();
        }
        return;
      }

      if (autoState) {
        this.app.autoReorder.updateAutoDragIntent(active, autoState);
      } else {
        const aim = aimPoint(active);
        this.app.merge.updateMergeTarget(aim.x, aim.y);
      }
      this.follow.writeFollowFrame(active);
      if (!autoState) {
        this.app.freeReorder.updateDragReorderPreview(active);
      }

      if (didAutoScroll && this.drag === active) {
        this.scheduleDragFrame();
      }
    });
  }

  private promoteFolderDrag(drag: ActiveDrag) {
    if (drag.source.type !== "folder") {
      return;
    }

    const child = this.app.findFolderChild(drag.source.folderId, drag.source.childId);
    if (!child) {
      return;
    }

    const rect = drag.element.getBoundingClientRect();
    const floating = document.createElement("div");
    floating.className = "floating-drag";
    floating.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1)`;
    floating.append(renderIcon(child));
    const label = document.createElement("span");
    label.className = "tile-name";
    label.textContent = child.name;
    floating.append(label);
    document.body.append(floating);

    drag.element = floating;
    drag.baseX = rect.left;
    drag.baseY = rect.top;
    drag.width = floating.offsetWidth || rect.width;
    drag.height = floating.offsetHeight || rect.height;
    drag.floating = true;
    void this.app.folder.closeFolder();
  }

  cancelDrag() {
    const drag = this.drag;
    if (!drag) {
      return;
    }

    // Capture before the drag styles go, so cancelled icons glide back from
    // where they were held.
    const before = captureRects(this.app.grid);
    this.releaseDrag(drag);
    this.settleDragElements(drag);
    if (drag.started) {
      this.app.render();
      playFlip(this.app.grid, before);
    }
  }

  // Every way a drag ends (drop, cancel, a merge or trash commit taking over,
  // a folder press turning into a page swipe) releases it here. Only the
  // active drag owns the window listeners and the shared preview / merge-target
  // state, so releasing a drag that has since been replaced touches neither.
  releaseDrag(drag: ActiveDrag) {
    if (drag.frame !== null) {
      cancelAnimationFrame(drag.frame);
      drag.frame = null;
    }
    this.app.merge.clearMergeCandidate(drag);
    if (this.drag !== drag) {
      return;
    }

    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);
    this.app.root.classList.remove("is-drag-active");
    this.app.reorder.clearDragReorderPreview();
    this.app.merge.clearTargetStyles();
    this.drag = null;
    this.app.resumeDeferredRender();
  }

  // Put this drag's own tiles back down on their slots and drop its floating icon.
  settleDragElements(drag: ActiveDrag) {
    if (drag.floating) {
      drag.element.remove();
    }

    const settle = (id: string, element: HTMLElement) => {
      element.classList.remove("is-dragging");
      this.follow.restoreSlotTransform(id, element);
    };
    if (isDesktopGroupDrag(drag)) {
      drag.groupItems.forEach((item) => settle(item.id, item.element));
      return;
    }

    const id = drag.source.type === "desktop" ? drag.source.nodeId : drag.source.childId;
    settle(id, drag.element);
  }
}
