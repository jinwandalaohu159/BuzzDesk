// The one door to the native side. Everything else in src/system talks to Tauri
// through here; in a plain browser (preview / tests) `getInvoke` is null and
// callers fall back to a harmless default.
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let cachedInvoke: Invoke | null | undefined;

export async function getInvoke(): Promise<Invoke | null> {
  if (cachedInvoke !== undefined) {
    return cachedInvoke;
  }

  if (!hasTauriRuntime()) {
    cachedInvoke = null;
    return cachedInvoke;
  }

  try {
    const api = await import("@tauri-apps/api/core");
    cachedInvoke = api.invoke as Invoke;
  } catch {
    cachedInvoke = null;
  }

  return cachedInvoke;
}

export function hasTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as Window & { __TAURI_INTERNALS__?: unknown })
  );
}

export function isDesktopRuntime() {
  return hasTauriRuntime();
}
