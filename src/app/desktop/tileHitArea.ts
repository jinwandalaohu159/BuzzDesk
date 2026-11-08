import { expandedRect, type Rect } from "../support/geometry";

// A desktop tile is a 106x124 box, but what the user sees of it is the icon and
// the name text under it. Only those count as "on the icon" — like Explorer, a
// press on the empty padding around them is a press on the desktop (it starts a
// marquee, not an icon drag) and a marquee only picks a tile up once it touches
// them.
const contentPadPx = 3;

export function tileContentRects(tile: HTMLElement): Rect[] {
  const rects: Rect[] = [];
  const shell = tile.querySelector<HTMLElement>(".icon-shell");
  if (shell) {
    rects.push(expandedRect(shell.getBoundingClientRect(), contentPadPx, contentPadPx));
  }

  const rename = tile.querySelector<HTMLElement>(".tile-rename");
  const label = rename ?? tile.querySelector<HTMLElement>(".tile-name");
  const text = label && (rename ? rename.getBoundingClientRect() : labelTextRect(label));
  if (text) {
    rects.push(expandedRect(text, contentPadPx, contentPadPx));
  }

  // Unrendered / unexpected markup: fall back to the whole tile.
  return rects.length > 0 ? rects : [expandedRect(tile.getBoundingClientRect(), 0, 0)];
}

export function pointHitsTileContent(tile: HTMLElement, x: number, y: number) {
  return tileContentRects(tile).some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}

// The name element spans the tile's full width; the text itself is usually
// narrower. Measure the glyph boxes, clipped to the element (line-clamp hides
// overflowing lines but they are still laid out).
function labelTextRect(label: HTMLElement): Rect | null {
  if (!label.textContent?.trim()) {
    return null;
  }

  const box = label.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(label);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const line of Array.from(range.getClientRects())) {
    if (line.width <= 0 || line.height <= 0 || line.top >= box.bottom || line.bottom <= box.top) {
      continue;
    }
    left = Math.min(left, line.left);
    top = Math.min(top, line.top);
    right = Math.max(right, line.right);
    bottom = Math.max(bottom, line.bottom);
  }
  range.detach();

  if (!Number.isFinite(left)) {
    return null;
  }
  left = Math.max(left, box.left);
  right = Math.min(right, box.right);
  top = Math.max(top, box.top);
  bottom = Math.min(bottom, box.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
