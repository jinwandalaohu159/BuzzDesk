export type DesktopItemKind = "app" | "file" | "directory" | "system";

export type FolderCoverSize = "small" | "medium" | "large";
export type DesktopLayoutMode = "auto" | "free";
export type AppProcessPriority = "normal" | "aboveNormal" | "high";
export type SettingsView = "main" | "layout" | "system" | "contextMenu";
export type DesktopContextMenuPlacement = "main" | "more" | "hidden";
export type DesktopContextMenuSource = "native" | "action";
export type DesktopSystemIconId =
  | "myComputer"
  | "recycleBin"
  | "network"
  | "controlPanel"
  | "userFiles"
  | "downloads"
  | "documents"
  | "pictures"
  | "music"
  | "videos";
export type DesktopSystemIconSettings = Record<DesktopSystemIconId, boolean>;

export interface DesktopPosition {
  x: number;
  y: number;
}

export interface DesktopSourceItem {
  id: string;
  name: string;
  kind: DesktopItemKind;
  path?: string | null;
  launchId: string;
  iconDataUrl?: string | null;
  isVirtual: boolean;
}

export interface DesktopDiagnostics {
  desktopListViewFound: boolean;
  desktopHostFound: boolean;
  virtualScreenBounds?: WindowBounds | null;
  desktopHostBounds?: WindowBounds | null;
  desktopLayerBounds?: WindowBounds | null;
  shellItemCount?: number | null;
  fallbackItemCount?: number | null;
  lastError?: string | null;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeContextMenuResult {
  invoked: boolean;
  verb?: string | null;
}

export interface NativeContextMenuItem {
  key?: string | null;
  label: string;
  verb?: string | null;
  commandId?: number | null;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: NativeContextMenuItem[];
}

export interface DesktopContextMenuLayoutItem {
  key: string;
  parentKey?: string | null;
  source: DesktopContextMenuSource;
  placement: DesktopContextMenuPlacement;
  order: number;
  group: number;
}

export interface DesktopContextMenuSettings {
  items: DesktopContextMenuLayoutItem[];
}

export type DesktopContextMenuAction =
  | "open"
  | "copy"
  | "paste"
  | "newFolder"
  | "refresh"
  | "rename"
  | "delete"
  | "properties"
  | "settings"
  | "folderRatio"
  | "folderIconSmall"
  | "folderIconMedium"
  | "folderIconLarge";

export interface DesktopSettings {
  layoutMode: DesktopLayoutMode;
  appPriority: AppProcessPriority;
  settingsDarkMode: boolean;
  systemIcons: DesktopSystemIconSettings;
  contextMenu: DesktopContextMenuSettings;
  appIconSize: number;
  desktopGapPx: number;
  desktopPaddingX: number;
  desktopPaddingY: number;
  folderCoverSmallPx: number;
  folderCoverMediumPx: number;
  folderCoverLargePx: number;
}

export interface FolderAppearanceSettings {
  folderCoverSize: FolderCoverSize;
  folderPanelColumns: number;
  folderPanelRows: number;
}

export interface AppNode extends DesktopSourceItem {
  type: "item";
  position?: DesktopPosition | null;
}

export interface FolderNode {
  type: "folder";
  id: string;
  name: string;
  children: AppNode[];
  appearance: FolderAppearanceSettings;
  createdAt: number;
  position?: DesktopPosition | null;
}

export type DesktopNode = AppNode | FolderNode;

export interface PersistedItemNode {
  type: "item";
  id: string;
  name?: string;
  path?: string | null;
  launchId?: string | null;
  position?: DesktopPosition | null;
}

export interface PersistedFolderNode {
  type: "folder";
  id: string;
  name: string;
  children: PersistedItemNode[];
  appearance?: Partial<FolderAppearanceSettings>;
  createdAt: number;
  position?: DesktopPosition | null;
}

export type PersistedNode = PersistedItemNode | PersistedFolderNode;

export interface PersistedDesktopState {
  version: 1;
  nodes: PersistedNode[];
  settings?: Partial<DesktopSettings>;
}

export interface LayoutSlot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
