/**
 * Builder canvas entity interactions extracted from [`canvas.ts`](../../builder/canvas.ts).
 *
 * - **All placeable types**: selection, multi-entity drag on the grid (when pointer starts outside special regions).
 * - **Tick collision / drop** (“red border”): driven by simulation highlights in `canvas.ts`, not here.
 * - **Notes (`text`)**: bottom/right **resize** band → [`tryStartTextEntityResizeDrag`](./text-entity-resize-drag.ts).
 * - **Relay**: outer ring **rotate** (90° snap) → [`startRelayRotateDrag`](./relay-entity-rotate-drag.ts) (wrapper around [`startSnappedRotateDragAroundPivot`](./snapped-rotate-drag.ts)); **move** uses the generic drag path from relay core hit testing (`relayPointerMode` in [`hub-geometry`](./hub-geometry.ts)).
 * - **Hub**: layout, SVG shell, triangle hit-test (`hubPointerMode`) → [`hub-geometry`](./hub-geometry.ts); **move** still orchestrated in `canvas.ts`; centroid **rotate** (30° snap) uses [`startSnappedRotateDragAroundPivot`](./snapped-rotate-drag.ts).
 */

export type { RotateDragChrome } from "./snapped-rotate-drag";
export { startSnappedRotateDragAroundPivot } from "./snapped-rotate-drag";
export { tryStartTextEntityResizeDrag } from "./text-entity-resize-drag";
export { startRelayRotateDrag } from "./relay-entity-rotate-drag";
export * from "./hub-geometry";
