import type {
  AppNode,
  DesktopContextMenuAction,
  DesktopNode,
  DesktopSettings,
  FolderAppearanceSettings,
  FolderNode,
  LayoutSlot,
  SettingsView
} from "../types";
import type { FolderPanelSize } from "../layout/grid";
import {
  folderCoverCssVariables,
  folderRatioMax,
  folderRatioMin,
  normalizeFolderAppearance,
  desktopTileMetrics,
  folderTileMetrics,
  desktopSystemIconOptions
} from "../settings/desktopSettings";

interface FolderOpenOrigin {
  x: number;
  y: number;
  scale: number;
}

type DesktopSystemIconOption = (typeof desktopSystemIconOptions)[number];

interface FolderPageRenderOptions {
  renamingChildId: string | null;
  selectedChildId: string | null;
  openingIds: ReadonlySet<string>;
  size: FolderPanelSize;
  page: number;
  pageSize: number;
}

interface FolderLayerRenderOptions extends FolderPageRenderOptions {
  editing: boolean;
  origin: FolderOpenOrigin | null;
  pageCount: number;
  animate: boolean;
}

export function renderDesktopNode(
  node: DesktopNode,
  slot: LayoutSlot,
  selectedIds: ReadonlySet<string>,
  renamingId: string | null,
  openingIds: ReadonlySet<string>,
  settings: DesktopSettings
) {
  const tile = document.createElement("div");
  const isFolder = node.type === "folder";
  tile.className = `desktop-tile ${isFolder ? "is-folder" : "is-item"}`;
  tile.dataset.nodeId = node.id;
  tile.style.transform = `translate3d(${slot.x}px, ${slot.y}px, 0)`;
  tile.style.width = `${slot.width}px`;
  tile.style.height = `${slot.height}px`;
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.setAttribute("aria-label", node.name);

  if (selectedIds.has(node.id)) {
    tile.classList.add("is-selected");
  }

  if (openingIds.has(node.id)) {
    tile.classList.add("is-opening");
  }

  if (isFolder) {
    applyFolderTileShellStyle(tile, node, settings);
  }

  const icon = node.type === "folder" ? renderFolderCover(node, settings) : renderIcon(node);
  const label =
    renamingId === node.id ? renderRenameInput(node.id, node.name) : renderTileName(node.name);

  tile.append(icon, label);
  return tile;
}

export function applyFolderTileShellStyle(
  tile: HTMLElement,
  folder: FolderNode,
  settings: DesktopSettings
) {
  const folderTile = folderTileMetrics(settings, folder.appearance);
  const baseIconShellSize = desktopTileMetrics(settings).iconShellSize;

  if (folderTile.iconShellWidth === baseIconShellSize && folderTile.iconShellHeight === baseIconShellSize) {
    tile.style.removeProperty("--desktop-icon-shell-width");
    tile.style.removeProperty("--desktop-icon-shell-height");
    tile.style.gridTemplateRows = "";
    return;
  }

  tile.style.setProperty("--desktop-icon-shell-width", `${folderTile.iconShellWidth}px`);
  tile.style.setProperty("--desktop-icon-shell-height", `${folderTile.iconShellHeight}px`);
  tile.style.gridTemplateRows = `calc(${folderTile.iconShellHeight}px + 8px) 1fr`;
}

export function renderIcon(item: AppNode) {
  const shell = document.createElement("span");
  shell.className = "icon-shell";

  if (item.iconDataUrl) {
    const img = document.createElement("img");
    img.className = "app-icon";
    img.src = item.iconDataUrl;
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    shell.append(img);
  } else {
    const fallback = document.createElement("span");
    fallback.className = `fallback-icon fallback-${item.kind}`;
    fallback.setAttribute("aria-hidden", "true");
    shell.append(fallback);
  }

  return shell;
}

