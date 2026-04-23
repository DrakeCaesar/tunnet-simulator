import { BuilderState, createEmptyBuilderState } from "./state";

const STORAGE_KEY = "tunnet.builder.v1";

function isBuilderStateLike(value: unknown): value is BuilderState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<BuilderState>;
  return v.version === 1 && Array.isArray(v.entities) && Array.isArray(v.links) && typeof v.nextId === "number";
}

export function loadBuilderState(): BuilderState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyBuilderState();
    const parsed = JSON.parse(raw) as unknown;
    return isBuilderStateLike(parsed) ? parsed : createEmptyBuilderState();
  } catch {
    return createEmptyBuilderState();
  }
}

export function saveBuilderState(state: BuilderState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function exportBuilderStateText(state: BuilderState): string {
  return JSON.stringify(state);
}

export function importBuilderStateText(raw: string): BuilderState | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isBuilderStateLike(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
