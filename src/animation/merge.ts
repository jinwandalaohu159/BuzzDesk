export async function playMergeIntoTarget(sourceElement: HTMLElement, targetElement: HTMLElement) {
  const sourceRect = sourceElement.getBoundingClientRect();
  const targetRect = targetElement.getBoundingClientRect();

  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) {
    return;
  }

  const ghost = sourceElement.cloneNode(true) as HTMLElement;
  const targetGhost = targetElement.cloneNode(true) as HTMLElement;
  const originalVisibility = sourceElement.style.visibility;
  const scale = Math.max(0.26, Math.min(0.42, targetRect.width / sourceRect.width * 0.42));
  const targetX = targetRect.left + targetRect.width / 2 - (sourceRect.width * scale) / 2;
  const targetY = targetRect.top + targetRect.height / 2 - (sourceRect.height * scale) / 2;

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
  document.body.append(targetGhost, ghost);

  try {
    const flight = ghost.animate(
      [
        {
          opacity: 1,
          transform: `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(1)`
        },
        {
          opacity: 0.92,
          transform: `translate3d(${targetX}px, ${targetY}px, 0) scale(${scale})`
        },
        {
          opacity: 0,
          transform: `translate3d(${targetX}px, ${targetY}px, 0) scale(${scale * 0.82})`
        }
      ],
      {
        duration: 230,
        easing: "cubic-bezier(.16,1,.22,1)",
        fill: "forwards"
      }
    );

    const targetPulse = targetGhost.animate(
      [
        { opacity: 0.96, transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1)` },
        { opacity: 1, transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1.07)` },
        { opacity: 0.66, transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(.98)` }
      ],
      {
        duration: 250,
        easing: "cubic-bezier(.16,1,.22,1)",
        fill: "forwards"
      }
    );

    await Promise.allSettled([flight.finished, targetPulse.finished]);
  } finally {
    sourceElement.style.visibility = originalVisibility;
    ghost.remove();
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
  const scale = Math.max(0.76, Math.min(0.98, (originRect.width / targetRect.width) * 0.94));

  folderElement.animate(
    [
      {
        opacity: 0.54,
        transform: `${baseTransform} translate3d(${dx}px, ${dy}px, 0) scale(${scale})`
      },
      {
        opacity: 1,
        transform: `${baseTransform} translate3d(${dx * 0.12}px, ${dy * 0.12}px, 0) scale(1.035)`
      },
      {
        opacity: 1,
        transform: baseTransform
      }
    ],
    {
      duration: 320,
      easing: "cubic-bezier(.16,1,.22,1)"
    }
  );
}