export function renderFolderLayerContent(folder: FolderNode, options: FolderLayerRenderOptions) {
  const backdrop = document.createElement("div");
  backdrop.className = "folder-backdrop";
  if (!options.animate) {
    backdrop.classList.add("is-static");
  }

  const panel = document.createElement("section");
  panel.className = "folder-panel";
  if (options.pageCount > 1) {
    panel.classList.add("has-pages");
  }
  if (options.animate) {
    panel.classList.add("is-performance-animating");
  }
  if (!options.animate) {
    panel.classList.add("is-static");
  }
  panel.dataset.folderPanelId = folder.id;
  panel.style.width = `${options.size.width}px`;
  panel.style.height = `${options.size.height}px`;
  panel.style.setProperty("--folder-open-x", `${options.origin?.x ?? 0}px`);
  panel.style.setProperty("--folder-open-y", `${options.origin?.y ?? 0}px`);
  panel.style.setProperty("--folder-open-scale", `${options.origin?.scale ?? 0.92}`);

  const title = document.createElement("div");
  title.className = "folder-title";
  title.dataset.folderTitle = folder.id;

  if (options.editing) {
    const input = document.createElement("input");
    input.value = folder.name;
    input.maxLength = 32;
    input.dataset.folderNameInput = folder.id;
    title.append(input);
  } else {
    const name = document.createElement("span");
    name.textContent = folder.name;
    title.append(name);
  }

  const itemsViewport = document.createElement("div");
  itemsViewport.className = "folder-items-viewport";

  const pages = document.createElement("div");
  pages.className = "folder-pages";
  pages.style.setProperty("--folder-page-offset", `${options.page * -100}%`);

  for (let pageIndex = 0; pageIndex < options.pageCount; pageIndex += 1) {
    const items = document.createElement("div");
    items.className = "folder-items";
    if (pageIndex === options.page) {
      items.classList.add("is-current-page");
    } else {
      items.setAttribute("aria-hidden", "true");
    }
    items.dataset.folderPage = String(pageIndex);
    items.style.setProperty("--folder-panel-item-width", `${options.size.itemWidth}px`);
    items.style.setProperty("--folder-panel-item-height", `${options.size.itemHeight}px`);
    items.style.setProperty("--folder-panel-icon-size", `${Math.min(64, Math.max(48, options.size.itemWidth - 12))}px`);
    items.style.gridTemplateColumns = `repeat(${options.size.columns}, ${options.size.itemWidth}px)`;
    items.style.gridTemplateRows = `repeat(${options.size.rows}, ${options.size.itemHeight}px)`;
    items.style.gridAutoRows = `${options.size.itemHeight}px`;

    renderFolderPageItems(folder, items, pageIndex, options);

    pages.append(items);
  }

  itemsViewport.append(pages);
  panel.append(title, itemsViewport);
  if (options.pageCount > 1) {
    panel.append(renderFolderPager(options.page, options.pageCount));
  }
  return [backdrop, panel];
}

function renderFolderPager(page: number, pageCount: number) {
  const pager = document.createElement("div");
  pager.className = "folder-pager";

  const dots = document.createElement("div");
  dots.className = "folder-page-dots";
  for (let index = 0; index < pageCount; index += 1) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "folder-page-dot";
    dot.dataset.folderPageIndex = String(index);
    dot.setAttribute("aria-label", `Page ${index + 1}`);
    if (index === page) {
      dot.classList.add("is-current");
      dot.setAttribute("aria-current", "page");
    }
    dots.append(dot);
  }

  pager.append(dots);
  return pager;
}

export function renderFolderCover(folder: FolderNode, settings: DesktopSettings) {
  const shell = document.createElement("span");
  shell.className = "icon-shell";

  const cover = document.createElement("span");
  cover.className = "folder-cover";
  const appearance = normalizeFolderAppearance(folder.appearance);
  for (const [key, value] of Object.entries(folderCoverCssVariables(settings, appearance))) {
    cover.style.setProperty(key, value);
  }

  const previewLimit = Math.max(1, appearance.folderPanelColumns * appearance.folderPanelRows);
  folder.children.slice(0, previewLimit).forEach((child) => {
    if (child.iconDataUrl) {
      const img = document.createElement("img");
      img.src = child.iconDataUrl;
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      cover.append(img);
    } else {
      const fallback = document.createElement("span");
      fallback.className = `cover-fallback fallback-${child.kind}`;
      fallback.setAttribute("aria-hidden", "true");
      cover.append(fallback);
    }
  });

  shell.append(cover);
  return shell;
}

function renderTileName(name: string) {
  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = name;
  return label;
}

function renderRenameInput(id: string, name: string) {
  const input = document.createElement("input");
  input.className = "tile-rename";
  input.value = name;
  input.maxLength = 128;
  input.dataset.renameId = id;
  input.setAttribute("aria-label", "重命名");
  return input;
}

function renderFolderChildRenameInput(folderId: string, childId: string, name: string) {
  const input = renderRenameInput(childId, name);
  input.dataset.folderChildRenameId = childId;
  input.dataset.parentFolderId = folderId;
  return input;
}

