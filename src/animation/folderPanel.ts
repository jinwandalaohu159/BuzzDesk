import { springs } from "./spring";

export interface FolderCloseOrigin {
  x: number;
  y: number;
  scale: number;
}

export async function playFolderOpen(
  panel: HTMLElement,
  backdrop: HTMLElement | null,
  origin: FolderCloseOrigin | null
) {
  const originLeft = origin?.x ?? 0;
  const originTop = origin?.y ?? 0;
  const originScale = origin?.scale ?? 0.18;
  const from = `translate3d(calc(-50% + ${originLeft}px), calc(-50% + ${originTop}px), 0) scale(${originScale})`;
  const to = "translate3d(-50%, -50%, 0) scale(1)";

  panel.getAnimations().forEach((animation) => animation.cancel());
  backdrop?.getAnimations().forEach((animation) => animation.cancel());

  panel.style.opacity = "0";
  panel.style.transform = from;

  await waitForAnimationFrame();

  // Transform rides the spring; opacity resolves quickly so the panel reads as
  // one solid object growing out of the folder icon.
  const panelAnimation = panel.animate(
    [
      { transform: from },
      { transform: to }
    ],
    {
      duration: springs.open.duration,
      easing: springs.open.easing,
      fill: "forwards"
    }
  );
  const panelFade = panel.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 140,
    easing: "ease-out",
    fill: "forwards",
    composite: "replace"
  });

  const backdropAnimation = backdrop?.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 240,
    easing: "cubic-bezier(.2,.8,.2,1)",
    fill: "forwards"
  });

  await Promise.allSettled([panelAnimation.finished, panelFade.finished, backdropAnimation?.finished]);
  panel.style.opacity = "1";
  panel.style.transform = to;
}

export async function playFolderClose(
  panel: HTMLElement,
  backdrop: HTMLElement | null,
  origin: FolderCloseOrigin | null
) {
  const originLeft = origin?.x ?? 0;
  const originTop = origin?.y ?? 0;
  const originScale = origin?.scale ?? 0.18;
  const midScale = Math.max(0.42, Math.min(0.72, originScale * 2.8));
  const center = "translate3d(-50%, -50%, 0) scale(1)";
  const mid = `translate3d(calc(-50% + ${originLeft * 0.72}px), calc(-50% + ${originTop * 0.72}px), 0) scale(${midScale})`;
  const target = `translate3d(calc(-50% + ${originLeft}px), calc(-50% + ${originTop}px), 0) scale(${originScale})`;

  panel.getAnimations().forEach((animation) => animation.cancel());
  backdrop?.getAnimations().forEach((animation) => animation.cancel());

  panel.style.transform = center;
  panel.style.opacity = "1";

  const panelAnimation = panel.animate(
    [
      { opacity: 1, transform: center },
      { offset: 0.6, opacity: 0.9, transform: mid },
      { opacity: 0, transform: target }
    ],
    {
      duration: 300,
      easing: "cubic-bezier(.3,.7,.2,1)",
      fill: "forwards"
    }
  );

  const backdropAnimation = backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 240,
    easing: "cubic-bezier(.4,0,.2,1)",
    fill: "forwards"
  });

  await Promise.allSettled([panelAnimation.finished, backdropAnimation?.finished]);
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
