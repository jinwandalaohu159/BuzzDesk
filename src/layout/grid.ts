import { desktopTileMetrics } from "../settings/desktopSettings";
import type { DesktopNode, DesktopSettings, FolderAppearanceSettings, LayoutSlot } from "../types";

export const desktopGrid = {
  itemWidth: 106,
  itemHeight: 124,
  gapX: 12,
  gapY: 12,
  paddingX: 28,
  paddingY: 32
};

export const folderGrid = {
  itemWidth: 92,
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
}

export function computeDesktopLayout(
  nodes: DesktopNode[],
  viewportWidth: number,
  viewportHeight: number,
  settings: DesktopSettings
): Map<string, LayoutSlot> {
  const slots = new Map<string, LayoutSlot>();
  const tile = desktopTileMetrics(settings);
  const usableWidth = Math.max(1, viewportWidth - tile.paddingX * 2);
  const columns = Math.max(
    1,
    Math.floor((usableWidth + tile.gapX) / (tile.width + tile.gapX))
  );

  nodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = tile.paddingX + column * (tile.width + tile.gapX);
    const y = tile.paddingY + row * (tile.height + tile.gapY);

    slots.set(node.id, {
      id: node.id,
      x,
      y,
      width: tile.width,
      height: tile.height
    });
  });

  document.documentElement.style.setProperty("--desktop-content-height", `${viewportHeight}px`);

  return slots;
}

export function desktopIndexForPoint(
  x: number,
  y: number,
  viewportWidth: number,
  nodeCount: number,
  settings: DesktopSettings
) {
  const tile = desktopTileMetrics(settings);
  const usableWidth = Math.max(1, viewportWidth - tile.paddingX * 2);
  const columns = Math.max(
    1,
    Math.floor((usableWidth + tile.gapX) / (tile.width + tile.gapX))
  );
  const cellWidth = tile.width + tile.gapX;
  const cellHeight = tile.height + tile.gapY;
  const column = clamp(Math.floor((x - tile.paddingX) / cellWidth), 0, columns - 1);
  const row = Math.max(0, Math.floor((y - tile.paddingY) / cellHeight));
  const cellX = tile.paddingX + column * cellWidth;
  const insertAfter = x - cellX > tile.width / 2 ? 1 : 0;

  return clamp(row * columns + column + insertAfter, 0, nodeCount);
}

export function panelSizeFor(
  viewportWidth: number,
  viewportHeight: number,
  appearance: FolderAppearanceSettings
): FolderPanelSize {
  const desiredColumns = clamp(appearance.folderPanelColumns, 2, 6);
  const desiredRows = clamp(appearance.folderPanelRows, 2, 6);
  const naturalMaxWidth =
    folderGrid.paddingX * 2 + desiredColumns * folderGrid.itemWidth + (desiredColumns - 1) * folderGrid.gapX;
  const maxWidth = Math.max(1, Math.min(viewportWidth - 40, naturalMaxWidth));
  const maxHeight = Math.max(1, Math.min(viewportHeight - 56, 540));
  const availableColumns = Math.floor(
    (maxWidth - folderGrid.paddingX * 2 + folderGrid.gapX) / (folderGrid.itemWidth + folderGrid.gapX)
  );
  const columns = Math.max(1, Math.min(desiredColumns, availableColumns));
  const visibleRows = Math.max(1, desiredRows);
  const contentHeight =
    folderGrid.paddingY * 2 + visibleRows * folderGrid.itemHeight + (visibleRows - 1) * folderGrid.gapY;
  const naturalWidth = folderGrid.paddingX * 2 + columns * folderGrid.itemWidth + (columns - 1) * folderGrid.gapX;
  const naturalHeight = 78 + contentHeight;

  return {
    width: Math.min(maxWidth, naturalWidth),
    height: Math.min(maxHeight, naturalHeight),
    columns
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
