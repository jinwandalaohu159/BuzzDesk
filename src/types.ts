export type DesktopItemKind = "app" | "file" | "directory" | "system";

export type FolderCoverSize = "small" | "medium" | "large";

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
  shellItemCount?: number | null;
  fallbackItemCount?: number | null;
  lastError?: string | null;
}

export interface NativeContextMenuResult {
  invoked: boolean;
  verb?: string | null;
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
  | "folderRatio"
  | "folderIconSmall"
  | "folderIconMedium"
  | "folderIconLarge";

export interface DesktopSettings {
  appIconSize: number;
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
}

export interface FolderNode {
  type: "folder";
  id: string;
  name: string;
  children: AppNode[];
  appearance: FolderAppearanceSettings;
  createdAt: number;
}

export type DesktopNode = AppNode | FolderNode;

export interface PersistedItemNode {
  type: "item";
  id: string;
  name?: string;
  path?: string | null;
  launchId?: string | null;
}

export interface PersistedFolderNode {
  type: "folder";
  id: string;
  name: string;
  children: PersistedItemNode[];
  appearance?: Partial<FolderAppearanceSettings>;
  createdAt: number;
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
