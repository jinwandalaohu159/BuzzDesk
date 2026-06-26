import type { AppNode, PersistedItemNode } from "../types";

export function createScannedPathIndex(scannedItems: AppNode[]) {
  const index = new Map<string, AppNode[]>();

  for (const item of scannedItems) {
    addPathIndexEntry(index, item.path, item);
    addPathIndexEntry(index, item.launchId, item);
  }

  return index;
}

export function resolveScannedItem(
  savedItem: PersistedItemNode,
  scanned: Map<string, AppNode>,
  scannedByPath: Map<string, AppNode[]>,
  used: Set<string>
) {
  const direct = scanned.get(savedItem.id);
  if (direct && !used.has(direct.id)) {
    return direct;
  }

  for (const key of persistedLookupKeys(savedItem)) {
    const candidates = scannedByPath.get(normalizePathKey(key)) ?? [];
    const match = candidates.find((candidate) => !used.has(candidate.id));
    if (match) {
      return match;
    }
  }

  const legacyPath = savedItem.id.startsWith("path:") ? savedItem.id.slice("path:".length) : null;
  if (!legacyPath) {
    return null;
  }

  const candidates = scannedByPath.get(normalizePathKey(legacyPath)) ?? [];
  return candidates.find((candidate) => !used.has(candidate.id)) ?? null;
}

function addPathIndexEntry(index: Map<string, AppNode[]>, value: string | null | undefined, item: AppNode) {
  if (!value) {
    return;
  }

  const key = normalizePathKey(value);
  const existing = index.get(key);
  if (existing) {
    if (!existing.some((candidate) => candidate.id === item.id)) {
      existing.push(item);
    }
    return;
  }

  index.set(key, [item]);
}

function persistedLookupKeys(savedItem: PersistedItemNode) {
  const keys = [savedItem.path, savedItem.launchId].filter((value): value is string => Boolean(value));
  return Array.from(new Set(keys));
}

function normalizePathKey(value: string) {
  let path = value.trim();
  if (path.startsWith("\\\\?\\UNC\\")) {
    path = `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  } else if (path.startsWith("\\\\?\\")) {
    path = path.slice("\\\\?\\".length);
  }

  return path.replace(/\//g, "\\").replace(/\\+$/g, "").toLocaleLowerCase();
}
