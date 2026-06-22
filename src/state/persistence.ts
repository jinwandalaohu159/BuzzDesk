import type {
  AppNode,
  DesktopNode,
  DesktopSettings,
  PersistedDesktopState,
  PersistedItemNode,
  PersistedNode
} from "../types";

const storageKey = "desktop-layer-state-v1";

export function loadState(): PersistedDesktopState | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    return isPersistedDesktopState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveState(nodes: DesktopNode[], settings: DesktopSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(toPersistedState(nodes, settings)));
  } catch (error) {
    console.warn("Unable to persist desktop layout", error);
  }
}

function toPersistedState(nodes: PersistedNode[] | DesktopNode[], settings: DesktopSettings): PersistedDesktopState {
  return {
    version: 1,
    nodes: nodes.map(toPersistedNode),
    settings
  };
}

function toPersistedNode(node: PersistedNode | DesktopNode): PersistedNode {
  if (node.type === "item") {
    return toPersistedItem(node);
  }

  return {
    type: "folder",
    id: node.id,
    name: node.name,
    createdAt: node.createdAt,
    appearance: node.appearance,
    position: node.position ?? null,
    children: node.children.map(toPersistedItem)
  };
}

function toPersistedItem(node: PersistedItemNode | AppNode): PersistedItemNode {
  if ("launchId" in node) {
    return {
      type: "item",
      id: node.id,
      name: node.name,
      path: node.path ?? null,
      launchId: node.launchId,
      position: node.position ?? null
    };
  }

  return {
    type: "item",
    id: node.id,
    name: node.name,
    path: node.path ?? null,
    launchId: node.launchId ?? null,
    position: node.position ?? null
  };
}

function isPersistedDesktopState(value: unknown): value is PersistedDesktopState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<PersistedDesktopState>;
  return state.version === 1 && Array.isArray(state.nodes) && state.nodes.every(isPersistedNode);
}

function isPersistedNode(value: unknown): value is PersistedNode {
  if (!value || typeof value !== "object") {
    return false;
  }

  const node = value as Partial<PersistedNode>;
  if (isPersistedItemNode(value)) {
    return true;
  }

  if (node.type !== "folder") {
    return false;
  }

  const folder = node as Partial<Extract<PersistedNode, { type: "folder" }>>;
  return (
    typeof folder.id === "string" &&
    typeof folder.name === "string" &&
    typeof folder.createdAt === "number" &&
    Array.isArray(folder.children) &&
    folder.children.every(isPersistedItemNode)
  );
}

function isPersistedItemNode(value: unknown): value is PersistedItemNode {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<PersistedItemNode>;
  return item.type === "item" && typeof item.id === "string";
}
