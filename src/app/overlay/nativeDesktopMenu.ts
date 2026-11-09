import { listNativeDesktopContextMenu } from "../../system/desktopApi";
import type { NativeContextMenuItem } from "../../types";

// The first listing in a process can miss shell extensions that are still
// registering (they arrive in the background after the desktop menu is first
// asked for); the second one catches them before the user's first right-click.
const preloadDelaysMs = [300, 2_500];

// The Windows desktop context menu as last listed by the shell. Listing takes
// a moment, so menus open from this cache and refresh it behind the scenes.
export class NativeDesktopMenu {
  items: NativeContextMenuItem[] | null = null;
  private pending: Promise<NativeContextMenuItem[]> | null = null;

  // Lists the menu again (joining a listing already in flight).
  load() {
    this.pending ??= listNativeDesktopContextMenu()
      .then((items) => {
        this.items = items;
        return items;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  preload() {
    for (const delay of preloadDelaysMs) {
      window.setTimeout(() => {
        this.load().catch((error) => {
          console.warn("Unable to load the native desktop menu", error);
        });
      }, delay);
    }
  }
}
