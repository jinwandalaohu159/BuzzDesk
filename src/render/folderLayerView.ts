import type { FolderNode } from "../types";
import type { FolderPanelSize } from "../layout/grid";
import { renderIcon, renderTileName, renderRenameInput } from "./desktopTile";

// The open-folder panel markup: header, paged item grid and pager dots.

export interface FolderOpenOrigin {
  x: number;
  y: number;
  scale: number;
}

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

function renderFolderChildRenameInput(folderId: string, childId: string, name: string) {
  const input = renderRenameInput(childId, name);
  input.dataset.folderChildRenameId = childId;
  input.dataset.parentFolderId = folderId;
  return input;
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
