import {
  desktopContextMenuPool,
  desktopContextMenuSettingsItems,
  reorderContextMenuItem,
  toggleContextMenuSeparator,
  updateContextMenuItemPlacement
} from "../contextMenuModel";
import { renderSettingsPriorityPopover, renderSettingsLayer } from "../../render/settingsView";
import { defaultDesktopSettings, desktopSystemIconIdFromNodeId, isDesktopSystemIconId } from "../../settings/desktopSettings";
import { setAppProcessPriority, setStartupEnabled } from "../../system/desktopApi";
import { ContextMenuEditorDrag } from "./contextMenuEditorDrag";
import { withoutRender } from "./withoutRender";
import {
  isDesktopSettingKey,
  isAppProcessPriority,
  isContextMenuPlacement,
  isSettingsView
} from "../support/guards";
import type { SettingsView } from "../../types";
import type { DesktopApp } from "../DesktopApp";

export type SettingsPanelHost = Pick<
  DesktopApp,
  "consumeSuppressedClick"
  | "desktopSync"
  | "menus"
  | "settingsActions"
  | "settingsLayer"
  | "store"
  | "suppressClickOnce"
  | "suppressStoreRender"
  | "updates"
>;

// The settings panel: rendering, navigation between views and control events.
export class SettingsPanel {
  settingsOpen = false;
  settingsView: SettingsView = "main";
  private renderedSettingsView: SettingsView | null = null;
  private renderedSettingsContextMenuParentKey: string | null = null;
  private settingsContextMenuParentKey: string | null = null;
  private settingsSystemIconAddOpen = false;
  private settingsPriorityMenuOpen = false;
  readonly contextMenuEditorDrag = new ContextMenuEditorDrag({
    getLayer: () => this.app.settingsLayer,
    isEditorVisible: () => this.settingsView === "contextMenu",
    suppressNextClick: () => this.app.suppressClickOnce(),
    move: (key, targetKey, placement, position) => {
      this.app.store.updateSettings({
        contextMenu: reorderContextMenuItem(
          this.app.store.getSettings().contextMenu,
          this.app.menus.cachedDesktopNativeMenuItems ?? [],
          key,
          targetKey,
          placement,
          position,
          this.settingsContextMenuParentKey
        )
      });
    }
  });

  constructor(private readonly app: SettingsPanelHost) {}

  renderSettingsLayer() {
    const wasOpen = this.app.settingsLayer.classList.contains("is-open");
    const preserveScroll =
      wasOpen &&
      this.renderedSettingsView === this.settingsView &&
      this.renderedSettingsContextMenuParentKey === this.settingsContextMenuParentKey;
    const previousControls = this.app.settingsLayer.querySelector<HTMLElement>(".settings-controls");
    const scrollLeft = preserveScroll ? previousControls?.scrollLeft ?? 0 : 0;
    const scrollTop = preserveScroll ? previousControls?.scrollTop ?? 0 : 0;
    this.app.settingsLayer.classList.toggle("is-open", this.settingsOpen);

    if (!this.settingsOpen) {
      this.settingsPriorityMenuOpen = false;
      this.settingsSystemIconAddOpen = false;
      this.settingsContextMenuParentKey = null;
      this.renderedSettingsView = null;
      this.renderedSettingsContextMenuParentKey = null;
      this.app.settingsLayer.classList.remove("is-settings-dark");
      this.app.settingsLayer.replaceChildren();
      return;
    }

    const settings = this.app.store.getSettings();
    const contextMenuParentLabel = this.contextMenuParentLabel();
    this.app.settingsLayer.classList.toggle("is-settings-dark", settings.settingsDarkMode);

    this.app.settingsLayer.replaceChildren(
      ...renderSettingsLayer({
        settings,
        view: this.settingsView,
        systemIconItems: this.app.store.getScannedItems().filter((item) => desktopSystemIconIdFromNodeId(item.id)),
        systemIconAddOpen: this.settingsSystemIconAddOpen,
        contextMenuItems: this.contextMenuSettingsItems(this.settingsContextMenuParentKey),
        contextMenuTitle: this.settingsView === "contextMenu" ? contextMenuParentLabel ?? undefined : undefined,
        contextMenuParentLabel,
        updateState: this.app.updates.currentState,
        animate: !wasOpen
      })
    );
    this.renderedSettingsView = this.settingsView;
    this.renderedSettingsContextMenuParentKey = this.settingsContextMenuParentKey;
    const nextControls = this.app.settingsLayer.querySelector<HTMLElement>(".settings-controls");
    if (nextControls) {
      nextControls.scrollLeft = scrollLeft;
      nextControls.scrollTop = scrollTop;
      requestAnimationFrame(() => {
        nextControls.scrollLeft = scrollLeft;
        nextControls.scrollTop = scrollTop;
      });
    }
    this.renderSettingsPriorityMenu();
  }