export function renderSettingsLayer(options: {
  settings: DesktopSettings;
  view: SettingsView;
  systemIconItems?: AppNode[];
  systemIconAddOpen?: boolean;
  animate?: boolean;
}) {
  const { settings, view } = options;
  const backdrop = document.createElement("div");
  backdrop.className = "settings-backdrop";
  if (options.animate === false) {
    backdrop.classList.add("is-static");
  }
  backdrop.dataset.settingsClose = "true";

  const panel = document.createElement("section");
  panel.className = "settings-panel";
  if (options.animate === false) {
    panel.classList.add("is-static");
  }
  panel.setAttribute("aria-label", "外观设置");

  const header = document.createElement("header");
  header.className = "settings-header";

  const title = document.createElement("h2");
  title.textContent = settingsTitle(view);

  const close = document.createElement("button");
  close.className = "settings-close";
  close.type = "button";
  close.dataset.settingsClose = "true";
  close.setAttribute("aria-label", "关闭设置");

  const reset = document.createElement("button");
  reset.className = "settings-reset";
  reset.type = "button";
  reset.textContent = "恢复默认";
  reset.dataset.settingsReset = "true";

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(reset, close);

  const titleGroup = document.createElement("div");
  titleGroup.className = "settings-title";
  if (view !== "main") {
    const back = document.createElement("button");
    back.className = "settings-back";
    back.type = "button";
    back.dataset.settingsView = "main";
    back.setAttribute("aria-label", "\u8fd4\u56de");
    titleGroup.append(back);
  }
  titleGroup.append(title);

  header.append(titleGroup, actions);
  panel.append(header);

  const controls = document.createElement("div");
  controls.className = "settings-controls";
  if (view === "system") {
    controls.classList.add("is-system-view");
  }
  controls.replaceChildren(
    ...renderSettingsControls(settings, view, {
      systemIconItems: options.systemIconItems ?? [],
      systemIconAddOpen: options.systemIconAddOpen === true
    })
  );

  panel.append(controls);
  return [backdrop, panel];
}

function settingsTitle(view: SettingsView) {
  if (view === "layout") {
    return "\u5e03\u5c40\u8bbe\u7f6e";
  }

  if (view === "system") {
    return "\u7cfb\u7edf\u56fe\u6807";
  }

  return "\u8bbe\u7f6e";
}

function renderSettingsControls(
  settings: DesktopSettings,
  view: SettingsView,
  options: {
    systemIconItems: AppNode[];
    systemIconAddOpen: boolean;
  }
) {
  if (view === "layout") {
    return [
      renderLayoutModeControl(settings.layoutMode),
      renderSettingControl("\u684c\u9762\u56fe\u6807", "appIconSize", settings.appIconSize, 48, 76, "px"),
      renderSettingControl("\u56fe\u6807\u95f4\u8ddd", "desktopGapPx", settings.desktopGapPx, 0, 32, "px"),
      renderSettingControl("\u5de6\u53f3\u8fb9\u8ddd", "desktopPaddingX", settings.desktopPaddingX, 0, 160, "px"),
      renderSettingControl("\u4e0a\u4e0b\u8fb9\u8ddd", "desktopPaddingY", settings.desktopPaddingY, 0, 160, "px"),
      renderSettingControl("\u6587\u4ef6\u5939\u56fe\u6807 \u5c0f", "folderCoverSmallPx", settings.folderCoverSmallPx, 6, 40, "px"),
      renderSettingControl("\u6587\u4ef6\u5939\u56fe\u6807 \u4e2d", "folderCoverMediumPx", settings.folderCoverMediumPx, 6, 40, "px"),
      renderSettingControl("\u6587\u4ef6\u5939\u56fe\u6807 \u5927", "folderCoverLargePx", settings.folderCoverLargePx, 6, 40, "px")
    ];
  }

  if (view === "system") {
    return renderSystemIconControls(settings.systemIcons, options.systemIconItems, options.systemIconAddOpen);
  }

  return [
    renderSettingsNavControl(
      "\u5e03\u5c40\u8bbe\u7f6e",
      settings.layoutMode === "free"
        ? "\u81ea\u7531\u5e03\u5c40\u3001\u56fe\u6807\u3001\u95f4\u8ddd\u548c\u8fb9\u8ddd"
        : "\u81ea\u52a8\u6392\u5217\u3001\u56fe\u6807\u3001\u95f4\u8ddd\u548c\u8fb9\u8ddd",
      "layout"
    ),
    renderSettingsNavControl(
      "\u7cfb\u7edf\u56fe\u6807",
      "\u6b64\u7535\u8111\u3001\u56de\u6536\u7ad9\u3001\u7f51\u7edc\u7b49",
      "system"
    ),
    renderSettingsDarkModeControl(settings.settingsDarkMode),
    renderAppPriorityControl(settings.appPriority)
  ];
}

