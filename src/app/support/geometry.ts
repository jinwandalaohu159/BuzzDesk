// Pure geometry helpers for tiles, hit areas and layout positions.
import type { DesktopPosition } from "../../types";
import { roundFrameValue } from "../../shared/math";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function clampScroll(value: number, min: number, max: number) {
  return Math.min(Math.max(min, max), Math.max(min, value));
}


// Three coordinate spaces meet in the desktop code:
//   client - pointer events and getBoundingClientRect
//   layout - tile slots (LayoutSlot.x/y); client + the desktop's scroll offset
//   free   - saved free-layout positions; layout - the viewport's edge offset
type Scroller = Pick<HTMLElement, "scrollLeft" | "scrollTop">;
type ViewportOffset = { offsetX: number; offsetY: number };

export function clientToLayout(root: Scroller, x: number, y: number) {
  return { x: x + root.scrollLeft, y: y + root.scrollTop };
}

export function layoutToClient(root: Scroller, x: number, y: number) {
  return { x: x - root.scrollLeft, y: y - root.scrollTop };
}

export function layoutToFree(viewport: ViewportOffset, x: number, y: number) {
  return { x: x - viewport.offsetX, y: y - viewport.offsetY };
}

export function freeToLayout(viewport: ViewportOffset, x: number, y: number) {
  return { x: x + viewport.offsetX, y: y + viewport.offsetY };
}

export function tileTransform(x: number, y: number) {
  return `translate3d(${roundFrameValue(x)}px, ${roundFrameValue(y)}px, 0)`;
}


export function normalizedRect(startX: number, startY: number, currentX: number, currentY: number): Rect {
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const right = Math.max(startX, currentX);
  const bottom = Math.max(startY, currentY);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

export function mergeHitRectForElement(element: HTMLElement, tileRect: DOMRect): Rect {
  const iconRect = element.querySelector<HTMLElement>(".icon-shell")?.getBoundingClientRect() ?? tileRect;
  const padX = Math.max(6, Math.min(10, tileRect.width * 0.09));
  const padY = Math.max(6, Math.min(10, tileRect.height * 0.08));
  return expandedRect(iconRect, padX, padY);
}

export function expandedRect(rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">, padX: number, padY: number): Rect {
  const left = rect.left - padX;
  const top = rect.top - padY;
  const right = rect.right + padX;
  const bottom = rect.bottom + padY;

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

export function rectsIntersect(a: Rect, b: Pick<DOMRect, "left" | "top" | "right" | "bottom">) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function rectsOverlapWithMargin(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  margin: number
) {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

export function edgeAxisPositions(start: number, size: number, itemSize: number, pitch: number) {
  const positions: number[] = [];
  const maxStart = start + Math.max(0, size - itemSize);
  const safePitch = Math.max(1, pitch);
  const push = (value: number) => {
    const rounded = Math.round(value);
    if (!positions.some((position) => Math.abs(position - rounded) < 1)) {
      positions.push(rounded);
    }
  };

  push(start);
  for (let position = start + safePitch; position < maxStart - 0.5; position += safePitch) {
    push(position);
  }
  push(maxStart);

  return positions;
}

export function uniqueDesktopPositions(positions: DesktopPosition[]) {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = `${Math.round(position.x)}:${Math.round(position.y)}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function desktopPositionDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointInMergeRect(x: number, y: number, rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
