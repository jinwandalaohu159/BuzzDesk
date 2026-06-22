import type { DesktopLayoutMode, DesktopNode, DesktopSettings, FolderAppearanceSettings, FolderCoverSize } from "../types";

export const defaultDesktopSettings: DesktopSettings = {
  layoutMode: "auto",
  appIconSize: 60,
  desktopGapPx: 12,
  desktopPaddingX: 28,
  desktopPaddingY: 30,
  folderCoverSmallPx: 14,
  folderCoverMediumPx: 20,
  folderCoverLargePx: 28
};

export const defaultFolderAppearance: FolderAppearanceSettings = {
  folderCoverSize: "small",
  folderPanelColumns: 3,
  folderPanelRows: 3
};

export const folderRatioMin = 1;
export const folderRatioMax = 12;

export function createDefaultFolderAppearance(): FolderAppearanceSettings {
  return { ...defaultFolderAppearance };
}

export function folderCoverCellSizeForAppearance(
  settings: DesktopSettings,
  appearance: FolderAppearanceSettings
): number {
  switch (appearance.folderCoverSize) {
    case "medium":
      return settings.folderCoverMediumPx;
    case "large":
      return settings.folderCoverLargePx;
    default:
      return settings.folderCoverSmallPx;
  }
}

export function normalizeDesktopSettings(settings?: Partial<DesktopSettings> | null): DesktopSettings {
  const legacyCoverCellSize = legacyNumber(settings, "folderCoverCellSize");
  const fallbackSmall = legacyCoverCellSize ?? defaultDesktopSettings.folderCoverSmallPx;
  const fallbackMedium = Math.max(fallbackSmall, Math.round(fallbackSmall * 1.43));
  const fallbackLarge = Math.max(fallbackMedium, Math.round(fallbackSmall * 2));

  return {
    layoutMode: normalizeLayoutMode(settings?.layoutMode),
    appIconSize: clampNumber(settings?.appIconSize, 48, 76, defaultDesktopSettings.appIconSize),
    desktopGapPx: clampNumber(settings?.desktopGapPx, 0, 32, defaultDesktopSettings.desktopGapPx),
    desktopPaddingX: clampNumber(settings?.desktopPaddingX, 0, 160, defaultDesktopSettings.desktopPaddingX),
    desktopPaddingY: clampNumber(settings?.desktopPaddingY, 0, 160, defaultDesktopSettings.desktopPaddingY),
    folderCoverSmallPx: clampNumber(
      settings?.folderCoverSmallPx,
      6,
      40,
      fallbackSmall
    ),
    folderCoverMediumPx: clampNumber(
      settings?.folderCoverMediumPx,
      6,
      40,
      fallbackMedium
    ),
    folderCoverLargePx: clampNumber(
      settings?.folderCoverLargePx,
      6,
      40,
      fallbackLarge
    )
  };
}

function normalizeLayoutMode(value: unknown): DesktopLayoutMode {
  return value === "free" ? "free" : "auto";
}

export function normalizeFolderAppearance(
  appearance?: Partial<FolderAppearanceSettings> | null,
  fallback: FolderAppearanceSettings = defaultFolderAppearance
): FolderAppearanceSettings {
  const legacyCoverCellSize = legacyNumber(appearance, "folderCoverCellSize");
  const legacyCoverSize = legacyCoverSizeFromCellSize(legacyCoverCellSize);
  const coverSize: FolderCoverSize =
    appearance?.folderCoverSize && ["small", "medium", "large"].includes(appearance.folderCoverSize)
      ? appearance.folderCoverSize
      : legacyCoverSize ?? fallback.folderCoverSize;

  return {
    folderCoverSize: coverSize,
    folderPanelColumns: clampNumber(
      appearance?.folderPanelColumns,
      folderRatioMin,
      folderRatioMax,
      fallback.folderPanelColumns
    ),
    folderPanelRows: clampNumber(
      appearance?.folderPanelRows,
      folderRatioMin,
      folderRatioMax,
      fallback.folderPanelRows
    )
  };
}

