import { getInvoke } from "./nativeBridge";

// Desktop snapshots for the frosted glass (see wallpaperGlass.ts).
export interface DesktopBackdropInfo {
  virtualX: number;
  virtualY: number;
  virtualWidth: number;
  virtualHeight: number;
  layerBleed: number;
  // Changes whenever the wallpaper or the monitor layout changes.
  signature: string;
}

export type DesktopBackdropSnapshot = {
  width: number;
  height: number;
  pixels: ImageData;
};

export async function getDesktopBackdropInfo() {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  return invoke<DesktopBackdropInfo>("get_desktop_backdrop_info");
}

// Whether no window covers the desktop right now.
export async function desktopBackdropClear() {
  const invoke = await getInvoke();
  if (!invoke) {
    return false;
  }

  return invoke<boolean>("desktop_backdrop_clear");
}

// Snapshot of the screen as it is now (the caller hides its own content first);
// null when a window covers the desktop.
export async function captureDesktopBackdrop(signature: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  return decodeBackdrop(await invoke<ArrayBuffer>("capture_desktop_backdrop", { signature }));
}

// The cached snapshot for this exact wallpaper, if any.
export async function loadDesktopBackdrop(signature: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  return decodeBackdrop(await invoke<ArrayBuffer>("load_desktop_backdrop", { signature }));
}

function decodeBackdrop(buffer: ArrayBuffer): DesktopBackdropSnapshot | null {
  if (buffer.byteLength < 8) {
    return null;
  }

  const header = new DataView(buffer, 0, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  if (width === 0 || height === 0 || buffer.byteLength < 8 + width * height * 4) {
    return null;
  }

  const pixels = new ImageData(new Uint8ClampedArray(buffer, 8, width * height * 4), width, height);
  return { width, height, pixels };
}
