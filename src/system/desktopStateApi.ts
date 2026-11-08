import type { PersistedDesktopState } from "../types";
import { getInvoke } from "./nativeBridge";

// The desktop layout saved by the native side (survives WebView storage resets).
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
