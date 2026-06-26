import { isDesktopRuntime } from "./desktopApi";

export const desktopLayerEdgeBleed = 20;

export interface DesktopViewport {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export function desktopViewport(): DesktopViewport {
  const bleed = isDesktopRuntime() ? desktopLayerEdgeBleed : 0;
  return {
    width: Math.max(1, window.innerWidth - bleed * 2),
    height: Math.max(1, window.innerHeight - bleed * 2),
    offsetX: bleed,
    offsetY: bleed
  };
}
