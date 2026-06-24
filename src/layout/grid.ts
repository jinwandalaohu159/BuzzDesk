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
  if (settings.layoutMode === "free") {
    return computeFreeDesktopLayout(nodes, viewportWidth, viewportHeight, settings, viewportOffsetX, viewportOffsetY);
  }

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

function computeFreeDesktopLayout(
  nodes: DesktopNode[],
  viewportWidth: number,
  viewportHeight: number,
  settings: DesktopSettings,
  viewportOffsetX: number,
  viewportOffsetY: number
) {
  const { slots: fallbackSlots } = layoutDesktopNodes(
    nodes,
    viewportWidth,
    settings,
    viewportOffsetX,
    viewportOffsetY
  );
  const slots = new Map<string, LayoutSlot>();
  const occupied: LayoutSlot[] = [];
  const base = desktopTileMetrics(settings);
  const unpositioned: Array<{ node: DesktopNode; tile: ReturnType<typeof desktopNodeTileMetrics>; fallback: LayoutSlot | null }> = [];
  let right = viewportWidth + viewportOffsetX * 2;
  let bottom = viewportHeight + viewportOffsetY * 2;

  for (const node of nodes) {
    const tile = desktopNodeTileMetrics(settings, node);
    const fallback = fallbackSlots.get(node.id);
    if (!node.position) {
      unpositioned.push({ node, tile, fallback: fallback ?? null });
      continue;
    }

    const clamped = clampFreeLayoutPosition(node.position.x, node.position.y, tile, viewportWidth, viewportHeight, settings);
    const preferred = {
      id: node.id,
      x: viewportOffsetX + clamped.x,
      y: viewportOffsetY + clamped.y,
      width: tile.width,
      height: tile.height
    };
    const slot = occupied.some((rect) => layoutRectsOverlapWithGap(preferred, rect, base.gapX, base.gapY))
      ? findFreeLayoutSlot(
          node.id,
          tile,
          preferred,
          occupied,
          viewportWidth,
          viewportHeight,
          settings,
          viewportOffsetX,
          viewportOffsetY
        )
      : preferred;
    slots.set(node.id, slot);
    occupied.push(slot);
    right = Math.max(right, slot.x + slot.width + viewportOffsetX);
    bottom = Math.max(bottom, slot.y + slot.height + viewportOffsetY);
  }

  for (const entry of unpositioned) {
    const slot = findFreeLayoutSlot(
      entry.node.id,
      entry.tile,
      entry.fallback,
      occupied,
      viewportWidth,
      viewportHeight,
      settings,
      viewportOffsetX,
      viewportOffsetY
    );
    slots.set(entry.node.id, slot);
    occupied.push(slot);
    right = Math.max(right, slot.x + slot.width + viewportOffsetX);
    bottom = Math.max(bottom, slot.y + slot.height + viewportOffsetY);
  }

  document.documentElement.style.setProperty("--desktop-content-width", `${right}px`);
  document.documentElement.style.setProperty("--desktop-content-height", `${bottom}px`);

  return slots;
}

function clampFreeLayoutPosition(
  x: number,
  y: number,
  tile: ReturnType<typeof desktopNodeTileMetrics>,
  viewportWidth: number,
  viewportHeight: number,
  settings: DesktopSettings
) {
  const base = desktopTileMetrics(settings);
  const maxAvailableX = Math.max(0, viewportWidth - tile.width);
  const maxAvailableY = Math.max(0, viewportHeight - tile.height);
  const minX = Math.min(base.paddingX, maxAvailableX);
  const minY = Math.min(base.paddingY, maxAvailableY);
  const maxX = Math.max(minX, maxAvailableX - base.paddingX);
  const maxY = Math.max(minY, maxAvailableY - base.paddingY);

  return {
    x: clamp(Math.round(x), minX, maxX),
    y: clamp(Math.round(y), minY, maxY)
  };
}

