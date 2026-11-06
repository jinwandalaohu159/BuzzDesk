import { captureRects, playFlip } from "../../animation/flip";
import { dragAutoScrollDelta, dragFrameTransform, toTransformStyle } from "../../animation/drag";
import { renderIcon } from "../../render/desktopTile";
import { desktopTileMetrics } from "../../settings/desktopSettings";
import { desktopViewport } from "../../system/desktopViewport";
import { AutoDragIntentTracker, createAutoDragState, dropInsertionIndex } from "../../interaction/autoDragIntent";
import { PointerVelocityTracker } from "../../interaction/pointerVelocity";
import { clampScroll, clientToLayout, layoutToFree, pointInMergeRect, tileTransform } from "../support/geometry";
import type { AppNode } from "../../types";
import { aimPoint, type DragSource, type ActiveDrag, type DragGroupItem } from "./dragTypes";
import type { DesktopApp } from "../DesktopApp";

const dragStartDistancePx = 7;

export type DragControllerHost = Pick<
  DesktopApp,
  "findFolder"
  | "findFolderChild"
  | "findNode"
  | "folder"
  | "folderInput"
  | "freePlacement"
  | "grid"
  | "items"
  | "keyboard"
  | "layout"
  | "merge"
  | "rename"
  | "render"
  | "reorder"
  | "resumeDeferredRender"
  | "root"
  | "selection"
  | "store"
  | "suppressClickOnce"
  | "suppressStoreRender"
  | "tileElement"
>;

// Icon drag lifecycle: press, pickup, per-frame transforms, drop commit and
// cancel. Reordering and merging decisions live in DragReorder / DragMerge.
export class DragController {
  drag: ActiveDrag | null = null;

  constructor(private readonly app: DragControllerHost) {}

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
        ? this.captureDesktopDragGroup(options.groupNodeIds ?? [options.source.nodeId])
        : [];
    // An icon may be grabbed while it is still gliding (a drop settling, a
    // neighbour making room): follow it from where it is seen, not its slot.
    const grabbed = options.floating ? { x: 0, y: 0 } : this.visualOffset(options.element, options.baseX, options.baseY);
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

