import type {
  AppNode,
  DesktopContextMenuAction,
  DesktopContextMenuLayoutItem,
  DesktopContextMenuPlacement,
  DesktopContextMenuSettings,
  DesktopContextMenuSource,
  DesktopNode,
  FolderCoverSize,
  NativeContextMenuItem
} from "../types";

export interface ContextMenuItemModel {
  key?: string;
  source?: DesktopContextMenuSource;
  action?: DesktopContextMenuAction;
  nativeCommandId?: number;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: ContextMenuItemModel[];
}

export interface DesktopContextMenuPoolItem {
  key: string;
  parentKey: string | null;
  source: DesktopContextMenuSource;
  label: string;
  group: number;
  order: number;
  submenuCount: number;
  item: ContextMenuItemModel;
}

export interface DesktopContextMenuSettingsItem extends DesktopContextMenuPoolItem {
  placement: DesktopContextMenuPlacement;
  separatorAfter: boolean;
}

const defaultMainNativeLimit = 9;

const desktopActionItems: DesktopContextMenuPoolItem[] = [
  {
    key: "action:refresh",
    parentKey: null,
    source: "action",
    label: "刷新",
    group: 80,
    order: 0,
    submenuCount: 0,
    item: { key: "action:refresh", source: "action", action: "refresh", label: "刷新" }
  },
  {
    key: "action:paste",
    parentKey: null,
    source: "action",
    label: "粘贴",
    group: 80,
    order: 1,
    submenuCount: 0,
    item: { key: "action:paste", source: "action", action: "paste", label: "粘贴" }
  },
  {
    key: "action:newFolder",
    parentKey: null,
    source: "action",
    label: "新建文件夹",
    group: 80,
    order: 2,
    submenuCount: 0,
    item: { key: "action:newFolder", source: "action", action: "newFolder", label: "新建文件夹" }
  },
  {
    key: "action:settings",
    parentKey: null,
    source: "action",
    label: "设置",
    group: 90,
    order: 0,
    submenuCount: 0,
    item: { key: "action:settings", source: "action", action: "settings", label: "设置" }
  }
];

function desktopFallbackMenuItems(): ContextMenuItemModel[] {
  return [
    { key: "action:refresh", source: "action", action: "refresh", label: "刷新" },
    { key: "action:paste", source: "action", action: "paste", label: "粘贴" },
    { key: "action:newFolder", source: "action", action: "newFolder", label: "新建文件夹" },
    { label: "", separator: true },
    { key: "action:settings", source: "action", action: "settings", label: "设置" }
  ];
}

export function desktopContextMenuPool(nativeItems: NativeContextMenuItem[] = [], parentKey: string | null = null) {
  const nativePool = nativeItems.length > 0 ? nativeContextMenuPool(nativeItems, parentKey) : [];
  return parentKey ? nativePool : [...nativePool, ...desktopActionItems];
}

