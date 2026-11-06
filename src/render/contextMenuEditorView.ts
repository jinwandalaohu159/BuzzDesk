import type { DesktopContextMenuPlacement } from "../types";

// The context-menu editor inside settings: visible list, pool and item rows.

export interface SettingsContextMenuItem {
  key: string;
  label: string;
  source: "native" | "action";
  placement: DesktopContextMenuPlacement;
  separatorAfter: boolean;
  submenuCount: number;
}

export function renderContextMenuSettingsControls(items: SettingsContextMenuItem[], parentLabel: string | null) {
  const section = document.createElement("section");
  section.className = "settings-menu-manager";

  const mainItems = items.filter((item) => item.placement === "main");
  const moreItems = items.filter((item) => item.placement === "more");
  const hiddenItems = items.filter((item) => item.placement === "hidden");

  section.append(
    renderContextMenuEditorList(
      parentLabel ? "\u5f53\u524d\u83dc\u5355" : "\u4e3b\u83dc\u5355",
      parentLabel ? `${parentLabel} \u7684\u4e8c\u7ea7\u83dc\u5355` : "\u76f4\u63a5\u53f3\u952e\u65f6\u663e\u793a",
      mainItems,
      "main",
      moreItems.length
    ),
    renderContextMenuEditorList("\u663e\u793a\u66f4\u591a\u9009\u9879", "\u6536\u8d77\u5728\u8fd9\u4e00\u7ea7\u83dc\u5355\u91cc", moreItems, "more"),
    renderContextMenuPoolList(hiddenItems)
  );

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "settings-menu-reset";
  reset.dataset.settingContextMenuReset = "true";
  reset.textContent = "\u6062\u590d\u53f3\u952e\u83dc\u5355\u9ed8\u8ba4";
  section.append(reset);

  return [section];
}

function renderContextMenuEditorList(
  title: string,
  subtitle: string,
  items: SettingsContextMenuItem[],
  placement: Exclude<DesktopContextMenuPlacement, "hidden">,
  moreCount = 0
) {
  const group = renderContextMenuEditorShell(title, subtitle, items.length);

  const list = document.createElement("div");
  list.className = "settings-menu-editor-list";
  list.dataset.settingContextMenuList = placement;

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-menu-empty";
    empty.textContent = "\u6682\u65e0\u9879";
    list.append(empty);
  } else {
    items.forEach((item, index) => {
      list.append(renderContextMenuEditorItem(item, placement));
      if (index < items.length - 1) {
        list.append(renderContextMenuDividerToggle(item));
      }
    });
    if (placement === "main" && moreCount > 0) {
      list.append(renderContextMenuMoreMarker(moreCount));
    }
  }

  group.append(list);
  return group;
}

function renderContextMenuPoolList(items: SettingsContextMenuItem[]) {
  const group = renderContextMenuEditorShell(
    "\u5f85\u6dfb\u52a0",
    "\u5220\u9664\u540e\u56de\u5230\u8fd9\u91cc\uff0c\u53ef\u4ee5\u518d\u52a0\u56de\u83dc\u5355",
    items.length
  );
  const list = document.createElement("div");
  list.className = "settings-menu-pool";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-menu-empty";
    empty.textContent = "\u6ca1\u6709\u5f85\u6dfb\u52a0\u9879";
    list.append(empty);
  } else {
    items.forEach((item) => list.append(renderContextMenuPoolItem(item)));
  }

  group.append(list);
  return group;
}

function renderContextMenuEditorShell(title: string, subtitle: string, countValue: number) {
  const group = document.createElement("div");
  group.className = "settings-menu-group";

  const header = document.createElement("div");
  header.className = "settings-menu-group-header";

  const text = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = title;
  const detail = document.createElement("span");
  detail.textContent = subtitle;
  text.append(name, detail);

  const count = document.createElement("span");
  count.className = "settings-menu-count";
  count.textContent = String(countValue);
  header.append(text, count);
  group.append(header);
  return group;
}

