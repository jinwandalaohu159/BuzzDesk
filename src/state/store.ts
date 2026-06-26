import type {
  AppNode,
  DesktopSettings,
  DesktopNode,
  DesktopPosition,
  FolderAppearanceSettings,
  FolderNode,
  PersistedDesktopState,
  PersistedNode
} from "../types";
import {
  createDefaultFolderAppearance,
  desktopSystemIconIds,
  desktopSystemIconIdFromNodeId,
  normalizeFolderAppearance,
  defaultDesktopSettings,
  defaultFolderAppearance,
  normalizeDesktopSettings
} from "../settings/desktopSettings";
import { loadState, saveState } from "./persistence";
import { createScannedPathIndex, resolveScannedItem } from "./reconcile";

const defaultFolderName = "\u6587\u4ef6\u5939";

interface FolderCreationResult {
  changed: boolean;
  folderId: string | null;
}

interface MovePosition {
  id: string;
  position: DesktopPosition;
}

export class DesktopStore {
  private nodes: DesktopNode[] = [];
  private settings: DesktopSettings = defaultDesktopSettings;
  private scannedItems: AppNode[] = [];
  private listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getNodes() {
    return this.nodes;
  }

  getSettings() {
    return this.settings;
  }

  getScannedItems() {
    return this.scannedItems;
  }

  hydrate(scannedItems: AppNode[], nativeState: PersistedDesktopState | null = null) {
    const saved = choosePersistedState(nativeState, loadState());
    this.scannedItems = scannedItems;
    this.settings = normalizeDesktopSettings(saved?.settings);
    const visibleScannedItems = this.visibleScannedItems();

    if (!saved) {
      this.nodes = visibleScannedItems;
      this.persistAndEmit();
      return;
    }

    this.nodes = reconcileNodesWithScanned(saved.nodes, visibleScannedItems);
    this.persistAndEmit();
  }

  syncScannedItems(scannedItems: AppNode[]) {
    this.scannedItems = scannedItems;
    const visibleScannedItems = this.visibleScannedItems();
    this.nodes = this.nodes.length > 0
      ? reconcileNodesWithScanned(this.nodes, visibleScannedItems)
      : visibleScannedItems;
    this.persistAndEmit();
  }

  updateSettings(settings: Partial<DesktopSettings>) {
    const previousSystemIcons = this.settings.systemIcons;
    this.settings = normalizeDesktopSettings({ ...this.settings, ...settings });
    if (previousSystemIcons && systemIconsChanged(previousSystemIcons, this.settings.systemIcons)) {
      this.nodes = reconcileNodesWithScanned(this.nodes, this.visibleScannedItems());
    }
    this.persistAndEmit();
  }

  updateFolderAppearance(folderId: string, appearance: Partial<FolderAppearanceSettings>) {
    let changed = false;

    this.nodes = this.nodes.map((node) => {
      if (node.type !== "folder" || node.id !== folderId) {
        return node;
      }

      changed = true;
      return {
        ...node,
        appearance: normalizeFolderAppearance(
          { ...node.appearance, ...appearance },
          defaultFolderAppearance
        )
      };
    });

    if (!changed) {
      return false;
    }

    this.persistAndEmit();
    return true;
  }

  renameFolder(folderId: string, name: string) {
    this.nodes = this.nodes.map((node) => (node.type === "folder" && node.id === folderId ? { ...node, name } : node));
    this.persistAndEmit();
  }

  replaceItem(previousId: string, nextItem: AppNode) {
    let changed = false;

    this.nodes = this.nodes.map((node) => {
      if (node.type === "item") {
        if (node.id !== previousId) {
          return node;
        }

        changed = true;
        return nextItem;
      }

      let nodeChanged = false;
      const children = node.children.map((child) => {
        if (child.id !== previousId) {
          return child;
        }

        changed = true;
        nodeChanged = true;
        return nextItem;
      });

      return nodeChanged ? { ...node, children } : node;
    });

    if (!changed) {
      return false;
    }

    this.persistAndEmit();
    return true;
  }

