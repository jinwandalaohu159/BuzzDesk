export async function playMergeIntoTarget(
  sourceElement: HTMLElement,
  targetElement: HTMLElement,
  options: { restoreOriginals?: boolean } = {}
) {
  const sourceRect = sourceElement.getBoundingClientRect();
  const targetRect = targetElement.getBoundingClientRect();

  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) {
    return;
  }

  const ghost = sourceElement.cloneNode(true) as HTMLElement;
  const targetGhost = targetElement.cloneNode(true) as HTMLElement;
  const originalVisibility = sourceElement.style.visibility;
  const originalTargetVisibility = targetElement.style.visibility;
  const sourceScale = Math.max(0.24, Math.min(0.38, targetRect.width / sourceRect.width * 0.38));
  const targetScale = 0.9;
  const targetCenterX = targetRect.left + targetRect.width / 2;
  const targetCenterY = targetRect.top + targetRect.height / 2;
  const sourceTargetX = targetCenterX - (sourceRect.width * sourceScale) / 2;
  const sourceTargetY = targetCenterY - (sourceRect.height * sourceScale) / 2;

  ghost.classList.add("merge-flight");
  ghost.style.width = `${sourceRect.width}px`;
  ghost.style.height = `${sourceRect.height}px`;
  ghost.style.transform = `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(1)`;
  ghost.style.transformOrigin = "top left";

  targetGhost.classList.add("merge-target-flight");
  targetGhost.style.width = `${targetRect.width}px`;
  targetGhost.style.height = `${targetRect.height}px`;
  targetGhost.style.transform = `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1)`;
  targetGhost.style.transformOrigin = "center";

  sourceElement.style.visibility = "hidden";
  targetElement.style.visibility = "hidden";
  document.body.append(targetGhost, ghost);

  try {
    const flight = ghost.animate(
      [
        {
          offset: 0,
          opacity: 1,
          transform: `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(1)`
        },
        {
          offset: 0.68,
          opacity: 0.94,
          transform: `translate3d(${sourceTargetX}px, ${sourceTargetY}px, 0) scale(${sourceScale})`
        },
        {
          offset: 1,
          opacity: 0,
          transform: `translate3d(${sourceTargetX}px, ${sourceTargetY}px, 0) scale(${sourceScale * 0.74})`
        }
      ],
      {
        duration: 300,
        easing: "cubic-bezier(.16,.94,.18,1)",
        fill: "forwards"
      }
    );

    const targetPulse = targetGhost.animate(
      [
        {
          offset: 0,
          opacity: 1,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1)`
        },
        {
          offset: 0.42,
          opacity: 1,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1.045)`
        },
        {
          offset: 0.68,
          opacity: 0.72,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(${targetScale})`
        },
        {
          offset: 1,
          opacity: 0,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(${targetScale * 0.96})`
        }
      ],
      {
        duration: 300,
        easing: "cubic-bezier(.16,.94,.18,1)",
        fill: "forwards"
      }
    );

    await Promise.allSettled([flight.finished, targetPulse.finished]);
  } finally {
    if (options.restoreOriginals ?? true) {
      sourceElement.style.visibility = originalVisibility;
      targetElement.style.visibility = originalTargetVisibility;
    }
    ghost.remove();
    targetGhost.remove();
  }
}