function renderContextMenuEditorItem(
  item: SettingsContextMenuItem,
  currentPlacement: Exclude<DesktopContextMenuPlacement, "hidden">
) {
  const row = document.createElement("div");
  row.className = "settings-menu-editor-item";
  row.dataset.settingContextMenuDrag = item.key;
  row.dataset.settingContextMenuRowPlacement = currentPlacement;

  const handle = document.createElement("span");
  handle.className = "settings-menu-drag-handle";
  handle.setAttribute("aria-hidden", "true");

  const meta = document.createElement("span");
  meta.className = "settings-menu-item-meta";
  if (item.submenuCount > 0) {
    meta.dataset.settingContextMenuSubmenu = item.key;
    meta.classList.add("has-submenu");
  }

  const label = document.createElement("span");
  label.textContent = item.label;

  const source = document.createElement("small");
  source.textContent = item.source === "native" ? "Windows" : "\u5e94\u7528";
  meta.append(label, source);

  const actions = document.createElement("span");
  actions.className = "settings-menu-item-actions";
  const hideLabel = currentPlacement === "main" ? "\u9690\u85cf" : "\u663e\u793a";
  const hideTitle = currentPlacement === "main" ? "\u653e\u5230\u663e\u793a\u66f4\u591a\u9009\u9879" : "\u653e\u5230\u4e3b\u83dc\u5355";
  const hidePlacement = currentPlacement === "main" ? "more" : "main";
  if (item.submenuCount > 0) {
    actions.append(renderContextMenuSubmenuButton(item));
  }
  actions.append(
    renderContextMenuSettingsButton(item.key, hideLabel, hideTitle, { placement: hidePlacement }),
    renderContextMenuSettingsButton(item.key, "\u5220\u9664", "\u79fb\u5230\u5f85\u6dfb\u52a0", { placement: "hidden" })
  );

  row.append(handle, meta, actions);
  return row;
}

function renderContextMenuSubmenuButton(item: SettingsContextMenuItem) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = "\u914d\u7f6e\u8fd9\u4e2a\u4e8c\u7ea7\u83dc\u5355";
  button.textContent = `${item.submenuCount}\u9879`;
  button.dataset.settingContextMenuSubmenu = item.key;
  return button;
}

function renderContextMenuPoolItem(item: SettingsContextMenuItem) {
  const row = document.createElement("div");
  row.className = "settings-menu-pool-item";

  const meta = document.createElement("span");
  meta.className = "settings-menu-item-meta";

  const label = document.createElement("span");
  label.textContent = item.label;

  const source = document.createElement("small");
  source.textContent = item.source === "native" ? "Windows" : "\u5e94\u7528";
  meta.append(label, source);

  const actions = document.createElement("span");
  actions.className = "settings-menu-item-actions";
  actions.append(
    renderContextMenuSettingsButton(item.key, "\u6dfb\u52a0", "\u653e\u5230\u4e3b\u83dc\u5355", { placement: "main" }),
    renderContextMenuSettingsButton(item.key, "\u66f4\u591a", "\u653e\u5230\u663e\u793a\u66f4\u591a\u9009\u9879", { placement: "more" })
  );

  row.append(meta, actions);
  return row;
}

function renderContextMenuDividerToggle(item: SettingsContextMenuItem) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-menu-divider-toggle";
  button.classList.toggle("is-active", item.separatorAfter);
  button.title = item.separatorAfter ? "\u79fb\u9664\u8fd9\u6761\u5206\u533a\u7ebf" : "\u5728\u8fd9\u91cc\u6dfb\u52a0\u5206\u533a\u7ebf";
  button.dataset.menuKey = item.key;
  button.dataset.settingContextMenuSeparator = "true";
  button.dataset.settingContextMenuDropAfter = item.key;
  button.append(document.createElement("span"));
  return button;
}

function renderContextMenuMoreMarker(count: number) {
  const row = document.createElement("div");
  row.className = "settings-menu-more-marker";
  const label = document.createElement("span");
  label.textContent = "\u663e\u793a\u66f4\u591a\u9009\u9879";
  const detail = document.createElement("small");
  detail.textContent = `${count} \u9879`;
  row.append(label, detail);
  return row;
}

function renderContextMenuSettingsButton(
  key: string,
  label: string,
  title: string,
  options: { placement?: DesktopContextMenuPlacement }
) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = title;
  button.textContent = label;
  button.draggable = false;
  button.dataset.menuKey = key;
  if (options.placement) {
    button.dataset.settingContextMenuPlacement = options.placement;
  }
  return button;
}
