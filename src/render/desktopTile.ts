import type {
  AppNode,
  DesktopNode,
  DesktopSettings,
  FolderNode,
  LayoutSlot
} from "../types";
import {
  folderCoverCssVariables,
  normalizeFolderAppearance,
  desktopTileMetrics,
  folderTileMetrics
} from "../settings/desktopSettings";

// Desktop tiles: icon, name, folder cover and the keyed in-place update.

export function renderDesktopNode(
  node: DesktopNode,
  slot: LayoutSlot,
  selectedIds: ReadonlySet<string>,
  renamingId: string | null,
  openingIds: ReadonlySet<string>,
  settings: DesktopSettings
) {
  const tile = document.createElement("div");
  tile.dataset.nodeId = node.id;
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  updateDesktopNodeElement(tile, node, slot, selectedIds, openingIds);

  if (node.type === "folder") {
    applyFolderTileShellStyle(tile, node, settings);
  }

  const icon = node.type === "folder" ? renderFolderCover(node, settings) : renderIcon(node);
  const label =
    renamingId === node.id ? renderRenameInput(node.id, node.name) : renderTileName(node.name);

  tile.append(icon, label);
  return tile;
}

// Everything about a tile that can change without rebuilding its content:
// position, size and state classes. Also clears transient drag/merge styling
// so a reused element always starts clean.
export function updateDesktopNodeElement(
  tile: HTMLElement,
  node: DesktopNode,
  slot: LayoutSlot,
  selectedIds: ReadonlySet<string>,
  openingIds: ReadonlySet<string>
) {
  let className = `desktop-tile ${node.type === "folder" ? "is-folder" : "is-item"}`;
  if (selectedIds.has(node.id)) {
    className += " is-selected";
  }
  if (openingIds.has(node.id)) {
    className += " is-opening";
  }
  if (tile.className !== className) {
    tile.className = className;
  }

  const transform = `translate3d(${slot.x}px, ${slot.y}px, 0)`;
  if (tile.style.transform !== transform) {
    tile.style.transform = transform;
  }
  tile.style.width = `${slot.width}px`;
  tile.style.height = `${slot.height}px`;
  tile.style.visibility = "";
  tile.style.removeProperty("--merge-pull-x");
  tile.style.removeProperty("--merge-pull-y");
  tile.setAttribute("aria-label", node.name);
}

// Identity of a tile's *content* (icon artwork, label, folder cover). Tiles
// whose key is unchanged are reused across renders instead of being rebuilt,
// which avoids re-creating and re-decoding every icon image.
export function desktopTileContentKey(node: DesktopNode, settingsKey: string, renaming: boolean) {
  const parts = [node.type, node.id, node.name, renaming ? "rename" : "", settingsKey];
  if (node.type === "folder") {
    parts.push(JSON.stringify(node.appearance ?? null));
    node.children.forEach((child) => parts.push(child.id, child.kind, iconKey(child.iconDataUrl)));
  } else {
    parts.push(node.kind, iconKey(node.iconDataUrl));
  }
  return parts.join("\u001f");
}

function iconKey(url: string | null | undefined) {
  // Data URLs are large; length plus tail is a cheap, reliable change marker.
  return url ? `${url.length}:${url.slice(-32)}` : "-";
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

export function renderTileName(name: string) {
  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = name;
  return label;
}

export function renderRenameInput(id: string, name: string) {
  const input = document.createElement("input");
  input.className = "tile-rename";
  input.value = name;
  input.maxLength = 128;
  input.dataset.renameId = id;
  input.setAttribute("aria-label", "重命名");
  return input;
}
