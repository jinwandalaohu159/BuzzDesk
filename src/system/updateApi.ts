import { getInvoke, hasTauriRuntime } from "./nativeBridge";
import { updateReleaseUrl } from "./updateRelease";

// Downloading and handing over updates, and cleaning up legacy installs.
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

export interface UpdateDownloadProgress {
  downloaded: number;
  total: number | null;
}

// Downloads the installer through the native side and reports byte progress.
// Returns false when there is no native runtime (browser preview).
export async function downloadUpdateInstaller(
  url: string,
  fileName: string,
  onProgress: (progress: UpdateDownloadProgress) => void
) {
  const invoke = await getInvoke();
  if (!invoke) {
    window.open(url, "_blank", "noopener,noreferrer");
    return false;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<UpdateDownloadProgress>("update-download-progress", (event) => {
    onProgress(event.payload);
  });

  try {
    await invoke<string>("download_update_installer", { url, fileName });
    return true;
  } finally {
    unlisten();
  }
}

// Hands installation over to the helper process; the app exits right after.
export async function launchUpdateHelper(fileName: string, version: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    return;
  }

  await invoke("launch_update_helper", { fileName, version });
}

export interface LegacyInstall {
  version: string;
  location: string;
  uninstaller: string;
}

export async function detectLegacyInstall() {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  try {
    return await invoke<LegacyInstall | null>("detect_legacy_install");
  } catch (error) {
    console.warn("Unable to detect legacy install", error);
    return null;
  }
}

// Hands off to the helper process, which asks for elevation exactly once,
// removes the old Program Files copy and relaunches BuzzDesk.
export async function cleanupLegacyInstall(restoreStartup: boolean) {
  const invoke = await getInvoke();
  if (!invoke) {
    return;
  }

  await invoke("cleanup_legacy_install", { restoreStartup });
}
