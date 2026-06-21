import type { DesktopContextMenuAction, DesktopNode, AppNode } from "../types";

export interface ContextMenuItemModel {
  action: DesktopContextMenuAction;
  label: string;
  disabled?: boolean;
}

export function desktopFallbackMenuItems(): ContextMenuItemModel[] {
  return [
    { action: "refresh", label: "\u5237\u65b0" },
    { action: "paste", label: "\u7c98\u8d34" },
    { action: "newFolder", label: "\u65b0\u5efa\u6587\u4ef6\u5939" }
  ];
}

export function itemFallbackMenuItems(node: DesktopNode | AppNode | null, context: "desktop" | "folder") {
  const isVirtualFolder = context === "desktop" && node?.type === "folder";
  const isRealFileItem = node?.type === "item" && Boolean(node.path);

  const items: ContextMenuItemModel[] = [
    { action: "open" as const, label: "\u6253\u5f00", disabled: !node },
    { action: "copy" as const, label: "\u590d\u5236", disabled: !isRealFileItem },
    {
      action: "rename" as const,
      label: "\u91cd\u547d\u540d",
      disabled: !isRealFileItem && !isVirtualFolder
    },
    {
      action: "delete" as const,
      label: isVirtualFolder ? "\u89e3\u6563\u6587\u4ef6\u5939" : "\u5220\u9664",
      disabled: !isRealFileItem && !isVirtualFolder
    },
    {
      action: "properties" as const,
      label: "\u5c5e\u6027",
      disabled: node?.type !== "item"
    },
    { action: "refresh" as const, label: "\u5237\u65b0" }
  ];

  if (isVirtualFolder) {
    items.splice(1, 0, {
      action: "folderAppearance",
      label: "\u6587\u4ef6\u5939\u5916\u89c2"
    });
  }

  return items;
}
