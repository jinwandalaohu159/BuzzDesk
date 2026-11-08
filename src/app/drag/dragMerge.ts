import { desktopSystemIconIdFromNodeId } from "../../settings/desktopSettings";
import { type DragTargetIntent, type DragTargetSnapshot } from "../../interaction/autoDragIntent";
import {
  mergeHitRectForElement,
  pointInMergeRect,
  type Rect
} from "../support/geometry";
import { roundFrameValue } from "../../shared/math";
import type { DesktopApp } from "../DesktopApp";
import { desktopDragSourceIds, dragSourceItems } from "./dragSource";
import { aimPoint, type ActiveDrag } from "./dragTypes";

const mergeIntentDelayMs = 400;
const trashIntentDelayMs = 30;

export type DragMergeHost = Pick<
  DesktopApp,
  "dragging"
  | "findFolderChild"
  | "findNode"
  | "grid"
  | "reorder"
  | "store"
  | "tileElement"
>;

// Folder-forming while dragging: which icon is the merge target, its armed /
// hover feedback and the target pull. The drop itself is MergeCommit's.
export class DragMerge {
  private armedId: string | null = null;

  constructor(private readonly app: DragMergeHost) {}

  updateMergeTarget(x: number, y: number) {
    const drag = this.app.dragging.drag;
    if (!drag) {
      return;
    }

    if (drag.targetHitRect && pointInMergeRect(x, y, drag.targetHitRect)) {
      return;
    }

    const hit = this.hitTestMergeTarget(x, y, drag.targetSnapshots);

    if (!hit) {
      this.clearMergeCandidate(drag);
      this.setMergeTarget(null);
      return;
    }

    if (drag.targetId === hit.id) {
      drag.targetIntent = hit.intent;
      drag.targetRect = hit.rect;
      drag.targetHitRect = hit.hitRect;
      return;
    }

    this.setMergeTarget(null);
    this.setMergeCandidate(drag, hit);
  }

  private setMergeCandidate(drag: ActiveDrag, candidate: DragTargetSnapshot) {
    if (drag.candidateTargetId === candidate.id) {
      drag.candidateTargetIntent = candidate.intent;
      drag.candidateTargetRect = candidate.rect;
      drag.candidateTargetHitRect = candidate.hitRect;
      return;
    }

    this.clearMergeCandidate(drag);
    drag.candidateTargetId = candidate.id;
    drag.candidateTargetIntent = candidate.intent;
    drag.candidateTargetRect = candidate.rect;
    drag.candidateTargetHitRect = candidate.hitRect;
    this.setMergeArmed(candidate.id);
    drag.mergeIntentTimer = window.setTimeout(() => {
      const active = this.app.dragging.drag;
      if (
        active !== drag ||
        active.committing ||
        active.candidateTargetId !== candidate.id ||
        active.candidateTargetIntent !== candidate.intent ||
        !active.candidateTargetRect ||
        !active.candidateTargetHitRect
      ) {
        return;
      }

      const aim = aimPoint(active);
      if (!pointInMergeRect(aim.x, aim.y, active.candidateTargetHitRect)) {
        this.clearMergeCandidate(active);
        return;
      }

      const targetRect = active.candidateTargetRect;
      const targetHitRect = active.candidateTargetHitRect;
      const targetIntent = active.candidateTargetIntent ?? "merge";
      this.clearMergeCandidate(active);
      this.setMergeTarget(candidate.id, targetRect, targetHitRect, targetIntent);
      this.app.dragging.scheduleDragFrame();
    }, candidate.intent === "trash" ? trashIntentDelayMs : mergeIntentDelayMs);
  }

  clearMergeCandidate(drag: ActiveDrag | null = this.app.dragging.drag) {
    if (!drag) {
      return;
    }

    if (drag.mergeIntentTimer !== null) {
      window.clearTimeout(drag.mergeIntentTimer);
      drag.mergeIntentTimer = null;
    }
    drag.candidateTargetId = null;
    drag.candidateTargetIntent = null;
    drag.candidateTargetRect = null;
    drag.candidateTargetHitRect = null;
    if (drag === this.app.dragging.drag) {
      this.setMergeArmed(null);
    }
  }

  // The icon a folder is about to form with: it answers as soon as the dragged
  // icon reaches its centre, before the short hold commits the merge.
  setMergeArmed(targetId: string | null) {
    if (this.armedId === targetId) {
      return;
    }

    if (this.armedId) {
      this.app.tileElement(this.armedId)?.classList.remove("is-merge-armed");
    }
    this.armedId = targetId;
    if (targetId) {
      this.app.tileElement(targetId)?.classList.add("is-merge-armed");
    }
  }