function findFreeLayoutSlot(
  id: string,
  tile: ReturnType<typeof desktopNodeTileMetrics>,
  fallback: LayoutSlot | null,
  occupied: LayoutSlot[],
  viewportWidth: number,
  viewportHeight: number,
  settings: DesktopSettings,
  viewportOffsetX: number,
  viewportOffsetY: number
): LayoutSlot {
  const base = desktopTileMetrics(settings);
  const maxAvailableX = Math.max(0, viewportWidth - tile.width);
  const maxAvailableY = Math.max(0, viewportHeight - tile.height);
  const minX = viewportOffsetX + Math.min(base.paddingX, maxAvailableX);
  const minY = viewportOffsetY + Math.min(base.paddingY, maxAvailableY);
  const maxX = viewportOffsetX + Math.max(minX - viewportOffsetX, maxAvailableX - base.paddingX);
  const maxY = viewportOffsetY + Math.max(minY - viewportOffsetY, maxAvailableY - base.paddingY);
  const preferred = {
    x: clamp(fallback?.x ?? viewportOffsetX + base.paddingX, minX, maxX),
    y: clamp(fallback?.y ?? viewportOffsetY + base.paddingY, minY, maxY)
  };
  const candidates = uniqueLayoutCandidates([
    preferred,
    ...freeGridCandidates(base, tile, viewportWidth, viewportHeight, viewportOffsetX, viewportOffsetY)
  ]);

  for (const candidate of candidates) {
    const slot = {
      id,
      x: clamp(candidate.x, minX, maxX),
      y: clamp(candidate.y, minY, maxY),
      width: tile.width,
      height: tile.height
    };

    if (!occupied.some((rect) => layoutRectsOverlapWithGap(slot, rect, base.gapX, base.gapY))) {
      return slot;
    }
  }

  return {
    id,
    x: preferred.x,
    y: preferred.y,
    width: tile.width,
    height: tile.height
  };
}

function freeGridCandidates(
  base: ReturnType<typeof desktopTileMetrics>,
  tile: ReturnType<typeof desktopNodeTileMetrics>,
  viewportWidth: number,
  viewportHeight: number,
  viewportOffsetX: number,
  viewportOffsetY: number
) {
  const candidates: Array<{ x: number; y: number }> = [];
  const maxAvailableX = Math.max(0, viewportWidth - tile.width);
  const maxAvailableY = Math.max(0, viewportHeight - tile.height);
  const minLocalX = Math.min(base.paddingX, maxAvailableX);
  const minLocalY = Math.min(base.paddingY, maxAvailableY);
  const maxLocalX = Math.max(minLocalX, maxAvailableX - base.paddingX);
  const maxLocalY = Math.max(minLocalY, maxAvailableY - base.paddingY);
  const startX = viewportOffsetX + minLocalX;
  const startY = viewportOffsetY + minLocalY;
  const maxX = viewportOffsetX + maxLocalX;
  const maxY = viewportOffsetY + maxLocalY;
  const stepX = Math.max(base.width + base.gapX, Math.ceil(tile.width / 2) + base.gapX);
  const stepY = Math.max(base.height + base.gapY, Math.ceil(tile.height / 2) + base.gapY);

  for (let y = startY; y <= maxY; y += stepY) {
    for (let x = startX; x <= maxX; x += stepX) {
      candidates.push({ x, y });
    }
  }

  return candidates;
}

function uniqueLayoutCandidates(candidates: Array<{ x: number; y: number }>) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function layoutRectsOverlapWithGap(
  a: Pick<LayoutSlot, "x" | "y" | "width" | "height">,
  b: Pick<LayoutSlot, "x" | "y" | "width" | "height">,
  gapX: number,
  gapY: number
) {
  return (
    a.x < b.x + b.width + gapX &&
    a.x + a.width + gapX > b.x &&
    a.y < b.y + b.height + gapY &&
    a.y + a.height + gapY > b.y
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
