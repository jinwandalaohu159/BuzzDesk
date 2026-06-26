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

export interface FlowGrid {
  left: number;
  top: number;
  columns: number;
  columnPitch: number;
  rowPitch: number;
  effectiveGapX: number;
  effectivePaddingX: number;
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
  const grid = createFlowGrid(viewportWidth, base, viewportOffsetX, viewportOffsetY);
  const slots = new Map<string, LayoutSlot>();
  const occupied: boolean[][] = [];
  let right = grid.left;
  let bottom = grid.top;

  nodes.forEach((node) => {
    const tile = tileForNode(node);
    const columnSpan = tileSpan(tile.width, base.width, grid.effectiveGapX, grid.columns);
    const rowSpan = tileSpan(tile.height, base.height, base.gapY);
    const cell = firstAvailableCell(occupied, grid.columns, columnSpan, rowSpan);
    occupyCells(occupied, cell.row, cell.column, columnSpan, rowSpan);

    const reservedWidth = spanSize(base.width, grid.effectiveGapX, columnSpan);
    const x = grid.left + cell.column * grid.columnPitch + Math.max(0, Math.round((reservedWidth - tile.width) / 2));
    const y = grid.top + cell.row * grid.rowPitch;

    slots.set(node.id, {
      id: node.id,
      x,
      y,
      width: tile.width,
      height: tile.height
    });

    right = Math.max(right, x + tile.width);
    bottom = Math.max(bottom, y + tile.height);
  });

  return {
    slots,
    contentWidth: right + grid.effectivePaddingX + viewportOffsetX,
    contentHeight: bottom + base.paddingY + viewportOffsetY
  };
}

export function createFlowGrid(
  viewportWidth: number,
  base: FlowBaseMetrics,
  viewportOffsetX: number,
  viewportOffsetY: number
): FlowGrid {
  const maxPadding = Math.max(0, Math.floor((viewportWidth - base.width) / 2));
  const effectivePaddingX = Math.min(Math.max(0, base.paddingX), maxPadding);
  const contentWidth = Math.max(base.width, viewportWidth - effectivePaddingX * 2);
  const desiredGapX = Math.max(0, base.gapX);
  const columns = Math.max(1, Math.floor((contentWidth + desiredGapX) / (base.width + desiredGapX)));
  const effectiveGapX =
    columns > 1
      ? Math.max(desiredGapX, (contentWidth - columns * base.width) / (columns - 1))
      : desiredGapX;

  return {
    left: viewportOffsetX + effectivePaddingX,
    top: viewportOffsetY + Math.max(0, base.paddingY),
    columns,
    columnPitch: base.width + effectiveGapX,
    rowPitch: base.height + Math.max(0, base.gapY),
    effectiveGapX,
    effectivePaddingX
  };
}

export function tileSpan(size: number, baseSize: number, gap: number, maxSpan = Number.POSITIVE_INFINITY) {
  const pitch = baseSize + Math.max(0, gap);
  const span = pitch > 0 ? Math.ceil((size + Math.max(0, gap)) / pitch) : 1;
  return Math.max(1, Math.min(maxSpan, span));
}

export function spanSize(baseSize: number, gap: number, span: number) {
  return span * baseSize + Math.max(0, span - 1) * Math.max(0, gap);
}

function firstAvailableCell(
  occupied: boolean[][],
  columns: number,
  columnSpan: number,
  rowSpan: number
) {
  for (let row = 0; row < 10000; row += 1) {
    for (let column = 0; column <= columns - columnSpan; column += 1) {
      if (cellsAvailable(occupied, row, column, columnSpan, rowSpan)) {
        return { row, column };
      }
    }
  }

  return { row: occupied.length, column: 0 };
}

function cellsAvailable(
  occupied: boolean[][],
  startRow: number,
  startColumn: number,
  columnSpan: number,
  rowSpan: number
) {
  for (let row = startRow; row < startRow + rowSpan; row += 1) {
    for (let column = startColumn; column < startColumn + columnSpan; column += 1) {
      if (occupied[row]?.[column]) {
        return false;
      }
    }
  }

  return true;
}

function occupyCells(
  occupied: boolean[][],
  startRow: number,
  startColumn: number,
  columnSpan: number,
  rowSpan: number
) {
  for (let row = startRow; row < startRow + rowSpan; row += 1) {
    occupied[row] ??= [];
    for (let column = startColumn; column < startColumn + columnSpan; column += 1) {
      occupied[row][column] = true;
    }
  }
}
