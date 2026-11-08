import { resetContextMenuSettings } from "./contextMenuLayoutEdit";
import { computeDesktopLayout } from "../../layout/grid";
import { applyFolderTileShellStyle, renderFolderCover } from "../../render/desktopTile";
import { applyDesktopSettings, defaultDesktopSettings, desktopTileMetrics, fitDesktopSettings } from "../../settings/desktopSettings";
import { desktopViewport } from "../../system/desktopViewport";
import { isDesktopSettingKey } from "../support/guards";
import { withoutRender } from "./withoutRender";
import type {
  AppProcessPriority,
  DesktopNode,
  DesktopPosition,
  DesktopSettings,
  DesktopSystemIconId,
  LayoutSlot
} from "../../types";
import type { DesktopApp } from "../DesktopApp";

export type SettingsActionsHost = Pick<
  DesktopApp,
  "folder"
  | "freePlacement"
  | "layout"
  | "renderWithFlip"
  | "settings"
  | "store"
  | "suppressStoreRender"
  | "tileElement"
>;

// Applying setting changes to the desktop: live previews, layout-mode switches,
// resets and per-item tweaks.
export class SettingsActions {
  private settingsPreviewFrame: number | null = null;
  private pendingSettingsPreview: (() => void) | null = null;

  constructor(private readonly app: SettingsActionsHost) {}

  resetLayoutSettings() {
    withoutRender(this.app, () => {
      this.app.store.updateSettings({
        layoutMode: defaultDesktopSettings.layoutMode,
        appIconSize: defaultDesktopSettings.appIconSize,
        desktopGapPx: defaultDesktopSettings.desktopGapPx,
        desktopPaddingX: defaultDesktopSettings.desktopPaddingX,
        desktopPaddingY: defaultDesktopSettings.desktopPaddingY,
        folderCoverSmallPx: defaultDesktopSettings.folderCoverSmallPx,
        folderCoverMediumPx: defaultDesktopSettings.folderCoverMediumPx,
        folderCoverLargePx: defaultDesktopSettings.folderCoverLargePx
      });
    });

    this.app.renderWithFlip();
  }

  resetContextMenuCustomization() {
    this.app.store.updateSettings({ contextMenu: resetContextMenuSettings() });
    void this.app.settings.refreshContextMenuSettingsPool();
  }

  commitAppPriority(appPriority: AppProcessPriority, label: string) {
    withoutRender(this.app, () => this.app.store.updateSettings({ appPriority }));
    this.app.settings.updateSettingsPriorityControl(label);
  }

  scheduleSettingsPreview(preview: () => void) {
    this.pendingSettingsPreview = preview;
    if (this.settingsPreviewFrame !== null) {
      return;
    }

    this.settingsPreviewFrame = requestAnimationFrame(() => {
      this.settingsPreviewFrame = null;
      const nextPreview = this.pendingSettingsPreview;
      this.pendingSettingsPreview = null;
      nextPreview?.();
    });
  }

  cancelSettingsPreview() {
    if (this.settingsPreviewFrame !== null) {
      cancelAnimationFrame(this.settingsPreviewFrame);
      this.settingsPreviewFrame = null;
    }

    this.pendingSettingsPreview = null;
  }

  // Live preview while a slider moves: lays the current tiles out with the
  // previewed settings without touching the store (committed on release).
  previewDesktopSettings(settings: DesktopSettings) {
    // Tiles are moved and restyled in place. They stay in app.tiles: a tile is
    // only reused while its effective settings are unchanged, so committing a
    // new value rebuilds them, and releasing on the old value leaves them as
    // they were rendered.
    const nodes = this.app.store.getNodes();
    const viewport = desktopViewport();
    const fitted = this.effectiveDesktopSettings(settings, nodes, viewport);
    applyDesktopSettings(fitted);
    this.app.layout = computeDesktopLayout(
      nodes,
      viewport.width,
      viewport.height,
      fitted,
      viewport.offsetX,
      viewport.offsetY
    );

    for (const node of nodes) {
      const slot = this.app.layout.get(node.id);
      const tile = this.app.tileElement(node.id);
      if (!slot || !tile) {
        continue;
      }

      tile.style.width = `${slot.width}px`;
      tile.style.height = `${slot.height}px`;
      tile.style.transform = `translate3d(${slot.x}px, ${slot.y}px, 0)`;

      if (node.type === "folder") {
        applyFolderTileShellStyle(tile, node, fitted);
        this.replaceTileIcon(tile, renderFolderCover(node, fitted));
      }
    }

    this.app.folder.renderFolderLayer(fitted);
  }

  switchDesktopLayoutMode(layoutMode: DesktopSettings["layoutMode"]) {
    const currentLayoutMode = this.app.store.getSettings().layoutMode;
    if (layoutMode === currentLayoutMode) {
      return;
    }

    withoutRender(this.app, () => {
      if (layoutMode === "free" && currentLayoutMode !== "free") {
        this.seedFreeLayoutPositions();
      }
      this.app.store.updateSettings({ layoutMode });
    });

    this.app.renderWithFlip();
  }

