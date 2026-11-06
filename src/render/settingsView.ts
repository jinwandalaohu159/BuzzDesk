import type {
  AppNode,
  DesktopSettings,
  SettingsView,
  UpdateCheckState
} from "../types";
import { desktopSystemIconOptions } from "../settings/desktopSettings";
import { renderContextMenuSettingsControls } from "./contextMenuEditorView";
import type { SettingsContextMenuItem } from "./contextMenuEditorView";
import { renderIcon } from "./desktopTile";
import { renderSettingsUpdateControl } from "./settingsUpdateView";

// The settings panel markup: views, rows and controls.

type DesktopSystemIconOption = (typeof desktopSystemIconOptions)[number];

export function renderSettingsLayer(options: {
  settings: DesktopSettings;
  view: SettingsView;
  systemIconItems?: AppNode[];
  systemIconAddOpen?: boolean;
  contextMenuItems?: SettingsContextMenuItem[];
  contextMenuTitle?: string;
  contextMenuParentLabel?: string | null;
  updateState: UpdateCheckState;
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
  title.textContent = options.contextMenuTitle ?? settingsTitle(view);

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
      systemIconAddOpen: options.systemIconAddOpen === true,
      contextMenuItems: options.contextMenuItems ?? [],
      contextMenuParentLabel: options.contextMenuParentLabel ?? null,
      updateState: options.updateState
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

  if (view === "contextMenu") {
    return "\u53f3\u952e\u83dc\u5355";
  }

  return "\u8bbe\u7f6e";
}

function renderSettingsControls(
  settings: DesktopSettings,
  view: SettingsView,
  options: {
    systemIconItems: AppNode[];
    systemIconAddOpen: boolean;
    contextMenuItems: SettingsContextMenuItem[];
    contextMenuParentLabel: string | null;
    updateState: UpdateCheckState;
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

  if (view === "contextMenu") {
    return renderContextMenuSettingsControls(options.contextMenuItems, options.contextMenuParentLabel);
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
    renderSettingsNavControl(
      "\u53f3\u952e\u83dc\u5355",
      "\u4e3b\u83dc\u5355\u3001\u663e\u793a\u66f4\u591a\u9009\u9879\u548c\u53ef\u7528\u9879",
      "contextMenu"
    ),
    renderSettingsDarkModeControl(settings.settingsDarkMode),
    renderSettingsStartupControl(settings.startWithWindows),
    renderSettingsToggleRow({
      label: "自动更新",
      output: settings.autoUpdate ? "开" : "关",
      enabled: settings.autoUpdate,
      datasetKey: "settingAutoUpdate"
    }),
    renderAppPriorityControl(settings.appPriority),
    renderSettingsUpdateControl(options.updateState)
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

function renderSettingsStartupControl(enabled: boolean) {
  return renderSettingsToggleRow({
    label: "\u5f00\u673a\u81ea\u542f\u52a8",
    output: enabled ? "\u5f00" : "\u5173",
    enabled,
    datasetKey: "settingStartWithWindows"
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
  help.title = "\u8c03\u6574\u672c\u5e94\u7528\u5728 Windows \u4e2d\u83b7\u5f97 CPU \u8c03\u5ea6\u7684\u4f18\u5148\u7a0b\u5ea6\u3002\u8f83\u9ad8\u662f\u63a8\u8350\u503c\uff0c\u5b9e\u65f6\u662f\u6700\u9ad8\u6863\u3002";
  name.append(help);

  const output = document.createElement("output");
  output.textContent = appPriorityLabel(priority);

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
    { value: "high", label: "\u9ad8" },
    { value: "realtime", label: "\u5b9e\u65f6" }
  ] as const;
}

function appPriorityLabel(priority: DesktopSettings["appPriority"]) {
  return appPriorityOptions().find((option) => option.value === priority)?.label ?? "\u8f83\u9ad8";
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
