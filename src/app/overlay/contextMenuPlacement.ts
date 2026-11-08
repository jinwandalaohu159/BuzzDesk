import { clampScroll } from "../support/geometry";

// Keeps context menus and their submenus on screen: the usable screen area
// (minus the taskbar) and flipping / shifting submenus that would overflow it.
export function clampContextSubmenus(layer: HTMLElement) {
  const bounds = contextMenuSafeArea();
  const submenuGap = 4;
  const submenus = Array.from(layer.querySelectorAll<HTMLElement>(".context-submenu"));
  const previousSubmenuStyles = submenus.map((submenu) => ({
    submenu,
    display: submenu.style.display,
    visibility: submenu.style.visibility,
    pointerEvents: submenu.style.pointerEvents
  }));

  submenus.forEach((submenu) => {
    submenu.style.display = "grid";
    submenu.style.visibility = "hidden";
    submenu.style.pointerEvents = "none";
  });

  layer.querySelectorAll<HTMLElement>(".context-menu-item.has-submenu").forEach((item) => {
    const submenu = Array.from(item.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains("context-submenu")
    );
    if (!submenu) {
      return;
    }

    const floating = submenu.classList.contains("is-floating");
    item.classList.remove("opens-left");
    submenu.classList.remove("is-left");

    const itemRect = item.getBoundingClientRect();
    let submenuRect = submenu.getBoundingClientRect();

    if (floating) {
      const floatingGap = -1;
      let left = itemRect.right + floatingGap;
      if (
        left + submenuRect.width > bounds.right &&
        itemRect.left - submenuRect.width - floatingGap >= bounds.left
      ) {
        item.classList.add("opens-left");
        submenu.classList.add("is-left");
        left = itemRect.left - submenuRect.width - floatingGap;
      }
      left = clampScroll(left, bounds.left, Math.max(bounds.left, bounds.right - submenuRect.width));

      let top = itemRect.top - 8;
      if (top + submenuRect.height > bounds.bottom) {
        top -= top + submenuRect.height - bounds.bottom;
      }
      top = clampScroll(top, bounds.top, Math.max(bounds.top, bounds.bottom - submenuRect.height));

      submenu.style.left = `${Math.round(left)}px`;
      submenu.style.top = `${Math.round(top)}px`;
      return;
    }

    if (
      submenuRect.right > bounds.right &&
      itemRect.left - submenuRect.width - submenuGap >= bounds.left
    ) {
      item.classList.add("opens-left");
      submenu.classList.add("is-left");
      submenuRect = submenu.getBoundingClientRect();
    }

    let top = Number.parseFloat(submenu.style.top);
    if (!Number.isFinite(top)) {
      top = 0;
    }

    const bottomOverflow = submenuRect.bottom - bounds.bottom;
    if (bottomOverflow > 0) {
      top -= bottomOverflow;
    }

    const projectedTop = itemRect.top + top;
    if (projectedTop < bounds.top) {
      top += bounds.top - projectedTop;
    }

    submenu.style.top = `${Math.round(top)}px`;
  });

  previousSubmenuStyles.forEach(({ submenu, display, visibility, pointerEvents }) => {
    submenu.style.display = display;
    submenu.style.visibility = visibility;
    submenu.style.pointerEvents = pointerEvents;
  });
}

export function contextMenuSafeArea() {
  const edge = 8;
  const fallback = {
    left: edge,
    top: edge,
    right: Math.max(edge, window.innerWidth - edge),
    bottom: Math.max(edge, window.innerHeight - edge)
  };
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  const availLeft = Number.isFinite(screen.availLeft) ? Number(screen.availLeft) : window.screenX;
  const availTop = Number.isFinite(screen.availTop) ? Number(screen.availTop) : window.screenY;
  const availWidth = Number.isFinite(screen.availWidth) ? screen.availWidth : window.innerWidth;
  const availHeight = Number.isFinite(screen.availHeight) ? screen.availHeight : window.innerHeight;
  const screenX = Number.isFinite(window.screenX) ? window.screenX : 0;
  const screenY = Number.isFinite(window.screenY) ? window.screenY : 0;
  const left = Math.max(fallback.left, Math.round(availLeft - screenX + edge));
  const top = Math.max(fallback.top, Math.round(availTop - screenY + edge));
  const right = Math.min(fallback.right, Math.round(availLeft + availWidth - screenX - edge));
  const bottom = Math.min(fallback.bottom, Math.round(availTop + availHeight - screenY - edge));

  if (right - left < 240 || bottom - top < 160) {
    return fallback;
  }

  return { left, top, right, bottom };
}
