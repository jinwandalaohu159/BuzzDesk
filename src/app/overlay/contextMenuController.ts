import { collapseMenuSeparators, desktopMenuItems, itemFallbackMenuItems, folderContextMenuItems } from "../contextMenuModel";
import { renderContextMenu } from "../../render/contextMenuView";
import { normalizeFolderAppearance } from "../../settings/desktopSettings";
import {
  createDesktopFolder,
  copyDesktopItem,
  pasteDesktopItems,
  showDesktopItemProperties,
  invokeNativeDesktopContextMenuCommand,
  listNativeDesktopContextMenu,
  showNativeItemContextMenu
} from "../../system/desktopApi";
import { clampScroll } from "../support/geometry";
import type {
  AppNode,
  DesktopContextMenuAction,
  DesktopNode,
  NativeContextMenuItem
} from "../../types";
import type { DesktopApp } from "../DesktopApp";

type ContextMenuState =
  | { type: "desktop"; x: number; y: number; nativeItems?: NativeContextMenuItem[] }
  | { type: "item"; x: number; y: number; nodeId: string }
  | { type: "folderItem"; x: number; y: number; folderId: string; childId: string };

export type ContextMenuControllerHost = Pick<
  DesktopApp,
  "contextMenuLayer"
  | "desktopSync"
  | "dialogs"
  | "findFolderChild"
  | "findNode"
  | "folder"
  | "items"
  | "rename"
  | "settings"
  | "settingsActions"
  | "store"
>;

// Context menus (custom and native) for the desktop, items and folder children.
export class ContextMenuController {
  contextMenu: ContextMenuState | null = null;
  private contextOverlayVersion = 0;
  cachedDesktopNativeMenuItems: NativeContextMenuItem[] | null = null;
  private desktopNativeMenuLoad: Promise<NativeContextMenuItem[]> | null = null;

  constructor(private readonly app: ContextMenuControllerHost) {}

  renderContextMenu() {
    if (this.app.dialogs.confirmDialogResolve) {
      this.app.contextMenuLayer.classList.add("is-open");
      return;
    }

    if (this.app.dialogs.ratioDialogTargetId) {
      this.app.contextMenuLayer.classList.add("is-open");
      return;
    }

    this.app.contextMenuLayer.classList.toggle("is-open", Boolean(this.contextMenu));

    if (!this.contextMenu) {
      this.app.contextMenuLayer.replaceChildren();
      return;
    }

    const node = this.contextMenuTargetNode(this.contextMenu);
    let items;

    if (this.contextMenu.type === "desktop") {
      items = this.decorateDesktopContextMenuItems(
        desktopMenuItems(this.contextMenu.nativeItems, this.app.store.getSettings().contextMenu)
      );
    } else if (node?.type === "folder") {
      const appearance = normalizeFolderAppearance(node.appearance);
      items = folderContextMenuItems(appearance.folderCoverSize, appearance.compactPlacement);
    } else {
      items = itemFallbackMenuItems(node, this.contextMenu.type === "item" ? "desktop" : "folder");
    }

    this.app.contextMenuLayer.replaceChildren(
      renderContextMenu({
        x: this.contextMenu.x,
        y: this.contextMenu.y,
        items,
        bounds: this.contextMenuSafeArea()
      })
    );
    this.clampContextSubmenus();
  }

  private decorateDesktopContextMenuItems(
    items: ReturnType<typeof desktopMenuItems>
  ): ReturnType<typeof desktopMenuItems> {
    const hideAutoArrange = this.app.store.getSettings().layoutMode !== "free";
    return collapseMenuSeparators(items.flatMap((item) => {
      if (hideAutoArrange && item.action === "autoArrange") {
        return [];
      }

      const submenu = item.submenu ? this.decorateDesktopContextMenuItems(item.submenu) : undefined;
      if (item.submenu && submenu?.length === 0) {
        return [];
      }

      return [{ ...item, submenu }];
    }));
  }

