import type { DesktopNode, LayoutSlot } from "../types";

export interface FlowTileMetrics {
  width: number;
  height: number;
}

export interface FlowBaseMetrics extends FlowTileMetrics {
  gapX: number;
  gapY: number;
  paddingX: number;
  paddingY: number;
}

export interface FlowLayoutResult {
  slots: Map<string, LayoutSlot>;
  contentWidth: number;
  contentHeight: number;
}

interface PackedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function layoutDesktopFlow(
  nodes: DesktopNode[],
  viewportWidth: number,
  base: FlowBaseMetrics,
  tileForNode: (node: DesktopNode) => FlowTileMetrics,
  _isolateNode: (node: DesktopNode) => boolean,
  viewportOffsetX = 0,
  viewportOffsetY = 0
): FlowLayoutResult {
  const horizontalPadding = symmetricHorizontalPadding(viewportWidth, base);
  const layoutBase = {
    ...base,
    paddingX: viewportOffsetX + horizontalPadding,
    paddingY: viewportOffsetY + base.paddingY
  };
  const slots = new Map<string, LayoutSlot>();
  const usableRight = viewportOffsetX + Math.max(horizontalPadding + base.width, viewportWidth - horizontalPadding);
  const placed: PackedRect[] = [];
  let right = layoutBase.paddingX;
  let bottom = layoutBase.paddingY;

  nodes.forEach((node) => {
    const tile = tileForNode(node);
    const position = firstAvailableRect(placed, tile, layoutBase, usableRight);
    const x = position.x;
    const y = position.y;

    slots.set(node.id, {
      id: node.id,
      x,
      y,
      width: tile.width,
      height: tile.height
    });

    right = Math.max(right, x + tile.width);
    bottom = Math.max(bottom, y + tile.height);
    placed.push({ x, y, width: tile.width, height: tile.height });
  });

  return {
    slots,
    contentWidth: right + horizontalPadding + viewportOffsetX,
    contentHeight: bottom + base.paddingY + viewportOffsetY
  };
}

function firstAvailableRect(
  placed: PackedRect[],
  tile: FlowTileMetrics,
  base: FlowBaseMetrics,
  usableRight: number
) {
  const xCandidates = uniqueSorted([
    base.paddingX,
    ...placed.map((rect) => rect.x + rect.width + base.gapX)
  ]).filter((x) => x + tile.width <= usableRight || x === base.paddingX);
  const yCandidates = uniqueSorted([
    base.paddingY,
    ...placed.map((rect) => rect.y),
    ...placed.map((rect) => rect.y + rect.height + base.gapY)
  ]);

  for (const y of yCandidates) {
    for (const x of xCandidates) {
      const candidate = { x, y, width: tile.width, height: tile.height };
      if (candidate.x + candidate.width > usableRight && candidate.x !== base.paddingX) {
        continue;
      }

      if (!placed.some((rect) => rectsCollideWithGap(candidate, rect, base))) {
        return candidate;
      }
    }
  }

  const nextY =
    placed.length === 0
      ? base.paddingY
      : Math.max(...placed.map((rect) => rect.y + rect.height + base.gapY));
  return {
    x: base.paddingX,
    y: nextY,
    width: tile.width,
    height: tile.height
  };
}

function rectsCollideWithGap(a: PackedRect, b: PackedRect, base: FlowBaseMetrics) {
  return (
    a.x < b.x + b.width + base.gapX &&
    a.x + a.width + base.gapX > b.x &&
    a.y < b.y + b.height + base.gapY &&
    a.y + a.height + base.gapY > b.y
  );
}

function uniqueSorted(values: number[]) {
  return Array.from(new Set(values.map((value) => Math.round(value)))).sort((a, b) => a - b);
}

function symmetricHorizontalPadding(viewportWidth: number, base: FlowBaseMetrics) {
  const minPadding = Math.max(0, base.paddingX);
  const stride = base.width + base.gapX;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || base.width <= 0 || stride <= 0) {
    return minPadding;
  }

  const availableWidth = Math.max(base.width, viewportWidth - minPadding * 2);
  const columns = Math.max(1, Math.floor((availableWidth + base.gapX) / stride));
  const rowWidth = columns * base.width + Math.max(0, columns - 1) * base.gapX;
  return Math.max(minPadding, Math.floor((viewportWidth - rowWidth) / 2));
}
