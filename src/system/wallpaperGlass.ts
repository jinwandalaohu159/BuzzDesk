import {
  captureDesktopBackdrop,
  desktopBackdropClear,
  getDesktopBackdropInfo,
  loadDesktopBackdrop,
  type DesktopBackdropInfo,
  type DesktopBackdropSnapshot
} from "./backdropApi";
import { wait, waitForPaint } from "../shared/timing";

// Real frosted glass for a transparent desktop layer.
//
// backdrop-filter cannot see what is behind a transparent WebView, and live
// wallpapers (Wallpaper Engine and friends) are not image files at all. So the
// glass blurs a snapshot of the desktop exactly as the user sees it: while no
// window covers the desktop, our own content is hidden for a moment and the
// screen is captured. The snapshot is cached per wallpaper, blurred once on a
// small canvas and exposed as a CSS image that glass surfaces paint aligned to
// the screen, so it costs nothing per frame.
const canvasScale = 1 / 6;
const blurCssPx = 34;
// How often to look for a wallpaper / monitor change.
const signatureCheckMs = 30_000;
// While a snapshot is due, how often to look for a moment the desktop is clear.
const pendingPollMs = 2_000;
// Time for the compositor to present the frame without our content.
const hiddenSettleMs = 70;
// Our content is never hidden for longer than this; a later capture is dropped.
const hiddenLimitMs = 600;
// Only blink the icons away once the user has left the desktop alone this long.
const idleBeforeCaptureMs = 1_500;

let appliedSignature: string | null = null;
// Every refresh bumps this; results from an older one are dropped, so a slow
// capture can never overwrite a newer image.
let generation = 0;
let pending: { info: DesktopBackdropInfo; generation: number } | null = null;
let lastInteractionAt = performance.now();
let pendingTimer: number | null = null;
let checkTimer: number | null = null;
let resizeTimer: number | null = null;
let currentUrl: string | null = null;
let busy = false;
const listeners = new Set<() => void>();

export function startWallpaperGlass() {
  void refreshWallpaperGlass(true);
  if (checkTimer !== null) {
    return;
  }

  const noteInteraction = () => {
    lastInteractionAt = performance.now();
  };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel"]) {
    window.addEventListener(type, noteInteraction, { capture: true, passive: true });
  }

  checkTimer = window.setInterval(() => void refreshWallpaperGlass(false), signatureCheckMs);
  window.addEventListener("resize", () => {
    if (resizeTimer !== null) {
      window.clearTimeout(resizeTimer);
    }
    resizeTimer = window.setTimeout(() => void refreshWallpaperGlass(true), 400);
  });
}

// Called whenever the glass image changes so anchored surfaces can re-measure.
export function onWallpaperGlassChange(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function refreshWallpaperGlass(force: boolean) {
  try {
    const info = await getDesktopBackdropInfo();
    if (!info || (!force && info.signature === appliedSignature) || info.signature === pending?.info.signature) {
      return;
    }

    const current = ++generation;
    const cached = await loadDesktopBackdrop(info.signature);
    if (current !== generation) {
      return;
    }
    if (cached) {
      pending = null;
      await applySnapshot(info, cached, current);
      return;
    }

    pending = { info, generation: current };
    scheduleCapture(idleBeforeCaptureMs);
  } catch (error) {
    console.warn("Unable to refresh desktop glass", error);
  }
}

function scheduleCapture(delay: number) {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
  }
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    void tryCapture();
  }, delay);
}

async function tryCapture() {
  const job = pending;
  if (!job || busy) {
    return;
  }

  busy = true;
  try {
    if (!readyToCapture() || !(await desktopBackdropClear())) {
      scheduleCapture(pendingPollMs);
      return;
    }
    // The check above awaited the native side; the user may have started
    // something meanwhile.
    if (!readyToCapture() || pending !== job) {
      scheduleCapture(pendingPollMs);
      return;
    }

    const snapshot = await captureWhileHidden(job.info.signature);
    if (!snapshot) {
      scheduleCapture(pendingPollMs);
      return;
    }
    if (pending === job) {
      pending = null;
    }
    await applySnapshot(job.info, snapshot, job.generation);
  } catch (error) {
    console.warn("Unable to capture the desktop", error);
    scheduleCapture(pendingPollMs * 4);
  } finally {
    busy = false;
  }
}

// Hides our content, snapshots the screen and shows it again — within
// hiddenLimitMs no matter how slow the native side is. A snapshot that arrives
// after the content is back could contain it, so it is dropped.
async function captureWhileHidden(signature: string) {
  const root = document.documentElement;
  root.classList.add("is-capturing-backdrop");
  let timedOut = false;
  const restore = window.setTimeout(() => {
    timedOut = true;
    root.classList.remove("is-capturing-backdrop");
  }, hiddenLimitMs);

  try {
    await waitForPaint();
    await wait(hiddenSettleMs);
    if (timedOut) {
      return null;
    }
    const snapshot = await captureDesktopBackdrop(signature);
    return timedOut ? null : snapshot;
  } finally {
    window.clearTimeout(restore);
    root.classList.remove("is-capturing-backdrop");
  }
}