  refreshKnownItems(scannedItems: AppNode[]) {
    this.scannedItems = scannedItems;
    const visibleScannedItems = this.visibleScannedItems();
    const scanned = new Map(visibleScannedItems.map((item) => [item.id, item]));
    const scannedByPath = createScannedPathIndex(visibleScannedItems);
    const used = new Set<string>();
    let changed = false;

    const refreshItem = (item: AppNode) => {
      const current = resolveScannedItem(item, scanned, scannedByPath, used);
      if (!current) {
        return item;
      }

      used.add(current.id);
      if (sameItem(item, current)) {
        return item;
      }

      changed = true;
      return current;
    };

    this.nodes = this.nodes.map((node) => {
      if (node.type === "item") {
        return refreshItem(node);
      }

      const children = node.children.map(refreshItem);
      return children.some((child, index) => child !== node.children[index])
        ? { ...node, children }
        : node;
    });

    if (!changed) {
      return false;
    }

    this.persistAndEmit();
    return true;
  }

  dissolveFolder(folderId: string, childPositions: MovePosition[] = []) {
    const next: DesktopNode[] = [];
    let changed = false;
    const positions = new Map(
      childPositions.map((entry) => [entry.id, normalizePosition(entry.position)])
    );

    for (const node of this.nodes) {
      if (node.type === "folder" && node.id === folderId) {
        next.push(
          ...node.children.map((child) => {
            const position = positions.get(child.id) ?? null;
            return position ? { ...child, position } : child;
          })
        );
        changed = true;
      } else {
        next.push(node);
      }
    }

    if (!changed) {
      return false;
    }

    this.nodes = next;
    this.persistAndEmit();
    return true;
  }

  moveDesktopNode(nodeId: string, targetIndex: number) {
    const currentIndex = this.nodes.findIndex((node) => node.id === nodeId);
    if (currentIndex < 0) {
      return false;
    }

    const [node] = this.nodes.splice(currentIndex, 1);
    const adjustedIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
    this.nodes.splice(clampIndex(adjustedIndex, this.nodes.length), 0, node);
    this.persistAndEmit();
    return true;
  }

  moveDesktopNodes(nodeIds: string[], targetIndex: number) {
    const movingIds = new Set(nodeIds);
    const moving = this.nodes.filter((node) => movingIds.has(node.id));
    if (moving.length === 0) {
      return false;
    }

    const removedBeforeTarget = this.nodes
      .slice(0, clampIndex(targetIndex, this.nodes.length))
      .filter((node) => movingIds.has(node.id)).length;
    const remaining = this.nodes.filter((node) => !movingIds.has(node.id));
    const insertionIndex = clampIndex(targetIndex - removedBeforeTarget, remaining.length);
    const next = [
      ...remaining.slice(0, insertionIndex),
      ...moving,
      ...remaining.slice(insertionIndex)
    ];

    if (next.map((node) => node.id).join("\n") === this.nodes.map((node) => node.id).join("\n")) {
      return false;
    }

    this.nodes = next;
    this.persistAndEmit();
    return true;
  }

  updateNodePositions(positions: MovePosition[]) {
    const updates = new Map(
      positions.map((entry) => [entry.id, normalizePosition(entry.position)])
    );
    if (updates.size === 0) {
      return false;
    }

    let changed = false;
    this.nodes = this.nodes.map((node) => {
      const position = updates.get(node.id);
      if (!position) {
        return node;
      }

      changed = true;
      return { ...node, position };
    });

    if (!changed) {
      return false;
    }

    this.persistAndEmit();
    return true;
  }

  updateNodeOrderAndPositions(orderedIds: string[], positions: MovePosition[]) {
    const order = new Map(orderedIds.map((id, index) => [id, index]));
    const updates = new Map(
      positions.map((entry) => [entry.id, normalizePosition(entry.position)])
    );
    if (order.size === 0 && updates.size === 0) {
      return false;
    }

    let changed = false;
    const next = this.nodes
      .map((node, index) => {
        const position = updates.get(node.id);
        if (!position) {
          return { node, index };
        }

        if (node.position?.x !== position.x || node.position?.y !== position.y) {
          changed = true;
          return { node: { ...node, position }, index };
        }

        return { node, index };
      })
      .sort((a, b) => {
        const aOrder = order.get(a.node.id);
        const bOrder = order.get(b.node.id);
        if (aOrder === undefined && bOrder === undefined) {
          return a.index - b.index;
        }
        if (aOrder === undefined) {
          return 1;
        }
        if (bOrder === undefined) {
          return -1;
        }
        return aOrder - bOrder || a.index - b.index;
      })
      .map((entry) => entry.node);

    if (next.map((node) => node.id).join("\n") !== this.nodes.map((node) => node.id).join("\n")) {
      changed = true;
    }

    if (!changed) {
      return false;
    }

    this.nodes = next;
    this.persistAndEmit();
    return true;
  }

