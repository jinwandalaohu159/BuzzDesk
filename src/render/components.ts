import type {
  AppNode,
  DesktopContextMenuAction,
  DesktopNode,
  DesktopSettings,
  FolderAppearanceSettings,
  FolderNode,
  LayoutSlot
} from "../types";
import type { FolderPanelSize } from "../layout/grid";
import {
  folderCoverCssVariables,
  folderRatioMax,
  folderRatioMin,
  normalizeFolderAppearance,
  desktopTileMetrics,
  folderTileMetrics
} from "../settings/desktopSettings";

interface FolderOpenOrigin {
  x: number;
  y: number;
  scale: number;
}

interface FolderLayerRenderOptions {
  editing: boolean;
  renamingChildId: string | null;
  selectedChildId: string | null;
  openingIds: ReadonlySet<string>;
  origin: FolderOpenOrigin | null;
  size: FolderPanelSize;
  page: number;
  pageCount: number;
  pageSize: number;
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

    const pageStart = pageIndex * options.pageSize;
    const pageChildren = folder.children.slice(pageStart, pageStart + options.pageSize);
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
      item.setAttribute("tabindex", pageIndex === options.page ? "0" : "-1");
      item.setAttribute("aria-label", child.name);
      item.append(renderIcon(child));

      const label =
        options.renamingChildId === child.id
          ? renderFolderChildRenameInput(folder.id, child.id, child.name)
          : renderTileName(child.name);
      item.append(label);
      items.append(item);
    });

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
}) {
  const { settings } = options;
  const backdrop = document.createElement("div");
  backdrop.className = "settings-backdrop";
  backdrop.dataset.settingsClose = "true";

  const panel = document.createElement("section");
  panel.className = "settings-panel";
  panel.setAttribute("aria-label", "外观设置");

  const header = document.createElement("header");
  header.className = "settings-header";

  const title = document.createElement("h2");
  title.textContent = "设置";

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

  header.append(title, actions);
  panel.append(header);

  const controls = document.createElement("div");
  controls.className = "settings-controls";

  controls.append(
    renderLayoutModeControl(settings.layoutMode),
    renderSettingControl("桌面图标", "appIconSize", settings.appIconSize, 48, 76, "px"),
    renderSettingControl("图标间距", "desktopGapPx", settings.desktopGapPx, 0, 32, "px"),
    renderSettingControl("左右边距", "desktopPaddingX", settings.desktopPaddingX, 0, 160, "px"),
    renderSettingControl("上下边距", "desktopPaddingY", settings.desktopPaddingY, 0, 160, "px"),
    renderSettingControl("文件夹图标 小", "folderCoverSmallPx", settings.folderCoverSmallPx, 6, 40, "px"),
    renderSettingControl("文件夹图标 中", "folderCoverMediumPx", settings.folderCoverMediumPx, 6, 40, "px"),
    renderSettingControl("文件夹图标 大", "folderCoverLargePx", settings.folderCoverLargePx, 6, 40, "px")
  );

  panel.append(controls);
  return [backdrop, panel];
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
  items: Array<{ action: DesktopContextMenuAction; label: string; disabled?: boolean; checked?: boolean }>;
}) {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  const width = 176;
  const height = Math.max(44, options.items.length * 34 + 12);
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, options.x))}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, options.y))}px`;

  options.items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.contextAction = item.action;
    button.disabled = Boolean(item.disabled);

    if (item.checked) {
      button.classList.add("is-checked");
    }

    button.textContent = item.checked ? `✓ ${item.label}` : item.label;
    menu.append(button);
  });

  return menu;
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
  colInput.value = String(options.columns);
  colInput.dataset.ratioColumns = "true";

  const separator = document.createElement("span");
  separator.className = "ratio-dialog-sep";
  separator.textContent = "×";

  const rowInput = document.createElement("input");
  rowInput.className = "ratio-dialog-input";
  rowInput.type = "number";
  rowInput.min = String(folderRatioMin);
  rowInput.max = String(folderRatioMax);
  rowInput.value = String(options.rows);
  rowInput.dataset.ratioRows = "true";

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
