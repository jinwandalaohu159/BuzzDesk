// Identity keys for scanned desktop items: detects whether a rescan changed
// anything and whether deleted items have left the shell listing.
import type { AppNode } from "../../types";

export function desktopItemsSignature(items: AppNode[]) {
  return items
    .map((item) => [
      item.id,
      item.name,
      item.kind,
      item.path ?? "",
      item.launchId,
      item.isVirtual ? "1" : "0"
    ].join("\u001f"))
    .sort()
    .join("\u001e");
}

export function desktopItemIdentityKeys(items: AppNode[]) {
  const keys = new Set<string>();
  items.forEach((item) => addDesktopItemIdentityKeys(keys, item));
  return keys;
}

export function desktopItemMatchesIdentityKeys(item: AppNode, keys: Set<string>) {
  if (keys.has(`id:${item.id}`)) {
    return true;
  }

  return desktopItemPathKeys(item).some((key) => keys.has(key));
}

function addDesktopItemIdentityKeys(keys: Set<string>, item: AppNode) {
  keys.add(`id:${item.id}`);
  desktopItemPathKeys(item).forEach((key) => keys.add(key));
}

function desktopItemPathKeys(item: AppNode) {
  return [item.path, item.launchId]
    .filter((value): value is string => Boolean(value))
    .map((value) => `path:${normalizeDesktopItemPathKey(value)}`);
}

function normalizeDesktopItemPathKey(value: string) {
  let path = value.trim();
  if (path.startsWith("\\\\?\\UNC\\")) {
    path = `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  } else if (path.startsWith("\\\\?\\")) {
    path = path.slice("\\\\?\\".length);
  }

  return path.replace(/\//g, "\\").replace(/\\+$/g, "").toLocaleLowerCase();
}
