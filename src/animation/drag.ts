const freeDragScale = 1.035;
const mergeTargetScale = 0.88;
const mergeMagnetStrength = 0.22;
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
  targetLayoutOffsetX?: number;
  targetLayoutOffsetY?: number;
}

export interface DragFrameTransform {
  x: number;
  y: number;
  scale: number;
  targetPullX: number;
  targetPullY: number;
}

export function dragFrameTransform(input: DragFrameInput): DragFrameTransform {
  const dx = input.currentX - input.startX;
  const dy = input.currentY - input.startY;
  const followX = input.baseX + dx + (input.sourceLayoutOffsetX ?? 0);
  const followY = input.baseY + dy + (input.sourceLayoutOffsetY ?? 0);

  if (!input.targetRect) {
    return {
      x: followX,
      y: followY,
      scale: freeDragScale,
      targetPullX: 0,
      targetPullY: 0
    };
  }

  const targetX = input.targetRect.left + (input.targetLayoutOffsetX ?? 0) + input.targetRect.width / 2 - input.width / 2;
  const targetY = input.targetRect.top + (input.targetLayoutOffsetY ?? 0) + input.targetRect.height / 2 - input.height / 2;
  const centerX = input.targetRect.left + input.targetRect.width / 2;
  const centerY = input.targetRect.top + input.targetRect.height / 2;

  return {
    x: followX + (targetX - followX) * mergeMagnetStrength,
    y: followY + (targetY - followY) * mergeMagnetStrength,
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundFrameValue(value: number) {
  return Math.round(value * 10) / 10;
}