  private seedFreeLayoutPositions() {
    const viewport = desktopViewport();
    const positions = this.app.store.getNodes()
      .map((node) => {
        const slot = this.app.layout.get(node.id);
        if (!slot) {
          return null;
        }

        return {
          id: node.id,
          position: this.app.freePlacement.clampedDesktopPosition(
            slot.x - viewport.offsetX,
            slot.y - viewport.offsetY,
            slot.width,
            slot.height,
            viewport
          )
        };
      })
      .filter((entry): entry is { id: string; position: DesktopPosition } => Boolean(entry));

    this.app.store.updateNodePositions(positions);
  }

  autoArrangeFreeDesktop() {
    const nodes = this.app.store.getNodes();
    const settings = this.app.store.getSettings();
    if (settings.layoutMode !== "free" || nodes.length === 0) {
      return;
    }

    const viewport = desktopViewport();
    const arrangedSettings: DesktopSettings = { ...settings, layoutMode: "auto" };
    const orderedNodes = this.freeLayoutVisualNodes(nodes);
    const arrangedLayout = computeDesktopLayout(
      orderedNodes,
      viewport.width,
      viewport.height,
      arrangedSettings,
      viewport.offsetX,
      viewport.offsetY
    );
    const positions = orderedNodes
      .map((node) => {
        const slot = arrangedLayout.get(node.id);
        if (!slot) {
          return null;
        }

        return {
          id: node.id,
          position: this.app.freePlacement.clampedDesktopPosition(
            slot.x - viewport.offsetX,
            slot.y - viewport.offsetY,
            slot.width,
            slot.height,
            viewport
          )
        };
      })
      .filter((entry): entry is { id: string; position: DesktopPosition } => Boolean(entry));

    this.app.store.updateNodeOrderAndPositions(orderedNodes.map((node) => node.id), positions);
  }

  private freeLayoutVisualNodes(nodes: DesktopNode[]) {
    const metrics = desktopTileMetrics(this.app.store.getSettings());
    const rowTolerance = Math.max(18, Math.round(metrics.height * 0.45));
    const entries = nodes.map((node, index) => ({
      node,
      index,
      slot: this.app.layout.get(node.id) ?? null
    }));
    const rows: Array<{
      y: number;
      entries: Array<{ node: DesktopNode; index: number; slot: LayoutSlot }>;
    }> = [];
    const missing: Array<{ node: DesktopNode; index: number }> = [];

    entries
      .sort(
        (a, b) =>
          (a.slot?.y ?? Number.POSITIVE_INFINITY) - (b.slot?.y ?? Number.POSITIVE_INFINITY) ||
          (a.slot?.x ?? 0) - (b.slot?.x ?? 0) ||
          a.index - b.index
      )
      .forEach((entry) => {
        if (!entry.slot) {
          missing.push({ node: entry.node, index: entry.index });
          return;
        }

        const row = rows.at(-1);
        if (row && Math.abs(entry.slot.y - row.y) <= rowTolerance) {
          row.entries.push({ node: entry.node, index: entry.index, slot: entry.slot });
          row.y = Math.round((row.y * (row.entries.length - 1) + entry.slot.y) / row.entries.length);
          return;
        }

        rows.push({
          y: entry.slot.y,
          entries: [{ node: entry.node, index: entry.index, slot: entry.slot }]
        });
      });

    return [
      ...rows.flatMap((row) =>
        row.entries
          .sort((a, b) => a.slot.x - b.slot.x || a.index - b.index)
          .map((entry) => entry.node)
      ),
      ...missing
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.node)
    ];
  }

  getSettingsValueSource(): DesktopSettings {
    return this.app.store.getSettings();
  }

  effectiveDesktopSettings(
    settings: DesktopSettings,
    nodes: DesktopNode[],
    viewport = desktopViewport()
  ): DesktopSettings {
    return settings.layoutMode === "free"
      ? settings
      : fitDesktopSettings(settings, nodes, viewport.width, viewport.height);
  }

  commitSettingValue(key: string, value: number) {
    this.cancelSettingsPreview();
    if (isDesktopSettingKey(key)) {
      this.app.store.updateSettings({ [key]: value });
    }
  }

  setSystemIconVisibility(systemIconId: DesktopSystemIconId, visible: boolean) {
    const current = this.app.store.getSettings().systemIcons;
    if (current[systemIconId] === visible) {
      return;
    }

    this.app.store.updateSettings({
      systemIcons: {
        ...current,
        [systemIconId]: visible
      }
    });
  }

  private replaceTileIcon(tile: HTMLElement, icon: HTMLElement) {
    const currentIcon = Array.from(tile.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("icon-shell")
    );
    currentIcon?.replaceWith(icon);
  }
}
