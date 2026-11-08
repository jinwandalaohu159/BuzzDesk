// Feel and timing of auto-layout dragging, in one place. Distances are layout
// pixels, times milliseconds, speeds pixels per millisecond (pointer velocity).
// See autoDragIntent.ts for the zone rules these tune.

// --- Zones -------------------------------------------------------------------

// Share of the icon trimmed from each side to get its merge core ("drop into
// this icon"). The recycle bin uses its whole icon instead.
export const mergeCoreInset = 0.12;
// Once a merge target is active the core grows by this much, so a tremor at
// its edge does not drop the folder intent.
export const mergeExitPaddingPx = 12;
// An icon's cell: its tile grown by these shares, which covers the gaps
// between neighbouring tiles.
export const cellPadXRatio = 0.25;
export const cellPadYRatio = 0.15;

// --- Dwell: how long the icon must rest before an intent commits -------------

export const mergeDwellMs = 180;
export const trashDwellMs = 60;
// In open space (no icon cell) the slot opens quickly.
export const reorderDwellMs = 130;
// Inside an icon's cell, making room needs a deliberate still hold; a hand at
// rest still trembles a little, so "still" allows a slow drift.
export const approachReorderDwellMs = 600;
// ...but after this much rest the neighbours already lean apart a little, so
// the user sees room is coming while the target stays within reach.
export const makeRoomHintAfterMs = 220;
// Pause after a reorder before the next one may apply.
export const reorderCooldownMs = 140;

// --- Rest: how still "resting" is --------------------------------------------

// Fastest the icon may move and still commit each intent.
export const mergeMaxSpeed = 0.24;
export const trashMaxSpeed = 0.6;
export const reorderMaxSpeed = 0.18;
export const approachReorderMaxSpeed = 0.08;
// How far the icon may wander and still count as resting (a hand at rest
// trembles a pixel or two).
export const nearRestRadiusPx = 4;
export const openRestRadiusPx = 12;

// --- Heading into an icon ----------------------------------------------------

// Slower than this the pointer is not heading anywhere.
export const headingMinSpeed = 0.04;
// Motion within ~53° of the direction to an icon's core counts as heading for it.
export const headingMinCosine = 0.6;
// Re-check after the pointer was heading into an icon (velocity has decayed by then).
export const headingRecheckMs = 100;

// --- Wake-ups ----------------------------------------------------------------

// Added to the first wait so the re-check lands just past the dwell.
export const dwellWakeSlackMs = 8;
// Never re-check sooner than this while waiting.
export const minRecheckMs = 24;
