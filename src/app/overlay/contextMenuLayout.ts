import type {
  DesktopContextMenuAction,
  DesktopContextMenuLayoutItem,
  DesktopContextMenuPlacement,
  DesktopContextMenuSettings,
  DesktopContextMenuSource,
  NativeContextMenuItem
} from "../../types";

// The pool of desktop context-menu entries (app actions + the Windows menu)
// and how the saved layout places each of them.

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

export const desktopActionItems: DesktopContextMenuPoolItem[] = [
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
    key: "action:autoArrange",
    parentKey: null,
    source: "action",
    label: "\u81ea\u52a8\u6392\u5217",
    group: 85,
    order: 0,
    submenuCount: 0,
    item: { key: "action:autoArrange", source: "action", action: "autoArrange", label: "\u81ea\u52a8\u6392\u5217" }
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

export function desktopContextMenuPool(nativeItems: NativeContextMenuItem[] = [], parentKey: string | null = null) {
  const nativePool = nativeItems.length > 0 ? nativeContextMenuPool(nativeItems, parentKey) : [];
  return parentKey ? nativePool : [...nativePool, ...desktopActionItems];
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

export function resolveContextMenuLayout(
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
    // Copy saved entries: callers reorder the layout in place, and the saved
    // settings must only change through updateSettings.
    layout.set(item.key, savedItem ? { ...savedItem } : {
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

  return item.key === "action:settings" || item.key === "action:autoArrange" ? "main" : "hidden";
}

export function contextMenuLayoutMapKey(parentKey: string | null, key: string) {
  return `${parentKey ?? ""}\u0000${key}`;
}

export function nextPlacementOrder(
  layout: ReadonlyMap<string, DesktopContextMenuLayoutItem>,
  placement: DesktopContextMenuPlacement
) {
  const orders = [...layout.values()]
    .filter((item) => item.placement === placement)
    .map((item) => item.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

export function compareLayoutItems(a: DesktopContextMenuLayoutItem, b: DesktopContextMenuLayoutItem) {
  return a.group - b.group || a.order - b.order || a.key.localeCompare(b.key);
}

export function placementRank(placement: DesktopContextMenuPlacement) {
  if (placement === "main") {
    return 0;
  }
  if (placement === "more") {
    return 1;
  }
  return 2;
}
