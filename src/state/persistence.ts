import type {
  AppNode,
  DesktopNode,
  DesktopSettings,
  PersistedDesktopState,
  PersistedItemNode,
  PersistedNode
} from "../types";

const storageKey = "desktop-layer-state-v1";
const settingsStorageKey = "desktop-layer-settings-v1";

export function loadState(): PersistedDesktopState | null {
  const savedSettings = loadSettingsState();

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return savedSettings ? emptyPersistedState(savedSettings) : null;
    }

    const parsed = JSON.parse(raw) as unknown;
    const state = toLoadedDesktopState(parsed);
    if (!state) {
      return savedSettings ? emptyPersistedState(savedSettings) : null;
    }

    return savedSettings ? { ...state, settings: savedSettings } : state;
  } catch {
    return savedSettings ? emptyPersistedState(savedSettings) : null;
  }
}

export function saveState(nodes: DesktopNode[], settings: DesktopSettings) {
  const state = toPersistedState(nodes, settings);

  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
  } catch (error) {
    console.warn("Unable to persist desktop settings", error);
  }

  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
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

function toLoadedDesktopState(value: unknown): PersistedDesktopState | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }

  const nodes = Array.isArray(value.nodes) ? value.nodes.filter(isPersistedNode) : [];
  const settings = isRecord(value.settings) ? (value.settings as Partial<DesktopSettings>) : undefined;
  if (!settings && nodes.length === 0) {
    return null;
  }

  return { version: 1, nodes, settings };
}

function loadSettingsState(): Partial<DesktopSettings> | null {
  try {
    const raw = localStorage.getItem(settingsStorageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as Partial<DesktopSettings>) : null;
  } catch {
    return null;
  }
}

function emptyPersistedState(settings: Partial<DesktopSettings>): PersistedDesktopState {
  return { version: 1, nodes: [], settings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
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
