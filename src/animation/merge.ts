import { springs } from "./spring";
import { wait } from "../shared/timing";

// Merge animation, modelled on iOS folder creation: the icons themselves fly
// into their mini slots on the folder cover while a new folder grows out of the
// target icon. Ghost copies are captured *before* the store changes so the
// real DOM can re-render immediately underneath them.

export interface MergeGhost {
  element: HTMLElement;
  rect: DOMRect;
}

// Visible artwork of a tile: the icon image, fallback glyph or folder cover.
export function tileIconVisual(tile: HTMLElement) {
  return (
    tile.querySelector<HTMLElement>(".icon-shell > .app-icon") ??
    tile.querySelector<HTMLElement>(".icon-shell > .fallback-icon") ??
    tile.querySelector<HTMLElement>(".icon-shell > .folder-cover") ??
    tile.querySelector<HTMLElement>(".icon-shell")
  );
}

export function captureMergeGhosts(visuals: HTMLElement[]): MergeGhost[] {
  return visuals
    .map((visual) => ({ visual, rect: visual.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .map(({ visual, rect }) => {
      const element = visual.cloneNode(true) as HTMLElement;
      element.classList.add("merge-ghost");
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      element.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
      document.body.append(element);
      return { element, rect };
    });
}

export function discardMergeGhosts(ghosts: MergeGhost[]) {
  ghosts.forEach((ghost) => ghost.element.remove());
}

export async function playMergeMorph(
  ghosts: MergeGhost[],
  folderTile: HTMLElement | null,
  firstSlotIndex: number,
  growFrom: DOMRect | null
) {
  const cover = folderTile?.querySelector<HTMLElement>(".folder-cover") ?? null;
  if (!folderTile || !cover) {
    await fadeOutGhosts(ghosts);
    return;
  }

  // Measure everything before any animation transforms the cover.
  const coverRect = cover.getBoundingClientRect();
  const minis = Array.from(cover.children) as HTMLElement[];
  const destinations = ghosts.map((_, index) => {
    const mini = minis[firstSlotIndex + index] ?? null;
    const rect = mini?.getBoundingClientRect() ?? centeredRect(coverRect, coverRect.width * 0.24);
    return { mini, rect };
  });
  destinations.forEach(({ mini }) => {
    if (mini) {
      mini.style.opacity = "0";
    }
  });

  if (growFrom && growFrom.width > 0) {
    const scale = Math.max(0.5, Math.min(1.2, growFrom.width / coverRect.width));
    const dx = growFrom.left + growFrom.width / 2 - (coverRect.left + coverRect.width / 2);
    const dy = growFrom.top + growFrom.height / 2 - (coverRect.top + coverRect.height / 2);
    cover.animate(
      [
        { opacity: 0.35, transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale})` },
        { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }
      ],
      { duration: springs.pop.duration, easing: springs.pop.easing }
    );
    folderTile.querySelector<HTMLElement>(".tile-name")?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 220, delay: 120, easing: "ease-out", fill: "backwards" }
    );
  } else {
    cover.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.07)", offset: 0.4 },
        { transform: "scale(1)" }
      ],
      { duration: 380, delay: 120, easing: "cubic-bezier(.3,.7,.3,1)" }
    );
  }

  await Promise.allSettled(
    ghosts.map(async (ghost, index) => {
      const { mini, rect } = destinations[index];
      const scale = rect.width / ghost.rect.width;
      const flight = ghost.element.animate(
        [
          { transform: `translate3d(${ghost.rect.left}px, ${ghost.rect.top}px, 0) scale(1)` },
          { transform: `translate3d(${rect.left}px, ${rect.top}px, 0) scale(${scale})` }
        ],
        {
          duration: springs.merge.duration,
          easing: springs.merge.easing,
          delay: Math.min(index * 32, 128),
          fill: "forwards"
        }
      );

      // The spring is visually at rest well before its nominal end; hand over
      // to the real mini icon once the ghost has essentially landed.
      await Promise.race([flight.finished, wait(Math.min(index * 32, 128) + springs.merge.duration * 0.62)]);
      if (mini) {
        mini.style.opacity = "";
        mini.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90, easing: "linear" });
      }
      const fade = ghost.element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, fill: "forwards" });
      await fade.finished.catch(() => undefined);
      flight.cancel();
      ghost.element.remove();
    })
  );
}

async function fadeOutGhosts(ghosts: MergeGhost[]) {
  await Promise.allSettled(
    ghosts.map((ghost) =>
      ghost.element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).finished
    )
  );
  discardMergeGhosts(ghosts);
}

function centeredRect(rect: DOMRect, size: number) {
  return new DOMRect(rect.left + (rect.width - size) / 2, rect.top + (rect.height - size) / 2, size, size);
}


export async function playTrashGroupIntoTarget(
  sourceElements: HTMLElement[],
  targetElement: HTMLElement
) {
  const sources = sourceElements
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter((source) => source.rect.width && source.rect.height);
  const targetRect = targetElement.getBoundingClientRect();

  if (sources.length === 0 || !targetRect.width || !targetRect.height) {
    return;
  }

  const originalTargetTransform = targetElement.style.transform;
  const originalTargetTransformOrigin = targetElement.style.transformOrigin;
  const baseTargetTransform = originalTargetTransform || "translate3d(0, 0, 0)";
  const targetCenterX = targetRect.left + targetRect.width / 2;
  const targetCenterY = targetRect.top + targetRect.height / 2;

  const ghosts = sources.map((source) => {
    const ghost = source.element.cloneNode(true) as HTMLElement;
    ghost.classList.add("merge-flight");
    ghost.style.width = `${source.rect.width}px`;
    ghost.style.height = `${source.rect.height}px`;
    ghost.style.transform = `translate3d(${source.rect.left}px, ${source.rect.top}px, 0) scale(1)`;
    ghost.style.transformOrigin = "top left";
    return ghost;
  });

  sources.forEach((source) => {
    source.element.style.visibility = "hidden";
  });
  document.body.append(...ghosts);

  try {
    const flights = ghosts.map((ghost, index) => {
      const sourceRect = sources[index].rect;
      const sourceCenterX = sourceRect.left + sourceRect.width / 2;
      const sourceCenterY = sourceRect.top + sourceRect.height / 2;
      const sourceScale = Math.max(0.12, Math.min(0.24, (targetRect.width / sourceRect.width) * 0.22));
      const transformAt = (progress: number, scale: number) => {
        const centerX = sourceCenterX + (targetCenterX - sourceCenterX) * progress;
        const centerY = sourceCenterY + (targetCenterY - sourceCenterY) * progress;
        const x = centerX - (sourceRect.width * scale) / 2;
        const y = centerY - (sourceRect.height * scale) / 2;
        return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
      };

      return ghost.animate(
        [
          {
            offset: 0,
            opacity: 1,
            transform: transformAt(0, 1)
          },
          {
            offset: 0.28,
            opacity: 0.96,
            transform: transformAt(0.34, 0.78)
          },
          {
            offset: 0.64,
            opacity: 0.82,
            transform: transformAt(0.78, 0.4)
          },
          {
            offset: 0.9,
            opacity: 0.36,
            transform: transformAt(1, sourceScale)
          },
          {
            offset: 1,
            opacity: 0,
            transform: transformAt(1, sourceScale * 0.58)
          }
        ],
        {
          delay: Math.min(index * 12, 48),
          duration: 260,
          easing: "cubic-bezier(.2,.86,.16,1)",
          fill: "forwards"
        }
      );
    });

    targetElement.style.transformOrigin = "center";
    const targetPulse = targetElement.animate(
      [
        {
          offset: 0,
          transform: baseTargetTransform
        },
        {
          offset: 0.42,
          transform: `${baseTargetTransform} scale(1.045)`
        },
        {
          offset: 1,
          transform: baseTargetTransform
        }
      ],
      {
        duration: 260 + Math.min((sources.length - 1) * 12, 48),
        easing: "cubic-bezier(.16,.94,.18,1)"
      }
    );

    await Promise.allSettled([...flights.map((flight) => flight.finished), targetPulse.finished]);
  } finally {
    targetElement.style.transform = originalTargetTransform;
    targetElement.style.transformOrigin = originalTargetTransformOrigin;
    ghosts.forEach((ghost) => ghost.remove());
  }
}
