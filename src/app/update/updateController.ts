// Owns everything about updating BuzzDesk: manual checks from settings,
// automatic checks (install on start, announce once while running), download
// progress and the one-time cleanup of legacy per-machine installs.
import { UpdateToast } from "../../render/updateToast";
import { showSystemNotification } from "../../system/desktopApi";
import { isDesktopRuntime } from "../../system/nativeBridge";
import {
  cleanupLegacyInstall,
  detectLegacyInstall,
  downloadUpdateInstaller,
  launchUpdateHelper,
  openUpdateReleasePage
} from "../../system/updateApi";
import { checkForUpdateRelease, currentAppVersion } from "../../system/updateRelease";
import { wait } from "../../shared/timing";
import type { DesktopSettings, UpdateCheckState } from "../../types";

export interface UpdateControllerHost {
  getSettingsLayer(): HTMLElement;
  getSettings(): DesktopSettings;
  isSettingsOpen(): boolean;
  renderSettings(): void;
  confirmUpdate(state: UpdateCheckState): Promise<boolean>;
}

const autoUpdateIntervalMs = 6 * 60 * 60 * 1000;
const autoUpdateStartupRetryDelaysMs = [4_000, 30_000, 120_000];
const autoUpdateRetryCooldownMs = 24 * 60 * 60 * 1000;
const updateAttemptStorageKey = "buzzdesk.updateAttempt";
const legacyCleanupDismissedKey = "buzzdesk.legacyCleanupDismissed";

export class UpdateController {
  private readonly toast = new UpdateToast(document.body);
  private inFlight = false;
  private autoUpdateTimer: number | null = null;
  private notifiedUpdateVersion: string | null = null;
  private state: UpdateCheckState = {
    status: "idle",
    currentVersion: currentAppVersion,
    latestVersion: null,
    releaseUrl: null,
    error: null
  };

  constructor(private readonly host: UpdateControllerHost) {}

  get currentState(): UpdateCheckState {
    return this.state;
  }

