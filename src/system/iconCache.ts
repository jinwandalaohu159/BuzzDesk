import type { AppNode } from "../types";

const iconCacheKey = "desktop-layer-icon-cache-v4";
const maxCachedIcons = 160;
const maxIconDataUrlLength = 220_000;

interface CachedIconEntry {
  iconDataUrl: string;
  updatedAt: number;
}

interface IconCachePayload {
  version: 1;
  entries: Record<string, CachedIconEntry>;
}

export function applyCachedIcons(items: AppNode[]) {
  const cache = loadIconCache();
  if (!cache) {
    return items;
  }

  return items.map((item) => {
    if (item.iconDataUrl) {
      return item;
    }

    const cached = cache.entries[cacheKeyForItem(item)];
    return cached ? { ...item, iconDataUrl: cached.iconDataUrl } : item;
  });
}

export function rememberIconImages(items: AppNode[]) {
  const cache = loadIconCache() ?? { version: 1 as const, entries: {} };
  const now = Date.now();
  let changed = false;

  for (const item of items) {
    if (!item.iconDataUrl || item.iconDataUrl.length > maxIconDataUrlLength) {
      continue;
    }

    const key = cacheKeyForItem(item);
    const existing = cache.entries[key];
    if (existing?.iconDataUrl === item.iconDataUrl) {
      existing.updatedAt = now;
      changed = true;
      continue;
    }

    cache.entries[key] = {
      iconDataUrl: item.iconDataUrl,
      updatedAt: now
    };
    changed = true;
  }

  if (!changed) {
    return;
  }

  saveIconCache(trimIconCache(cache));
}

function cacheKeyForItem(item: AppNode) {
  return [item.id, item.kind, item.name, item.path ?? "", item.launchId].join("\n");
}

function trimIconCache(cache: IconCachePayload) {
  const entries = Object.entries(cache.entries)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, maxCachedIcons);

  return {
    version: 1 as const,
    entries: Object.fromEntries(entries)
  };
}

function loadIconCache(): IconCachePayload | null {
  try {
    const raw = localStorage.getItem(iconCacheKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as IconCachePayload;
    return parsed.version === 1 && parsed.entries ? parsed : null;
  } catch {
    return null;
  }
}

function saveIconCache(cache: IconCachePayload) {
  try {
    localStorage.setItem(iconCacheKey, JSON.stringify(cache));
  } catch {
    // Icon cache is only a startup accelerator; failing to persist it is harmless.
  }
}