  private clampContextSubmenus() {
    const bounds = this.contextMenuSafeArea();
    const submenuGap = 4;
    const submenus = Array.from(this.app.contextMenuLayer.querySelectorAll<HTMLElement>(".context-submenu"));
    const previousSubmenuStyles = submenus.map((submenu) => ({
      submenu,
      display: submenu.style.display,
      visibility: submenu.style.visibility,
      pointerEvents: submenu.style.pointerEvents
    }));

    submenus.forEach((submenu) => {
      submenu.style.display = "grid";
      submenu.style.visibility = "hidden";
      submenu.style.pointerEvents = "none";
    });

    this.app.contextMenuLayer.querySelectorAll<HTMLElement>(".context-menu-item.has-submenu").forEach((item) => {
      const submenu = Array.from(item.children).find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.classList.contains("context-submenu")
      );
      if (!submenu) {
        return;
      }

      const floating = submenu.classList.contains("is-floating");
      item.classList.remove("opens-left");
      submenu.classList.remove("is-left");

      const itemRect = item.getBoundingClientRect();
      let submenuRect = submenu.getBoundingClientRect();

      if (floating) {
        const floatingGap = -1;
        let left = itemRect.right + floatingGap;
        if (
          left + submenuRect.width > bounds.right &&
          itemRect.left - submenuRect.width - floatingGap >= bounds.left
        ) {
          item.classList.add("opens-left");
          submenu.classList.add("is-left");
          left = itemRect.left - submenuRect.width - floatingGap;
        }
        left = clampScroll(left, bounds.left, Math.max(bounds.left, bounds.right - submenuRect.width));

        let top = itemRect.top - 8;
        if (top + submenuRect.height > bounds.bottom) {
          top -= top + submenuRect.height - bounds.bottom;
        }
        top = clampScroll(top, bounds.top, Math.max(bounds.top, bounds.bottom - submenuRect.height));

        submenu.style.left = `${Math.round(left)}px`;
        submenu.style.top = `${Math.round(top)}px`;
        return;
      }

      if (
        submenuRect.right > bounds.right &&
        itemRect.left - submenuRect.width - submenuGap >= bounds.left
      ) {
        item.classList.add("opens-left");
        submenu.classList.add("is-left");
        submenuRect = submenu.getBoundingClientRect();
      }

      let top = Number.parseFloat(submenu.style.top);
      if (!Number.isFinite(top)) {
        top = 0;
      }

      const bottomOverflow = submenuRect.bottom - bounds.bottom;
      if (bottomOverflow > 0) {
        top -= bottomOverflow;
      }

      const projectedTop = itemRect.top + top;
      if (projectedTop < bounds.top) {
        top += bounds.top - projectedTop;
      }

      submenu.style.top = `${Math.round(top)}px`;
    });

