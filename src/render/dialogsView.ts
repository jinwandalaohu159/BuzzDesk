import { folderRatioMax, folderRatioMin } from "../settings/desktopSettings";
import { formatVersion } from "../system/updateRelease";

// Modal dialog markup: folder ratio, delete and update confirmations.

export function renderRatioDialog(options: {
  x: number;
  y: number;
  columns: number;
  rows: number;
}) {
  const dialog = document.createElement("div");
  dialog.className = "ratio-dialog";

  const width = 200;
  const height = 120;
  dialog.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, options.x))}px`;
  dialog.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, options.y))}px`;

  const label = document.createElement("div");
  label.className = "ratio-dialog-label";
  label.textContent = "比例";

  const inputRow = document.createElement("div");
  inputRow.className = "ratio-dialog-inputs";

  const colInput = document.createElement("input");
  colInput.className = "ratio-dialog-input";
  colInput.type = "number";
  colInput.min = String(folderRatioMin);
  colInput.max = String(folderRatioMax);
  colInput.value = String(options.rows);
  colInput.dataset.ratioRows = "true";

  const separator = document.createElement("span");
  separator.className = "ratio-dialog-sep";
  separator.textContent = "×";

  const rowInput = document.createElement("input");
  rowInput.className = "ratio-dialog-input";
  rowInput.type = "number";
  rowInput.min = String(folderRatioMin);
  rowInput.max = String(folderRatioMax);
  rowInput.value = String(options.columns);
  rowInput.dataset.ratioColumns = "true";

  inputRow.append(colInput, separator, rowInput);

  const actions = document.createElement("div");
  actions.className = "ratio-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ratio-dialog-cancel";
  cancelBtn.textContent = "取消";
  cancelBtn.dataset.ratioCancel = "true";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ratio-dialog-confirm";
  confirmBtn.textContent = "确认";
  confirmBtn.dataset.ratioConfirm = "true";

  actions.append(cancelBtn, confirmBtn);

  dialog.append(label, inputRow, actions);
  return dialog;
}

interface ConfirmDialogOptions {
  variant: "delete" | "update";
  title: string;
  name: string;
  message: string;
  confirmLabel: string;
}

export function renderDeleteConfirmDialog(itemName: string) {
  return renderConfirmDialog({
    variant: "delete",
    title: "\u5220\u9664\u9879\u76ee",
    name: `\u201c${itemName}\u201d`,
    message: "\u5c06\u79fb\u5230\u56de\u6536\u7ad9\uff0c\u53ef\u4ee5\u5728\u56de\u6536\u7ad9\u4e2d\u8fd8\u539f\u3002",
    confirmLabel: "\u5220\u9664"
  });
}

export function renderUpdateConfirmDialog(currentVersion: string, latestVersion: string) {
  return renderConfirmDialog({
    variant: "update",
    title: "\u66f4\u65b0 BuzzDesk",
    name: `${formatVersion(currentVersion)} \u2192 ${formatVersion(latestVersion)}`,
    message: "\u5c06\u4e0b\u8f7d\u6700\u65b0\u5b89\u88c5\u5305\uff0c\u5b89\u88c5\u5b8c\u6210\u540e BuzzDesk \u4f1a\u81ea\u52a8\u91cd\u542f\u3002",
    confirmLabel: "\u4e0b\u8f7d\u5e76\u5b89\u88c5"
  });
}

function renderConfirmDialog(options: ConfirmDialogOptions) {
  const backdrop = document.createElement("div");
  backdrop.className = "delete-confirm-backdrop";

  const dialog = document.createElement("section");
  dialog.className = `delete-confirm-dialog confirm-dialog is-${options.variant}-confirm`;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "confirm-dialog-title");

  const icon = document.createElement("div");
  icon.className = "delete-confirm-icon";
  icon.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "delete-confirm-body";

  const title = document.createElement("h2");
  title.id = "confirm-dialog-title";
  title.textContent = options.title;

  const name = document.createElement("div");
  name.className = "delete-confirm-name";
  name.textContent = options.name;

  const message = document.createElement("p");
  message.textContent = options.message;

  body.append(title, name, message);

  const actions = document.createElement("div");
  actions.className = "delete-confirm-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "delete-confirm-cancel";
  cancel.dataset.confirmCancel = "true";
  cancel.textContent = "\u53d6\u6d88";

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "delete-confirm-confirm";
  confirm.dataset.confirmAccept = "true";
  confirm.textContent = options.confirmLabel;

  actions.append(cancel, confirm);
  dialog.append(icon, body, actions);
  backdrop.append(dialog);
  return backdrop;
}