  captureMergeTargets(drag: ActiveDrag): DragTargetSnapshot[] {
    const sourceIds = desktopDragSourceIds(drag);
    const nodes = this.app.store.getNodes();
    const sourceItems = dragSourceItems(this.app, drag);
    if (!sourceItems) {
      return [];
    }
    const canTrashSource = sourceItems.length > 0 && sourceItems.every((item) => Boolean(item.path));

    const excludedIds = new Set(sourceIds);
    if (drag.source.type === "folder") {
      excludedIds.add(drag.source.folderId);
    }

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const snapshots: DragTargetSnapshot[] = [];
    this.app.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
      const id = element.dataset.nodeId;
      if (!id) {
        return;
      }

      const node = nodeById.get(id);
      if (!node || excludedIds.has(id)) {
        return;
      }

      const systemIconId = desktopSystemIconIdFromNodeId(node.id);
      const intent: DragTargetIntent | null =
        systemIconId === "recycleBin"
          ? (canTrashSource ? "trash" : null)
          : (node.type === "item" || node.type === "folder" ? "merge" : null);
      if (!intent) {
        return;
      }

      const rect = element.getBoundingClientRect();
      const iconRect = element.querySelector<HTMLElement>(".icon-shell")?.getBoundingClientRect() ?? rect;
      snapshots.push({
        id,
        intent,
        rect,
        hitRect: mergeHitRectForElement(element, rect),
        icon: {
          x: iconRect.left - rect.left,
          y: iconRect.top - rect.top,
          width: iconRect.width,
          height: iconRect.height
        }
      });
    });

    return snapshots;
  }

  private hitTestMergeTarget(x: number, y: number, snapshots: DragTargetSnapshot[]) {
    let best: DragTargetSnapshot | null = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    for (const snapshot of snapshots) {
      const rect = snapshot.hitRect;
      if (!pointInMergeRect(x, y, rect)) {
        continue;
      }

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distanceSquared = (x - centerX) ** 2 + (y - centerY) ** 2;
      if (distanceSquared < bestDistanceSquared) {
        best = snapshot;
        bestDistanceSquared = distanceSquared;
      }
    }

    return best;
  }

  setMergeTarget(
    targetId: string | null,
    targetRect: DOMRect | null = null,
    targetHitRect: Rect | null = null,
    targetIntent: DragTargetIntent = "merge"
  ) {
    const drag = this.app.dragging.drag;
    if (!drag) {
      return;
    }

    if (targetId) {
      this.clearMergeCandidate(drag);
      this.setMergeArmed(null);
      if (!drag.auto) {
        this.app.reorder.clearDragReorderPreview();
      }
    }

    if (drag.targetId === targetId) {
      drag.targetIntent = targetId ? targetIntent : null;
      if (targetRect) {
        drag.targetRect = targetRect;
      }
      return;
    }

    this.clearTargetStyles();
    drag.targetId = targetId;
    drag.targetIntent = null;
    drag.targetRect = null;
    drag.targetHitRect = null;
    drag.targetElement = null;

    if (!targetId) {
      return;
    }

    const target = this.app.tileElement(targetId);
    target?.classList.add("is-merge-target");
    target?.classList.toggle("is-trash-target", targetIntent === "trash");
    drag.lastPullX = 0;
    drag.lastPullY = 0;
    target?.style.setProperty("--merge-pull-x", "0px");
    target?.style.setProperty("--merge-pull-y", "0px");
    const resolvedTargetRect = targetRect ?? target?.getBoundingClientRect() ?? null;
    drag.targetIntent = targetIntent;
    drag.targetRect = resolvedTargetRect;
    drag.targetHitRect = targetHitRect ?? (target && resolvedTargetRect ? mergeHitRectForElement(target, resolvedTargetRect) : null);
    drag.targetElement = target ?? null;
  }

  writeMergePull(drag: ActiveDrag, x: number, y: number) {
    if (!drag.targetElement) {
      return;
    }

    if (Math.abs(x - drag.lastPullX) < 0.2 && Math.abs(y - drag.lastPullY) < 0.2) {
      return;
    }

    drag.lastPullX = x;
    drag.lastPullY = y;
    drag.targetElement.style.setProperty("--merge-pull-x", `${roundFrameValue(x)}px`);
    drag.targetElement.style.setProperty("--merge-pull-y", `${roundFrameValue(y)}px`);
  }

  clearTargetStyles() {
    this.app.grid.querySelectorAll<HTMLElement>(".is-merge-target").forEach((node) => {
      this.clearMergeTargetElement(node);
    });
    this.setMergeArmed(null);
  }

  clearMergeTargetElement(node: HTMLElement) {
    node.classList.remove("is-merge-target");
    node.classList.remove("is-trash-target");
    node.style.removeProperty("--merge-pull-x");
    node.style.removeProperty("--merge-pull-y");
  }
}
