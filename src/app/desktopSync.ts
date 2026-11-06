// Keeps the virtual desktop in step with the real one: a cheap poll that only
// does a full (icon) scan when the item list actually changed, follow-up
// refreshes after shell commands, and deferral while the user is mid-gesture.
import { scanDesktopItems, isDesktopRuntime } from "../system/desktopApi";
import { warmIconImages } from "../system/iconWarmup";
import { desktopItemIdentityKeys, desktopItemMatchesIdentityKeys, desktopItemsSignature } from "./support/desktopItemIdentity";
import { scheduleIdleTask, wait } from "../shared/timing";
import type { AppNode } from "../types";

export interface DesktopSyncHost {
  syncScannedItems(items: AppNode[]): void;
  refreshKnownItems(items: AppNode[]): void;
  // Any interaction that a re-render would disturb (incl. an open folder).
  isBusy(): boolean;
  // Interactions that must not see items change underneath them at all.
  isHardBusy(): boolean;
  isFolderOpen(): boolean;
}

export class DesktopSync {
  private desktopScanSignature: string | null = null;
  private autoSyncTimer: number | null = null;
  private autoSyncInFlight = false;
  private fullDesktopLoadScheduled = false;
  private fullDesktopLoadInFlight = false;
  private pendingRefreshTimers: number[] = [];
  private deferredRefreshTimer: number | null = null;
  // Newest scan that arrived mid-gesture, applied once the gesture is over.
  private pendingScan: AppNode[] | null = null;
  private pendingScanTimer: number | null = null;

  constructor(private readonly host: DesktopSyncHost) {}

  rememberScan(items: AppNode[]) {
    this.desktopScanSignature = desktopItemsSignature(items);
  }

  async refreshDesktopItems(options: { keepPendingRefreshes?: boolean; deferIfBusy?: boolean } = {}) {
    if (!options.keepPendingRefreshes) {
      this.cancelPendingRefreshes();
    }

    if (options.deferIfBusy && this.host.isBusy()) {
      this.scheduleDeferredRefresh();
      return;
    }

    const items = await this.scanAndWarmDesktopItems(48);
    if (items.length === 0) {
      return;
    }

    this.applyScan(items);
  }

  // The only way scan results reach the store. Scans are slow, so the user
  // may have started a drag, a rename or a marquee since this one began: then
  // the result waits and is applied once they are done, so no tile is
  // re-keyed or re-rendered under their hands. The newest result wins.
  private applyScan(items: AppNode[]) {
    this.desktopScanSignature = desktopItemsSignature(items);
    if (this.host.isHardBusy()) {
      this.pendingScan = items;
      if (this.pendingScanTimer === null) {
        this.pendingScanTimer = window.setTimeout(() => {
          this.pendingScanTimer = null;
          const pending = this.pendingScan;
          if (pending) {
            this.applyScan(pending);
          }
        }, 250);
      }
      return;
    }

    this.pendingScan = null;
    this.host.syncScannedItems(items);
  }

  startDesktopAutoSync() {
    if (!isDesktopRuntime() || this.autoSyncTimer !== null) {
      return;
    }

    this.autoSyncTimer = window.setInterval(() => {
      void this.refreshDesktopItemsIfChanged();
    }, 4500);
  }

  stopDesktopAutoSync() {
    if (this.autoSyncTimer === null) {
      return;
    }

    window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
  }

  private async refreshDesktopItemsIfChanged() {
    if (this.autoSyncInFlight || this.host.isBusy()) {
      return;
    }

    this.autoSyncInFlight = true;
    try {
      const fastItems = await scanDesktopItems({ includeIcons: false });
      if (fastItems.length === 0) {
        return;
      }

      const signature = desktopItemsSignature(fastItems);
      if (signature === this.desktopScanSignature) {
        return;
      }

      const items = await this.scanAndWarmDesktopItems(12);
      if (items.length === 0) {
        return;
      }

      this.applyScan(items);
    } finally {
      this.autoSyncInFlight = false;
    }
  }

  private async scanAndWarmDesktopItems(iconWarmupBudgetMs = 90) {
    const items = await scanDesktopItems();
    await warmIconImages(items, iconWarmupBudgetMs);
    return items;
  }

  private async loadFullDesktopItemsAfterBoot() {
    if (this.fullDesktopLoadInFlight) {
      return;
    }

    if (this.host.isHardBusy()) {
      this.scheduleFullDesktopItemLoad(700);
      return;
    }

    this.fullDesktopLoadInFlight = true;
    try {
      const items = await this.scanAndWarmDesktopItems(18);
      if (items.length === 0) {
        return;
      }

      // With a folder open (and nothing else going on) only refresh what is
      // already shown; the structural sync follows once the folder closes.
      if (!this.host.isHardBusy() && this.host.isFolderOpen()) {
        this.desktopScanSignature = desktopItemsSignature(items);
        this.host.refreshKnownItems(items);
        this.scheduleDeferredRefresh(900);
        return;
      }

      this.applyScan(items);
    } finally {
      this.fullDesktopLoadInFlight = false;
    }
  }

  scheduleFullDesktopItemLoad(timeout = 900) {
    if (this.fullDesktopLoadScheduled || this.fullDesktopLoadInFlight) {
      return;
    }

    this.fullDesktopLoadScheduled = true;
    scheduleIdleTask(() => {
      this.fullDesktopLoadScheduled = false;
      void this.loadFullDesktopItemsAfterBoot();
    }, timeout);
  }

  async syncAfterNativeShellCommand() {
    this.cancelPendingRefreshes();
    await this.refreshDesktopItems({ keepPendingRefreshes: true, deferIfBusy: true });

    for (const delayMs of [220, 900, 1800]) {
      const timer = window.setTimeout(() => {
        this.pendingRefreshTimers = this.pendingRefreshTimers.filter((value) => value !== timer);
        void this.refreshDesktopItems({ keepPendingRefreshes: true, deferIfBusy: true });
      }, delayMs);
      this.pendingRefreshTimers.push(timer);
    }
  }

  cancelPendingRefreshes() {
    for (const timer of this.pendingRefreshTimers) {
      window.clearTimeout(timer);
    }

    this.pendingRefreshTimers = [];
    this.deferredRefreshTimer = null;
  }

  scheduleDeferredRefresh(delayMs = 650) {
    if (this.deferredRefreshTimer !== null) {
      return;
    }

    const timer = window.setTimeout(() => {
      this.deferredRefreshTimer = null;
      this.pendingRefreshTimers = this.pendingRefreshTimers.filter((value) => value !== timer);
      void this.refreshDesktopItems({ keepPendingRefreshes: true, deferIfBusy: true });
    }, delayMs);

    this.deferredRefreshTimer = timer;
    this.pendingRefreshTimers.push(timer);
  }

  async waitForDeletedItemsToLeaveScan(items: AppNode[], timeoutMs = 1000) {
    const deletedKeys = desktopItemIdentityKeys(items);
    const deadline = performance.now() + timeoutMs;
    let delayMs = 35;

    while (true) {
      const scanned = await scanDesktopItems({ includeIcons: false });
      if (!scanned.some((item) => desktopItemMatchesIdentityKeys(item, deletedKeys))) {
        return;
      }

      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        return;
      }

      await wait(Math.min(delayMs, remainingMs));
      delayMs = Math.min(Math.round(delayMs * 1.6), 180);
    }
  }
}
