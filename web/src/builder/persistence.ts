import { BuilderState, createEmptyBuilderState, isStaticOuterLeafEndpoint } from "./state";

const STORAGE_KEY = "tunnet.builder.v1";
const EXPORT_GZIP_BASE64_PREFIX = "tunnet-simulator-gz64:";
const LAYOUT_SLOT_COUNT = 4;
const LAYOUT_SLOT_KEY_PREFIX = "tunnet.builder.layoutSlot.";

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
  const persisted: BuilderState = {
    ...state,
    entities: state.entities.filter((entity) => !isStaticOuterLeafEndpoint(entity)),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

function stateForPersistence(state: BuilderState): BuilderState {
  return {
    ...state,
    entities: state.entities.filter((entity) => !isStaticOuterLeafEndpoint(entity)),
  };
}

export interface BuilderLayoutSlotRecord {
  index: number;
  updatedAtMs: number;
  state: BuilderState;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let bin = "";
    for (let j = 0; j < chunk.length; j += 1) {
      bin += String.fromCharCode(chunk[j]!);
    }
    out += bin;
  }
  return btoa(out);
}

function base64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(base64Url: string): Uint8Array {
  const base64 = base64Url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  return base64ToBytes(base64);
}

async function gzipToBase64(text: string): Promise<string> {
  const input = new TextEncoder().encode(text);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToBase64(compressed);
}

async function gunzipBase64(base64: string): Promise<string> {
  const bytes = base64ToBytes(base64);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const decompressed = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(decompressed);
}

async function gzipToBase64Url(text: string): Promise<string> {
  const input = new TextEncoder().encode(text);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToBase64Url(compressed);
}

async function gunzipBase64Url(base64Url: string): Promise<string> {
  const bytes = base64UrlToBytes(base64Url);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const decompressed = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(decompressed);
}

function layoutSlotKey(index: number): string {
  return `${LAYOUT_SLOT_KEY_PREFIX}${index}`;
}

export async function exportBuilderStateText(state: BuilderState): Promise<string> {
  const persisted: BuilderState = {
    ...stateForPersistence(state),
  };
  const serialized = JSON.stringify(persisted);
  const gz64 = await gzipToBase64(serialized);
  return `${EXPORT_GZIP_BASE64_PREFIX}${gz64}`;
}

export async function importBuilderStateText(raw: string): Promise<BuilderState | null> {
  try {
    const text = raw.trim();
    let payloadText = text;
    if (text.startsWith(EXPORT_GZIP_BASE64_PREFIX)) {
      const base64 = text.slice(EXPORT_GZIP_BASE64_PREFIX.length);
      payloadText = await gunzipBase64(base64);
    }
    const parsed = JSON.parse(payloadText) as unknown;
    if (!isBuilderStateLike(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function exportBuilderStateUrlToken(state: BuilderState): Promise<string> {
  const serialized = JSON.stringify(stateForPersistence(state));
  return gzipToBase64Url(serialized);
}

export async function importBuilderStateUrlToken(token: string): Promise<BuilderState | null> {
  try {
    const payloadText = await gunzipBase64Url(token.trim());
    const parsed = JSON.parse(payloadText) as unknown;
    if (!isBuilderStateLike(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveBuilderLayoutSlot(index: number, state: BuilderState): boolean {
  if (!Number.isInteger(index) || index < 1 || index > LAYOUT_SLOT_COUNT) return false;
  const record: BuilderLayoutSlotRecord = {
    index,
    updatedAtMs: Date.now(),
    state: stateForPersistence(state),
  };
  window.localStorage.setItem(layoutSlotKey(index), JSON.stringify(record));
  return true;
}

export function clearBuilderLayoutSlot(index: number): boolean {
  if (!Number.isInteger(index) || index < 1 || index > LAYOUT_SLOT_COUNT) return false;
  window.localStorage.removeItem(layoutSlotKey(index));
  return true;
}

export function loadBuilderLayoutSlot(index: number): BuilderLayoutSlotRecord | null {
  if (!Number.isInteger(index) || index < 1 || index > LAYOUT_SLOT_COUNT) return null;
  try {
    const raw = window.localStorage.getItem(layoutSlotKey(index));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BuilderLayoutSlotRecord> & { state?: unknown };
    if (!Number.isFinite(parsed.updatedAtMs) || !isBuilderStateLike(parsed.state)) return null;
    return {
      index,
      updatedAtMs: Math.floor(parsed.updatedAtMs),
      state: parsed.state,
    };
  } catch {
    return null;
  }
}

export function listBuilderLayoutSlots(): BuilderLayoutSlotRecord[] {
  const out: BuilderLayoutSlotRecord[] = [];
  for (let i = 1; i <= LAYOUT_SLOT_COUNT; i += 1) {
    const slot = loadBuilderLayoutSlot(i);
    if (slot) out.push(slot);
  }
  return out;
}