export function applyDesktopSettings(settings: DesktopSettings) {
  const root = document.documentElement;
  const tile = desktopTileMetrics(settings);

  root.style.setProperty("--app-icon-size", `${settings.appIconSize}px`);
  root.style.setProperty("--app-icon-radius", `${Math.max(3, Math.round(settings.appIconSize * 0.23))}px`);
  root.style.setProperty("--desktop-icon-shell-size", `${tile.iconShellSize}px`);
  root.style.setProperty("--tile-name-font-size", `${tile.labelFontSize}px`);
  root.style.setProperty("--tile-name-line-height", `${tile.labelLineHeight}px`);
  root.style.setProperty("--tile-name-max-height", `${tile.labelMaxHeight}px`);
}

export function folderCoverCssVariables(
  settings: DesktopSettings,
  appearance: FolderAppearanceSettings
): Record<string, string> {
  const normalized = normalizeFolderAppearance(appearance);
  const cellSize = folderCoverCellSizeForAppearance(settings, normalized);
  const columns = normalized.folderPanelColumns;
  const rows = normalized.folderPanelRows;
  const coverGap = Math.max(2, Math.round(cellSize * 0.18));
  const basePadding = Math.max(4, Math.round(cellSize * 0.42));
  const shortAxisExtra = folderCoverShortAxisPaddingExtra(cellSize, columns, rows);
  const coverPaddingX = basePadding + (columns < rows ? shortAxisExtra : 0);
  const coverPaddingY = basePadding + (rows < columns ? shortAxisExtra : 0);
  const rawCoverWidth =
    columns * cellSize +
    (columns - 1) * coverGap +
    coverPaddingX * 2;
  const rawCoverHeight =
    rows * cellSize +
    (rows - 1) * coverGap +
    coverPaddingY * 2;
  const coverRadius = folderCoverRadius(rawCoverWidth, rawCoverHeight);

  return {
    "--folder-cover-width": `${rawCoverWidth}px`,
    "--folder-cover-height": `${rawCoverHeight}px`,
    "--folder-cover-mini-icon-size": `${cellSize}px`,
    "--folder-cover-padding-x": `${coverPaddingX}px`,
    "--folder-cover-padding-y": `${coverPaddingY}px`,
    "--folder-cover-gap": `${coverGap}px`,
    "--folder-cover-radius": `${coverRadius}px`,
    "--folder-cover-icon-radius": `${Math.max(3, Math.round(cellSize * 0.26))}px`,
    "--folder-cover-columns": `${columns}`,
    "--folder-cover-rows": `${rows}`
  };
}

function folderCoverShortAxisPaddingExtra(cellSize: number, columns: number, rows: number) {
  const shortSide = Math.max(1, Math.min(columns, rows));
  const longSide = Math.max(columns, rows);
  const ratioSpread = Math.max(0, longSide / shortSide - 1);

  return Math.round(cellSize * Math.min(0.42, ratioSpread * 0.12));
}

function folderCoverRadius(width: number, height: number) {
  const shortSide = Math.min(width, height);
  return Math.round(Math.max(10, Math.min(28, shortSide * 0.28)));
}

/**
 * Calculate the tile dimensions for a folder node.
 * For "small" cover size, the tile is the same as a regular app tile.
 * For "medium"/"large", the tile is wider/taller to accommodate the larger cover.
 */
export function folderTileMetrics(
  settings: DesktopSettings,
  appearance: FolderAppearanceSettings
) {
  const base = desktopTileMetrics(settings);

  const coverVars = folderCoverCssVariables(settings, appearance);
  const coverWidth = parseFloat(coverVars["--folder-cover-width"]);
  const coverHeight = parseFloat(coverVars["--folder-cover-height"]);
  const iconShellWidth = Math.max(base.iconShellSize, Math.ceil(coverWidth) + 4);
  const iconShellHeight = Math.max(base.iconShellSize, Math.ceil(coverHeight) + 4);
  const iconShellSize = Math.max(iconShellWidth, iconShellHeight);
  const width = Math.max(base.width, Math.round(iconShellWidth + 42));
  const height = Math.max(base.height, Math.round(iconShellHeight + base.labelMaxHeight + 22));

  return {
    ...base,
    width,
    height,
    iconShellWidth,
    iconShellHeight,
    iconShellSize
  };
}