  // How far a tile currently is (visually) from the slot it is laid out at;
  // non-zero only while an animation or transition is moving it.
  private visualOffset(element: HTMLElement, baseX: number, baseY: number) {
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
  private liftForDrag(element: HTMLElement) {
    element.getAnimations().forEach((animation) => animation.cancel());
    element.classList.remove("is-reorder-preview");
    element.classList.add("is-dragging");
  }

  private captureDesktopDragGroup(nodeIds: string[]) {
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
      const moved = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
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
              this.app.reorder.autoReorderMovingNodes(drag, this.app.store.getNodes()),
              this.app.layout,
              drag.source.type === "desktop"
            )
          : null;
      if (this.isDesktopGroupDrag(drag)) {
        drag.groupItems.forEach((item) => this.liftForDrag(item.element));
      } else {
        this.app.selection.clearAllSelection();
        drag.element.classList.remove("is-selected");
        this.liftForDrag(drag.element);
      }
    }

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
          void this.app.merge.commitTrash(drag.targetId);
        } else {
          void this.app.merge.commitMerge(drag.targetId);
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
    const aim = aimPoint(drag);
    let changed = false;
    let focusAfterRender: string | null = null;
    this.app.suppressStoreRender = true;
    try {
      if (this.app.store.getSettings().layoutMode === "free" && drag.source.type === "desktop") {
        changed = this.commitFreeDesktopDrag(drag);
        this.app.selection.setDesktopSelection(this.desktopDragSourceIds(drag), drag.source.nodeId);
        focusAfterRender = drag.source.nodeId;
      } else if (this.isDesktopGroupDrag(drag)) {
        const groupIds = drag.groupItems.map((item) => item.id);
        this.app.selection.setDesktopSelection(groupIds, drag.source.type === "desktop" ? drag.source.nodeId : groupIds[0]);
        focusAfterRender = this.app.selection.selectedId;
        const index = this.dropIndex(drag, aim);
        changed = index !== null && this.app.store.placeDesktopNodes(groupIds, index);
      } else if (drag.source.type === "folder") {
        this.app.selection.selectSingleDesktopNode(drag.source.childId);
        this.app.rename.renamingFolderChild = null;
        focusAfterRender = drag.source.childId;
        if (this.app.store.getSettings().layoutMode === "free") {
          changed = this.app.store.moveFolderChildToDesktop(
            drag.source.folderId,
            drag.source.childId,
            this.app.store.getNodes().length,
            this.freeFolderChildDropPosition(drag)
          );
        } else {
          // The child is not among the desktop nodes, so both index spaces agree.
          changed = this.app.store.moveFolderChildToDesktop(
            drag.source.folderId,
            drag.source.childId,
            this.dropIndex(drag, aim) ?? this.app.reorder.desktopInsertionIndex(aim.x, aim.y)
          );
        }
      } else {
        this.app.selection.selectSingleDesktopNode(drag.source.nodeId);
        const index = this.dropIndex(drag, aim);
        changed = index !== null && this.app.store.placeDesktopNodes([drag.source.nodeId], index);
      }
    } finally {
      this.app.suppressStoreRender = false;
    }

    this.app.suppressClickOnce();

    // An icon dragged out of a folder becomes a new desktop tile: let it fly
    // from where it was dropped instead of popping up in its slot.
    if (drag.floating && drag.source.type === "folder" && changed) {
      before.set(drag.source.childId, this.dropRect(drag));
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

  // Where a release lands, as an index among the nodes that are not moving
  // (what placeDesktopNodes expects); null means "stay where you are". In the
  // auto layout the intent engine already knows the open slot.
  private dropIndex(drag: ActiveDrag, aim: { x: number; y: number }): number | null {
    if (drag.auto) {
      const point = clientToLayout(this.app.root, aim.x, aim.y);
      return dropInsertionIndex(point.x, point.y, drag.auto, drag.targetSnapshots);
    }

    const fullIndex = this.app.reorder.desktopInsertionIndex(aim.x, aim.y);
    const moving = new Set(this.desktopDragSourceIds(drag));
    const movingBefore = this.app.store.getNodes().slice(0, fullIndex).filter((node) => moving.has(node.id)).length;
    return fullIndex - movingBefore;
  }

  // Free layout: an icon dragged out of a folder lands like any desktop icon:
  // a desktop-sized tile centred where it was dropped, snapped to the grid and
  // moved to the nearest open spot.
  private freeFolderChildDropPosition(drag: ActiveDrag) {
    const viewport = desktopViewport();
    const metrics = desktopTileMetrics(this.app.store.getSettings());
    const rect = drag.element.getBoundingClientRect();
    const center = clientToLayout(this.app.root, rect.left + rect.width / 2, rect.top + rect.height / 2);
    const preferred = layoutToFree(viewport, center.x - metrics.width / 2, center.y - metrics.height / 2);
    return this.app.freePlacement.findOpenDesktopPosition(
      preferred,
      metrics.width,
      metrics.height,
      new Set(drag.source.type === "folder" ? [drag.source.childId] : []),
      [],
      false
    );
  }

  // The dropped icon's position at release, aligned like a desktop tile.
  private dropRect(drag: ActiveDrag) {
    const rect = drag.element.getBoundingClientRect();
    const scale = rect.width / Math.max(1, drag.width);
    return {
      left: rect.left + rect.width / 2 - drag.width / 2,
      top: rect.top + rect.height / 2 - drag.height / 2,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1
    };
  }

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
      const didAutoScroll = this.autoScrollDrag(active);
      const autoState = active.auto;
      if (didAutoScroll && !autoState) {
        this.app.reorder.clearDragReorderPreview();
        active.targetSnapshots = this.app.merge.captureMergeTargets(active);
        active.targetRect = null;
        this.app.merge.clearMergeCandidate(active);
      }

      if (this.isDesktopGroupDrag(active)) {
        this.updateDesktopGroupDragFrame(active);
        if (autoState) {
          this.app.reorder.updateAutoDragIntent(active, autoState);
        } else {
          const aim = aimPoint(active);
          this.app.merge.updateMergeTarget(aim.x, aim.y);
          this.app.reorder.updateDragReorderPreview(active);
        }
        if (didAutoScroll && this.drag === active) {
          this.scheduleDragFrame();
        }
        return;
      }

      if (autoState) {
        this.app.reorder.updateAutoDragIntent(active, autoState);
      } else {
        const aim = aimPoint(active);
        this.app.merge.updateMergeTarget(aim.x, aim.y);
      }
      const magneticTarget = active.targetId && active.targetRect ? active.targetRect : null;
      const transform = dragFrameTransform({
        currentX: active.currentX,
        currentY: active.currentY,
        startX: active.startX,
        startY: active.startY,
        baseX: active.baseX,
        baseY: active.baseY,
        sourceLayoutOffsetX: active.floating ? 0 : this.app.root.scrollLeft - active.startScrollLeft,
        sourceLayoutOffsetY: active.floating ? 0 : this.app.root.scrollTop - active.startScrollTop,
        width: active.width,
        height: active.height,
        targetRect: magneticTarget,
        targetLayoutOffsetX: active.floating ? 0 : this.app.root.scrollLeft,
        targetLayoutOffsetY: active.floating ? 0 : this.app.root.scrollTop
      });

      if (magneticTarget && active.targetElement) {
        this.app.merge.writeMergePull(active, transform.targetPullX, transform.targetPullY);
      }
      this.writeDragTransform(active, toTransformStyle(transform));
      if (!autoState) {
        this.app.reorder.updateDragReorderPreview(active);
      }

      if (didAutoScroll && this.drag === active) {
        this.scheduleDragFrame();
      }
    });
  }

  private updateDesktopGroupDragFrame(drag: ActiveDrag) {
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
      this.writeGroupDragTransform(item, toTransformStyle({
        x: item.baseX + dx + offsetX,
        y: item.baseY + dy + offsetY,
        scale: 1.025
      }));
    });
  }

  // Scrolls the desktop while a dragged icon nears a screen edge (only when the
  // desktop is larger than the screen).
  private autoScrollDrag(drag: ActiveDrag) {
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

  isDesktopGroupDrag(drag: ActiveDrag) {
    return drag.source.type === "desktop" && drag.groupItems.length > 1;
  }

  private commitFreeDesktopDrag(drag: ActiveDrag) {
    const reorderPlan = this.activeFreeReorderPlan(drag);
    if (reorderPlan) {
      return this.app.store.updateNodePositions(reorderPlan.positions);
    }

    const viewport = desktopViewport();
    const movedItems = this.freeDragMovedItems(drag);
    if (movedItems.length === 0) {
      return false;
    }

    const { dx, dy } = this.freeDragDelta(drag, movedItems, viewport);
    const positions = movedItems.length > 1
      ? this.app.freePlacement.resolveFreeGroupPositions(movedItems, dx, dy)
      : movedItems
          .map((item) => ({
            id: item.id,
            position: this.app.freePlacement.findOpenDesktopPosition(
              {
                x: item.baseX + dx - viewport.offsetX,
                y: item.baseY + dy - viewport.offsetY
              },
              item.width,
              item.height,
              new Set([item.id]),
              [],
              this.app.freePlacement.isCompactPlacementFolder(item.id)
            )
          }));

    if (positions.length === 0) {
      return false;
    }

    return this.app.store.updateNodePositions(positions);
  }

  freeDragMovedItems(
    drag: ActiveDrag
  ): Array<Pick<DragGroupItem, "id" | "baseX" | "baseY" | "width" | "height">> {
    if (drag.source.type !== "desktop") {
      return [];
    }

    return this.isDesktopGroupDrag(drag)
      ? drag.groupItems
      : [{
          id: drag.source.nodeId,
          baseX: drag.baseX,
          baseY: drag.baseY,
          width: drag.width,
          height: drag.height
        }];
  }

  freeDragDelta(
    drag: ActiveDrag,
    movedItems: Array<Pick<DragGroupItem, "baseX" | "baseY" | "width" | "height">>,
    viewport: ReturnType<typeof desktopViewport>
  ) {
    let dx = drag.currentX - drag.startX + this.app.root.scrollLeft - drag.startScrollLeft;
    let dy = drag.currentY - drag.startY + this.app.root.scrollTop - drag.startScrollTop;

    if (movedItems.length > 1) {
      const minX = Math.min(...movedItems.map((item) => item.baseX - viewport.offsetX));
      const minY = Math.min(...movedItems.map((item) => item.baseY - viewport.offsetY));
      const maxX = Math.max(...movedItems.map((item) => item.baseX - viewport.offsetX + item.width));
      const maxY = Math.max(...movedItems.map((item) => item.baseY - viewport.offsetY + item.height));
      const metrics = desktopTileMetrics(this.app.store.getSettings());
      dx = clampScroll(dx, metrics.paddingX - minX, viewport.width - metrics.paddingX - maxX);
      dy = clampScroll(dy, metrics.paddingY - minY, viewport.height - metrics.paddingY - maxY);
    }

    return { dx, dy };
  }

  private activeFreeReorderPlan(drag: ActiveDrag) {
    if (
      this.app.store.getSettings().layoutMode !== "free" ||
      drag.targetId ||
      drag.candidateTargetId ||
      !this.app.reorder.isPointerInReorderGap(drag)
    ) {
      return null;
    }

    const candidate = this.app.reorder.freeReorderCandidate(drag);
    if (!candidate?.freePlan || candidate.key !== this.app.reorder.dragReorderActiveKey) {
      return null;
    }

    return this.app.reorder.dragReorderFreePlan ?? candidate.freePlan;
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

  desktopDragSourceIds(drag: ActiveDrag) {
    if (drag.source.type !== "desktop") {
      return [];
    }

    return this.isDesktopGroupDrag(drag)
      ? drag.groupItems.map((item) => item.id)
      : [drag.source.nodeId];
  }

  dragSourceItems(drag: ActiveDrag): AppNode[] | null {
    if (drag.source.type === "folder") {
      const child = this.app.findFolderChild(drag.source.folderId, drag.source.childId);
      return child ? [child] : null;
    }

    const nodes = this.desktopDragSourceIds(drag).map((id) => this.app.findNode(id));
    if (nodes.length === 0 || nodes.some((node) => !node || node.type !== "item")) {
      return null;
    }

    return nodes as AppNode[];
  }

  trashableDragSourceItems(drag: ActiveDrag) {
    const items = this.dragSourceItems(drag);
    return items && items.every((item) => Boolean(item.path)) ? items : [];
  }

  private writeDragTransform(drag: ActiveDrag, transform: string) {
    if (drag.lastTransformStyle === transform) {
      return;
    }

    drag.lastTransformStyle = transform;
    drag.element.style.transform = transform;
  }

  private writeGroupDragTransform(item: DragGroupItem, transform: string) {
    if (item.lastTransformStyle === transform) {
      return;
    }

    item.lastTransformStyle = transform;
    item.element.style.transform = transform;
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
      this.restoreSlotTransform(id, element);
    };
    if (this.isDesktopGroupDrag(drag)) {
      drag.groupItems.forEach((item) => settle(item.id, item.element));
      return;
    }

    const id = drag.source.type === "desktop" ? drag.source.nodeId : drag.source.childId;
    settle(id, drag.element);
  }

  // Put a tile back on its layout slot. Clearing the transform instead would
  // park it at the grid origin, and any animation captured from there would
  // fly in from the top-left corner.
  private restoreSlotTransform(id: string, element: HTMLElement) {
    const slot = element.parentElement === this.app.grid ? this.app.layout.get(id) : undefined;
    element.style.transform = slot ? tileTransform(slot.x, slot.y) : "";
  }
}
