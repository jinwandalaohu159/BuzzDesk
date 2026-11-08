import type { AppNode } from "../types";

// Browser preview only (no Tauri runtime): a fake desktop to develop and test against.
export function mockDesktopItems(): AppNode[] {
  const names = [
    "Cursor",
    "VS Code",
    "Chrome",
    "Figma",
    "Steam",
    "\u5fae\u4fe1",
    "\u6b64\u7535\u8111",
    "\u56de\u6536\u7ad9",
    "Downloads",
    "Notes",
    "Photoshop"
  ];
  // Browser preview only: `?mockItems=40` simulates a crowded desktop.
  const wanted = Number(new URLSearchParams(window.location.search).get("mockItems"));
  for (let index = names.length; Number.isFinite(wanted) && index < Math.min(wanted, 200); index += 1) {
    names.push(`App ${index + 1}`);
  }

  return names.map((name, index) => ({
    id: `mock:${name}`,
    type: "item",
    name,
    kind: index > 5 && index < 11 ? "system" : "app",
    launchId: `mock:${name}`,
    path: null,
    iconDataUrl: makeMockIcon(name, index),
    isVirtual: index > 5 && index < 11
  }));
}

function makeMockIcon(name: string, index: number) {
  const hue = (index * 39 + 205) % 360;
  const letter = [...name][0]?.toUpperCase() ?? "A";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="hsl(${hue}, 78%, 62%)"/>
          <stop offset="1" stop-color="hsl(${(hue + 64) % 360}, 82%, 44%)"/>
        </linearGradient>
      </defs>
      <rect x="22" y="22" width="212" height="212" rx="52" fill="url(#g)"/>
      <text x="128" y="150" text-anchor="middle" font-size="96" font-family="Segoe UI, sans-serif" font-weight="700" fill="white">${letter}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
