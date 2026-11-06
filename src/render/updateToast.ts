// Small glass card in the top-right corner used for update prompts and download
// progress. It owns its DOM; callers only describe what to show.
export interface UpdateToastActions {
  onUpdate: () => void;
}

export interface ToastPrompt {
  title: string;
  detail: string;
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  autoHideMs?: number;
}

type ToastTone = "info" | "success" | "error";

const exitDurationMs = 220;

export class UpdateToast {
  private readonly host: HTMLElement;
  private card: HTMLElement | null = null;
  private hideTimer: number | null = null;
  private progressBar: HTMLElement | null = null;
  private progressLabel: HTMLElement | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  showAvailable(version: string, actions: UpdateToastActions, autoHideMs = 10_000) {
    this.showPrompt({
      title: `发现新版本 v${version}`,
      detail: "点击立即更新，或下次启动时自动安装。",
      primaryLabel: "立即更新",
      secondaryLabel: "稍后",
      onPrimary: actions.onUpdate,
      autoHideMs
    });
  }

  showPrompt(prompt: ToastPrompt) {
    const autoHideMs = prompt.autoHideMs ?? 10_000;
    const card = this.mount("info");
    card.append(this.header(prompt.title, prompt.detail));

    const buttons = document.createElement("div");
    buttons.className = "update-toast-actions";
    const secondary = this.button(prompt.secondaryLabel, "is-secondary", () => {
      this.hide();
      prompt.onSecondary?.();
    });
    const primary = this.button(prompt.primaryLabel, "is-primary", () => {
      prompt.onPrimary();
    });
    buttons.append(secondary, primary);
    card.append(buttons);

    // A thin countdown line makes the auto-dismiss predictable.
    const countdown = document.createElement("span");
    countdown.className = "update-toast-countdown";
    countdown.style.animationDuration = `${autoHideMs}ms`;
    card.append(countdown);
    card.addEventListener("pointerenter", () => {
      countdown.style.animationPlayState = "paused";
      this.clearHideTimer();
    });
    card.addEventListener("pointerleave", () => {
      countdown.style.animationPlayState = "running";
      this.scheduleHide(Math.max(2500, autoHideMs / 3));
    });

    this.scheduleHide(autoHideMs);
  }

  showProgress(title: string, progress: number | null, detail: string) {
    if (!this.card || !this.progressBar) {
      const card = this.mount("info");
      card.append(this.header(title, detail));

      const track = document.createElement("div");
      track.className = "update-toast-track";
      const bar = document.createElement("span");
      track.append(bar);

      const label = document.createElement("span");
      label.className = "update-toast-percent";

      card.append(track, label);
      this.progressBar = bar;
      this.progressLabel = label;
    }

    this.clearHideTimer();
    const detailElement = this.card?.querySelector(".update-toast-detail");
    if (detailElement && detailElement.textContent !== detail) {
      detailElement.textContent = detail;
    }

    const track = this.progressBar?.parentElement;
    track?.classList.toggle("is-indeterminate", progress === null);
    if (this.progressBar) {
      this.progressBar.style.transform = `scaleX(${progress === null ? 1 : Math.max(0.02, Math.min(1, progress))})`;
    }
    if (this.progressLabel) {
      this.progressLabel.textContent = progress === null ? "" : `${Math.round(progress * 100)}%`;
    }
  }

  showMessage(title: string, detail: string, tone: ToastTone = "info", autoHideMs = 6000) {
    const card = this.mount(tone);
    card.append(this.header(title, detail));
    card.append(
      this.button("知道了", "is-secondary is-compact", () => this.hide())
    );
    this.scheduleHide(autoHideMs);
  }

  hide() {
    this.clearHideTimer();
    const card = this.card;
    this.card = null;
    this.progressBar = null;
    this.progressLabel = null;
    if (!card) {
      return;
    }

    card.classList.add("is-leaving");
    window.setTimeout(() => card.remove(), exitDurationMs);
  }

  private mount(tone: ToastTone) {
    this.clearHideTimer();
    this.card?.remove();
    this.progressBar = null;
    this.progressLabel = null;

    const card = document.createElement("section");
    card.className = `update-toast is-${tone}`;
    card.setAttribute("role", "status");
    card.addEventListener("pointerdown", (event) => event.stopPropagation());
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.host.append(card);
    this.card = card;
    return card;
  }

  private header(title: string, detail: string) {
    const header = document.createElement("div");
    header.className = "update-toast-header";

    const titleElement = document.createElement("strong");
    titleElement.textContent = title;

    const detailElement = document.createElement("span");
    detailElement.className = "update-toast-detail";
    detailElement.textContent = detail;

    header.append(titleElement, detailElement);
    return header;
  }

  private button(label: string, className: string, onClick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `update-toast-button ${className}`;
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private scheduleHide(delayMs: number) {
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => this.hide(), delayMs);
  }

  private clearHideTimer() {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
