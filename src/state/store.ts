import type {
  AppNode,
  DesktopSettings,
  DesktopNode,
  FolderAppearanceSettings,
  FolderNode,
  PersistedNode
} from "../types";
import {
  createDefaultFolderAppearance,
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

export class DesktopStore {
  private nodes: DesktopNode[] = [];
  private settings: DesktopSettings = defaultDesktopSettings;
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

  hydrate(scannedItems: AppNode[]) {
    const saved = loadState();
    this.settings = normalizeDesktopSettings(saved?.settings);

    if (!saved) {
      this.nodes = scannedItems;
      this.persistAndEmit();
      return;
    }

    this.nodes = reconcileNodesWithScanned(saved.nodes, scannedItems);
    this.persistAndEmit();
  }

  syncScannedItems(scannedItems: AppNode[]) {
    this.nodes = this.nodes.length > 0
      ? reconcileNodesWithScanned(this.nodes, scannedItems)
      : scannedItems;
    this.persistAndEmit();
  }

  updateSettings(settings: Partial<DesktopSettings>) {
    this.settings = normalizeDesktopSettings({ ...this.settings, ...settings });
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
    const scanned = new Map(scannedItems.map((item) => [item.id, item]));
    const scannedByPath = createScannedPathIndex(scannedItems);
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

  dissolveFolder(folderId: string) {
    const next: DesktopNode[] = [];
    let changed = false;

    for (const node of this.nodes) {
      if (node.type === "folder" && node.id === folderId) {
        next.push(...node.children);
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
      createdAt: Date.now()
    };

    const insertionIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0);
    this.nodes = this.nodes.filter((_, index) => index !== sourceIndex && index !== targetIndex);
    this.nodes.splice(clampIndex(insertionIndex, this.nodes.length), 0, folder);
    this.persistAndEmit();
    return { changed: true, folderId: folder.id };
  }

  addDesktopItemToFolder(sourceId: string, folderId: string) {
    const sourceIndex = this.nodes.findIndex((node) => node.type === "item" && node.id === sourceId);
    const source = sourceIndex >= 0 ? (this.nodes[sourceIndex] as AppNode) : null;
    const folderExists = this.nodes.some((node) => node.type === "folder" && node.id === folderId);
    if (!source || !folderExists) {
      return false;
    }

    this.nodes = this.nodes
      .filter((_, index) => index !== sourceIndex)
      .map((node) =>
        node.type === "folder" && node.id === folderId
          ? {
              ...node,
              children: [...node.children, source]
            }
          : node
      );

    this.persistAndEmit();
    return true;
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

  moveFolderChildToDesktop(folderId: string, childId: string, targetIndex = this.nodes.length) {
    const folder = this.nodes.find((node): node is FolderNode => node.type === "folder" && node.id === folderId);
    const child = folder?.children.find((item) => item.id === childId) ?? null;
    if (!child) {
      return false;
    }

    this.nodes = this.nodes.map((node) =>
      node.type === "folder" && node.id === folderId
        ? { ...node, children: node.children.filter((item) => item.id !== childId) }
        : node
    );
    this.nodes.splice(clampIndex(targetIndex, this.nodes.length), 0, child);
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
      createdAt: Date.now()
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
        normalized.push(...node.children);
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
        nodes.push(current);
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