  // Manual checks always show progress and report failures (keeping the last
  // known result); quiet background checks change nothing visible on failure.
  async checkForUpdates(options: { quiet?: boolean } = {}) {
    if (this.inFlight || this.state.installing) {
      return false;
    }

    const manual = options.quiet !== true;
    const previous = this.state;
    this.inFlight = true;

    if (manual) {
      this.state = { ...previous, status: "checking", currentVersion: currentAppVersion, error: null };
      this.host.renderSettings();
    }

    try {
      const result = await checkForUpdateRelease();
      const nextState: UpdateCheckState = {
        status: result.hasUpdate ? "available" : "current",
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        releaseUrl: result.releaseUrl,
        installerUrl: result.installerUrl,
        installerName: result.installerName,
        error: null
      };
      const shouldRender =
        manual ||
        this.state.status !== nextState.status ||
        this.state.currentVersion !== nextState.currentVersion ||
        this.state.latestVersion !== nextState.latestVersion ||
        this.state.releaseUrl !== nextState.releaseUrl ||
        this.state.error !== nextState.error;

      this.state = nextState;
      if (shouldRender) {
        this.host.renderSettings();
      }
      return true;
    } catch (error) {
      console.warn("Unable to check for updates", error);
      if (manual) {
        const failure = "\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5 GitHub Releases\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002";
        // Keep a known result (current / available) and just add the error.
        this.state =
          previous.status === "current" || previous.status === "available"
            ? { ...previous, error: failure }
            : { ...previous, status: "error", latestVersion: null, releaseUrl: null, error: failure };
        this.host.renderSettings();
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  async confirmAndOpenLatestUpdate() {
    if (this.state.status !== "available") {
      await this.checkForUpdates();
    }

    if (
      this.state.status !== "available" ||
      !this.state.latestVersion
    ) {
      return;
    }

    const confirmed = await this.host.confirmUpdate(this.state);
    if (!confirmed) {
      return;
    }

    await this.installLatestUpdate();
  }

  // Automatic updates: install straight away while BuzzDesk is starting (boot or
  // relaunch); while it is in use, announce the new version once and let the
  // user choose, falling back to installing on the next start.
  startAutoUpdateLoop() {
    if (!isDesktopRuntime() || this.autoUpdateTimer !== null) {
      return;
    }

    let attempt = 0;
    const runStartupCheck = async () => {
      const outcome = await this.runAutomaticUpdateCheck("startup");
      attempt += 1;
      if (outcome === "error" && attempt < autoUpdateStartupRetryDelaysMs.length) {
        window.setTimeout(() => void runStartupCheck(), autoUpdateStartupRetryDelaysMs[attempt]);
      }
    };

    window.setTimeout(() => void runStartupCheck(), autoUpdateStartupRetryDelaysMs[0]);
    this.autoUpdateTimer = window.setInterval(
      () => void this.runAutomaticUpdateCheck("background"),
      autoUpdateIntervalMs
    );
  }

  async runAutomaticUpdateCheck(phase: "startup" | "background") {
    if (!this.host.getSettings().autoUpdate || this.state.installing) {
      return "skipped" as const;
    }

    const checked = await this.checkForUpdates({ quiet: true });
    if (!checked) {
      return "error" as const;
    }

    const state = this.state;
    if (state.status !== "available" || !state.latestVersion) {
      return "current" as const;
    }

    const canInstall = Boolean(state.installerUrl && state.installerName);
    if (phase === "startup" && canInstall && !recentlyAttemptedUpdate(state.latestVersion)) {
      void this.installLatestUpdate();
    } else {
      this.notifyUpdateAvailable(state.latestVersion);
    }

    return "available" as const;
  }

  // Builds up to 0.1.4 installed into Program Files, which forced a UAC prompt
  // on every update. Offer to remove such a leftover copy once; after that all
  // installs and updates stay per-user and never need elevation.
  async offerLegacyInstallCleanup() {
    const legacy = await detectLegacyInstall();
    if (!legacy || this.state.installing) {
      return;
    }

    try {
      if (window.localStorage.getItem(legacyCleanupDismissedKey) === legacy.location) {
        return;
      }
    } catch {
      // Ignore storage failures; worst case we ask again.
    }

    const versionLabel = legacy.version ? ` v${legacy.version}` : "";
    this.toast.showPrompt({
      title: `发现旧版 BuzzDesk${versionLabel}`,
      detail: `旧版安装在 ${legacy.location}，会导致每次更新都需要管理员确认。清理只需确认这一次。`,
      primaryLabel: "清理旧版",
      secondaryLabel: "保留",
      autoHideMs: 20_000,
      onPrimary: () => {
        this.toast.showProgress("清理旧版 BuzzDesk", null, "正在准备清理…");
        void cleanupLegacyInstall(this.host.getSettings().startWithWindows).catch((error) => {
          console.warn("Unable to start legacy cleanup", error);
          this.toast.showMessage("清理失败", String(error), "error");
        });
      },
      onSecondary: () => {
        try {
          window.localStorage.setItem(legacyCleanupDismissedKey, legacy.location);
        } catch {
          // Best effort.
        }
      }
    });
  }

  private notifyUpdateAvailable(version: string) {
    if (this.notifiedUpdateVersion === version || this.state.installing) {
      return;
    }

    this.notifiedUpdateVersion = version;
    this.toast.showAvailable(version, {
      onUpdate: () => void this.installLatestUpdate()
    });
    void showSystemNotification(
      `BuzzDesk 有新版本 v${version}`,
      "下次启动时会自动更新，也可以在桌面通知或设置里点“立即更新”。"
    );
  }

  private async installLatestUpdate() {
    const state = this.state;
    if (state.installing || state.status !== "available" || !state.latestVersion) {
      return;
    }

    const version = state.latestVersion;
    const installerUrl = state.installerUrl;
    const installerName = state.installerName;
    if (!installerUrl || !installerName) {
      void openUpdateReleasePage(state.releaseUrl ?? undefined);
      return;
    }

    this.setUpdateDownloadProgress(0);
    this.toast.showProgress(`正在更新到 v${version}`, 0, "正在下载安装包…");

    let downloaded: boolean;
    try {
      downloaded = await downloadUpdateInstaller(installerUrl, installerName, (progress) => {
        const ratio = progress.total ? progress.downloaded / progress.total : null;
        this.setUpdateDownloadProgress(ratio);
        this.toast.showProgress(
          `正在更新到 v${version}`,
          ratio,
          progress.total
            ? `${formatMegabytes(progress.downloaded)} / ${formatMegabytes(progress.total)}`
            : `已下载 ${formatMegabytes(progress.downloaded)}`
        );
      });
    } catch (error) {
      console.warn("Failed to download update", error);
      this.failInstall("安装包下载失败，请检查网络后重试。");
      return;
    }

    if (!downloaded) {
      this.state = { ...this.state, installing: false, downloadProgress: null };
      this.toast.hide();
      this.host.renderSettings();
      return;
    }

    rememberUpdateAttempt(version);
    this.setUpdateDownloadProgress(1);
    this.toast.showProgress(`正在更新到 v${version}`, 1, "下载完成，正在重启并安装…");
    await wait(450);
    try {
      await launchUpdateHelper(installerName, version);
    } catch (error) {
      console.warn("Failed to launch the update helper", error);
      this.failInstall(`无法启动更新程序：${String(error)}`);
    }
  }

  private failInstall(message: string) {
    this.state = {
      ...this.state,
      installing: false,
      downloadProgress: null,
      error: `更新失败：${message}`
    };
    this.host.renderSettings();
    this.toast.showMessage("更新失败", message, "error");
  }

  // Progress ticks arrive ~12x per second; patch the settings row in place
  // instead of rebuilding the whole settings layer each time.
  private setUpdateDownloadProgress(progress: number | null) {
    const wasInstalling = this.state.installing === true;
    this.state = {
      ...this.state,
      installing: true,
      downloadProgress: progress,
      error: null
    };

    if (!this.host.isSettingsOpen()) {
      return;
    }

    const bar = this.host.getSettingsLayer().querySelector<HTMLElement>(".settings-update-progress > span");
    const button = this.host.getSettingsLayer().querySelector<HTMLButtonElement>('[data-setting-action="updateLatest"]');
    if (!wasInstalling || !bar || !button) {
      this.host.renderSettings();
      return;
    }

    bar.parentElement?.classList.toggle("is-indeterminate", progress === null);
    bar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, progress ?? 0.3))})`;
    button.textContent = progress === null ? "下载中" : `下载中 ${Math.round(progress * 100)}%`;
  }
}

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function recentlyAttemptedUpdate(version: string) {
  try {
    const raw = window.localStorage.getItem(updateAttemptStorageKey);
    const attempt = raw ? (JSON.parse(raw) as { version?: string; at?: number }) : null;
    return (
      attempt?.version === version &&
      typeof attempt.at === "number" &&
      Date.now() - attempt.at < autoUpdateRetryCooldownMs
    );
  } catch {
    return false;
  }
}

function rememberUpdateAttempt(version: string) {
  try {
    window.localStorage.setItem(updateAttemptStorageKey, JSON.stringify({ version, at: Date.now() }));
  } catch {
    // Storage is best-effort; worst case the next start retries the install.
  }
}
