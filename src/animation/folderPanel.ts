export async function playFolderClose(panel: HTMLElement, backdrop: HTMLElement | null) {
  const styles = getComputedStyle(panel);
  const originX = styles.getPropertyValue("--folder-open-x").trim() || "0px";
  const originY = styles.getPropertyValue("--folder-open-y").trim() || "0px";
  const originScale = styles.getPropertyValue("--folder-open-scale").trim() || ".18";
  const driftX = `${(Number.parseFloat(originX) || 0) * 0.18}px`;
  const driftY = `${(Number.parseFloat(originY) || 0) * 0.18}px`;

  panel.getAnimations().forEach((animation) => animation.cancel());
  backdrop?.getAnimations().forEach((animation) => animation.cancel());

  panel.style.transform = "translate(-50%, -50%) scale(1)";
  panel.style.opacity = "1";

  const panelAnimation = panel.animate(
    [
      {
        opacity: 1,
        transform: "translate(-50%, -50%) scale(1)"
      },
      {
        opacity: 0.86,
        transform: `translate(calc(-50% + ${driftX}), calc(-50% + ${driftY})) scale(.92)`
      },
      {
        opacity: 0,
        transform: `translate(calc(-50% + ${originX}), calc(-50% + ${originY})) scale(${originScale})`
      }
    ],
    {
      duration: 280,
      easing: "cubic-bezier(.16,1,.22,1)",
      fill: "forwards"
    }
  );

  const backdropAnimation = backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 240,
    easing: "ease",
    fill: "forwards"
  });

  await Promise.allSettled([panelAnimation.finished, backdropAnimation?.finished]);
}

export function captureFolderItemRects(root: ParentNode): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  root.querySelectorAll<HTMLElement>("[data-parent-folder-id][data-folder-child-id]").forEach((element) => {
    const parentId = element.dataset.parentFolderId;
    const childId = element.dataset.folderChildId;
    if (parentId && childId) {
      rects.set(`${parentId}:${childId}`, element.getBoundingClientRect());
    }
  });
  return rects;
}

export function playFolderLayerMorph(
  root: ParentNode,
  beforePanel: DOMRect | null,
  beforeItems: Map<string, DOMRect>
) {
  requestAnimationFrame(() => {
    const panel = root.querySelector<HTMLElement>(".folder-panel");
    if (panel && beforePanel) {
      const nextPanel = panel.getBoundingClientRect();
      if (nextPanel.width > 0 && nextPanel.height > 0) {
        const scaleX = beforePanel.width / nextPanel.width;
        const scaleY = beforePanel.height / nextPanel.height;
        if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
          panel.getAnimations({ subtree: false }).forEach((animation) => animation.cancel());
          panel.animate(
            [
              { transform: `translate(-50%, -50%) scale(${scaleX}, ${scaleY})` },
              { transform: "translate(-50%, -50%) scale(1)" }
            ],
            {
              duration: 220,
              easing: "cubic-bezier(.16,1,.22,1)"
            }
          );
        }
      }
    }

    root.querySelectorAll<HTMLElement>("[data-parent-folder-id][data-folder-child-id]").forEach((element) => {
      const parentId = element.dataset.parentFolderId;
      const childId = element.dataset.folderChildId;
      if (!parentId || !childId) {
        return;
      }

      const previous = beforeItems.get(`${parentId}:${childId}`);
      if (!previous) {
        return;
      }

      const next = element.getBoundingClientRect();
      const dx = previous.left - next.left;
      const dy = previous.top - next.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        return;
      }

      element.getAnimations({ subtree: false }).forEach((animation) => animation.cancel());
      element.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0)` },
          { transform: "translate3d(0, 0, 0)" }
        ],
        {
          duration: 230,
          easing: "cubic-bezier(.16,1,.22,1)"
        }
      );
    });
  });
}
