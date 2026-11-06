import "./updater.css";
import iconUrl from "../../icons/像素-蜜蜂-01.svg";

// Progress window shown by the update helper process while the installer runs
// and BuzzDesk restarts. It polls the helper's status instead of listening to
// events so nothing emitted before the page loaded can be missed.
interface HelperStatus {
  mode: "update" | "cleanup";
  stage: "waiting" | "installing" | "launching" | "failed" | "done";
  progress: number;
  message: string;
  version: string;
  failed: boolean;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const title = document.getElementById("updater-title");
const version = document.getElementById("updater-version");
const percent = document.getElementById("updater-percent");
const bar = document.getElementById("updater-bar");
const message = document.getElementById("updater-message");
const track = document.querySelector<HTMLElement>(".updater-track");
const icon = document.getElementById("updater-icon") as HTMLImageElement | null;

if (icon) {
  icon.src = iconUrl;
}

let displayed = 0;
let target = 0;
let lastFrame = performance.now();

function render(status: HelperStatus) {
  target = Math.max(target, Math.min(1, status.progress));
  if (title) {
    const cleanup = status.mode === "cleanup";
    title.textContent = status.stage === "done"
      ? (status.failed ? (cleanup ? "旧版本未清理" : "更新未完成") : (cleanup ? "清理完成" : "更新完成"))
      : (cleanup ? "正在清理旧版 BuzzDesk" : "BuzzDesk 正在更新");
  }
  if (version) {
    version.textContent = status.version ? `新版本 v${status.version}` : "";
  }
  if (message) {
    message.textContent = status.message;
  }
  document.body.classList.toggle("is-failed", status.failed);
  document.body.classList.toggle("is-done", status.stage === "done");
}

// Ease the bar toward the latest reported value so polling steps never look jumpy.
function animate(now: number) {
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  displayed += (target - displayed) * (1 - Math.exp(-dt / 140));
  if (Math.abs(target - displayed) < 0.0005) {
    displayed = target;
  }

  if (bar) {
    bar.style.transform = `scaleX(${Math.max(0.015, displayed)})`;
  }
  if (percent) {
    percent.textContent = `${Math.round(displayed * 100)}%`;
  }
  track?.setAttribute("aria-valuenow", String(Math.round(displayed * 100)));
  requestAnimationFrame(animate);
}

async function poll(invoke: Invoke) {
  try {
    const status = await invoke<HelperStatus | null>("update_helper_status");
    if (status) {
      render(status);
    }
  } catch (error) {
    console.warn("Unable to read update helper status", error);
  }

  window.setTimeout(() => void poll(invoke), 120);
}

async function boot() {
  requestAnimationFrame(animate);
  try {
    const api = await import("@tauri-apps/api/core");
    void poll(api.invoke as Invoke);
  } catch {
    render({ mode: "update", stage: "installing", progress: 0.4, message: "预览模式", version: "0.0.0", failed: false });
  }
}

void boot();
