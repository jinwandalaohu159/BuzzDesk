import { formatVersion } from "../system/updateRelease";
import type { UpdateCheckState } from "../types";

// The "updates" row of the settings panel: status, versions and progress.

export function renderSettingsUpdateControl(updateState: UpdateCheckState) {
  const row = document.createElement("section");
  row.className = "settings-update-row";
  row.classList.toggle("is-checking", updateState.status === "checking");

  const title = document.createElement("div");
  title.className = "settings-update-title";

  const name = document.createElement("span");
  name.textContent = "\u68c0\u6d4b\u66f4\u65b0";

  const badge = document.createElement("span");
  badge.className = "settings-update-badge";
  badge.textContent = updateStatusLabel(updateState);

  title.append(name, badge);

  const versions = document.createElement("dl");
  versions.className = "settings-update-versions";
  versions.append(
    renderVersionPair("\u5f53\u524d\u7248\u672c:", formatVersion(updateState.currentVersion)),
    renderVersionPair("\u6700\u65b0\u7248\u672c:", latestVersionLabel(updateState))
  );

  const message = document.createElement("p");
  message.className = "settings-update-message";
  message.textContent = updateMessage(updateState);

  const footer = document.createElement("div");
  footer.className = "settings-update-footer";

  const actions = document.createElement("div");
  actions.className = "settings-update-actions";

  const check = document.createElement("button");
  check.type = "button";
  check.className = "settings-update-check";
  check.dataset.settingAction = "checkUpdates";
  check.disabled = updateState.status === "checking" || updateState.installing === true;
  check.textContent = updateState.status === "checking" ? "\u68c0\u6d4b\u4e2d" : "\u68c0\u6d4b\u66f4\u65b0";
  actions.append(check);

  if (updateState.status === "available") {
    const update = document.createElement("button");
    update.type = "button";
    update.className = "settings-update-primary";
    update.dataset.settingAction = "updateLatest";
    update.disabled = updateState.installing === true;
    update.textContent = updateState.installing === true
      ? `\u4e0b\u8f7d\u4e2d ${formatDownloadPercent(updateState.downloadProgress)}`
      : "\u7acb\u5373\u66f4\u65b0";
    actions.append(update);
  }

  footer.append(message, actions);
  row.append(title, versions, footer);

  if (updateState.installing === true) {
    const progress = document.createElement("div");
    progress.className = "settings-update-progress";
    progress.classList.toggle("is-indeterminate", updateState.downloadProgress == null);
    const bar = document.createElement("span");
    bar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, updateState.downloadProgress ?? 0.3))})`;
    progress.append(bar);
    row.append(progress);
  }

  return row;
}

function formatDownloadPercent(progress: number | null | undefined) {
  return progress == null ? "" : `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

function renderVersionPair(label: string, value: string) {
  const fragment = document.createDocumentFragment();

  const term = document.createElement("dt");
  term.textContent = label;

  const description = document.createElement("dd");
  description.textContent = value;

  fragment.append(term, description);
  return fragment;
}

function latestVersionLabel(updateState: UpdateCheckState) {
  if (updateState.status === "idle") {
    return "\u672a\u68c0\u6d4b";
  }

  if (updateState.status === "checking") {
    return "\u68c0\u6d4b\u4e2d...";
  }

  return updateState.latestVersion ? formatVersion(updateState.latestVersion) : "\u672a\u77e5";
}

function updateStatusLabel(updateState: UpdateCheckState) {
  if (updateState.status === "checking") {
    return "\u68c0\u6d4b\u4e2d";
  }

  if (updateState.status === "available") {
    return "\u53ef\u66f4\u65b0";
  }

  if (updateState.status === "current") {
    return "\u5df2\u662f\u6700\u65b0";
  }

  if (updateState.status === "error") {
    return "\u68c0\u6d4b\u5931\u8d25";
  }

  return "\u672a\u68c0\u6d4b";
}

function updateMessage(updateState: UpdateCheckState) {
  if (updateState.status === "checking") {
    return "\u6b63\u5728\u8fde\u63a5 GitHub Releases...";
  }

  if (updateState.installing === true) {
    return "\u6b63\u5728\u4e0b\u8f7d\u6700\u65b0\u5b89\u88c5\u5305...";
  }

  // A failed install or re-check keeps the last result but says what went wrong.
  if (updateState.error) {
    return updateState.error;
  }

  if (updateState.status === "available") {
    return "\u68c0\u6d4b\u5230\u65b0\u7248\u672c\uff0c\u66f4\u65b0\u65f6\u4f1a\u81ea\u52a8\u5b89\u88c5\u5e76\u91cd\u542f BuzzDesk\u3002";
  }

  if (updateState.status === "current") {
    return "\u5f53\u524d\u5df2\u7ecf\u662f\u6700\u65b0\u7248\u672c\u3002";
  }

  if (updateState.status === "error") {
    return updateState.error ?? "\u6682\u65f6\u65e0\u6cd5\u68c0\u6d4b\u66f4\u65b0\u3002";
  }

  return "\u70b9\u51fb\u68c0\u6d4b\u540e\uff0c\u4f1a\u663e\u793a GitHub Releases \u4e0a\u7684\u6700\u65b0\u7248\u672c\u3002";
}
