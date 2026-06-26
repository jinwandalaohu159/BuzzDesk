import type { AppNode } from "../types";

const warmedIcons = new Set<string>();

export async function warmIconImages(items: AppNode[], budgetMs = 90) {
  const sources = uniqueIconSources(items);
  const start = performance.now();
  let index = 0;

  for (; index < sources.length; index += 1) {
    const remaining = budgetMs - (performance.now() - start);
    if (remaining <= 0) {
      break;
    }

    await Promise.race([decodeIcon(sources[index]), delay(Math.min(remaining, 24))]);
  }

  scheduleRemainingWarmup(sources.slice(index));
}

function uniqueIconSources(items: AppNode[]) {
  const sources: string[] = [];

  for (const item of items) {
    const source = item.iconDataUrl;
    if (!source || warmedIcons.has(source)) {
      continue;
    }

    warmedIcons.add(source);
    sources.push(source);
  }

  return sources;
}

function scheduleRemainingWarmup(sources: string[]) {
  if (sources.length === 0) {
    return;
  }

  const run = async () => {
    const source = sources.shift();
    if (source) {
      await decodeIcon(source);
    }

    scheduleRemainingWarmup(sources);
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => {
      void run();
    }, { timeout: 700 });
    return;
  }

  setTimeout(() => {
    void run();
  }, 32);
}

function decodeIcon(source: string) {
  const image = new Image();
  image.decoding = "async";
  image.src = source;
  const decodable = image as HTMLImageElement & { decode?: () => Promise<void> };

  if (typeof decodable.decode === "function") {
    return decodable.decode().catch(() => undefined);
  }

  return new Promise<void>((resolve) => {
    image.onload = () => resolve();
    image.onerror = () => resolve();
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
