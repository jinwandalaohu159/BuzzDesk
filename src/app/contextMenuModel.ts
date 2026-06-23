import type { DesktopContextMenuAction, DesktopNode, AppNode, FolderCoverSize, NativeContextMenuItem } from "../types";

export interface ContextMenuItemModel {
  action?: DesktopContextMenuAction;
  nativeCommandId?: number;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: ContextMenuItemModel[];
}

function desktopFallbackMenuItems(): ContextMenuItemModel[] {
  return [
    { action: "refresh", label: "刷新" },
    { action: "paste", label: "粘贴" },
    { action: "newFolder", label: "新建文件夹" }
  ];
}

export function desktopMenuItems(nativeItems: NativeContextMenuItem[] = []): ContextMenuItemModel[] {
  const items = nativeItems.length > 0
    ? nativeItems.map(nativeContextMenuItem)
    : desktopFallbackMenuItems();

  return [
    ...items,
    { label: "", separator: true },
    { action: "settings", label: "设置" }
  ];
}

function nativeContextMenuItem(item: NativeContextMenuItem): ContextMenuItemModel {
  return {
    label: item.label,
    nativeCommandId: item.commandId ?? undefined,
    disabled: item.disabled,
    checked: item.checked,
    separator: item.separator,
    submenu: item.submenu?.map(nativeContextMenuItem)
  };
}

export function itemFallbackMenuItems(node: DesktopNode | AppNode | null, context: "desktop" | "folder") {
  const isVirtualFolder = context === "desktop" && node?.type === "folder";
  const isRealFileItem = node?.type === "item" && Boolean(node.path);
  const isFolderChild = context === "folder";

  const items: ContextMenuItemModel[] = [
    { action: "open" as const, label: "打开", disabled: !node },
    { action: "copy" as const, label: "复制", disabled: !isRealFileItem },
    {
      action: "rename" as const,
      label: "重命名",
      disabled: isFolderChild || (!isRealFileItem && !isVirtualFolder)
    },
    {
      action: "delete" as const,
      label: isFolderChild ? "移出文件夹" : isVirtualFolder ? "解散文件夹" : "删除",
      disabled: isFolderChild ? !node : !isRealFileItem && !isVirtualFolder
    },
    {
      action: "properties" as const,
      label: "属性",
      disabled: node?.type !== "item"
    },
    { action: "refresh" as const, label: "刷新" }
  ];

  return items;
}

export function folderContextMenuItems(currentCoverSize: FolderCoverSize): ContextMenuItemModel[] {
  return [
    { action: "rename" as const, label: "重命名" },
    { action: "folderRatio" as const, label: "布局" },
    {
      label: "图标大小",
      submenu: [
        { action: "folderIconSmall" as const, label: "小", checked: currentCoverSize === "small" },
        { action: "folderIconMedium" as const, label: "中", checked: currentCoverSize === "medium" },
        { action: "folderIconLarge" as const, label: "大", checked: currentCoverSize === "large" }
      ]
    },
    {
      action: "delete" as const,
      label: "解散"
    }
  ];
}