  renderSettingsPriorityMenu() {
    this.app.settingsLayer.querySelector("[data-setting-priority-popover]")?.remove();

    const trigger = this.app.settingsLayer.querySelector<HTMLElement>("[data-setting-priority-trigger]");
    trigger?.classList.toggle("is-open", this.settingsPriorityMenuOpen);
    trigger?.setAttribute("aria-expanded", String(this.settingsPriorityMenuOpen));

    if (!this.settingsPriorityMenuOpen || !trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const popover = renderSettingsPriorityPopover(this.app.store.getSettings().appPriority);
    const width = Math.max(168, rect.width);
    const gap = 8;
    const edge = 10;
    const estimatedHeight = 126;
    const left = Math.min(Math.max(edge, rect.left), Math.max(edge, window.innerWidth - width - edge));
    const below = rect.bottom + gap;
    const top =
      below + estimatedHeight > window.innerHeight - edge
        ? Math.max(edge, rect.top - estimatedHeight - gap)
        : below;

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.style.width = `${Math.round(width)}px`;
    this.app.settingsLayer.append(popover);
  }

  private playSettingsToggleGhost(
    button: HTMLButtonElement,
    nextEnabled: boolean,
    nextLayerDark = this.app.settingsLayer.classList.contains("is-settings-dark")
  ) {
    const knob = button.querySelector<HTMLElement>("span");
    if (!knob) {
      return;
    }

    document.querySelectorAll(".settings-toggle-ghost").forEach((node) => node.remove());

    const buttonRect = button.getBoundingClientRect();
    const knobRect = knob.getBoundingClientRect();
    const buttonStyle = getComputedStyle(button);
    const knobStyle = getComputedStyle(knob);
    const layerHadDark = this.app.settingsLayer.classList.contains("is-settings-dark");
    this.app.settingsLayer.classList.toggle("is-settings-dark", nextLayerDark);
    const finalLayerStyle = getComputedStyle(this.app.settingsLayer);
    const finalTrackBg = (
      nextEnabled
        ? finalLayerStyle.getPropertyValue("--settings-toggle-on")
        : finalLayerStyle.getPropertyValue("--settings-control-bg")
    ).trim();
    const finalKnobBg = finalLayerStyle.getPropertyValue("--settings-toggle-knob").trim();
    this.app.settingsLayer.classList.toggle("is-settings-dark", layerHadDark);

    const paddingLeft = Number.parseFloat(buttonStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(buttonStyle.paddingRight) || 0;
    const startX = knobRect.left - buttonRect.left;
    const endX = nextEnabled
      ? buttonRect.width - knobRect.width - paddingRight
      : paddingLeft;

    const ghost = document.createElement("div");
    ghost.className = "settings-toggle-ghost";
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${buttonRect.left}px`,
      top: `${buttonRect.top}px`,
      width: `${buttonRect.width}px`,
      height: `${buttonRect.height}px`,
      borderRadius: buttonStyle.borderRadius,
      backgroundColor: buttonStyle.backgroundColor,
      boxShadow: buttonStyle.boxShadow,
      pointerEvents: "none",
      zIndex: "2147483647",
      overflow: "hidden",
      transition: "background-color 220ms cubic-bezier(.22, 1, .36, 1), box-shadow 220ms ease"
    });

    const ghostKnob = document.createElement("span");
    Object.assign(ghostKnob.style, {
      position: "absolute",
      left: "0",
      top: `${knobRect.top - buttonRect.top}px`,
      width: `${knobRect.width}px`,
      height: `${knobRect.height}px`,
      borderRadius: knobStyle.borderRadius,
      backgroundColor: knobStyle.backgroundColor,
      boxShadow: knobStyle.boxShadow,
      transform: `translate3d(${startX}px, 0, 0)`,
      transition:
        "transform 300ms cubic-bezier(.18, 1.05, .22, 1), background-color 220ms ease, box-shadow 220ms ease",
      willChange: "transform"
    });

    ghost.append(ghostKnob);
    document.body.append(ghost);

    requestAnimationFrame(() => {
      ghost.style.backgroundColor = finalTrackBg;
      ghostKnob.style.backgroundColor = finalKnobBg;
      ghostKnob.style.transform = `translate3d(${Math.max(0, endX)}px, 0, 0)`;
      ghostKnob.style.boxShadow = "0 6px 16px rgba(15, 23, 42, 0.24)";
    });

    window.setTimeout(() => ghost.remove(), 340);
  }

  private updateSettingsToggleRow(button: HTMLButtonElement, enabled: boolean) {
    button.setAttribute("aria-pressed", String(enabled));
    const row = button.closest(".settings-toggle-row");
    const output = row?.querySelector("output");
    if (output) {
      output.textContent = enabled ? "\u5f00" : "\u5173";
    }
  }

  private updateStartupSettingState(enabled: boolean) {
    withoutRender(this.app, () => this.app.store.updateSettings({ startWithWindows: enabled }));
  }

  private contextMenuSettingsItems(parentKey: string | null = null) {
    return desktopContextMenuSettingsItems(
      this.app.menus.cachedDesktopNativeMenuItems ?? [],
      this.app.store.getSettings().contextMenu,
      parentKey
    );
  }

  private contextMenuParentLabel() {
    const parentKey = this.settingsContextMenuParentKey;
    if (!parentKey) {
      return null;
    }

    return desktopContextMenuPool(this.app.menus.cachedDesktopNativeMenuItems ?? []).find((item) => item.key === parentKey)?.label ?? null;
  }

  onSettingsClick(event: MouseEvent) {
    if (this.app.consumeSuppressedClick()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const close = (event.target as HTMLElement).closest("[data-settings-close]");
    const reset = (event.target as HTMLElement).closest("[data-settings-reset]");
    const viewButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-settings-view]");
    const stepButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-step]");
    const layoutModeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-layout-mode]");
    const darkModeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-dark-mode]");
    const startupButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-start-with-windows]");
    const autoUpdateButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-auto-update]");
    const systemIconAddTrigger = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-system-icon-add-trigger]");
    const systemIconAddButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-system-icon-add]");
    const systemIconRemoveButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-system-icon-remove]");
    const contextMenuSubmenuTarget = (event.target as HTMLElement).closest<HTMLElement>("[data-setting-context-menu-submenu]");
    const contextMenuPlacementButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-context-menu-placement]");
    const contextMenuSeparatorButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-context-menu-separator]");
    const contextMenuResetButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-context-menu-reset]");
    const priorityTrigger = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-priority-trigger]");
    const priorityButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-app-priority]");
    const priorityPopover = (event.target as HTMLElement).closest<HTMLElement>("[data-setting-priority-popover]");
    const settingsActionButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting-action]");

    if (!priorityTrigger && !priorityPopover && this.settingsPriorityMenuOpen) {
      this.settingsPriorityMenuOpen = false;
      this.renderSettingsPriorityMenu();
    }

    if (reset) {
      this.resetCurrentSettingsView();
      return;
    }

    const nextSettingsView = viewButton?.dataset.settingsView;
    if (isSettingsView(nextSettingsView)) {
      if (this.settingsView === "contextMenu" && this.settingsContextMenuParentKey && nextSettingsView === "main") {
        this.app.settingsActions.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.settingsContextMenuParentKey = null;
        this.renderSettingsLayer();
        return;
      }

      this.app.settingsActions.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      this.settingsSystemIconAddOpen = false;
      this.settingsContextMenuParentKey = null;
      this.settingsView = nextSettingsView;
      this.renderSettingsLayer();
      if (nextSettingsView === "system") {
        this.app.desktopSync.scheduleFullDesktopItemLoad(120);
      } else if (nextSettingsView === "contextMenu") {
        void this.refreshContextMenuSettingsPool();
      }
      return;
    }

    if (layoutModeButton?.dataset.settingLayoutMode === "auto" || layoutModeButton?.dataset.settingLayoutMode === "free") {
      this.app.settingsActions.cancelSettingsPreview();
      this.app.settingsActions.switchDesktopLayoutMode(layoutModeButton.dataset.settingLayoutMode);
      return;
    }

    if (darkModeButton) {
      this.app.settingsActions.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      const nextEnabled = this.app.store.getSettings().settingsDarkMode !== true;
      this.playSettingsToggleGhost(darkModeButton, nextEnabled, nextEnabled);
      this.app.store.updateSettings({ settingsDarkMode: nextEnabled });
      return;
    }

    if (autoUpdateButton) {
      this.app.settingsActions.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      const nextEnabled = this.app.store.getSettings().autoUpdate !== true;
      this.playSettingsToggleGhost(autoUpdateButton, nextEnabled);
      this.updateSettingsToggleRow(autoUpdateButton, nextEnabled);
      withoutRender(this.app, () => this.app.store.updateSettings({ autoUpdate: nextEnabled }));
      if (nextEnabled) {
        void this.app.updates.runAutomaticUpdateCheck("background");
      }
      return;
    }

    if (startupButton) {
      this.app.settingsActions.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      const nextEnabled = this.app.store.getSettings().startWithWindows !== true;
      this.playSettingsToggleGhost(startupButton, nextEnabled);
      this.updateSettingsToggleRow(startupButton, nextEnabled);
      this.updateStartupSettingState(nextEnabled);
      void setStartupEnabled(nextEnabled).catch((error) => {
        console.warn("Unable to update startup setting", error);
        this.updateSettingsToggleRow(startupButton, !nextEnabled);
        this.updateStartupSettingState(!nextEnabled);
      });
      return;
    }

    if (systemIconAddTrigger) {
      this.settingsPriorityMenuOpen = false;
      this.settingsSystemIconAddOpen = !this.settingsSystemIconAddOpen;
      this.renderSettingsLayer();
      this.app.desktopSync.scheduleFullDesktopItemLoad(80);
      return;
    }

    if (systemIconAddButton) {
      const systemIconId = systemIconAddButton.dataset.settingSystemIconAdd;
      if (isDesktopSystemIconId(systemIconId)) {
        this.app.settingsActions.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.settingsSystemIconAddOpen = false;
        this.app.settingsActions.setSystemIconVisibility(systemIconId, true);
      }
      return;
    }

    if (systemIconRemoveButton) {
      const systemIconId = systemIconRemoveButton.dataset.settingSystemIconRemove;
      if (isDesktopSystemIconId(systemIconId)) {
        this.app.settingsActions.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.app.settingsActions.setSystemIconVisibility(systemIconId, false);
      }
      return;
    }

    if (contextMenuSubmenuTarget) {
      const key = contextMenuSubmenuTarget.dataset.settingContextMenuSubmenu;
      if (key) {
        this.app.settingsActions.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.settingsContextMenuParentKey = key;
        this.renderSettingsLayer();
      }
      return;
    }

    if (contextMenuPlacementButton) {
      const key = contextMenuPlacementButton.dataset.menuKey;
      const placement = contextMenuPlacementButton.dataset.settingContextMenuPlacement;
      if (key && isContextMenuPlacement(placement)) {
        this.app.settingsActions.cancelSettingsPreview();
        this.app.store.updateSettings({
          contextMenu: updateContextMenuItemPlacement(
            this.app.store.getSettings().contextMenu,
            this.app.menus.cachedDesktopNativeMenuItems ?? [],
            key,
            placement,
            this.settingsContextMenuParentKey
          )
        });
      }
      return;
    }

    if (contextMenuSeparatorButton) {
      const key = contextMenuSeparatorButton.dataset.menuKey;
      if (key) {
        this.app.settingsActions.cancelSettingsPreview();
        this.app.store.updateSettings({
          contextMenu: toggleContextMenuSeparator(
            this.app.store.getSettings().contextMenu,
            this.app.menus.cachedDesktopNativeMenuItems ?? [],
            key,
            this.settingsContextMenuParentKey
          )
        });
      }
      return;
    }

    if (contextMenuResetButton) {
      this.app.settingsActions.cancelSettingsPreview();
      this.app.settingsActions.resetContextMenuCustomization();
      return;
    }

    if (priorityTrigger) {
      this.settingsPriorityMenuOpen = !this.settingsPriorityMenuOpen;
      this.renderSettingsPriorityMenu();
      return;
    }

    if (priorityButton) {
      const appPriority = priorityButton.dataset.settingAppPriority;
      if (isAppProcessPriority(appPriority)) {
        this.app.settingsActions.cancelSettingsPreview();
        this.settingsPriorityMenuOpen = false;
        this.app.settingsActions.commitAppPriority(appPriority, priorityButton.textContent?.trim() ?? "");
        void setAppProcessPriority(appPriority);
      }
      return;
    }

    const settingsAction = settingsActionButton?.dataset.settingAction;
    if (settingsAction === "checkUpdates" || settingsAction === "updateLatest") {
      this.app.settingsActions.cancelSettingsPreview();
      this.settingsPriorityMenuOpen = false;
      if (settingsAction === "checkUpdates") {
        void this.app.updates.checkForUpdates();
      } else {
        void this.app.updates.confirmAndOpenLatestUpdate();
      }
      return;
    }

    if (stepButton) {
      const key = stepButton.dataset.settingKey;
      const step = Number(stepButton.dataset.settingStep);
      const min = Number(stepButton.dataset.settingMin);
      const max = Number(stepButton.dataset.settingMax);
      const current = this.app.settingsActions.getSettingsValueSource();
      if (key && isDesktopSettingKey(key) && Number.isFinite(step) && Number.isFinite(min) && Number.isFinite(max)) {
        const value = Math.min(max, Math.max(min, current[key] + step));
        this.app.settingsActions.commitSettingValue(key, value);
      }
      return;
    }

    if (!close) {
      return;
    }

    this.app.settingsActions.cancelSettingsPreview();
    this.settingsOpen = false;
    this.settingsView = "main";
    this.settingsPriorityMenuOpen = false;
    this.renderSettingsLayer();
  }

  private resetCurrentSettingsView() {
    this.app.settingsActions.cancelSettingsPreview();
    this.settingsPriorityMenuOpen = false;
    this.settingsSystemIconAddOpen = false;

    if (this.settingsView === "layout") {
      this.app.settingsActions.resetLayoutSettings();
      return;
    }

    if (this.settingsView === "system") {
      this.app.store.updateSettings({ systemIcons: { ...defaultDesktopSettings.systemIcons } });
      return;
    }

    if (this.settingsView === "contextMenu") {
      this.app.settingsActions.resetContextMenuCustomization();
      return;
    }

    this.app.store.updateSettings(defaultDesktopSettings);
    void setAppProcessPriority(defaultDesktopSettings.appPriority);
    void setStartupEnabled(defaultDesktopSettings.startWithWindows).catch((error) => {
      console.warn("Unable to reset startup setting", error);
    });
  }

  updateSettingsPriorityControl(label: string) {
    const trigger = this.app.settingsLayer.querySelector<HTMLElement>("[data-setting-priority-trigger]");
    const row = trigger?.closest<HTMLElement>(".settings-row");
    const output = row?.querySelector<HTMLOutputElement>("output");

    if (label) {
      if (trigger) {
        trigger.textContent = label;
      }
      if (output) {
        output.textContent = label;
      }
    }

    this.renderSettingsPriorityMenu();
  }

  onSettingsInput(event: Event) {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-setting-range]");
    if (!input) {
      return;
    }

    this.updateSettingControlVisual(input);
    this.previewSettingInput(input);
  }

  onSettingsChange(event: Event) {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-setting-range]");
    const key = input?.dataset.settingRange;
    if (!input || !key || !(key in this.app.settingsActions.getSettingsValueSource())) {
      return;
    }

    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }

    this.app.settingsActions.commitSettingValue(key, Math.min(max, Math.max(min, Math.round(value))));
  }

  private updateSettingControlVisual(input: HTMLInputElement) {
    const key = input.dataset.settingRange;
    const unit = input.dataset.settingUnit ?? "";
    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    if (!key || !Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }

    input.style.setProperty("--setting-progress", `${((value - min) / (max - min)) * 100}%`);
    const row = input.closest(".settings-row");
    const output = row?.querySelector<HTMLOutputElement>(`[data-setting-value="${CSS.escape(key)}"]`);
    if (output) {
      output.textContent = `${Math.round(value)}${unit}`;
    }
  }

  private previewSettingInput(input: HTMLInputElement) {
    const key = input.dataset.settingRange;
    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    const current = this.app.settingsActions.getSettingsValueSource();
    if (!key || !(key in current) || !Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }

    const next = Math.min(max, Math.max(min, Math.round(value)));

    // Preview only; the value is saved once, on release (onSettingsChange).
    if (isDesktopSettingKey(key)) {
      const settings = { ...this.app.store.getSettings(), [key]: next };
      this.app.settingsActions.scheduleSettingsPreview(() => this.app.settingsActions.previewDesktopSettings(settings));
    }
  }

  async refreshContextMenuSettingsPool() {
    try {
      await this.app.menus.loadNativeDesktopMenuItems();
    } catch (error) {
      console.warn("Unable to refresh context menu settings pool", error);
      return;
    }

    if (this.settingsOpen && this.settingsView === "contextMenu") {
      this.renderSettingsLayer();
    }
  }
}
