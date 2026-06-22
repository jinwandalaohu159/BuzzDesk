import type { DesktopContextMenuAction, DesktopNode, AppNode, FolderCoverSize } from "../types";

export interface ContextMenuItemModel {
  action: DesktopContextMenuAction;
  label: string;
  disabled?: boolean;
  checked?: boolean;
}

export function desktopFallbackMenuItems(): ContextMenuItemModel[] {
  return [
    { action: "refresh", label: "刷新" },
    { action: "paste", label: "粘贴" },
    { action: "newFolder", label: "新建文件夹" }
  ];
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
    { action: "folderRatio" as const, label: "比例" },
    { action: "folderIconSmall" as const, label: "图标小", checked: currentCoverSize === "small" },
    { action: "folderIconMedium" as const, label: "图标中", checked: currentCoverSize === "medium" },
    { action: "folderIconLarge" as const, label: "图标大", checked: currentCoverSize === "large" },
    {
      action: "delete" as const,
      label: "解散文件夹"
    }
  ];
}
