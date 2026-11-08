import type {
  AppNode,
  DesktopNode,
  DesktopPosition,
  PersistedDesktopState,
  PersistedItemNode,
  PersistedNode
} from "../types";
import { defaultFolderAppearance, normalizeFolderAppearance } from "../settings/desktopSettings";

// Matching saved desktop state against what is actually on the desktop now:
// which saved copy wins, which scanned item each saved node is, and cheap
// equality checks that keep the store from emitting no-op changes.

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

export function choosePersistedState(nativeState: PersistedDesktopState | null, localState: PersistedDesktopState | null) {
  if (!nativeState) {
    return localState;
  }

  if (!localState) {
    return nativeState;
  }

  return updatedAtOf(localState) > updatedAtOf(nativeState) ? localState : nativeState;
}

function updatedAtOf(state: PersistedDesktopState) {
  return Number.isFinite(state.updatedAt) ? Number(state.updatedAt) : 0;
}

export function reconcileNodesWithScanned(sourceNodes: Array<DesktopNode | PersistedNode>, scannedItems: AppNode[]) {
  const scanned = new Map(scannedItems.map((item) => [item.id, item]));
  const scannedByPath = createScannedPathIndex(scannedItems);
  const used = new Set<string>();
  const nodes: DesktopNode[] = [];

  for (const node of sourceNodes) {
    if (node.type === "item") {
      const current = resolveScannedItem(node, scanned, scannedByPath, used);
      if (current) {
        nodes.push({ ...current, position: normalizePosition(node.position) });
        used.add(current.id);
      }
      continue;
    }

    const children = node.children
      .map((child) => resolveScannedItem(child, scanned, scannedByPath, used))
      .filter((child): child is AppNode => Boolean(child));

    children.forEach((child) => used.add(child.id));

    if (children.length > 1) {
      nodes.push({
        type: "folder",
        id: node.id,
        name: node.name,
        createdAt: node.createdAt,
        position: normalizePosition(node.position),
        appearance: normalizeFolderAppearance(node.appearance, defaultFolderAppearance),
        children
      });
    } else {
      nodes.push(...children);
    }
  }

  for (const item of scannedItems) {
    if (!used.has(item.id)) {
      nodes.push(item);
    }
  }

  return nodes;
}

export function normalizePosition(position: unknown): DesktopPosition | null {
  if (!position || typeof position !== "object") {
    return null;
  }

  const value = position as Partial<DesktopPosition>;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    return null;
  }

  return {
    x: Math.round(Number(value.x)),
    y: Math.round(Number(value.y))
  };
}

export function sameNodeOrder(a: DesktopNode[], b: DesktopNode[]) {
  return a.length === b.length && a.every((node, index) => node.id === b[index]?.id);
}

export function sameItem(a: AppNode, b: AppNode) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.kind === b.kind &&
    (a.path ?? null) === (b.path ?? null) &&
    a.launchId === b.launchId &&
    (a.iconDataUrl ?? null) === (b.iconDataUrl ?? null) &&
    a.isVirtual === b.isVirtual
  );
}
