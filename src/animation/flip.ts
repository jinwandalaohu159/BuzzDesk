interface FlipRect {
  left: number;
  top: number;
}

export function captureRects(root: ParentNode): Map<string, FlipRect> {
  const rects = new Map<string, FlipRect>();
  const rootRect = root instanceof HTMLElement ? root.getBoundingClientRect() : { left: 0, top: 0 };

  root.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
    const id = element.dataset.nodeId;
    if (id) {
      rects.set(id, layoutRectForElement(element, rootRect));
    }
  });

  return rects;
}

interface FlipOptions {
  skipIds?: Set<string>;
  skipNewIds?: Set<string>;
}

export function playFlip(root: ParentNode, before: Map<string, FlipRect>, options: FlipOptions = {}) {
  requestAnimationFrame(() => {
    const rootRect = root instanceof HTMLElement ? root.getBoundingClientRect() : { left: 0, top: 0 };
    root.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
      const id = element.dataset.nodeId;
      if (!id || element.classList.contains("is-dragging")) {
        return;
      }

      if (options.skipIds?.has(id)) {
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

      const next = layoutRectForElement(element, rootRect);
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

function layoutRectForElement(element: HTMLElement, rootRect: Pick<DOMRect, "left" | "top">): FlipRect {
  const transform = parseTranslate3d(element.style.transform);
  if (!transform) {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  return {
    left: rootRect.left + transform.x,
    top: rootRect.top + transform.y
  };
}

function parseTranslate3d(transform: string) {
  const match = /translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px,\s*0\)/.exec(transform);
  if (!match) {
    return null;
  }

  return {
    x: Number(match[1]),
    y: Number(match[2])
  };
}

function cancelElementAnimations(element: HTMLElement) {
  element.getAnimations({ subtree: false }).forEach((animation) => animation.cancel());
}