export function desktopNodeTileMetrics(settings: DesktopSettings, node: DesktopNode) {
  return node.type === "folder" ? folderTileMetrics(settings, node.appearance) : desktopTileMetrics(settings);
}

export function shouldIsolateDesktopNode(settings: DesktopSettings, node: DesktopNode) {
  if (node.type !== "folder") {
    return false;
  }

  const appearance = normalizeFolderAppearance(node.appearance);
  if (
    appearance.folderPanelColumns !== defaultFolderAppearance.folderPanelColumns ||
    appearance.folderPanelRows !== defaultFolderAppearance.folderPanelRows ||
    appearance.folderCoverSize !== defaultFolderAppearance.folderCoverSize
  ) {
    return true;
  }

  const base = desktopTileMetrics(settings);
  const folder = folderTileMetrics(settings, node.appearance);
  return folder.width > base.width || folder.height > base.height;
}

export function fitDesktopSettings(
  settings: DesktopSettings,
  nodesOrItemCount: DesktopNode[] | number,
  viewportWidth: number,
  viewportHeight: number
) {
  let appIconSize = settings.appIconSize;
  const itemCount = typeof nodesOrItemCount === "number" ? nodesOrItemCount : nodesOrItemCount.length;

  while (
    appIconSize > 8 &&
    !desktopLayoutFits({ ...settings, appIconSize }, itemCount, viewportWidth, viewportHeight)
  ) {
    appIconSize -= 2;
  }

  return { ...settings, appIconSize };
}

export function desktopTileMetrics(settings: DesktopSettings) {
  const compactness = Math.max(0, Math.min(1, (36 - settings.appIconSize) / 20));
  const emergencyCompactness = Math.max(0, Math.min(1, (20 - settings.appIconSize) / 12));
  const iconShellSize = Math.round(Math.max(14, settings.appIconSize + 8 - compactness * 4 - emergencyCompactness * 4));
  const labelFontSize = Math.round(Math.max(9, 12 - compactness * 2 - emergencyCompactness));
  const labelLineHeight = Math.round(Math.max(10, 16 - compactness * 4 - emergencyCompactness * 2));
  const labelLines = settings.appIconSize <= 20 ? 1 : 2;
  const labelMaxHeight = labelLineHeight * labelLines;
  const width = Math.round(Math.max(32, iconShellSize + 42 - compactness * 18 - emergencyCompactness * 8));
  const height = Math.round(Math.max(38, iconShellSize + labelMaxHeight + 22 - compactness * 12 - emergencyCompactness * 10));
  const gapX = settings.desktopGapPx;
  const gapY = settings.desktopGapPx;
  const paddingX = settings.desktopPaddingX;
  const paddingY = settings.desktopPaddingY;

  return {
    width,
    height,
    iconShellSize,
    gapX,
    gapY,
    paddingX,
    paddingY,
    labelFontSize,
    labelLineHeight,
    labelMaxHeight
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function legacyNumber(source: unknown, key: string) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function legacyCoverSizeFromCellSize(cellSize: number | null): FolderCoverSize | null {
  if (cellSize === null) {
    return null;
  }

  if (cellSize <= 16) {
    return "small";
  }

  if (cellSize <= 24) {
    return "medium";
  }

  return "large";
}

function desktopLayoutFits(
  settings: DesktopSettings,
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number
) {
  if (itemCount <= 0) {
    return true;
  }

  const metrics = desktopTileMetrics(settings);
  const usableWidth = Math.max(1, viewportWidth - metrics.paddingX * 2);
  const columns = Math.max(1, Math.floor((usableWidth + metrics.gapX) / (metrics.width + metrics.gapX)));
  const rows = Math.ceil(itemCount / columns);
  const usedColumns = Math.min(itemCount, columns);
  const contentWidth =
    metrics.paddingX * 2 +
    usedColumns * metrics.width +
    Math.max(0, usedColumns - 1) * metrics.gapX;
  const contentHeight = metrics.paddingY * 2 + rows * metrics.height + Math.max(0, rows - 1) * metrics.gapY;

  return contentWidth <= viewportWidth && contentHeight <= viewportHeight;
}
