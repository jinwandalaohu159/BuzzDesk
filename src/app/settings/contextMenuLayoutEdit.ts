import type {
  DesktopContextMenuLayoutItem,
  DesktopContextMenuPlacement,
  DesktopContextMenuSettings,
  NativeContextMenuItem
} from "../../types";
import {
  type DesktopContextMenuSettingsItem,
  desktopContextMenuPool,
  resolveContextMenuLayout,
  contextMenuLayoutMapKey,
  nextPlacementOrder,
  compareLayoutItems,
  placementRank
} from "../overlay/contextMenuLayout";

// Editing the desktop context-menu layout from settings: moving entries
// between the main menu / submenu / hidden, reordering and separators.

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

// Writes the edited layout back. Saved entries the current pool doesn't contain
// are kept: the Windows menu may not be loaded yet (or may lack an item right
// now), and editing must never throw away the user's placements for it.
function mergeContextMenuLayout(
  settings: DesktopContextMenuSettings,
  layout: ReadonlyMap<string, DesktopContextMenuLayoutItem>,
  parentKey: string | null
): DesktopContextMenuSettings {
  const edited = new Set([...layout.values()].map((item) => contextMenuLayoutMapKey(item.parentKey ?? parentKey, item.key)));
  const kept = settings.items.filter((item) => !edited.has(contextMenuLayoutMapKey(item.parentKey ?? null, item.key)));
  return { items: [...kept, ...layout.values()] };
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
