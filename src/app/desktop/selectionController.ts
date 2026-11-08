import type { DesktopApp } from "../DesktopApp";
import { DesktopMarquee, type MarqueeHost } from "./desktopMarquee";

export type SelectionControllerHost = Pick<DesktopApp, "folder" | "grid" | "store"> & MarqueeHost;

// Desktop icon selection: single / toggle selection and its DOM state. The
// rubber-band selection lives in DesktopMarquee.
export class SelectionController {
  selectedId: string | null = null;
  selectedIds = new Set<string>();
  readonly marquee: DesktopMarquee;

  constructor(private readonly app: SelectionControllerHost) {
    this.marquee = new DesktopMarquee(app, this);
  }

  desktopSelectionForRender() {
    const selected = new Set(this.selectedIds);
    if (this.selectedId) {
      selected.add(this.selectedId);
    }
    return selected;
  }

  setDesktopSelection(ids: Iterable<string>, primaryId?: string | null) {
    const nodes = new Set(this.app.store.getNodes().map((node) => node.id));
    const next = Array.from(new Set(ids)).filter((id) => nodes.has(id));
    this.selectedIds = new Set(next);
    this.selectedId =
      primaryId && this.selectedIds.has(primaryId)
        ? primaryId
        : next.length > 0
          ? next[next.length - 1]
          : null;
    this.app.folder.selectedFolderChild = null;
  }

  selectSingleDesktopNode(id: string | null) {
    if (!id) {
      this.clearDesktopSelection();
      return;
    }

    this.setDesktopSelection([id], id);
  }

  toggleDesktopNodeSelection(id: string) {
    const selected = this.desktopSelectionForRender();
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
    }

    this.setDesktopSelection(selected, selected.has(id) ? id : null);
  }

  clearDesktopSelection() {
    this.selectedId = null;
    this.selectedIds.clear();
  }

  clearAllSelection() {
    this.clearDesktopSelection();
    this.app.folder.selectedFolderChild = null;
  }

  applyDesktopSelectionToDom() {
    const selected = this.desktopSelectionForRender();
    this.app.grid.querySelectorAll<HTMLElement>("[data-node-id]").forEach((tile) => {
      const id = tile.dataset.nodeId;
      tile.classList.toggle("is-selected", Boolean(id && selected.has(id)));
    });
  }
}