export function desktopContextMenuSettingsItems(
  nativeItems: NativeContextMenuItem[] = [],
  settings: DesktopContextMenuSettings,
  parentKey: string | null = null
): DesktopContextMenuSettingsItem[] {
  const pool = desktopContextMenuPool(nativeItems, parentKey);
  const layout = resolveContextMenuLayout(pool, settings);
  const items = pool
    .map((item) => {
      const layoutItem = layout.get(item.key);
      return {
        ...item,
        placement: layoutItem?.placement ?? "hidden",
        group: layoutItem?.group ?? item.group,
        order: layoutItem?.order ?? item.order,
        separatorAfter: false
      };
    })
    .sort((a, b) => placementRank(a.placement) - placementRank(b.placement) || a.group - b.group || a.order - b.order);

  return items.map((item, index) => ({
    ...item,
    separatorAfter:
      item.placement !== "hidden" &&
      items[index + 1]?.placement === item.placement &&
      items[index + 1].group !== item.group
  }));
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

export function updateContextMenuItemPlacement(
  settings: DesktopContextMenuSettings,
  nativeItems: NativeContextMenuItem[],
  key: string,
  placement: DesktopContextMenuPlacement,
  parentKey: string | null = null
): DesktopContextMenuSettings {
  const pool = desktopContextMenuPool(nativeItems, parentKey);
  const layout = resolveContextMenuLayout(pool, settings);
  const current = layout.get(key);
  const poolItem = pool.find((item) => item.key === key);
  if (!poolItem) {
    return settings;
  }

  layout.set(key, {
    key,
    parentKey,
    source: poolItem.source,
    placement,
    order: current?.placement === placement ? current.order : nextPlacementOrder(layout, placement),
    group: current?.placement === placement ? current.group : targetPlacementGroup(layout, placement, poolItem.group)
  });

  return mergeContextMenuLayout(settings, layout, parentKey);
}

export function toggleContextMenuSeparator(
  settings: DesktopContextMenuSettings,
  nativeItems: NativeContextMenuItem[],
  key: string,
  parentKey: string | null = null
): DesktopContextMenuSettings {
  const pool = desktopContextMenuPool(nativeItems, parentKey);
  const layout = resolveContextMenuLayout(pool, settings);
  const current = layout.get(key);
  if (!current || current.placement === "hidden") {
    return settings;
  }

  const peers = [...layout.values()]
    .filter((item) => item.placement === current.placement)
    .sort(compareLayoutItems);
  const index = peers.findIndex((item) => item.key === key);
  if (index < 0 || index >= peers.length - 1) {
    return settings;
  }

  const breaks = separatorBreakKeys(peers);

  if (breaks.has(key)) {
    breaks.delete(key);
  } else {
    breaks.add(key);
  }

  writeOrderedPeers(layout, peers, breaks);

  return mergeContextMenuLayout(settings, layout, parentKey);
}

export function reorderContextMenuItem(
  settings: DesktopContextMenuSettings,
  nativeItems: NativeContextMenuItem[],
  key: string,
  targetKey: string | null,
  placement: Exclude<DesktopContextMenuPlacement, "hidden">,
  position: "before" | "after" | "end",
  parentKey: string | null = null
): DesktopContextMenuSettings {
  const pool = desktopContextMenuPool(nativeItems, parentKey);
  const layout = resolveContextMenuLayout(pool, settings);
  const dragged = layout.get(key);
  if (!dragged || dragged.placement !== placement) {
    return settings;
  }

  const peers = [...layout.values()]
    .filter((item) => item.placement === placement)
    .sort(compareLayoutItems);
  const breaks = separatorBreakKeys(peers);
  const draggedIndex = peers.findIndex((item) => item.key === key);
  if (draggedIndex < 0) {
    return settings;
  }

  const [draggedItem] = peers.splice(draggedIndex, 1);
  let targetIndex = targetKey ? peers.findIndex((item) => item.key === targetKey) : peers.length;
  if (targetIndex < 0) {
    targetIndex = peers.length;
  }

  const insertIndex = position === "after" ? targetIndex + 1 : position === "before" ? targetIndex : peers.length;
  peers.splice(Math.min(peers.length, insertIndex), 0, draggedItem);
  writeOrderedPeers(layout, peers, breaks);
  return mergeContextMenuLayout(settings, layout, parentKey);
}

export function resetContextMenuSettings(): DesktopContextMenuSettings {
  return { items: [] };
}

function nativeContextMenuPool(nativeItems: NativeContextMenuItem[], parentKey: string | null) {
  let group = 0;
  let order = 0;
  const pool: DesktopContextMenuPoolItem[] = [];
  const items = parentKey ? findNativeContextMenuItem(nativeItems, parentKey)?.submenu ?? [] : nativeItems;

  items.forEach((item) => {
    if (item.separator) {
      group += 1;
      order = 0;
      return;
    }

    const model = nativeContextMenuItem(item);
    if (!model.label && !model.submenu?.length) {
      return;
    }

    pool.push({
      key: model.key ?? nativeContextMenuItemKey(item),
      parentKey,
      source: "native",
      label: model.label,
      group,
      order,
      submenuCount: model.submenu?.filter((child) => !child.separator).length ?? 0,
      item: model
    });
    order += 1;
  });

  return pool;
}

function nativeContextMenuItem(item: NativeContextMenuItem): ContextMenuItemModel {
  const key = nativeContextMenuItemKey(item);
  return {
    key,
    source: "native",
    label: item.label,
    nativeCommandId: item.commandId ?? undefined,
    disabled: item.disabled,
    checked: item.checked,
    separator: item.separator,
    submenu: item.submenu?.map(nativeContextMenuItem)
  };
}

function nativeContextMenuItemKey(item: NativeContextMenuItem) {
  if (item.key) {
    return item.key;
  }

  if (item.verb) {
    return `native:verb:${item.verb}`;
  }

  return `native:label:${item.label}`;
}

function findNativeContextMenuItem(items: NativeContextMenuItem[], key: string): NativeContextMenuItem | null {
  for (const item of items) {
    if (!item.separator && nativeContextMenuItemKey(item) === key) {
      return item;
    }

    const match = item.submenu?.length ? findNativeContextMenuItem(item.submenu, key) : null;
    if (match) {
      return match;
    }
  }

  return null;
}

function resolveContextMenuLayout(
  pool: DesktopContextMenuPoolItem[],
  settings?: DesktopContextMenuSettings
) {
  const hasSavedItems = Boolean(settings?.items.length);
  const saved = new Map((settings?.items ?? []).map((item) => [contextMenuLayoutMapKey(item.parentKey ?? null, item.key), item]));
  const layout = new Map<string, DesktopContextMenuLayoutItem>();
  let visibleNativeCount = 0;

  pool.forEach((item) => {
    const savedItem = saved.get(contextMenuLayoutMapKey(item.parentKey, item.key));
    const defaultPlacement = defaultContextMenuPlacement(item, visibleNativeCount);
    if (item.source === "native" && !item.parentKey) {
      visibleNativeCount += 1;
    }
    layout.set(item.key, savedItem ?? {
      key: item.key,
      parentKey: item.parentKey,
      source: item.source,
      placement: defaultPlacement,
      order: hasSavedItems ? nextPlacementOrder(layout, defaultPlacement) : item.order,
      group: item.group
    });
  });

  return layout;
}

function defaultContextMenuPlacement(
  item: DesktopContextMenuPoolItem,
  visibleNativeCount = 0
): DesktopContextMenuPlacement {
  if (item.parentKey) {
    return "main";
  }

  if (item.source === "native") {
    return visibleNativeCount < defaultMainNativeLimit ? "main" : "more";
  }

  return item.key === "action:settings" ? "main" : "hidden";
}

function contextMenuLayoutMapKey(parentKey: string | null, key: string) {
  return `${parentKey ?? ""}\u0000${key}`;
}

function mergeContextMenuLayout(
  settings: DesktopContextMenuSettings,
  layout: ReadonlyMap<string, DesktopContextMenuLayoutItem>,
  parentKey: string | null
): DesktopContextMenuSettings {
  const items = settings.items.filter((item) => (item.parentKey ?? null) !== parentKey);
  return { items: [...items, ...layout.values()] };
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

function nextPlacementOrder(
  layout: ReadonlyMap<string, DesktopContextMenuLayoutItem>,
  placement: DesktopContextMenuPlacement
) {
  const orders = [...layout.values()]
    .filter((item) => item.placement === placement)
    .map((item) => item.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

function targetPlacementGroup(
  layout: ReadonlyMap<string, DesktopContextMenuLayoutItem>,
  placement: DesktopContextMenuPlacement,
  fallback: number
) {
  const groups = [...layout.values()]
    .filter((item) => item.placement === placement)
    .map((item) => item.group);
  return groups.length === 0 ? fallback : Math.max(...groups);
}

function separatorBreakKeys(items: DesktopContextMenuLayoutItem[]) {
  const breaks = new Set<string>();
  for (let index = 0; index < items.length - 1; index += 1) {
    if (items[index + 1].group !== items[index].group) {
      breaks.add(items[index].key);
    }
  }
  return breaks;
}

function writeOrderedPeers(
  layout: Map<string, DesktopContextMenuLayoutItem>,
  peers: DesktopContextMenuLayoutItem[],
  breaks: ReadonlySet<string>
) {
  let group = 0;
  peers.forEach((item, index) => {
    item.group = group;
    item.order = index;
    layout.set(item.key, item);
    if (breaks.has(item.key)) {
      group += 1;
    }
  });
}

function compareLayoutItems(a: DesktopContextMenuLayoutItem, b: DesktopContextMenuLayoutItem) {
  return a.group - b.group || a.order - b.order || a.key.localeCompare(b.key);
}

function placementRank(placement: DesktopContextMenuPlacement) {
  if (placement === "main") {
    return 0;
  }
  if (placement === "more") {
    return 1;
  }
  return 2;
}

function collapseMenuSeparators(items: ContextMenuItemModel[]) {
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
