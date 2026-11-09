import type {
  AppNode,
  AppProcessPriority,
  DesktopDiagnostics,
  DesktopSourceItem,
  NativeContextMenuItem,
  NativeContextMenuResult
} from "../types";
import { applyCachedIcons, rememberIconImages } from "./iconCache";
import { mockDesktopItems } from "./mockDesktop";
import { getInvoke, hasTauriRuntime } from "./nativeBridge";

// The desktop layer window, desktop items and their shell operations, native
// context menus, tray requests, process priority and notifications.
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

// `label` is what the user clicked; the native side uses it to find the same
// command even when the menu's numbering moved since it was listed.
export async function invokeNativeDesktopContextMenuCommand(commandId: number, label?: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    return { invoked: false, verb: null };
  }

  const result = await invoke<boolean | NativeContextMenuResult>("invoke_native_desktop_context_menu_command", {
    commandId,
    label: label ?? null
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

export async function showSystemNotification(title: string, body: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    console.info("Notification", title, body);
    return;
  }

  try {
    await invoke("show_system_notification", { title, body });
  } catch (error) {
    console.warn("Unable to show system notification", error);
  }
}

function toAppNode(item: DesktopSourceItem): AppNode {
  return {
    ...item,
    type: "item",
    iconDataUrl: item.iconDataUrl ?? null
  };
}
