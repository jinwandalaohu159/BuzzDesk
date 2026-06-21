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
  folderAppearanceFromSettings,
  folderCoverCssVariables,
  normalizeFolderAppearance
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
  animate: boolean;
}

export function renderDesktopNode(
  node: DesktopNode,
  slot: LayoutSlot,
  selectedId: string | null,
  renamingId: string | null,
  openingIds: ReadonlySet<string>,
  settings: DesktopSettings
) {
  const tile = document.createElement("div");
  tile.className = `desktop-tile ${node.type === "folder" ? "is-folder" : "is-item"}`;
  tile.dataset.nodeId = node.id;
  tile.style.transform = `translate3d(${slot.x}px, ${slot.y}px, 0)`;
  tile.style.width = `${slot.width}px`;
  tile.style.height = `${slot.height}px`;
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.setAttribute("aria-label", node.name);

  if (selectedId === node.id) {
    tile.classList.add("is-selected");
  }

  if (openingIds.has(node.id)) {
    tile.classList.add("is-opening");
  }

  const icon = node.type === "folder" ? renderFolderCover(node, settings) : renderIcon(node);
  const label =
    renamingId === node.id ? renderRenameInput(node.id, node.name) : renderTileName(node.name);

  tile.append(icon, label);
  return tile;
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
  if (!options.animate) {
    panel.classList.add("is-static");
  }
  panel.dataset.folderPanelId = folder.id;
  panel.style.width = `${options.size.width}px`;
  panel.style.height = `${options.size.height}px`;
  panel.style.setProperty("--folder-open-x", `${options.origin?.x ?? 0}px`);
  panel.style.setProperty("--folder-open-y", `${options.origin?.y ?? 0}px`);
  panel.style.setProperty("--folder-open-drift-x", `${(options.origin?.x ?? 0) * 0.05}px`);
  panel.style.setProperty("--folder-open-drift-y", `${(options.origin?.y ?? 0) * 0.05}px`);
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

  const items = document.createElement("div");
  items.className = "folder-items";
  items.style.gridTemplateColumns = `repeat(${options.size.columns}, minmax(0, 92px))`;

  folder.children.forEach((child) => {
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
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", child.name);
    item.append(renderIcon(child));

    const label =
      options.renamingChildId === child.id
        ? renderFolderChildRenameInput(folder.id, child.id, child.name)
        : renderTileName(child.name);
    item.append(label);
    items.append(item);
  });

  panel.append(title, items);
  return [backdrop, panel];
}

export function renderFolderCover(folder: FolderNode, settings: DesktopSettings) {
  const shell = document.createElement("span");
  shell.className = "icon-shell";

  const cover = document.createElement("span");
  cover.className = "folder-cover";
  const appearance = normalizeFolderAppearance(folder.appearance, folderAppearanceFromSettings(settings));
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
  input.setAttribute("aria-label", "\u91cd\u547d\u540d");
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
  folderAppearance?: FolderAppearanceSettings | null;
  folderName?: string | null;
}) {
  const { settings, folderAppearance, folderName } = options;
  const isFolderAppearance = Boolean(folderAppearance);
  const active = folderAppearance ?? folderAppearanceFromSettings(settings);
  const backdrop = document.createElement("div");
  backdrop.className = "settings-backdrop";
  backdrop.dataset.settingsClose = "true";

  const panel = document.createElement("section");
  panel.className = "settings-panel";
  panel.setAttribute("aria-label", "\u684c\u9762\u5916\u89c2\u8bbe\u7f6e");

  const header = document.createElement("header");
  header.className = "settings-header";

  const title = document.createElement("h2");
  title.textContent = isFolderAppearance ? "\u6587\u4ef6\u5939\u5916\u89c2" : "\u5916\u89c2";
  if (isFolderAppearance && folderName) {
    const target = document.createElement("span");
    target.className = "settings-target";
    target.textContent = folderName;
    title.append(target);
  }

  const close = document.createElement("button");
  close.className = "settings-close";
  close.type = "button";
  close.dataset.settingsClose = "true";
  close.setAttribute("aria-label", "\u5173\u95ed\u8bbe\u7f6e");

  const reset = document.createElement("button");
  reset.className = "settings-reset";
  reset.type = "button";
  reset.textContent = "\u6062\u590d\u9ed8\u8ba4";
  reset.dataset.settingsReset = "true";

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(reset, close);

  header.append(title, actions);
  panel.append(header);

  const controls = document.createElement("div");
  controls.className = "settings-controls";

  if (!isFolderAppearance) {
    controls.append(
      renderSettingControl("\u684c\u9762\u56fe\u6807", "appIconSize", settings.appIconSize, 48, 76, "px")
    );
  } else {
    controls.append(
      renderSettingControl("\u6298\u53e0\u56fe\u6807\u5927\u5c0f", "folderCoverCellSize", active.folderCoverCellSize, 10, 22, "px"),
      renderSettingStepper("\u6bd4\u4f8b\u5217\u6570", "folderPanelColumns", active.folderPanelColumns, 2, 6, "\u5217"),
      renderSettingStepper("\u6bd4\u4f8b\u884c\u6570", "folderPanelRows", active.folderPanelRows, 2, 6, "\u884c")
    );
  }

  panel.append(controls);
  return [backdrop, panel];
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

function renderSettingStepper(
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
  controls.className = "settings-stepper";

  const decrement = renderSettingStepButton(key, -1, min, max, unit);
  const valueText = document.createElement("span");
  valueText.className = "settings-stepper-value";
  valueText.textContent = String(value);
  const increment = renderSettingStepButton(key, 1, min, max, unit);

  controls.append(decrement, valueText, increment);
  row.append(meta, controls);
  return row;
}

function renderSettingStepButton(
  key: keyof DesktopSettings,
  step: number,
  min: number,
  max: number,
  unit: string
) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = step > 0 ? "+" : "-";
  button.dataset.settingStep = String(step);
  button.dataset.settingKey = key;
  button.dataset.settingMin = String(min);
  button.dataset.settingMax = String(max);
  button.dataset.settingUnit = unit;
  return button;
}

export function renderContextMenu(options: {
  x: number;
  y: number;
  items: Array<{ action: DesktopContextMenuAction; label: string; disabled?: boolean }>;
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
    button.textContent = item.label;
    button.dataset.contextAction = item.action;
    button.disabled = Boolean(item.disabled);
    menu.append(button);
  });

  return menu;
}
