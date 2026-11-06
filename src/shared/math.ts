// Small numeric helpers shared across layout, animation and state.

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// Clamp an insertion index into [0, length].
export function clampIndex(index: number, length: number) {
  return Math.min(length, Math.max(0, index));
}

// Round to 0.1px so transforms stay stable between frames.
export function roundFrameValue(value: number) {
  return Math.round(value * 10) / 10;
}