function renderSettingsNavControl(label: string, detail: string, view: Exclude<SettingsView, "main">) {
  const button = document.createElement("button");
  button.className = "settings-nav-row";
  button.type = "button";
  button.dataset.settingsView = view;

  const text = document.createElement("span");
  text.className = "settings-nav-text";

  const name = document.createElement("span");
  name.textContent = label;

  const subtitle = document.createElement("span");
  subtitle.textContent = detail;

  text.append(name, subtitle);
  button.append(text);
  return button;
}

function renderFolderPageItems(
  folder: FolderNode,
  pageElement: HTMLElement,
  pageIndex: number,
  options: FolderPageRenderOptions
) {
  const pageStart = pageIndex * options.pageSize;
  const pageChildren = folder.children.slice(pageStart, pageStart + options.pageSize);
  const isCurrentPage = pageIndex === options.page;
  const fragment = document.createDocumentFragment();

  pageChildren.forEach((child) => {
    const item = document.createElement("div");
    item.className = "folder-item";
    if (options.selectedChildId === child.id) {
      item.classList.add("is-selected");
    }
    if (options.openingIds.has(child.id)) {
      item.classList.add("is-opening");
    }
    item.dataset.folderChildId = child.id;
    item.dataset.parentFolderId = folder.id;
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", isCurrentPage ? "0" : "-1");
    item.setAttribute("aria-label", child.name);
    item.append(renderIcon(child));

    const label =
      options.renamingChildId === child.id
        ? renderFolderChildRenameInput(folder.id, child.id, child.name)
        : renderTileName(child.name);
    item.append(label);
    fragment.append(item);
  });

  pageElement.replaceChildren(fragment);
}

function renderLayoutModeControl(layoutMode: DesktopSettings["layoutMode"]) {
  const row = document.createElement("section");
  row.className = "settings-row";

  const meta = document.createElement("span");
  meta.className = "settings-row-meta";

  const name = document.createElement("span");
  name.textContent = "排列方式";

  const output = document.createElement("output");
  output.textContent = layoutMode === "free" ? "自由布局" : "自动排列";

  meta.append(name, output);

  const control = document.createElement("div");
  control.className = "settings-segmented";

  [
    { value: "auto", label: "自动排列" },
    { value: "free", label: "自由布局" }
  ].forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.settingLayoutMode = option.value;
    button.classList.toggle("is-active", layoutMode === option.value);
    button.textContent = option.label;
    control.append(button);
  });

  row.append(meta, control);
  return row;
}

function renderSettingsDarkModeControl(enabled: boolean) {
  return renderSettingsToggleRow({
    label: "\u6df1\u8272\u6a21\u5f0f",
    output: enabled ? "\u5f00" : "\u5173",
    enabled,
    datasetKey: "settingDarkMode"
  });
}

function renderSettingsToggleRow(options: {
  label: string;
  output: string;
  enabled: boolean;
  datasetKey: string;
  datasetValue?: string;
}) {
  const row = document.createElement("section");
  row.className = "settings-row settings-toggle-row";

  const meta = document.createElement("span");
  meta.className = "settings-row-meta";

  const name = document.createElement("span");
  name.textContent = options.label;

  const output = document.createElement("output");
  output.textContent = options.output;

  meta.append(name, output);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "settings-toggle";
  toggle.dataset[options.datasetKey] = options.datasetValue ?? "true";
  toggle.setAttribute("aria-pressed", String(options.enabled));
  toggle.append(document.createElement("span"));

  row.append(meta, toggle);
  return row;
}