export async function playMergeGroupIntoTarget(
  sourceElements: HTMLElement[],
  targetElement: HTMLElement,
  options: { restoreOriginals?: boolean } = {}
) {
  const sources = sourceElements
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter((source) => source.rect.width && source.rect.height);
  const targetRect = targetElement.getBoundingClientRect();

  if (sources.length === 0 || !targetRect.width || !targetRect.height) {
    return;
  }

  const originalTargetVisibility = targetElement.style.visibility;
  const originalSourceVisibilities = sources.map((source) => source.element.style.visibility);
  const targetGhost = targetElement.cloneNode(true) as HTMLElement;
  const targetScale = 0.9;
  const targetCenterX = targetRect.left + targetRect.width / 2;
  const targetCenterY = targetRect.top + targetRect.height / 2;

  targetGhost.classList.add("merge-target-flight");
  targetGhost.style.width = `${targetRect.width}px`;
  targetGhost.style.height = `${targetRect.height}px`;
  targetGhost.style.transform = `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1)`;
  targetGhost.style.transformOrigin = "center";

  const ghosts = sources.map((source) => {
    const ghost = source.element.cloneNode(true) as HTMLElement;
    ghost.classList.add("merge-flight");
    ghost.style.width = `${source.rect.width}px`;
    ghost.style.height = `${source.rect.height}px`;
    ghost.style.transform = `translate3d(${source.rect.left}px, ${source.rect.top}px, 0) scale(1)`;
    ghost.style.transformOrigin = "top left";
    return ghost;
  });

  targetElement.style.visibility = "hidden";
  sources.forEach((source) => {
    source.element.style.visibility = "hidden";
  });
  document.body.append(targetGhost, ...ghosts);

  try {
    const flights = ghosts.map((ghost, index) => {
      const sourceRect = sources[index].rect;
      const sourceScale = Math.max(0.24, Math.min(0.38, (targetRect.width / sourceRect.width) * 0.38));
      const sourceTargetX = targetCenterX - (sourceRect.width * sourceScale) / 2;
      const sourceTargetY = targetCenterY - (sourceRect.height * sourceScale) / 2;

      return ghost.animate(
        [
          {
            offset: 0,
            opacity: 1,
            transform: `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(1)`
          },
          {
            offset: 0.68,
            opacity: 0.94,
            transform: `translate3d(${sourceTargetX}px, ${sourceTargetY}px, 0) scale(${sourceScale})`
          },
          {
            offset: 1,
            opacity: 0,
            transform: `translate3d(${sourceTargetX}px, ${sourceTargetY}px, 0) scale(${sourceScale * 0.74})`
          }
        ],
        {
          delay: Math.min(index * 14, 56),
          duration: 300,
          easing: "cubic-bezier(.16,.94,.18,1)",
          fill: "forwards"
        }
      );
    });

    const targetPulse = targetGhost.animate(
      [
        {
          offset: 0,
          opacity: 1,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1)`
        },
        {
          offset: 0.42,
          opacity: 1,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1.045)`
        },
        {
          offset: 0.68,
          opacity: 0.72,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(${targetScale})`
        },
        {
          offset: 1,
          opacity: 0,
          transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(${targetScale * 0.96})`
        }
      ],
      {
        duration: 300 + Math.min((sources.length - 1) * 14, 56),
        easing: "cubic-bezier(.16,.94,.18,1)",
        fill: "forwards"
      }
    );

    await Promise.allSettled([...flights.map((flight) => flight.finished), targetPulse.finished]);
  } finally {
    if (options.restoreOriginals ?? true) {
      targetElement.style.visibility = originalTargetVisibility;
      sources.forEach((source, index) => {
        source.element.style.visibility = originalSourceVisibilities[index];
      });
    }
    ghosts.forEach((ghost) => ghost.remove());
    targetGhost.remove();
  }
}

export function playFolderBirth(folderElement: HTMLElement, originRect: DOMRect) {
  const targetRect = folderElement.getBoundingClientRect();
  if (!originRect.width || !originRect.height || !targetRect.width || !targetRect.height) {
    return;
  }

  const baseTransform = folderElement.style.transform || "translate3d(0, 0, 0)";
  const dx = originRect.left - targetRect.left;
  const dy = originRect.top - targetRect.top;
  const scale = Math.max(0.78, Math.min(0.98, (originRect.width / targetRect.width) * 0.94));

  folderElement.animate(
    [
      {
        offset: 0,
        opacity: 0,
        transform: `${baseTransform} translate3d(${dx}px, ${dy}px, 0) scale(${Math.min(scale, 0.86)})`
      },
      {
        offset: 0.42,
        opacity: 0,
        transform: `${baseTransform} translate3d(${dx * 0.48}px, ${dy * 0.48}px, 0) scale(.94)`
      },
      {
        offset: 0.78,
        opacity: 0.96,
        transform: `${baseTransform} translate3d(${dx * 0.08}px, ${dy * 0.08}px, 0) scale(1.012)`
      },
      {
        offset: 1,
        opacity: 1,
        transform: baseTransform
      }
    ],
    {
      duration: 260,
      easing: "cubic-bezier(.16,.96,.18,1)",
      fill: "both"
    }
  );
}
