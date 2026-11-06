// Spatial keyboard navigation over the desktop grid (arrows, Home/End).
import type { DesktopNode, LayoutSlot } from "../types";

export function desktopNavigationNode(key: string, activeId: string | null | undefined, nodes: DesktopNode[],
layout: ReadonlyMap<string, LayoutSlot>
) {
  if (nodes.length === 0) {
    return null;
  }

  const currentIndex = nodes.findIndex((node) => node.id === activeId);
  if (key === "Home") {
    return nodes[0];
  }

  if (key === "End") {
    return nodes[nodes.length - 1];
  }

  if (currentIndex < 0) {
    return nodes[0];
  }

  if (key === "ArrowLeft") {
    return nodes[Math.max(0, currentIndex - 1)];
  }

  if (key === "ArrowRight") {
    return nodes[Math.min(nodes.length - 1, currentIndex + 1)];
  }

  return desktopVerticalNavigationNode(key, nodes[currentIndex], nodes, layout);
}

function desktopVerticalNavigationNode(key: string, current: DesktopNode, nodes: DesktopNode[],
layout: ReadonlyMap<string, LayoutSlot>
) {
  const currentSlot = layout.get(current.id);
  if (!currentSlot || (key !== "ArrowUp" && key !== "ArrowDown")) {
    return current;
  }

  const currentCenterX = currentSlot.x + currentSlot.width / 2;
  const currentCenterY = currentSlot.y + currentSlot.height / 2;
  let best: { node: DesktopNode; score: number } | null = null;

  for (const node of nodes) {
    if (node.id === current.id) {
      continue;
    }

    const slot = layout.get(node.id);
    if (!slot) {
      continue;
    }

    const centerX = slot.x + slot.width / 2;
    const centerY = slot.y + slot.height / 2;
    const deltaY = centerY - currentCenterY;
    if ((key === "ArrowDown" && deltaY <= 0.5) || (key === "ArrowUp" && deltaY >= -0.5)) {
      continue;
    }

    const score = Math.abs(deltaY) * 1000 + Math.abs(centerX - currentCenterX);
    if (!best || score < best.score) {
      best = { node, score };
    }
  }

  return best?.node ?? current;
}
