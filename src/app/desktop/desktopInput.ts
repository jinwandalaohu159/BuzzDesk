import type { DesktopNode } from "../../types";
import type { DesktopApp } from "../DesktopApp";
import { pointHitsTileContent } from "./tileHitArea";

const preventDefaultOnce = (event: Event) => event.preventDefault();

export type DesktopInputHost = Pick<
  DesktopApp,
  "consumeSuppressedClick"
  | "dragging"
  | "findNode"
  | "folder"
  | "folderLayer"
  | "grid"
  | "isDesktopSurfaceEvent"
  | "items"
  | "layout"
  | "menus"
  | "rename"
  | "render"
  | "root"
  | "selection"
  | "settings"
  | "store"
>;

// Pointer, click and context-menu events on the desktop surface; routes them
// to selection, drag, activation and menus.
export class DesktopInput {

  constructor(private readonly app: DesktopInputHost) {}

  onDesktopClick(event: MouseEvent) {
    if (!this.app.isDesktopSurfaceEvent(event)) {
      return;
    }

    if (this.app.consumeSuppressedClick()) {
      return;
    }

    if (this.app.dragging.drag?.started) {
      return;
    }

    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    this.app.menus.closeContextMenu();

    const tile = this.tileUnderPointer(event);
    if (!tile) {
      this.app.selection.clearDesktopSelection();
      this.app.render();
    }
  }

  onDesktopDoubleClick(event: MouseEvent) {
    if (!this.app.isDesktopSurfaceEvent(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    const tile = this.tileUnderPointer(event);
    const node = this.app.findNode(tile?.dataset.nodeId ?? "");
    if (!tile || !node) {
      return;
    }

    if (node.type === "folder") {
      this.app.folder.openFolderFromElement(node, tile);
      return;
    }

    void this.app.items.openItem(node);
  }

  onDesktopPointerDown(event: PointerEvent) {
    if (!this.app.isDesktopSurfaceEvent(event)) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const tile = this.tileUnderPointer(event);
    const id = tile?.dataset.nodeId;
    const node = this.app.findNode(id ?? "");
    const slot = id ? this.app.layout.get(id) : null;
    if (!tile || !id || !node || !slot) {
      // Pressed on a tile's empty padding: keep focus where it was instead of
      // moving it to the tile the user missed.
      if ((event.target as HTMLElement).closest("[data-node-id]")) {
        const root = this.app.root;
        root.addEventListener("mousedown", preventDefaultOnce, { capture: true, once: true });
        // The mouse event follows in the same task; never let it linger.
        window.setTimeout(() => root.removeEventListener("mousedown", preventDefaultOnce, { capture: true }));
      }
      this.app.selection.marquee.begin(event);
      return;
    }

    if ((event.target as HTMLElement).closest("[data-rename-id]")) {
      return;
    }

    const groupNodeIds = this.desktopDragGroupForNode(id);
    if (groupNodeIds.length <= 1) {
      this.previewDesktopPress(node, tile, event.ctrlKey);
    }
    this.app.dragging.beginDrag({
      source: { type: "desktop", nodeId: id },
      event,
      element: tile,
      baseX: slot.x,
      baseY: slot.y,
      floating: false,
      groupNodeIds
    });
  }

  // The tile under the pointer, but only when the pointer is on what the user
  // sees of it (icon or name), not on the empty padding around them.
  private tileUnderPointer(event: MouseEvent) {
    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    return tile && pointHitsTileContent(tile, event.clientX, event.clientY) ? tile : null;
  }

  private desktopDragGroupForNode(nodeId: string) {
    if (this.app.selection.selectedIds.size <= 1 || !this.app.selection.selectedIds.has(nodeId)) {
      return [nodeId];
    }

    return this.app.store
      .getNodes()
      .map((node) => node.id)
      .filter((id) => this.app.selection.selectedIds.has(id));
  }

  private previewDesktopPress(node: DesktopNode, tile: HTMLElement, toggleSelection = false) {
    this.app.menus.closeContextMenu();
    this.app.folder.selectedFolderChild = null;
    this.app.rename.renamingId = null;
    if (toggleSelection) {
      return;
    }

    this.app.selection.selectSingleDesktopNode(node.id);
    this.app.grid.querySelectorAll(".desktop-tile.is-selected").forEach((element) => {
      if (element !== tile) {
        element.classList.remove("is-selected");
      }
    });
    tile.classList.add("is-selected");
  }

  previewFolderChildPress(folderId: string, childId: string, item: HTMLElement) {
    this.app.menus.closeContextMenu();
    this.app.selection.clearDesktopSelection();
    this.app.rename.renamingFolderChild = null;
    this.app.folder.selectedFolderChild = { folderId, childId };
    this.app.folderLayer.querySelectorAll(".folder-item.is-selected").forEach((element) => {
      if (element !== item) {
        element.classList.remove("is-selected");
      }
    });
    item.classList.add("is-selected");
  }

  onDesktopContextMenu(event: MouseEvent) {
    if (!this.app.isDesktopSurfaceEvent(event)) {
      return;
    }

    event.preventDefault();
    this.app.settings.settingsOpen = false;
    this.app.menus.clearContextOverlay();
    this.app.settings.renderSettingsLayer();

    const tile = this.tileUnderPointer(event);
    if (tile?.dataset.nodeId) {
      const node = this.app.findNode(tile.dataset.nodeId);
      if (node?.type === "item") {
        this.app.selection.selectSingleDesktopNode(node.id);
        this.app.menus.contextMenu = null;
        this.app.render();
        void this.app.menus.openNativeContextMenu(node, event.clientX, event.clientY, {
          type: "item",
          x: event.clientX,
          y: event.clientY,
          nodeId: node.id
        });
        return;
      }

      this.app.selection.selectSingleDesktopNode(tile.dataset.nodeId);
      this.app.menus.contextMenu = { type: "item", x: event.clientX, y: event.clientY, nodeId: tile.dataset.nodeId };
      this.app.render();
      return;
    }

    this.app.selection.clearDesktopSelection();
    this.app.menus.contextMenu = null;
    this.app.render();
    void this.app.menus.openCustomDesktopContextMenu(event.clientX, event.clientY);
  }
}
