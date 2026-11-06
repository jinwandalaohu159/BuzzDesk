// Runs a store update without the desktop re-rendering in response, for
// callers that patch the visible UI themselves (toggles, progress, previews).
export function withoutRender<T>(app: { suppressStoreRender: boolean }, update: () => T): T {
  const previous = app.suppressStoreRender;
  app.suppressStoreRender = true;
  try {
    return update();
  } finally {
    app.suppressStoreRender = previous;
  }
}
