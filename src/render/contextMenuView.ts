import type { DesktopContextMenuAction } from "../types";

// Context menu markup and its placement math (submenus, clamping, access keys).

export function renderContextMenu(options: {
  x: number;
  y: number;
  items: RenderContextMenuItem[];
  bounds?: ContextMenuBounds;
}) {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  const width = 216;
  const submenuWidth = 220;
  const submenuGap = 4;
  const bounds = options.bounds ?? defaultContextMenuBounds();
  const metrics = contextMenuMetrics(bounds);
  const height = estimateContextMenuHeight(options.items, metrics);
  const hasSubmenu = options.items.some((item) => item.submenu?.length);
  const submenuReserve = hasSubmenu ? submenuWidth + submenuGap : 0;
  const maxLeftWithSubmenu = bounds.right - width - submenuReserve;
  const maxLeft = maxLeftWithSubmenu >= bounds.left ? maxLeftWithSubmenu : bounds.right - width;
  const top = clampNumber(options.y, bounds.top, Math.max(bounds.top, bounds.bottom - height));
  menu.style.width = `${width}px`;
  menu.style.left = `${clampNumber(options.x, bounds.left, Math.max(bounds.left, maxLeft))}px`;
  menu.style.top = `${top}px`;

  let itemOffset = metrics.padding;
  options.items.forEach((item) => {
    if (item.separator) {
      const separator = document.createElement("div");
      separator.className = "context-menu-separator";
      menu.append(separator);
      itemOffset += metrics.separatorHeight + metrics.gap;
      return;
    }

    const itemElement = document.createElement("div");
    itemElement.className = "context-menu-item";
    itemElement.append(renderContextMenuButton(item, Boolean(item.submenu?.length)));

    if (item.submenu?.length) {
      const submenu = document.createElement("div");
      submenu.className = "context-submenu";
      submenu.style.width = `${submenuWidth}px`;
      submenu.style.maxHeight = `${metrics.submenuMaxHeight}px`;
      submenu.style.top = `${submenuTop(top + itemOffset, item.submenu, metrics, bounds)}px`;
      itemElement.classList.add("has-submenu");
      item.submenu.forEach((child) => {
        submenu.append(renderContextMenuNestedItem(child, submenuWidth, metrics));
      });
      itemElement.append(submenu);
    }

    menu.append(itemElement);
    itemOffset += metrics.rowHeight + metrics.gap;
  });

  return menu;
}

function renderContextMenuNestedItem(
  item: RenderContextMenuItem,
  submenuWidth: number,
  metrics: ReturnType<typeof contextMenuMetrics>
) {
  if (item.separator) {
    const separator = document.createElement("div");
    separator.className = "context-menu-separator";
    return separator;
  }

  const itemElement = document.createElement("div");
  itemElement.className = "context-menu-item";
  itemElement.append(renderContextMenuButton(item, Boolean(item.submenu?.length)));

  if (item.submenu?.length) {
    const submenu = document.createElement("div");
    submenu.className = "context-submenu is-floating";
    submenu.style.width = `${submenuWidth}px`;
    submenu.style.maxHeight = `${metrics.submenuMaxHeight}px`;
    submenu.style.top = `${-metrics.padding}px`;
    itemElement.classList.add("has-submenu");
    item.submenu.forEach((child) => {
      submenu.append(renderContextMenuNestedItem(child, submenuWidth, metrics));
    });
    itemElement.append(submenu);
  }

  return itemElement;
}

interface ContextMenuBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function defaultContextMenuBounds(): ContextMenuBounds {
  return {
    left: 8,
    top: 8,
    right: Math.max(8, window.innerWidth - 8),
    bottom: Math.max(8, window.innerHeight - 8)
  };
}

function contextMenuMetrics(bounds = defaultContextMenuBounds()) {
  return {
    padding: 8,
    rowHeight: 36,
    separatorHeight: 11,
    gap: 3,
    viewportEdge: 8,
    submenuMaxHeight: Math.min((bounds.bottom - bounds.top) * 0.68, 460)
  };
}

function estimateContextMenuHeight(items: RenderContextMenuItem[], metrics = contextMenuMetrics()) {
  if (items.length === 0) {
    return 44;
  }

  const contentHeight = items.reduce(
    (height, item) => height + (item.separator ? metrics.separatorHeight : metrics.rowHeight),
    0
  );
  return Math.max(44, metrics.padding * 2 + contentHeight + Math.max(0, items.length - 1) * metrics.gap);
}

function submenuTop(
  parentTop: number,
  items: RenderContextMenuItem[],
  metrics = contextMenuMetrics(),
  bounds = defaultContextMenuBounds()
) {
  const estimatedHeight = Math.min(estimateContextMenuHeight(items, metrics), metrics.submenuMaxHeight);
  const defaultTop = -metrics.padding;
  const minTop = bounds.top - parentTop;
  const maxTop = bounds.bottom - estimatedHeight - parentTop;
  return Math.max(minTop, Math.min(defaultTop, maxTop));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

interface RenderContextMenuItem {
  action?: DesktopContextMenuAction;
  nativeCommandId?: number;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: RenderContextMenuItem[];
}

function renderContextMenuButton(item: RenderContextMenuItem, hasSubmenu = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = Boolean(item.disabled);

  if (item.action) {
    button.dataset.contextAction = item.action;
  }

  if (item.nativeCommandId !== undefined) {
    button.dataset.nativeCommandId = String(item.nativeCommandId);
  }

  if (hasSubmenu) {
    button.dataset.contextSubmenu = "true";
    button.classList.add("has-submenu");
  }

  const accessKey = contextMenuAccessKey(item.label);
  if (accessKey) {
    button.dataset.contextAccessKey = accessKey;
  }

  if (item.checked) {
    button.classList.add("is-checked");
  }

  const label = document.createElement("span");
  label.className = "context-menu-label";
  label.textContent = item.checked ? `\u2713 ${item.label}` : item.label;
  button.append(label);
  return button;
}

function contextMenuAccessKey(label: string) {
  const match = label.match(/\((?:&)?([a-z0-9])\)/i) ?? label.match(/&([a-z0-9])/i);
  return match?.[1]?.toLowerCase() ?? "";
}
