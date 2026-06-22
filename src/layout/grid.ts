import {
  desktopNodeTileMetrics,
  desktopTileMetrics,
  folderRatioMax,
  folderRatioMin,
  shouldIsolateDesktopNode
} from "../settings/desktopSettings";
import { layoutDesktopFlow } from "./flow";
import type { DesktopNode, DesktopSettings, FolderAppearanceSettings, LayoutSlot } from "../types";

export const folderGrid = {
  itemWidth: 92,
  minItemWidth: 76,
  itemHeight: 108,
  gapX: 14,
  gapY: 12,
  paddingX: 28,
  paddingY: 22
};

export interface FolderPanelSize {
  width: number;
  height: number;
  columns: number;
  rows: number;
  itemWidth: number;
  itemHeight: number;
}

export function computeDesktopLayout(
  nodes: DesktopNode[],
  viewportWidth: number,
  viewportHeight: number,
  settings: DesktopSettings,
  viewportOffsetX = 0,
  viewportOffsetY = 0
): Map<string, LayoutSlot> {
  const { slots, contentWidth, contentHeight } = layoutDesktopNodes(
    nodes,
    viewportWidth,
    settings,
    viewportOffsetX,
    viewportOffsetY
  );
  const stageWidth = Math.max(viewportWidth + viewportOffsetX * 2, contentWidth);
  const stageHeight = Math.max(viewportHeight + viewportOffsetY * 2, contentHeight);
  document.documentElement.style.setProperty("--desktop-content-width", `${stageWidth}px`);
  document.documentElement.style.setProperty("--desktop-content-height", `${stageHeight}px`);

  return slots;
}

export function desktopIndexForPoint(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  nodes: DesktopNode[],
  settings: DesktopSettings,
  viewportOffsetX = 0,
  viewportOffsetY = 0
) {
  if (nodes.length === 0) {
    return 0;
  }

  const { slots } = layoutDesktopNodes(nodes, viewportWidth, settings, viewportOffsetX, viewportOffsetY);
  const ordered = nodes
    .map((node, index) => ({ index, slot: slots.get(node.id) }))
    .filter((entry): entry is { index: number; slot: LayoutSlot } => Boolean(entry.slot));

  if (ordered.length === 0) {
    return 0;
  }

  const viewportBottom = Math.max(y, viewportHeight);
  let best = ordered[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const entry of ordered) {
    const centerX = entry.slot.x + entry.slot.width / 2;
    const centerY = entry.slot.y + entry.slot.height / 2;
    const distance = Math.hypot(x - centerX, y - centerY);
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }

  const centerX = best.slot.x + best.slot.width / 2;
  const centerY = best.slot.y + best.slot.height / 2;
  const isAfter = y > centerY + best.slot.height * 0.35 || (y > centerY - best.slot.height * 0.35 && x > centerX);
  const afterLast = ordered[ordered.length - 1];
  if (viewportBottom > afterLast.slot.y + afterLast.slot.height && y > afterLast.slot.y + afterLast.slot.height / 2) {
    return nodes.length;
  }

  return clamp(best.index + (isAfter ? 1 : 0), 0, nodes.length);
}

export function panelSizeFor(
  viewportWidth: number,
  viewportHeight: number,
  appearance: FolderAppearanceSettings,
  footerHeight = 0
): FolderPanelSize {
  const desiredColumns = clamp(appearance.folderPanelColumns, folderRatioMin, folderRatioMax);
  const desiredRows = clamp(appearance.folderPanelRows, folderRatioMin, folderRatioMax);
  const maxWidth = Math.max(1, viewportWidth - 40);
  const maxHeight = Math.max(1, viewportHeight - 56);
  const { columns, itemWidth } = fitFolderPanelColumns(desiredColumns, maxWidth);
  const maxContentHeight = Math.max(1, maxHeight - 78 - footerHeight);
  const availableRows = Math.floor(
    (maxContentHeight - folderGrid.paddingY * 2 + folderGrid.gapY) / (folderGrid.itemHeight + folderGrid.gapY)
  );
  const visibleRows = Math.max(1, Math.min(desiredRows, availableRows));
  const contentHeight =
    folderGrid.paddingY * 2 + visibleRows * folderGrid.itemHeight + (visibleRows - 1) * folderGrid.gapY;
  const naturalWidth = folderGrid.paddingX * 2 + columns * itemWidth + (columns - 1) * folderGrid.gapX;
  const naturalHeight = 78 + contentHeight + footerHeight;

  return {
    width: Math.min(maxWidth, naturalWidth),
    height: Math.min(maxHeight, naturalHeight),
    columns,
    rows: visibleRows,
    itemWidth,
    itemHeight: folderGrid.itemHeight
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function layoutDesktopNodes(
  nodes: DesktopNode[],
  viewportWidth: number,
  settings: DesktopSettings,
  viewportOffsetX = 0,
  viewportOffsetY = 0
) {
  const base = desktopTileMetrics(settings);
  return layoutDesktopFlow(
    nodes,
    viewportWidth,
    base,
    (node) => desktopNodeTileMetrics(settings, node),
    (node) => shouldIsolateDesktopNode(settings, node),
    viewportOffsetX,
    viewportOffsetY
  );
}

function fitFolderPanelColumns(desiredColumns: number, maxWidth: number) {
  const naturalWidth =
    folderGrid.paddingX * 2 +
    desiredColumns * folderGrid.itemWidth +
    Math.max(0, desiredColumns - 1) * folderGrid.gapX;

  if (naturalWidth <= maxWidth) {
    return {
      columns: desiredColumns,
      itemWidth: folderGrid.itemWidth
    };
  }

  const widthForDesiredColumns = Math.floor(
    (maxWidth - folderGrid.paddingX * 2 - Math.max(0, desiredColumns - 1) * folderGrid.gapX) / desiredColumns
  );

  if (widthForDesiredColumns >= folderGrid.minItemWidth) {
    return {
      columns: desiredColumns,
      itemWidth: widthForDesiredColumns
    };
  }

  const availableColumns = Math.floor(
    (maxWidth - folderGrid.paddingX * 2 + folderGrid.gapX) / (folderGrid.minItemWidth + folderGrid.gapX)
  );
  const columns = Math.max(1, Math.min(desiredColumns, availableColumns));
  const fittedWidth = Math.floor(
    (maxWidth - folderGrid.paddingX * 2 - Math.max(0, columns - 1) * folderGrid.gapX) / columns
  );

  return {
    columns,
    itemWidth: clamp(fittedWidth, folderGrid.minItemWidth, folderGrid.itemWidth)
  };
}
