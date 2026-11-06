// Type guards for values read back from DOM datasets and settings controls.
import type {
  AppProcessPriority,
  DesktopContextMenuPlacement,
  DesktopSettings,
  SettingsView
} from "../../types";

export function isNavigationKey(key: string) {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End";
}

export type NumericDesktopSettingKey = Exclude<
  keyof DesktopSettings,
  "layoutMode" | "appPriority" | "settingsDarkMode" | "startWithWindows" | "autoUpdate" | "systemIcons" | "contextMenu"
>;

export function isDesktopSettingKey(key: string): key is NumericDesktopSettingKey {
  return (
    key === "appIconSize" ||
    key === "desktopGapPx" ||
    key === "desktopPaddingX" ||
    key === "desktopPaddingY" ||
    key === "folderCoverSmallPx" ||
    key === "folderCoverMediumPx" ||
    key === "folderCoverLargePx"
  );
}

export function isAppProcessPriority(value: unknown): value is AppProcessPriority {
  return value === "normal" || value === "aboveNormal" || value === "high" || value === "realtime";
}

export function isContextMenuPlacement(value: unknown): value is DesktopContextMenuPlacement {
  return value === "main" || value === "more" || value === "hidden";
}

export function isEditableContextMenuPlacement(value: unknown): value is Exclude<DesktopContextMenuPlacement, "hidden"> {
  return value === "main" || value === "more";
}

export function isSettingsView(value: unknown): value is SettingsView {
  return value === "main" || value === "layout" || value === "system" || value === "contextMenu";
}

export function nextGridIndex(key: string, currentIndex: number, itemCount: number, columns: number) {
  const lastIndex = Math.max(0, itemCount - 1);
  const safeColumns = Math.max(1, columns);

  if (currentIndex < 0) {
    return key === "End" ? lastIndex : 0;
  }

  switch (key) {
    case "ArrowLeft":
      return Math.max(0, currentIndex - 1);
    case "ArrowRight":
      return Math.min(lastIndex, currentIndex + 1);
    case "ArrowUp":
      return Math.max(0, currentIndex - safeColumns);
    case "ArrowDown":
      return Math.min(lastIndex, currentIndex + safeColumns);
    case "Home":
      return 0;
    case "End":
      return lastIndex;
    default:
      return currentIndex;
  }
}