    previousSubmenuStyles.forEach(({ submenu, display, visibility, pointerEvents }) => {
      submenu.style.display = display;
      submenu.style.visibility = visibility;
      submenu.style.pointerEvents = pointerEvents;
    });
  }

  private contextMenuSafeArea() {
    const edge = 8;
    const fallback = {
      left: edge,
      top: edge,
      right: Math.max(edge, window.innerWidth - edge),
      bottom: Math.max(edge, window.innerHeight - edge)
    };
    const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
    const availLeft = Number.isFinite(screen.availLeft) ? Number(screen.availLeft) : window.screenX;
    const availTop = Number.isFinite(screen.availTop) ? Number(screen.availTop) : window.screenY;
    const availWidth = Number.isFinite(screen.availWidth) ? screen.availWidth : window.innerWidth;
    const availHeight = Number.isFinite(screen.availHeight) ? screen.availHeight : window.innerHeight;
    const screenX = Number.isFinite(window.screenX) ? window.screenX : 0;
    const screenY = Number.isFinite(window.screenY) ? window.screenY : 0;
    const left = Math.max(fallback.left, Math.round(availLeft - screenX + edge));
    const top = Math.max(fallback.top, Math.round(availTop - screenY + edge));
    const right = Math.min(fallback.right, Math.round(availLeft + availWidth - screenX - edge));
    const bottom = Math.min(fallback.bottom, Math.round(availTop + availHeight - screenY - edge));

    if (right - left < 240 || bottom - top < 160) {
      return fallback;
    }

    return { left, top, right, bottom };
  }

  async onContextMenuClick(event: MouseEvent) {
    const submenuButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-context-submenu]");
    if (submenuButton) {
      this.setContextSubmenuOpen(submenuButton, true);
      return;
    }

    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-context-action], [data-native-command-id]");
    const action = button?.dataset.contextAction as DesktopContextMenuAction | undefined;
    const nativeCommandId = Number(button?.dataset.nativeCommandId);
    if ((!action && !Number.isFinite(nativeCommandId)) || !this.contextMenu) {
      return;
    }

    const menu = this.contextMenu;
    this.closeContextMenu();

    try {
      if (Number.isFinite(nativeCommandId) && menu.type === "desktop") {
        const result = await invokeNativeDesktopContextMenuCommand(nativeCommandId);
        if (result.invoked) {
          await this.app.desktopSync.syncAfterNativeShellCommand();
        }
        return;
      }

      if (action === "refresh") {
        await this.app.desktopSync.refreshDesktopItems();
        return;
      }

      if (action === "autoArrange") {
        this.app.settingsActions.autoArrangeFreeDesktop();
        return;
      }

      if (action === "paste") {
        await pasteDesktopItems();
        await this.app.desktopSync.refreshDesktopItems();
        return;
      }

      if (action === "newFolder") {
        await createDesktopFolder();
        await this.app.desktopSync.refreshDesktopItems();
        return;
      }

      if (action === "settings") {
        this.app.settings.settingsOpen = true;
        this.app.settings.settingsView = "main";
        this.app.settings.renderSettingsLayer();
        return;
      }

      if (menu.type === "desktop") {
        return;
      }

      const node = this.contextMenuTargetNode(menu);
      if (!node) {
        return;
      }

      if (action === "folderRatio") {
        if (node.type === "folder") {
          this.app.dialogs.showRatioDialog(node, menu.x, menu.y);
        }
      } else if (action === "folderCompactPlacement") {
        if (node.type === "folder") {
          const appearance = normalizeFolderAppearance(node.appearance);
          this.app.store.updateFolderAppearance(node.id, {
            compactPlacement: !appearance.compactPlacement
          });
        }
      } else if (action === "folderIconSmall") {
        if (node.type === "folder") {
          this.app.store.updateFolderAppearance(node.id, { folderCoverSize: "small" });
        }
      } else if (action === "folderIconMedium") {
        if (node.type === "folder") {
          this.app.store.updateFolderAppearance(node.id, { folderCoverSize: "medium" });
        }
      } else if (action === "folderIconLarge") {
        if (node.type === "folder") {
          this.app.store.updateFolderAppearance(node.id, { folderCoverSize: "large" });
        }
      } else if (action === "open") {
        if (node.type === "item") {
          await this.app.items.openItem(node);
        } else {
          this.app.folder.openFolderFromNode(node);
        }
      } else if (action === "rename") {
        if (menu.type !== "folderItem") {
          this.app.rename.startRename(node.id);
        }
      } else if (action === "delete") {
        if (menu.type === "folderItem" && node.type === "item") {
          this.app.folder.moveFolderChildOut(menu.folderId, node.id);
          return;
        }

        await this.app.items.deleteNode(node);
      } else if (action === "properties" && node.type === "item") {
        await showDesktopItemProperties(node);
      } else if (action === "copy" && node.type === "item") {
        await copyDesktopItem(node);
      }
    } catch (error) {
      console.warn("Desktop context menu action failed", action, error);
    }
  }

  handleContextMenuAccessKey(event: KeyboardEvent) {
    if (
      !this.contextMenu ||
      this.app.dialogs.ratioDialogTargetId ||
      this.app.dialogs.confirmDialogResolve ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.key.length !== 1
    ) {
      return false;
    }

    const key = event.key.toLowerCase();
    const button = this.contextMenuAccessKeyButton(key);
    if (!button) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.contextSubmenu) {
      this.setContextSubmenuOpen(button, false);
    } else {
      button.click();
    }
    return true;
  }

  private contextMenuAccessKeyButton(key: string) {
    const root = this.app.contextMenuLayer.querySelector<HTMLElement>(".context-menu");
    if (!root) {
      return null;
    }

    const openSubmenus = Array.from(this.app.contextMenuLayer.querySelectorAll<HTMLElement>(".context-menu-item.is-submenu-open > .context-submenu"));
    const scopes = [...openSubmenus.reverse(), root];
    for (const scope of scopes) {
      const button = directContextMenuButtons(scope).find(
        (candidate) => candidate.dataset.contextAccessKey === key && !candidate.disabled
      );
      if (button) {
        return button;
      }
    }

    return null;
  }

  private setContextSubmenuOpen(button: HTMLButtonElement, toggle: boolean) {
    const item = button.closest<HTMLElement>(".context-menu-item");
    const parent = item?.parentElement;
    if (!item || !parent) {
      return;
    }

    Array.from(parent.children).forEach((child) => {
      if (child !== item && child instanceof HTMLElement && child.classList.contains("context-menu-item")) {
        child.classList.remove("is-submenu-open");
      }
    });

    item.classList.toggle("is-submenu-open", toggle ? !item.classList.contains("is-submenu-open") : true);
    this.clampContextSubmenus();
  }

  contextMenuTargetNode(menu: ContextMenuState): DesktopNode | AppNode | null {
    if (menu.type === "item") {
      return this.app.findNode(menu.nodeId);
    }

    if (menu.type === "folderItem") {
      return this.app.findFolderChild(menu.folderId, menu.childId);
    }

    return null;
  }

  closeContextMenu() {
    this.invalidateContextOverlay();
    if (!this.contextMenu) {
      return;
    }

    this.contextMenu = null;
    this.renderContextMenu();
  }

  clearContextOverlay() {
    this.invalidateContextOverlay();
    this.contextMenu = null;
    this.app.dialogs.ratioDialogTargetId = null;
    this.app.dialogs.resolveConfirmDialog(false);
    this.app.contextMenuLayer.classList.remove("is-open");
    this.app.contextMenuLayer.replaceChildren();
  }

  beginContextOverlayRequest() {
    this.invalidateContextOverlay();
    this.contextMenu = null;
    this.app.dialogs.ratioDialogTargetId = null;
    this.app.dialogs.resolveConfirmDialog(false);
    this.app.contextMenuLayer.classList.remove("is-open");
    this.app.contextMenuLayer.replaceChildren();
    return this.contextOverlayVersion;
  }

  invalidateContextOverlay() {
    this.contextOverlayVersion += 1;
  }

  private isCurrentContextOverlayRequest(version: number) {
    return this.contextOverlayVersion === version;
  }

  async openNativeContextMenu(
    node: AppNode,
    x: number,
    y: number,
    fallback: ContextMenuState
  ) {
    const requestVersion = this.beginContextOverlayRequest();

    try {
      const result = await showNativeItemContextMenu(node, x, y);
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      if (result.verb === "rename") {
        if (fallback.type === "folderItem") {
          this.app.rename.startFolderChildRename(fallback.folderId, fallback.childId);
        } else if (fallback.type === "item") {
          this.app.rename.startRename(fallback.nodeId);
        }
        return;
      }

      if (result.invoked) {
        await this.app.desktopSync.syncAfterNativeShellCommand();
      }
    } catch (error) {
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      console.warn("Unable to open native shell context menu", node.name, error);
      this.contextMenu = fallback;
      this.renderContextMenu();
    }
  }

  async openCustomDesktopContextMenu(x: number, y: number) {
    const requestVersion = this.beginContextOverlayRequest();
    if (this.cachedDesktopNativeMenuItems) {
      this.contextMenu = {
        type: "desktop",
        x,
        y,
        nativeItems: this.cachedDesktopNativeMenuItems
      };
      this.renderContextMenu();
      void this.loadNativeDesktopMenuItems().catch((error) => {
        console.warn("Unable to refresh native desktop context menu", error);
      });
      return;
    }

    try {
      const nativeItems = await this.loadNativeDesktopMenuItems();
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      this.contextMenu = { type: "desktop", x, y, nativeItems };
      this.renderContextMenu();
    } catch (error) {
      if (!this.isCurrentContextOverlayRequest(requestVersion)) {
        return;
      }

      console.warn("Unable to list native desktop context menu", error);
      this.contextMenu = { type: "desktop", x, y };
      this.renderContextMenu();
    }
  }

  loadNativeDesktopMenuItems() {
    if (this.desktopNativeMenuLoad) {
      return this.desktopNativeMenuLoad;
    }

    this.desktopNativeMenuLoad = listNativeDesktopContextMenu()
      .then((items) => {
        this.cachedDesktopNativeMenuItems = items;
        return items;
      })
      .finally(() => {
        this.desktopNativeMenuLoad = null;
      });

    return this.desktopNativeMenuLoad;
  }
}

function directContextMenuButtons(scope: HTMLElement) {
  return Array.from(scope.children)
    .map((child) => {
      if (!(child instanceof HTMLElement) || !child.classList.contains("context-menu-item")) {
        return null;
      }

      const button = child.firstElementChild;
      return button instanceof HTMLButtonElement ? button : null;
    })
    .filter((button): button is HTMLButtonElement => Boolean(button));
}
