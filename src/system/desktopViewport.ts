import { isDesktopRuntime } from "./nativeBridge";

// The layer window overhangs every screen edge by this many *physical* pixels
// (DESKTOP_LAYER_EDGE_BLEED_PX on the native side) so no seam shows.
const desktopLayerEdgeBleedPhysicalPx = 20;

export interface DesktopViewport {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

// The visible screen area inside the layer window, in CSS pixels.
export function desktopViewport(): DesktopViewport {
  const bleed = isDesktopRuntime() ? desktopLayerEdgeBleedPhysicalPx / (window.devicePixelRatio || 1) : 0;
  return {
    width: Math.max(1, window.innerWidth - bleed * 2),
    height: Math.max(1, window.innerHeight - bleed * 2),
    offsetX: bleed,
    offsetY: bleed
  };
}
