import type {
  AppNode,
  DesktopContextMenuLayoutItem,
  DesktopContextMenuPlacement,
  DesktopContextMenuSettings,
  DesktopNode,
  FolderCoverSize,
  NativeContextMenuItem
} from "../../types";
import {
  type ContextMenuItemModel,
  type DesktopContextMenuPoolItem,
  desktopActionItems,
  desktopContextMenuPool,
  resolveContextMenuLayout,
  compareLayoutItems
} from "./contextMenuLayout";

// Menus as shown: the desktop menu built from the pool and the saved layout,
// and the fixed menus for items and folders.

// Without the Windows menu: every app action, settings set apart at the end.
function desktopFallbackMenuItems(): ContextMenuItemModel[] {
  const actions = desktopActionItems.filter((entry) => entry.key !== "action:settings").map((entry) => ({ ...entry.item }));
  const settings = desktopActionItems.find((entry) => entry.key === "action:settings");
  return settings ? [...actions, { label: "", separator: true }, { ...settings.item }] : actions;
}

export function desktopMenuItems(
  nativeItems: NativeContextMenuItem[] = [],
  settings?: DesktopContextMenuSettings
): ContextMenuItemModel[] {
  if (nativeItems.length === 0) {
    return desktopFallbackMenuItems();
  }

  return menuItemsForParent(nativeItems, settings, null);
}

function menuItemsForParent(
  nativeItems: NativeContextMenuItem[],
  settings: DesktopContextMenuSettings | undefined,
  parentKey: string | null
): ContextMenuItemModel[] {
  const pool = desktopContextMenuPool(nativeItems, parentKey);
  const layout = resolveContextMenuLayout(pool, settings);
  const mainItems = menuItemsForPlacement(pool, layout, "main", nativeItems, settings);
  const moreItems = menuItemsForPlacement(pool, layout, "more", nativeItems, settings);

  if (moreItems.length > 0) {
    if (mainItems.length > 0 && !mainItems[mainItems.length - 1]?.separator) {
      mainItems.push({ label: "", separator: true });
    }
    mainItems.push({
      key: "action:showMore",
      source: "action",
      label: "显示更多选项",
      submenu: moreItems
    });
  }

  return collapseMenuSeparators(mainItems);
}

function menuItemsForPlacement(
  pool: DesktopContextMenuPoolItem[],
  layout: ReadonlyMap<string, DesktopContextMenuLayoutItem>,
  placement: DesktopContextMenuPlacement,
  nativeItems: NativeContextMenuItem[],
  settings?: DesktopContextMenuSettings
) {
  const byKey = new Map(pool.map((item) => [item.key, item]));
  const items = [...layout.values()]
    .filter((item) => item.placement === placement)
    .sort(compareLayoutItems)
    .map((layoutItem) => ({ layoutItem, poolItem: byKey.get(layoutItem.key) }))
    .filter((item): item is { layoutItem: DesktopContextMenuLayoutItem; poolItem: DesktopContextMenuPoolItem } =>
      Boolean(item.poolItem)
    );

  const result: ContextMenuItemModel[] = [];
  let previousGroup: number | null = null;
  items.forEach((item) => {
    if (previousGroup !== null && previousGroup !== item.layoutItem.group) {
      result.push({ label: "", separator: true });
    }
    result.push(contextMenuItemForPoolItem(item.poolItem, nativeItems, settings));
    previousGroup = item.layoutItem.group;
  });

  return collapseMenuSeparators(result);
}

function contextMenuItemForPoolItem(
  poolItem: DesktopContextMenuPoolItem,
  nativeItems: NativeContextMenuItem[],
  settings?: DesktopContextMenuSettings
) {
  const { submenu: _unusedSubmenu, ...item } = poolItem.item;
  if (poolItem.source === "native" && poolItem.submenuCount > 0) {
    return {
      ...item,
      submenu: menuItemsForParent(nativeItems, settings, poolItem.key)
    };
  }
  return item;
}

// Drops leading, trailing and doubled separators.
export function collapseMenuSeparators(items: ContextMenuItemModel[]) {
  const collapsed: ContextMenuItemModel[] = [];
  let previousSeparator = true;

  items.forEach((item) => {
    if (item.separator) {
      if (!previousSeparator) {
        collapsed.push(item);
      }
      previousSeparator = true;
      return;
    }

    collapsed.push(item);
    previousSeparator = false;
  });

  while (collapsed[collapsed.length - 1]?.separator) {
    collapsed.pop();
  }

  return collapsed;
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

export function folderContextMenuItems(
  currentCoverSize: FolderCoverSize,
  compactPlacement: boolean
): ContextMenuItemModel[] {
  return [
    { action: "rename" as const, label: "重命名" },
    { action: "folderRatio" as const, label: "布局" },
    { action: "folderCompactPlacement" as const, label: "紧凑贴边", checked: compactPlacement },
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
