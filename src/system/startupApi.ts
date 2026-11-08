import { getInvoke } from "./nativeBridge";

// Start with Windows (scheduled task / Run key) and the startup log.
export async function logStartupEvent(event: string) {
  const invoke = await getInvoke();
  if (!invoke) {
    return;
  }

  try {
    await invoke("log_startup_event", { event });
  } catch {
    // Startup logs are diagnostic only.
  }
}

export async function getStartupEnabled() {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }

  try {
    return await invoke<boolean>("get_startup_enabled");
  } catch (error) {
    console.warn("Unable to read startup setting", error);
    return null;
  }
}

export async function setStartupEnabled(enabled: boolean) {
  const invoke = await getInvoke();
  if (!invoke) {
    console.info("Set startup enabled", enabled);
    return;
  }

  await invoke("set_startup_enabled", { enabled });
}

// Re-points the logon entry at this executable (after a move to the per-user install).
export async function repairStartupEntry() {
  const invoke = await getInvoke();
  if (!invoke) {
    return false;
  }

  try {
    return await invoke<boolean>("repair_startup_entry");
  } catch (error) {
    console.warn("Unable to repair startup entry", error);
    return false;
  }
}