  createFolder(sourceId: string, targetId: string): FolderCreationResult {
    const sourceIndex = this.nodes.findIndex((node) => node.type === "item" && node.id === sourceId);
    const targetIndex = this.nodes.findIndex((node) => node.type === "item" && node.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      return { changed: false, folderId: null };
    }

    const source = this.nodes[sourceIndex] as AppNode;
    const target = this.nodes[targetIndex] as AppNode;
    const folder: FolderNode = {
      type: "folder",
      id: `folder:${crypto.randomUUID()}`,
      name: defaultFolderName,
      children: [target, source],
      appearance: createDefaultFolderAppearance(),
      createdAt: Date.now(),
      position: target.position ?? null
    };

    const insertionIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0);
    this.nodes = this.nodes.filter((_, index) => index !== sourceIndex && index !== targetIndex);
    this.nodes.splice(clampIndex(insertionIndex, this.nodes.length), 0, folder);
    this.persistAndEmit();
    return { changed: true, folderId: folder.id };
  }

  addDesktopItemToFolder(sourceId: string, folderId: string) {
    return this.addDesktopItemsToFolder([sourceId], folderId);
  }

  addDesktopItemsToFolder(sourceIds: string[], folderId: string) {
    const movingIds = new Set(sourceIds);
    const sources = this.nodes.filter((node): node is AppNode => node.type === "item" && movingIds.has(node.id));
    const folderExists = this.nodes.some((node) => node.type === "folder" && node.id === folderId);
    if (sources.length === 0 || !folderExists) {
      return false;
    }

    this.nodes = this.nodes
      .filter((node) => !(node.type === "item" && movingIds.has(node.id)))
      .map((node) =>
        node.type === "folder" && node.id === folderId
          ? {
              ...node,
              children: [...node.children, ...sources]
            }
          : node
      );

    this.persistAndEmit();
    return true;
  }

  createFolderFromItems(sourceIds: string[], targetId: string): FolderCreationResult {
    const movingIds = new Set(sourceIds.filter((id) => id !== targetId));
    const sources = this.nodes.filter((node): node is AppNode => node.type === "item" && movingIds.has(node.id));
    const targetIndex = this.nodes.findIndex((node) => node.type === "item" && node.id === targetId);
    if (sources.length === 0 || targetIndex < 0) {
      return { changed: false, folderId: null };
    }

    const target = this.nodes[targetIndex] as AppNode;
    const folder: FolderNode = {
      type: "folder",
      id: `folder:${crypto.randomUUID()}`,
      name: defaultFolderName,
      children: [target, ...sources],
      appearance: createDefaultFolderAppearance(),
      createdAt: Date.now(),
      position: target.position ?? null
    };

    const insertionIndex = targetIndex - this.nodes.slice(0, targetIndex).filter((node) => movingIds.has(node.id)).length;
    this.nodes = this.nodes.filter(
      (node, index) => index !== targetIndex && !(node.type === "item" && movingIds.has(node.id))
    );
    this.nodes.splice(clampIndex(insertionIndex, this.nodes.length), 0, folder);
    this.persistAndEmit();
    return { changed: true, folderId: folder.id };
  }

  addFolderChildToFolder(sourceFolderId: string, childId: string, targetFolderId: string) {
    if (sourceFolderId === targetFolderId) {
      return false;
    }

    const sourceFolder = this.nodes.find(
      (node): node is FolderNode => node.type === "folder" && node.id === sourceFolderId
    );
    const targetExists = this.nodes.some((node) => node.type === "folder" && node.id === targetFolderId);
    const child = sourceFolder?.children.find((item) => item.id === childId) ?? null;
    if (!child || !targetExists) {
      return false;
    }

    this.nodes = this.nodes.map((node) => {
      if (node.type === "folder" && node.id === sourceFolderId) {
        return { ...node, children: node.children.filter((item) => item.id !== childId) };
      }

      if (node.type === "folder" && node.id === targetFolderId) {
        return { ...node, children: [...node.children, child] };
      }

      return node;
    });
    this.persistAndEmit();
    return true;
  }

  moveFolderChildToDesktop(
    folderId: string,
    childId: string,
    targetIndex = this.nodes.length,
    childPosition?: DesktopPosition | null
  ) {
    const folder = this.nodes.find((node): node is FolderNode => node.type === "folder" && node.id === folderId);
    const child = folder?.children.find((item) => item.id === childId) ?? null;
    if (!child) {
      return false;
    }

    const position = normalizePosition(childPosition) ?? child.position ?? null;
    const desktopChild = position ? { ...child, position } : child;
    this.nodes = this.nodes.map((node) =>
      node.type === "folder" && node.id === folderId
        ? { ...node, children: node.children.filter((item) => item.id !== childId) }
        : node
    );
    this.nodes.splice(clampIndex(targetIndex, this.nodes.length), 0, desktopChild);
    this.persistAndEmit();
    return true;
  }

  createFolderFromChild(sourceFolderId: string, childId: string, targetId: string): FolderCreationResult {
    const sourceFolder = this.nodes.find(
      (node): node is FolderNode => node.type === "folder" && node.id === sourceFolderId
    );
    const child = sourceFolder?.children.find((item) => item.id === childId) ?? null;
    const targetIndex = this.nodes.findIndex((node) => node.type === "item" && node.id === targetId);
    if (!child || targetIndex < 0) {
      return { changed: false, folderId: null };
    }

    const target = this.nodes[targetIndex] as AppNode;
    const folder: FolderNode = {
      type: "folder",
      id: `folder:${crypto.randomUUID()}`,
      name: defaultFolderName,
      children: [target, child],
      appearance: createDefaultFolderAppearance(),
      createdAt: Date.now(),
      position: target.position ?? null
    };

    this.nodes = this.nodes
      .map((node) =>
        node.type === "folder" && node.id === sourceFolderId
          ? { ...node, children: node.children.filter((item) => item.id !== childId) }
          : node
      )
      .filter((_, index) => index !== targetIndex);
    this.nodes.splice(clampIndex(targetIndex, this.nodes.length), 0, folder);
    this.persistAndEmit();
    return { changed: true, folderId: folder.id };
  }

  private normalizeFolders() {
    const normalized: DesktopNode[] = [];

    for (const node of this.nodes) {
      if (node.type === "folder" && node.children.length <= 1) {
        const inheritedPosition = normalizePosition(node.position);
        normalized.push(
          ...node.children.map((child) =>
            inheritedPosition ? { ...child, position: inheritedPosition } : child
          )
        );
      } else {
        normalized.push(node);
      }
    }

    this.nodes = normalized;
  }

  private persistAndEmit() {
    this.normalizeFolders();
    saveState(this.nodes, this.settings);
    this.listeners.forEach((listener) => listener());
  }

  private visibleScannedItems() {
    return this.scannedItems.filter((item) => {
      const systemIconId = desktopSystemIconIdFromNodeId(item.id);
      return !systemIconId || this.settings.systemIcons[systemIconId];
    });
  }
}

function choosePersistedState(nativeState: PersistedDesktopState | null, localState: PersistedDesktopState | null) {
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

function systemIconsChanged(a: DesktopSettings["systemIcons"], b: DesktopSettings["systemIcons"]) {
  return desktopSystemIconIds.some((id) => a[id] !== b[id]);
}

function reconcileNodesWithScanned(sourceNodes: Array<DesktopNode | PersistedNode>, scannedItems: AppNode[]) {
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

function clampIndex(index: number, length: number) {
  return Math.min(length, Math.max(0, index));
}

function normalizePosition(position: unknown): DesktopPosition | null {
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

function sameItem(a: AppNode, b: AppNode) {
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
