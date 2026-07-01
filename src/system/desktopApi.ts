import type {
  AppNode,
  AppProcessPriority,
  DesktopDiagnostics,
  DesktopSourceItem,
  PersistedDesktopState,
  NativeContextMenuItem,
  NativeContextMenuResult
} from "../types";
import { applyCachedIcons, rememberIconImages } from "./iconCache";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const updateReleaseUrl = "https://github.com/jinwandalaohu159/BuzzDesk/releases/latest";
const updateReleaseApiUrl = "https://api.github.com/repos/jinwandalaohu159/BuzzDesk/releases/latest";
export const currentAppVersion = __APP_VERSION__;

interface GitHubReleaseResponse {
  tag_name?: string;
  html_url?: string;
  name?: string | null;
  published_at?: string | null;
}

export interface UpdateReleaseCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseName?: string | null;
  publishedAt?: string | null;
}

let cachedInvoke: Invoke | null | undefined;

async function getInvoke(): Promise<Invoke | null> {
  if (cachedInvoke !== undefined) {
    return cachedInvoke;
  }

  if (!hasTauriRuntime()) {
    cachedInvoke = null;
    return cachedInvoke;
  }

  try {
    const api = await import("@tauri-apps/api/core");
    cachedInvoke = api.invoke as Invoke;
  } catch {
    cachedInvoke = null;
  }

  return cachedInvoke;
}

export async function prepareDesktopLayer() {
  const invoke = await getInvoke();
  document.documentElement.classList.toggle("is-browser-preview", !invoke);

  if (!invoke) {
    return true;
  }

  try {
    await invoke("hide_native_desktop_icons");
    return true;
  } catch (error) {
    console.warn("Unable to hide native desktop icons", error);
    return false;
  }
}

export async function showDesktopLayerWindow() {
  const invoke = await getInvoke();
  if (!invoke) {
    return true;
  }

  try {
    return await invoke<boolean>("show_desktop_layer_window");
  } catch (error) {
    console.warn("Unable to show desktop layer window", error);
    return false;
  }
}

export async function attachDesktopLayerWindow() {
  const invoke = await getInvoke();
  if (!invoke) {
    return true;
  }

  try {
    return await invoke<boolean>("attach_desktop_layer_window");
  } catch (error) {
    console.warn("Unable to attach desktop layer window", error);
    return false;
  }
}

export async function restoreNativeDesktopIcons() {
  const invoke = await getInvoke();
  if (!invoke) {
    return;
  }

  try {
    await invoke("show_native_desktop_icons");
  } catch (error) {
    console.warn("Unable to restore native desktop icons", error);
  }
}

export async function scanDesktopItems(options: { includeIcons?: boolean } = {}): Promise<AppNode[]> {
  const invoke = await getInvoke();
  const includeIcons = options.includeIcons ?? true;

  if (invoke) {
    try {
      const items = await invoke<DesktopSourceItem[]>(
        includeIcons ? "scan_desktop_items" : "scan_desktop_items_fast"
      );
      const nodes = items.map(toAppNode);
      if (includeIcons) {
        rememberIconImages(nodes);
        return nodes;
      }

      return applyCachedIcons(nodes);
    } catch (error) {
      console.warn("Unable to scan desktop items", error);
      return [];
    }
  }

  return mockDesktopItems();
}

export async function getDesktopDiagnostics(): Promise<DesktopDiagnostics | null> {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  try {
    return await invoke<DesktopDiagnostics>("desktop_diagnostics");
  } catch (error) {
    console.warn("Unable to collect desktop diagnostics", error);
    return null;
  }
}

export async function openDesktopItem(item: AppNode) {
  const invoke = await getInvoke();

  if (invoke) {
    await invoke("open_desktop_item", { launchId: item.launchId });
    return;
  }

  console.info("Open desktop item", item.name, item.launchId);
}

export async function copyDesktopItem(item: AppNode) {
  const invoke = await getInvoke();

  if (invoke) {
    await invoke("copy_desktop_item", { launchId: item.launchId });
    return;
  }

  await navigator.clipboard?.writeText(item.path ?? item.launchId);
}

export async function pasteDesktopItems() {
  const invoke = await getInvoke();

  if (invoke) {
    await invoke("paste_desktop_items");
  }
}

export async function createDesktopFolder() {
  const invoke = await getInvoke();

  if (invoke) {
    await invoke("create_desktop_folder");
  }
}

export async function renameDesktopItem(item: AppNode, name: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    console.info("Rename desktop item", item.name, name);
    return { ...item, name };
  }

  const renamed = await invoke<DesktopSourceItem>("rename_desktop_item", { launchId: item.launchId, name });
  return toAppNode(renamed);
}

export async function deleteDesktopItem(item: AppNode) {
  const invoke = await getInvoke();
  if (!invoke) {
    console.info("Delete desktop item", item.name);
    return;
  }

  await invoke("delete_desktop_item", { launchId: item.launchId });
}

export async function showDesktopItemProperties(item: AppNode) {
  const invoke = await getInvoke();
  if (!invoke) {
    console.info("Show properties", item.name);
    return;
  }

  await invoke("show_desktop_item_properties", { launchId: item.launchId });
}

export async function showNativeItemContextMenu(item: AppNode, x: number, y: number) {
  const invoke = await getInvoke();
  if (!invoke) {
    return { invoked: false, verb: null };
  }

  const result = await invoke<boolean | NativeContextMenuResult>("show_native_item_context_menu", {
    launchId: item.launchId,
    x: Math.round(x),
    y: Math.round(y)
  });
  return normalizeNativeContextMenuResult(result);
}