function renderSystemIconControls(
  systemIcons: DesktopSettings["systemIcons"],
  systemIconItems: AppNode[],
  addOpen: boolean
) {
  const section = document.createElement("section");
  section.className = "settings-system-manager";

  const scannedById = new Map(systemIconItems.map((item) => [item.id, item]));
  const enabledOptions = desktopSystemIconOptions.filter((option) => systemIcons[option.id] !== false);
  const disabledOptions = desktopSystemIconOptions.filter((option) => systemIcons[option.id] === false);

  const gallery = document.createElement("div");
  gallery.className = "settings-system-gallery";

  enabledOptions.forEach((option) => {
    gallery.append(renderSystemIconCard(option, scannedById.get(option.shellId)));
  });

  if (enabledOptions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-system-empty";
    empty.textContent = "\u6682\u65e0\u7cfb\u7edf\u56fe\u6807";
    gallery.append(empty);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-system-add-card";
  add.dataset.settingSystemIconAddTrigger = "true";
  add.setAttribute("aria-expanded", String(addOpen));

  const plus = document.createElement("span");
  plus.className = "settings-system-add-plus";
  plus.textContent = "+";

  const label = document.createElement("span");
  label.textContent = "\u6dfb\u52a0";

  add.append(plus, label);
  gallery.append(add);
  section.append(gallery);

  if (addOpen) {
    section.append(renderSystemIconPicker(disabledOptions, scannedById));
  }

  return [section];
}

function renderSystemIconCard(
  option: DesktopSystemIconOption,
  item?: AppNode
) {
  const card = document.createElement("div");
  card.className = "settings-system-card";
  card.append(renderIcon(systemIconPreviewItem(option, item)));

  const label = document.createElement("span");
  label.className = "settings-system-card-label";
  label.textContent = option.label;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "settings-system-remove";
  remove.dataset.settingSystemIconRemove = option.id;
  remove.setAttribute("aria-label", `\u79fb\u9664${option.label}`);

  card.append(label, remove);
  return card;
}

function renderSystemIconPicker(
  options: DesktopSystemIconOption[],
  scannedById: ReadonlyMap<string, AppNode>
) {
  const picker = document.createElement("div");
  picker.className = "settings-system-picker";

  if (options.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-system-picker-empty";
    empty.textContent = "\u5df2\u5168\u90e8\u6dfb\u52a0";
    picker.append(empty);
    return picker;
  }

  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-system-candidate";
    button.dataset.settingSystemIconAdd = option.id;
    button.append(renderIcon(systemIconPreviewItem(option, scannedById.get(option.shellId))));

    const label = document.createElement("span");
    label.textContent = option.label;
    button.append(label);
    picker.append(button);
  });

  return picker;
}

function systemIconPreviewItem(
  option: DesktopSystemIconOption,
  item?: AppNode
): AppNode {
  return item ?? {
    type: "item",
    id: option.shellId,
    name: option.label,
    kind: "system",
    path: null,
    launchId: option.shellId,
    iconDataUrl: null,
    isVirtual: true
  };
}

function renderAppPriorityControl(priority: DesktopSettings["appPriority"]) {
  const row = document.createElement("section");
  row.className = "settings-row";

  const meta = document.createElement("span");
  meta.className = "settings-row-meta";

  const name = document.createElement("span");
  name.className = "settings-label-with-help";
  name.textContent = "\u8fdb\u7a0b\u4f18\u5148\u7ea7";

  const help = document.createElement("span");
  help.className = "settings-help";
  help.textContent = "?";
  help.title = "\u8c03\u6574\u672c\u5e94\u7528\u5728 Windows \u4e2d\u83b7\u5f97 CPU \u8c03\u5ea6\u7684\u4f18\u5148\u7a0b\u5ea6\u3002\u8f83\u9ad8\u662f\u63a8\u8350\u503c\uff0c\u9ad8\u53ef\u80fd\u5f71\u54cd\u5176\u4ed6\u7a0b\u5e8f\u3002";
  name.append(help);

  const output = document.createElement("output");
  output.textContent =
    priority === "high" ? "\u9ad8" : priority === "normal" ? "\u6b63\u5e38" : "\u8f83\u9ad8";

  meta.append(name, output);

  const control = document.createElement("div");
  control.className = "settings-priority-select";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "settings-priority-trigger";
  trigger.dataset.settingPriorityTrigger = "true";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.textContent = output.textContent;

  control.append(trigger);
  row.append(meta, control);
  return row;
}

export function renderSettingsPriorityPopover(priority: DesktopSettings["appPriority"]) {
  const list = document.createElement("div");
  list.className = "settings-priority-popover";
  list.dataset.settingPriorityPopover = "true";
  list.setAttribute("role", "listbox");

  appPriorityOptions().forEach((option) => {
    const item = document.createElement("button");
    item.type = "button";
    item.dataset.settingAppPriority = option.value;
    item.classList.toggle("is-active", priority === option.value);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(priority === option.value));
    item.textContent = option.label;
    list.append(item);
  });

  return list;
}

