import { clamp, roundFrameValue } from "../shared/math";
const mergeTargetScale = 0.95;
const targetPullStrength = 0.035;
const targetPullLimit = 5;
const autoScrollEdge = 76;
const autoScrollMaxSpeed = 18;

export interface DragFrameInput {
  currentX: number;
  currentY: number;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  sourceLayoutOffsetX?: number;
  sourceLayoutOffsetY?: number;
  width: number;
  height: number;
  targetRect: DOMRect | null;
}

export interface DragFrameTransform {
  x: number;
  y: number;
  scale: number;
  targetPullX: number;
  targetPullY: number;
}

// The dragged icon stays exactly under the pointer, always (no magnet toward a
// merge target: that made it drift away from the hand). Over a merge target it
// only dips slightly, and the target answers with a small pull toward it.
export function dragFrameTransform(input: DragFrameInput): DragFrameTransform {
  const x = input.baseX + (input.currentX - input.startX) + (input.sourceLayoutOffsetX ?? 0);
  const y = input.baseY + (input.currentY - input.startY) + (input.sourceLayoutOffsetY ?? 0);

  if (!input.targetRect) {
    return { x, y, scale: 1, targetPullX: 0, targetPullY: 0 };
  }

  const centerX = input.targetRect.left + input.targetRect.width / 2;
  const centerY = input.targetRect.top + input.targetRect.height / 2;
  return {
    x,
    y,
    scale: mergeTargetScale,
    targetPullX: clamp((input.currentX - centerX) * targetPullStrength, -targetPullLimit, targetPullLimit),
    targetPullY: clamp((input.currentY - centerY) * targetPullStrength, -targetPullLimit, targetPullLimit)
  };
}

export function toTransformStyle(transform: Pick<DragFrameTransform, "x" | "y" | "scale">) {
  return `translate3d(${roundFrameValue(transform.x)}px, ${roundFrameValue(transform.y)}px, 0) scale(${roundFrameValue(transform.scale)})`;
}

export function dragAutoScrollDelta(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number
) {
  return {
    x: edgeVelocity(x, viewportWidth),
    y: edgeVelocity(y, viewportHeight)
  };
}

function edgeVelocity(position: number, viewportSize: number) {
  if (position < autoScrollEdge) {
    return -edgeStrength(autoScrollEdge - position);
  }

  const farEdge = viewportSize - autoScrollEdge;
  if (position > farEdge) {
    return edgeStrength(position - farEdge);
  }

  return 0;
}

function edgeStrength(distance: number) {
  const ratio = clamp(distance / autoScrollEdge, 0, 1);
  return Math.round(ratio * ratio * autoScrollMaxSpeed);
}