function readyToCapture() {
  return !userIsBusy() && performance.now() - lastInteractionAt >= idleBeforeCaptureMs;
}

// Never blink the icons away while the user is in the middle of something.
function userIsBusy() {
  return (
    document.hidden ||
    Boolean(
      document.querySelector(
        [
          ".folder-layer.is-open",
          ".settings-layer.is-open",
          ".context-menu-layer.is-open",
          ".is-drag-active",
          ".desktop-tile.is-dragging",
          ".tile-rename",
          ".selection-marquee:not([hidden])",
          ".update-toast",
          ".delete-confirm-backdrop",
          ".ratio-dialog"
        ].join(", ")
      )
    )
  );
}

async function applySnapshot(info: DesktopBackdropInfo, snapshot: DesktopBackdropSnapshot, from: number) {
  const blob = await renderBlurredBackdrop(info, snapshot);
  if (!blob || from !== generation) {
    return;
  }

  const url = URL.createObjectURL(blob);
  await preloadImage(url);
  if (from !== generation) {
    URL.revokeObjectURL(url);
    return;
  }
  const root = document.documentElement;
  root.style.setProperty("--wallpaper-glass", `url("${url}")`);
  root.style.setProperty("--wallpaper-width", `${window.innerWidth}px`);
  root.style.setProperty("--wallpaper-height", `${window.innerHeight}px`);
  root.classList.add("has-wallpaper-glass");
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
  }
  currentUrl = url;
  appliedSignature = info.signature;
  listeners.forEach((listener) => listener());
}

async function renderBlurredBackdrop(info: DesktopBackdropInfo, snapshot: DesktopBackdropSnapshot) {
  const width = Math.max(8, Math.round(Math.max(1, window.innerWidth) * canvasScale));
  const height = Math.max(8, Math.round(Math.max(1, window.innerHeight) * canvasScale));

  // The layer window covers the virtual screen plus a bleed on every side; the
  // snapshot covers the virtual screen. Mapping through the window size (not
  // devicePixelRatio) keeps this correct under any DPI scaling.
  const perPhysicalX = width / (info.virtualWidth + info.layerBleed * 2);
  const perPhysicalY = height / (info.virtualHeight + info.layerBleed * 2);

  const base = document.createElement("canvas");
  base.width = width;
  base.height = height;
  const ctx = base.getContext("2d");
  if (!ctx) {
    return null;
  }

  const image = await createImageBitmap(snapshot.pixels);
  // Stretch over the whole canvas first so the off-screen bleed gets edge colors,
  // then draw it exactly where the screen is.
  ctx.drawImage(image, 0, 0, width, height);
  ctx.drawImage(
    image,
    info.layerBleed * perPhysicalX,
    info.layerBleed * perPhysicalY,
    info.virtualWidth * perPhysicalX,
    info.virtualHeight * perPhysicalY
  );
  image.close();
  return blurCanvas(base, blurCssPx * canvasScale);
}

// Blur with clamped edges: pad the source by stretching its border pixels so the
// blur doesn't pull transparent black in from outside the frame.
async function blurCanvas(source: HTMLCanvasElement, radius: number) {
  const pad = Math.ceil(radius * 3);
  const { width, height } = source;
  const padded = document.createElement("canvas");
  padded.width = width + pad * 2;
  padded.height = height + pad * 2;
  const pctx = padded.getContext("2d");
  if (!pctx) {
    return null;
  }

  pctx.drawImage(source, pad, pad);
  pctx.drawImage(source, 0, 0, 1, height, 0, pad, pad, height);
  pctx.drawImage(source, width - 1, 0, 1, height, width + pad, pad, pad, height);
  pctx.drawImage(source, 0, 0, width, 1, pad, 0, width, pad);
  pctx.drawImage(source, 0, height - 1, width, 1, pad, height + pad, width, pad);
  pctx.drawImage(source, 0, 0, 1, 1, 0, 0, pad, pad);
  pctx.drawImage(source, width - 1, 0, 1, 1, width + pad, 0, pad, pad);
  pctx.drawImage(source, 0, height - 1, 1, 1, 0, height + pad, pad, pad);
  pctx.drawImage(source, width - 1, height - 1, 1, 1, width + pad, height + pad, pad, pad);

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const octx = output.getContext("2d");
  if (!octx) {
    return null;
  }

  octx.filter = `blur(${radius}px) saturate(1.45) brightness(1.04)`;
  octx.drawImage(padded, -pad, -pad);
  octx.filter = "none";

  return new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
}

function preloadImage(url: string) {
  return new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = url;
  });
}

// Glass surfaces that are not full-screen or centered need to know where they sit
// on screen so the shared backdrop image lines up behind them.
export function anchorGlassSurfaces(scope: ParentNode, selector: string) {
  if (!document.documentElement.classList.contains("has-wallpaper-glass")) {
    return;
  }

  scope.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    const rect = element.getBoundingClientRect();
    element.style.setProperty("--glass-x", `${Math.round(-rect.left)}px`);
    element.style.setProperty("--glass-y", `${Math.round(-rect.top)}px`);
  });
}