function appPriorityOptions() {
  return [
    { value: "normal", label: "\u6b63\u5e38" },
    { value: "aboveNormal", label: "\u8f83\u9ad8" },
    { value: "high", label: "\u9ad8" }
  ] as const;
}

function renderSettingControl(
  label: string,
  key: keyof DesktopSettings,
  value: number,
  min: number,
  max: number,
  unit: string
) {
  const row = document.createElement("label");
  row.className = "settings-row";

  const meta = document.createElement("span");
  meta.className = "settings-row-meta";

  const name = document.createElement("span");
  name.textContent = label;

  const output = document.createElement("output");
  output.dataset.settingValue = key;
  output.textContent = `${value}${unit}`;

  meta.append(name, output);

  const controls = document.createElement("span");
  controls.className = "settings-control";

  const decrement = document.createElement("button");
  decrement.type = "button";
  decrement.textContent = "-";
  decrement.dataset.settingStep = "-1";
  decrement.dataset.settingKey = key;
  decrement.dataset.settingMin = String(min);
  decrement.dataset.settingMax = String(max);
  decrement.dataset.settingUnit = unit;

  const slider = document.createElement("input");
  slider.className = "settings-slider";
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = "1";
  slider.value = String(value);
  slider.dataset.settingRange = key;
  slider.dataset.settingUnit = unit;
  slider.style.setProperty("--setting-progress", `${((value - min) / (max - min)) * 100}%`);

  const increment = document.createElement("button");
  increment.type = "button";
  increment.textContent = "+";
  increment.dataset.settingStep = "1";
  increment.dataset.settingKey = key;
  increment.dataset.settingMin = String(min);
  increment.dataset.settingMax = String(max);
  increment.dataset.settingUnit = unit;

  controls.append(decrement, slider, increment);

  row.append(meta, controls);
  return row;
}

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
        if (child.separator) {
          const separator = document.createElement("div");
          separator.className = "context-menu-separator";
          submenu.append(separator);
          return;
        }

        submenu.append(renderContextMenuButton(child, Boolean(child.submenu?.length)));
      });
      itemElement.append(submenu);
    }

    menu.append(itemElement);
    itemOffset += metrics.rowHeight + metrics.gap;
  });

  return menu;
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

  if (item.checked) {
    button.classList.add("is-checked");
  }

  const label = document.createElement("span");
  label.className = "context-menu-label";
  label.textContent = item.checked ? `\u2713 ${item.label}` : item.label;
  button.append(label);
  return button;
}

export function renderRatioDialog(options: {
  x: number;
  y: number;
  columns: number;
  rows: number;
}) {
  const dialog = document.createElement("div");
  dialog.className = "ratio-dialog";

  const width = 200;
  const height = 120;
  dialog.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, options.x))}px`;
  dialog.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, options.y))}px`;

  const label = document.createElement("div");
  label.className = "ratio-dialog-label";
  label.textContent = "比例";

  const inputRow = document.createElement("div");
  inputRow.className = "ratio-dialog-inputs";

  const colInput = document.createElement("input");
  colInput.className = "ratio-dialog-input";
  colInput.type = "number";
  colInput.min = String(folderRatioMin);
  colInput.max = String(folderRatioMax);
  colInput.value = String(options.rows);
  colInput.dataset.ratioRows = "true";

  const separator = document.createElement("span");
  separator.className = "ratio-dialog-sep";
  separator.textContent = "×";

  const rowInput = document.createElement("input");
  rowInput.className = "ratio-dialog-input";
  rowInput.type = "number";
  rowInput.min = String(folderRatioMin);
  rowInput.max = String(folderRatioMax);
  rowInput.value = String(options.columns);
  rowInput.dataset.ratioColumns = "true";

  inputRow.append(colInput, separator, rowInput);

  const actions = document.createElement("div");
  actions.className = "ratio-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ratio-dialog-cancel";
  cancelBtn.textContent = "取消";
  cancelBtn.dataset.ratioCancel = "true";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ratio-dialog-confirm";
  confirmBtn.textContent = "确认";
  confirmBtn.dataset.ratioConfirm = "true";

  actions.append(cancelBtn, confirmBtn);

  dialog.append(label, inputRow, actions);
  return dialog;
}
