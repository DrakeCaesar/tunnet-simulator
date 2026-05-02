import type { BuilderLayer } from "./state";

export const BUILDER_CANVAS_SCALE_KEY = "tunnet.builder.canvasScale";

export const CANVAS_SCALE_X_STEPS = [
  1 / 16, 1 / 8, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4,
] as const;

export const DEFAULT_LAYER_SCALE_Y = { outer64: 0.5, middle16: 1.5, inner4: 1.5, core1: 0.5 } as const;

export type CanvasScale = {
  x: number;
  yByLayer: Record<BuilderLayer, number>;
};

export function nearestCanvasScaleXStep(v: number): number {
  let best = CANVAS_SCALE_X_STEPS[0];
  let bestDelta = Math.abs(v - best);
  for (const step of CANVAS_SCALE_X_STEPS) {
    const delta = Math.abs(v - step);
    if (delta < bestDelta) {
      best = step;
      bestDelta = delta;
    }
  }
  return best;
}

export function clampCanvasScaleX(v: number): number {
  return nearestCanvasScaleXStep(Math.max(CANVAS_SCALE_X_STEPS[0], Math.min(4, v)));
}

export function canvasScaleXIndexFromValue(v: number): number {
  return Math.max(0, CANVAS_SCALE_X_STEPS.findIndex((step) => step === clampCanvasScaleX(v)));
}

export function canvasScaleXValueFromIndex(index: number): number {
  const i = Math.max(0, Math.min(CANVAS_SCALE_X_STEPS.length - 1, Math.round(index)));
  return CANVAS_SCALE_X_STEPS[i];
}

export function formatScaleLabel(v: number): string {
  if (Math.abs(v - 1 / 32) < 1e-9) return "1/32x";
  if (Math.abs(v - 1 / 16) < 1e-9) return "1/16x";
  if (Math.abs(v - 1 / 8) < 1e-9) return "1/8x";
  if (Math.abs(v - 1 / 4) < 1e-9) return "1/4x";
  if (Math.abs(v - 1 / 2) < 1e-9) return "1/2x";
  return `${v.toFixed(2)}x`;
}

export function clampCanvasScaleY(v: number): number {
  return Math.max(0.25, Math.min(4, v));
}
