export function captureRects(root: ParentNode): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();

  root.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
    const id = element.dataset.nodeId;
    if (id) {
      rects.set(id, element.getBoundingClientRect());
    }
  });

  return rects;
}

interface FlipOptions {
  skipNewIds?: Set<string>;
}

export function playFlip(root: ParentNode, before: Map<string, DOMRect>, options: FlipOptions = {}) {
  requestAnimationFrame(() => {
    root.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
      const id = element.dataset.nodeId;
      if (!id || element.classList.contains("is-dragging")) {
        return;
      }

      const previous = before.get(id);
      cancelElementAnimations(element);
      if (!previous) {
        if (options.skipNewIds?.has(id)) {
          return;
        }

        element.animate(
          [
            { opacity: 0, transform: `${element.style.transform} scale(.86)` },
            { opacity: 1, transform: element.style.transform }
          ],
          { duration: 190, easing: "cubic-bezier(.16,1,.22,1)" }
        );
        return;
      }

      const next = element.getBoundingClientRect();
      const dx = previous.left - next.left;
      const dy = previous.top - next.top;

      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        return;
      }

      element.animate(
        [
          { transform: `${element.style.transform} translate3d(${dx}px, ${dy}px, 0)` },
          { transform: element.style.transform }
        ],
        {
          duration: Math.min(320, Math.max(190, Math.hypot(dx, dy) * 1.6)),
          easing: "cubic-bezier(.16,1,.22,1)"
        }
      );
    });
  });
}

function cancelElementAnimations(element: HTMLElement) {
  element.getAnimations({ subtree: false }).forEach((animation) => animation.cancel());
}
