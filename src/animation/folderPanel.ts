export async function playFolderClose(panel: HTMLElement, backdrop: HTMLElement | null) {
  const styles = getComputedStyle(panel);
  const originX = styles.getPropertyValue("--folder-open-x").trim() || "0px";
  const originY = styles.getPropertyValue("--folder-open-y").trim() || "0px";
  const originScale = styles.getPropertyValue("--folder-open-scale").trim() || ".18";
  const midX = `${(Number.parseFloat(originX) || 0) * 0.34}px`;
  const midY = `${(Number.parseFloat(originY) || 0) * 0.34}px`;
  const nearX = `${(Number.parseFloat(originX) || 0) * 0.74}px`;
  const nearY = `${(Number.parseFloat(originY) || 0) * 0.74}px`;

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
        opacity: 0.96,
        transform: `translate(calc(-50% + ${midX}), calc(-50% + ${midY})) scale(.7)`
      },
      {
        opacity: 0.44,
        transform: `translate(calc(-50% + ${nearX}), calc(-50% + ${nearY})) scale(.38)`
      },
      {
        opacity: 0,
        transform: `translate(calc(-50% + ${originX}), calc(-50% + ${originY})) scale(${originScale})`
      }
    ],
    {
      duration: 320,
      easing: "cubic-bezier(.16,1,.22,1)",
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
