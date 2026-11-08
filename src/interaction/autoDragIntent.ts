// Intent engine for dragging in the auto-arranged grid (iOS-style).
//
// Every frame the dragged icon's centre is classified against where tiles are
// *displayed* (including tiles already shuffled aside), not where they were at
// drag start. Three zones, three rules:
//
//   1. Merge core (the centre of a mergeable icon) -> folder intent. The target
//      is armed (highlighted) at once and the folder forms after a short rest.
//   2. Icon cell (the rest of the tile plus half the gap around it) -> the user
//      may be on the way to that icon, so nothing is shoved aside: after a
//      brief rest the neighbours only lean apart (make-room hint), and the
//      slot opens only after a deliberate still hold that is not heading for
//      the icon's centre.
//   3. Open space past the icons -> the slot opens after a quick rest.
//
// Making room and forming a folder start with the same motion (slowing down
// next to the target before moving in), so a brief pause beside an icon must
// never push it away. Every intent needs the icon to stay put and move slowly,
// so sweeping across icons never triggers anything — the "pause to act" rule
// iOS uses. Zone geometry lives in autoDragZones.ts, every feel/timing number
// in autoDragTuning.ts. Pure logic: no DOM, no store.
import type { PointerVelocity } from "./pointerVelocity";
import {
  approachReorderDwellMs,
  approachReorderMaxSpeed,
  dwellWakeSlackMs,
  headingRecheckMs,
  makeRoomHintAfterMs,
  mergeDwellMs,
  mergeMaxSpeed,
  minRecheckMs,
  nearRestRadiusPx,
  openRestRadiusPx,
  reorderCooldownMs,
  reorderDwellMs,
  reorderMaxSpeed,
  trashDwellMs,
  trashMaxSpeed
} from "./autoDragTuning";
import {
  approachedTarget,
  findMergeHit,
  insertionIndexForPoint,
  isHeadingIntoMergeCore,
  type AutoDragState,
  type DragTargetSnapshot
} from "./autoDragZones";

export * from "./autoDragZones";
export { mergeExitPaddingPx } from "./autoDragTuning";

export type AutoDragDecision =
  | { kind: "none" }
  // `armed`: a folder is about to form with this target (show it right away).
  // `hint`: resting beside icons; part them slightly to show room is coming.
  | { kind: "wait"; delayMs: number; armed?: DragTargetSnapshot; hint?: boolean }
  | { kind: "merge"; target: DragTargetSnapshot }
  | { kind: "reorder"; insertAt: number };


export class AutoDragIntentTracker {
  // `since` counts from when the icon came to rest at (x, y): making room is
  // about stopping, so drifting slowly toward an icon's centre must keep
  // restarting the clock rather than add up to a reorder.
  private pending: { key: string; since: number; x: number; y: number } | null = null;

  reset() {
    this.pending = null;
  }

  // Decides what (if anything) the drag should do now. The caller applies
  // "merge"/"reorder" and re-runs after `delayMs` for "wait".
  decide(
    x: number,
    y: number,
    now: number,
    velocity: PointerVelocity,
    state: AutoDragState,
    snapshots: DragTargetSnapshot[]
  ): AutoDragDecision {
    const hit = findMergeHit(x, y, state, snapshots);
    let key: string;
    let insertAt = -1;
    let near = false;
    if (hit) {
      key = `merge:${hit.id}`;
    } else {
      const next = insertionIndexForPoint(x, y, state);
      if (next === null || next === state.insertAt) {
        this.pending = null;
        return { kind: "none" };
      }
      if (isHeadingIntoMergeCore(x, y, velocity, state, snapshots)) {
        // Look again once the motion has settled: a mouse that stops dead
        // sends no further events, so nothing else would re-evaluate.
        this.pending = null;
        return { kind: "wait", delayMs: headingRecheckMs };
      }
      near = approachedTarget(x, y, state, snapshots) !== null;
      key = `${near ? "reorder-near" : "reorder"}:${next}`;
      insertAt = next;
    }

    const dwell = hit
      ? hit.intent === "trash"
        ? trashDwellMs
        : mergeDwellMs
      : near
        ? approachReorderDwellMs
        : reorderDwellMs;
    const armed = hit ?? undefined;
    const restRadius = hit ? Number.POSITIVE_INFINITY : near ? nearRestRadiusPx : openRestRadiusPx;
    if (
      !this.pending ||
      this.pending.key !== key ||
      Math.hypot(x - this.pending.x, y - this.pending.y) > restRadius
    ) {
      this.pending = { key, since: now, x, y };
      return { kind: "wait", delayMs: (near ? makeRoomHintAfterMs : dwell) + dwellWakeSlackMs, armed };
    }

    const elapsed = now - this.pending.since;
    const maxSpeed = hit
      ? hit.intent === "trash"
        ? trashMaxSpeed
        : mergeMaxSpeed
      : near
        ? approachReorderMaxSpeed
        : reorderMaxSpeed;
    const cooldown = hit ? 0 : Math.max(0, state.lastAppliedAt + reorderCooldownMs - now);
    if (elapsed < dwell || cooldown > 0 || velocity.speed > maxSpeed) {
      const hint = near && elapsed >= makeRoomHintAfterMs && velocity.speed <= maxSpeed;
      const nextCheck = near && elapsed < makeRoomHintAfterMs ? makeRoomHintAfterMs - elapsed : dwell - elapsed;
      return { kind: "wait", delayMs: Math.max(minRecheckMs, nextCheck, cooldown), armed, hint };
    }

    this.pending = null;
    return hit ? { kind: "merge", target: hit } : { kind: "reorder", insertAt };
  }
}
