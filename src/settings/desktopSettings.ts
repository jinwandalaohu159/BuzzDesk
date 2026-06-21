import type { DesktopSettings, FolderAppearanceSettings } from "../types";

export const defaultDesktopSettings: DesktopSettings = {
  appIconSize: 60,
  folderCoverCellSize: 14,
  folderPanelColumns: 3,
  folderPanelRows: 3
};

export const defaultFolderAppearance: FolderAppearanceSettings = folderAppearanceFromSettings(defaultDesktopSettings);

export function createDefaultFolderAppearance(): FolderAppearanceSettings {
  return { ...defaultFolderAppearance };
}

export function normalizeDesktopSettings(settings?: Partial<DesktopSettings> | null): DesktopSettings {
  return {
    appIconSize: clampNumber(settings?.appIconSize, 48, 76, defaultDesktopSettings.appIconSize),
    folderCoverCellSize: clampNumber(
      settings?.folderCoverCellSize,
      10,
      22,
      defaultDesktopSettings.folderCoverCellSize
    ),
    folderPanelColumns: clampNumber(settings?.folderPanelColumns, 2, 6, defaultDesktopSettings.folderPanelColumns),
    folderPanelRows: clampNumber(settings?.folderPanelRows, 2, 6, defaultDesktopSettings.folderPanelRows)
  };
}

export function folderAppearanceFromSettings(settings: DesktopSettings): FolderAppearanceSettings {
  return {
    folderCoverCellSize: settings.folderCoverCellSize,
    folderPanelColumns: settings.folderPanelColumns,
    folderPanelRows: settings.folderPanelRows
  };
}

export function normalizeFolderAppearance(
  appearance?: Partial<FolderAppearanceSettings> | null,
  fallback: FolderAppearanceSettings = defaultFolderAppearance
): FolderAppearanceSettings {
  return {
    folderCoverCellSize: clampNumber(
      appearance?.folderCoverCellSize,
      10,
      22,
      fallback.folderCoverCellSize
    ),
    folderPanelColumns: clampNumber(appearance?.folderPanelColumns, 2, 6, fallback.folderPanelColumns),
    folderPanelRows: clampNumber(appearance?.folderPanelRows, 2, 6, fallback.folderPanelRows)
  };
}

export function applyDesktopSettings(settings: DesktopSettings) {
  const root = document.documentElement;
  const tile = desktopTileMetrics(settings);
  const folderCoverVariables = folderCoverCssVariables(settings, folderAppearanceFromSettings(settings));

  root.style.setProperty("--app-icon-size", `${settings.appIconSize}px`);
  root.style.setProperty("--app-icon-radius", `${Math.max(3, Math.round(settings.appIconSize * 0.23))}px`);
  root.style.setProperty("--desktop-icon-shell-size", `${tile.iconShellSize}px`);
  root.style.setProperty("--tile-name-font-size", `${tile.labelFontSize}px`);
  root.style.setProperty("--tile-name-line-height", `${tile.labelLineHeight}px`);
  root.style.setProperty("--tile-name-max-height", `${tile.labelMaxHeight}px`);
  for (const [key, value] of Object.entries(folderCoverVariables)) {
    root.style.setProperty(key, value);
  }
}

export function folderCoverCssVariables(
  settings: DesktopSettings,
  appearance: FolderAppearanceSettings
): Record<string, string> {
  const tile = desktopTileMetrics(settings);
  const normalized = normalizeFolderAppearance(appearance, folderAppearanceFromSettings(settings));
  const coverGap = Math.max(2, Math.round(normalized.folderCoverCellSize * 0.18));
  const coverPadding = Math.max(4, Math.round(normalized.folderCoverCellSize * 0.42));
  const rawCoverWidth =
    normalized.folderPanelColumns * normalized.folderCoverCellSize +
    (normalized.folderPanelColumns - 1) * coverGap +
    coverPadding * 2;
  const rawCoverHeight =
    normalized.folderPanelRows * normalized.folderCoverCellSize +
    (normalized.folderPanelRows - 1) * coverGap +
    coverPadding * 2;
  const folderCoverScale = Math.min(1, (tile.iconShellSize - 2) / Math.max(rawCoverWidth, rawCoverHeight));
  const scaledCellSize = Math.max(6, Math.round(normalized.folderCoverCellSize * folderCoverScale));
  const scaledGap = Math.max(1, Math.round(coverGap * folderCoverScale));
  const scaledPadding = Math.max(3, Math.round(coverPadding * folderCoverScale));

  return {
    "--folder-cover-width": `${Math.round(rawCoverWidth * folderCoverScale)}px`,
    "--folder-cover-height": `${Math.round(rawCoverHeight * folderCoverScale)}px`,
    "--folder-cover-mini-icon-size": `${scaledCellSize}px`,
    "--folder-cover-padding-x": `${scaledPadding}px`,
    "--folder-cover-padding-y": `${scaledPadding}px`,
    "--folder-cover-gap": `${scaledGap}px`,
    "--folder-cover-icon-radius": `${Math.max(3, Math.round(scaledCellSize * 0.26))}px`,
    "--folder-cover-columns": `${normalized.folderPanelColumns}`,
    "--folder-cover-rows": `${normalized.folderPanelRows}`
  };
}

export function fitDesktopSettings(
  settings: DesktopSettings,
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number
) {
  let appIconSize = settings.appIconSize;

  while (appIconSize > 12 && !desktopLayoutFits(appIconSize, itemCount, viewportWidth, viewportHeight)) {
    appIconSize -= 2;
  }

  return { ...settings, appIconSize };
}

export function desktopTileMetrics(settings: DesktopSettings) {
  const compactness = Math.max(0, Math.min(1, (36 - settings.appIconSize) / 20));
  const iconShellSize = Math.round(Math.max(22, settings.appIconSize + 8 - compactness * 4));
  const labelFontSize = Math.round(12 - compactness * 2);
  const labelLineHeight = Math.round(16 - compactness * 4);
  const labelLines = settings.appIconSize <= 20 ? 1 : 2;
  const labelMaxHeight = labelLineHeight * labelLines;
  const width = Math.round(Math.max(48, iconShellSize + 42 - compactness * 18));
  const height = Math.round(Math.max(58, iconShellSize + labelMaxHeight + 22 - compactness * 12));
  const gapX = Math.max(2, Math.round(settings.appIconSize * 0.18 - compactness * 2));
  const gapY = Math.max(2, Math.round(settings.appIconSize * 0.2 - compactness * 2));
  const paddingX = Math.max(4, Math.min(28, Math.round(settings.appIconSize * 0.46 - compactness * 4)));
  const paddingY = Math.max(4, Math.min(32, Math.round(settings.appIconSize * 0.52 - compactness * 5)));

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

function desktopLayoutFits(
  appIconSize: number,
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number
) {
  if (itemCount <= 0) {
    return true;
  }

  const metrics = desktopTileMetrics({ ...defaultDesktopSettings, appIconSize });
  const usableWidth = Math.max(1, viewportWidth - metrics.paddingX * 2);
  const columns = Math.max(1, Math.floor((usableWidth + metrics.gapX) / (metrics.width + metrics.gapX)));
  const rows = Math.ceil(itemCount / columns);
  const contentHeight = metrics.paddingY * 2 + rows * metrics.height + Math.max(0, rows - 1) * metrics.gapY;

  return contentHeight <= viewportHeight;
}