export async function listNativeDesktopContextMenu() {
  const invoke = await getInvoke();
  if (!invoke) {
    return [] as NativeContextMenuItem[];
  }

  return invoke<NativeContextMenuItem[]>("list_native_desktop_context_menu");
}

export async function invokeNativeDesktopContextMenuCommand(commandId: number) {
  const invoke = await getInvoke();
  if (!invoke) {
    return { invoked: false, verb: null };
  }

  const result = await invoke<boolean | NativeContextMenuResult>("invoke_native_desktop_context_menu_command", {
    commandId
  });
  return normalizeNativeContextMenuResult(result);
}

function normalizeNativeContextMenuResult(result: boolean | NativeContextMenuResult): NativeContextMenuResult {
  if (typeof result === "boolean") {
    return { invoked: result, verb: null };
  }

  return {
    invoked: Boolean(result.invoked),
    verb: result.verb ?? null
  };
}

export async function listenForSettingsRequests(callback: () => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }

  try {
    const api = await import("@tauri-apps/api/event");
    return await api.listen("desktop-layer-show-settings", callback);
  } catch (error) {
    console.warn("Unable to listen for tray settings requests", error);
    return () => {};
  }
}

export async function setAppProcessPriority(priority: AppProcessPriority) {
  const invoke = await getInvoke();
  if (!invoke) {
    console.info("Set app process priority", priority);
    return;
  }

  try {
    await invoke("set_app_process_priority", { priority });
  } catch (error) {
    console.warn("Unable to set app process priority", error);
  }
}

export async function loadDesktopState(): Promise<PersistedDesktopState | null> {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  try {
    return await invoke<PersistedDesktopState | null>("load_desktop_state");
  } catch (error) {
    console.warn("Unable to load native desktop state", error);
    return null;
  }
}

export async function saveDesktopState(state: PersistedDesktopState) {
  const invoke = await getInvoke();
  if (!invoke) {
    return;
  }

  try {
    await invoke("save_desktop_state", { state });
  } catch (error) {
    console.warn("Unable to save native desktop state", error);
  }
}

export async function logStartupEvent(event: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    return;
  }

  try {
    await invoke("log_startup_event", { event });
  } catch {
    // Startup logs are diagnostic only.
  }
}

export async function getStartupEnabled() {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  try {
    return await invoke<boolean>("get_startup_enabled");
  } catch (error) {
    console.warn("Unable to read startup setting", error);
    return null;
  }
}

export async function setStartupEnabled(enabled: boolean) {
  const invoke = await getInvoke();
  if (!invoke) {
    console.info("Set startup enabled", enabled);
    return;
  }

  await invoke("set_startup_enabled", { enabled });
}

export async function checkForUpdateRelease(): Promise<UpdateReleaseCheckResult> {
  const response = await fetch(updateReleaseApiUrl, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed: ${response.status}`);
  }

  const release = (await response.json()) as GitHubReleaseResponse;
  const latestVersion = normalizeVersionTag(release.tag_name ?? release.name ?? "");
  if (!latestVersion) {
    throw new Error("GitHub latest release does not contain a version tag");
  }

  return {
    currentVersion: currentAppVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentAppVersion) > 0,
    releaseUrl: release.html_url ?? updateReleaseUrl,
    releaseName: release.name ?? null,
    publishedAt: release.published_at ?? null
  };
}

export async function openUpdateReleasePage(url = updateReleaseUrl) {
  if (!hasTauriRuntime()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  const invoke = await getInvoke();
  if (!invoke) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  try {
    await invoke("open_update_release_page", { url });
  } catch (error) {
    console.warn("Unable to open update release page", error);
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function normalizeVersionTag(value: string) {
  return value.trim().replace(/^v/i, "");
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length, 3); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  if (a.prerelease && !b.prerelease) {
    return -1;
  }

  if (!a.prerelease && b.prerelease) {
    return 1;
  }

  return a.prerelease.localeCompare(b.prerelease);
}

function parseVersion(value: string) {
  const [core, prerelease = ""] = normalizeVersionTag(value).split("-", 2);
  return {
    numbers: core.split(".").map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    }),
    prerelease
  };
}

function toAppNode(item: DesktopSourceItem): AppNode {
  return {
    ...item,
    type: "item",
    iconDataUrl: item.iconDataUrl ?? null
  };
}

function mockDesktopItems(): AppNode[] {
  const names = [
    "Cursor",
    "VS Code",
    "Chrome",
    "Figma",
    "Steam",
    "\u5fae\u4fe1",
    "\u6b64\u7535\u8111",
    "\u56de\u6536\u7ad9",
    "Downloads",
    "Notes",
    "Photoshop"
  ];

  return names.map((name, index) => ({
    id: `mock:${name}`,
    type: "item",
    name,
    kind: index > 5 ? "system" : "app",
    launchId: `mock:${name}`,
    path: null,
    iconDataUrl: makeMockIcon(name, index),
    isVirtual: index > 5
  }));
}

function makeMockIcon(name: string, index: number) {
  const hue = (index * 39 + 205) % 360;
  const letter = [...name][0]?.toUpperCase() ?? "A";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="hsl(${hue}, 78%, 62%)"/>
          <stop offset="1" stop-color="hsl(${(hue + 64) % 360}, 82%, 44%)"/>
        </linearGradient>
      </defs>
      <rect x="22" y="22" width="212" height="212" rx="52" fill="url(#g)"/>
      <text x="128" y="150" text-anchor="middle" font-size="96" font-family="Segoe UI, sans-serif" font-weight="700" fill="white">${letter}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function hasTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as Window & { __TAURI_INTERNALS__?: unknown })
  );
}

export function isDesktopRuntime() {
  return hasTauriRuntime();
}
