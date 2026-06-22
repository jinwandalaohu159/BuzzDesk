export async function playFolderClose(panel: HTMLElement, backdrop: HTMLElement | null) {
  const styles = getComputedStyle(panel);
  const originX = styles.getPropertyValue("--folder-open-x").trim() || "0px";
  const originY = styles.getPropertyValue("--folder-open-y").trim() || "0px";
  const originScale = Number.parseFloat(styles.getPropertyValue("--folder-open-scale")) || 0.18;
  const originLeft = Number.parseFloat(originX) || 0;
  const originTop = Number.parseFloat(originY) || 0;
  const midX = `${originLeft * 0.28}px`;
  const midY = `${originTop * 0.28}px`;
  const nearX = `${originLeft * 0.68}px`;
  const nearY = `${originTop * 0.68}px`;
  const settleX = `${originLeft * 0.9}px`;
  const settleY = `${originTop * 0.9}px`;
  const nearScale = Math.max(0.34, Math.min(0.58, originScale * 2.4));
  const settleScale = Math.max(originScale * 1.45, Math.min(0.32, originScale + 0.1));

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
        offset: 0.44,
        opacity: 1,
        transform: `translate(calc(-50% + ${midX}), calc(-50% + ${midY})) scale(.78)`
      },
      {
        offset: 0.76,
        opacity: 0.9,
        transform: `translate(calc(-50% + ${nearX}), calc(-50% + ${nearY})) scale(${nearScale})`
      },
      {
        offset: 0.92,
        opacity: 0.58,
        transform: `translate(calc(-50% + ${settleX}), calc(-50% + ${settleY})) scale(${settleScale})`
      },
      {
        opacity: 0.02,
        transform: `translate(calc(-50% + ${originX}), calc(-50% + ${originY})) scale(${originScale})`
      }
    ],
    {
      duration: 300,
      easing: "cubic-bezier(.18,.86,.18,1)",
      fill: "forwards"
    }
  );

  const backdropAnimation = backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 280,
    easing: "ease",
    fill: "forwards"
  });

  await Promise.allSettled([panelAnimation.finished, backdropAnimation?.finished]);
}
