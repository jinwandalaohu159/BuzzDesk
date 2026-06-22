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

export function layoutDesktopFlow(
  nodes: DesktopNode[],
  viewportWidth: number,
  base: FlowBaseMetrics,
  tileForNode: (node: DesktopNode) => FlowTileMetrics,
  isolateNode: (node: DesktopNode) => boolean
): FlowLayoutResult {
  const slots = new Map<string, LayoutSlot>();
  const usableRight = Math.max(base.paddingX + 1, viewportWidth - base.paddingX);
  let x = base.paddingX;
  let y = base.paddingY;
  let rowHeight = 0;
  let right = base.paddingX;
  let bottom = base.paddingY;

  const breakRow = () => {
    if (rowHeight <= 0) {
      x = base.paddingX;
      return;
    }

    y += rowHeight + base.gapY;
    x = base.paddingX;
    rowHeight = 0;
  };

  nodes.forEach((node) => {
    const tile = tileForNode(node);
    const isolate = isolateNode(node);
    const rowHasItems = rowHeight > 0;

    if ((isolate && rowHasItems) || (!isolate && rowHasItems && x + tile.width > usableRight)) {
      breakRow();
    }

    slots.set(node.id, {
      id: node.id,
      x,
      y,
      width: tile.width,
      height: tile.height
    });

    right = Math.max(right, x + tile.width);
    bottom = Math.max(bottom, y + tile.height);

    if (isolate) {
      y += tile.height + base.gapY;
      x = base.paddingX;
      rowHeight = 0;
      return;
    }

    x += tile.width + base.gapX;
    rowHeight = Math.max(rowHeight, tile.height);
  });

  return {
    slots,
    contentWidth: right + base.paddingX,
    contentHeight: bottom + base.paddingY
  };
}
