import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

type JsonValue = unknown;

type BuilderState = {
  version: number;
  nextId: number;
  entities: Array<{
    id: string;
    groupId: string;
    templateType: string;
    layer: string;
    segmentIndex: number;
    x: number;
    y: number;
    settings: Record<string, string>;
    isStatic?: boolean;
  }>;
  links: Array<{
    id: string;
    groupId: string;
    fromEntityId: string;
    fromPort: number;
    toEntityId: string;
    toPort: number;
    fromSegmentIndex?: number;
    toSegmentIndex?: number;
    sameLayerSegmentDelta?: number;
    crossLayerBlockSlot?: number;
    voidBandInnerOuterCrossLayer?: boolean;
  }>;
};

type BenchmarkVariant = {
  name: string;
  payload: JsonValue;
  decode?: (payload: JsonValue) => BuilderState;
};

const DEFAULT_TEMP_PATH = "web/src/builder/temp.txt";

const templateCode = new Map<string, number>([
  ["endpoint", 0],
  ["relay", 1],
  ["hub", 2],
  ["filter", 3],
  ["text", 4],
]);

const layerCode = new Map<string, number>([
  ["outer64", 0],
  ["middle16", 1],
  ["inner4", 2],
  ["core1", 3],
]);

const rotationCode = new Map<string, number>([
  ["clockwise", 0],
  ["counterclockwise", 1],
]);

const addressFieldCode = new Map<string, number>([
  ["source", 0],
  ["destination", 1],
]);

const operationCode = new Map<string, number>([
  ["equal", 0],
  ["differ", 1],
]);

const actionCode = new Map<string, number>([
  ["send_back", 0],
  ["drop", 1],
  ["pass", 2],
]);

const collisionCode = new Map<string, number>([
  ["send_back_outbound", 0],
  ["drop", 1],
  ["pass", 2],
]);

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function gzipTokenFromString(text: string): string {
  return toBase64Url(gzipSync(text));
}

function extractLayoutToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Input file is empty.");
  if (!trimmed.includes("layout=")) return trimmed;
  try {
    return new URL(trimmed).searchParams.get("layout") ?? trimmed;
  } catch {
    return trimmed;
  }
}

function decodeLayoutTokenToState(token: string): BuilderState {
  const json = gunzipSync(fromBase64Url(token)).toString("utf8");
  return JSON.parse(json) as BuilderState;
}

function compactJsonLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function transformShortKeysOnly(state: BuilderState): JsonValue {
  return {
    v: state.version,
    n: state.nextId,
    e: state.entities.map((e) => ({
      i: e.id,
      g: e.groupId,
      t: e.templateType,
      l: e.layer,
      s: e.segmentIndex,
      x: e.x,
      y: e.y,
      z: e.settings,
      q: e.isStatic ? 1 : undefined,
    })),
    k: state.links.map((l) => ({
      i: l.id,
      g: l.groupId,
      f: l.fromEntityId,
      p: l.fromPort,
      t: l.toEntityId,
      r: l.toPort,
      a: l.fromSegmentIndex,
      b: l.toSegmentIndex,
      d: l.sameLayerSegmentDelta,
      c: l.crossLayerBlockSlot,
      v: l.voidBandInnerOuterCrossLayer ? 1 : undefined,
    })),
  };
}

function decodeShortKeysOnly(payload: JsonValue): BuilderState {
  const p = payload as any;
  const entities = (p.e as any[]).map((e, i) => ({
    id: e.i ?? `e${i + 1}`,
    groupId: e.g ?? e.i ?? `e${i + 1}`,
    templateType: e.t,
    layer: e.l,
    segmentIndex: e.s,
    x: e.x,
    y: e.y,
    settings: e.z ?? {},
    ...(e.q === 1 ? { isStatic: true } : {}),
  }));
  const links = (p.k as any[]).map((l, i) => ({
    id: l.i ?? `l${i + 1}`,
    groupId: l.g ?? l.i ?? `l${i + 1}`,
    fromEntityId: l.f,
    fromPort: l.p,
    toEntityId: l.t,
    toPort: l.r,
    ...(l.a !== undefined ? { fromSegmentIndex: l.a } : {}),
    ...(l.b !== undefined ? { toSegmentIndex: l.b } : {}),
    ...(l.d !== undefined ? { sameLayerSegmentDelta: l.d } : {}),
    ...(l.c !== undefined ? { crossLayerBlockSlot: l.c } : {}),
    ...(l.v === 1 ? { voidBandInnerOuterCrossLayer: true } : {}),
  }));
  return { version: p.v ?? 1, nextId: p.n ?? entities.length + links.length + 1, entities, links };
}

function transformTupleRows(state: BuilderState): JsonValue {
  return {
    v: state.version,
    n: state.nextId,
    e: state.entities.map((e) => [
      e.id,
      e.groupId,
      e.templateType,
      e.layer,
      e.segmentIndex,
      e.x,
      e.y,
      e.settings,
      e.isStatic ? 1 : 0,
    ]),
    l: state.links.map((l) => [
      l.id,
      l.groupId,
      l.fromEntityId,
      l.fromPort,
      l.toEntityId,
      l.toPort,
      l.fromSegmentIndex ?? null,
      l.toSegmentIndex ?? null,
      l.sameLayerSegmentDelta ?? null,
      l.crossLayerBlockSlot ?? null,
      l.voidBandInnerOuterCrossLayer ? 1 : 0,
    ]),
  };
}

function decodeTupleRows(payload: JsonValue): BuilderState {
  const p = payload as any;
  const entities = (p.e as any[]).map((e, i) => ({
    id: e[0] ?? `e${i + 1}`,
    groupId: e[1] ?? e[0] ?? `e${i + 1}`,
    templateType: e[2],
    layer: e[3],
    segmentIndex: e[4],
    x: e[5],
    y: e[6],
    settings: e[7] ?? {},
    ...(e[8] === 1 ? { isStatic: true } : {}),
  }));
  const links = (p.l as any[]).map((l, i) => ({
    id: l[0] ?? `l${i + 1}`,
    groupId: l[1] ?? l[0] ?? `l${i + 1}`,
    fromEntityId: l[2],
    fromPort: l[3],
    toEntityId: l[4],
    toPort: l[5],
    ...(l[6] !== null && l[6] !== undefined ? { fromSegmentIndex: l[6] } : {}),
    ...(l[7] !== null && l[7] !== undefined ? { toSegmentIndex: l[7] } : {}),
    ...(l[8] !== null && l[8] !== undefined ? { sameLayerSegmentDelta: l[8] } : {}),
    ...(l[9] !== null && l[9] !== undefined ? { crossLayerBlockSlot: l[9] } : {}),
    ...(l[10] === 1 ? { voidBandInnerOuterCrossLayer: true } : {}),
  }));
  return { version: p.v ?? 1, nextId: p.n ?? entities.length + links.length + 1, entities, links };
}

function encodeSettingsWithDict(settings: Record<string, string>, dict: Map<string, number>, arr: string[]): JsonValue {
  const out: Array<[number, number]> = [];
  for (const [k, v] of Object.entries(settings)) {
    const key = `${k}\u0000${v}`;
    let idx = dict.get(key);
    if (idx === undefined) {
      idx = arr.length;
      arr.push(key);
      dict.set(key, idx);
    }
    out.push([idx, 1]);
  }
  return out;
}

function transformIndexedDense(state: BuilderState, opts: { removeDefaults: boolean; enumInts: boolean }): JsonValue {
  const idToIndex = new Map<string, number>();
  state.entities.forEach((e, idx) => idToIndex.set(e.id, idx));

  const settingsDict = new Map<string, number>();
  const settingsItems: string[] = [];

  const entities = state.entities.map((e) => {
    const t = opts.enumInts ? (templateCode.get(e.templateType) ?? e.templateType) : e.templateType;
    const l = opts.enumInts ? (layerCode.get(e.layer) ?? e.layer) : e.layer;
    const row: Array<JsonValue> = [t as JsonValue, l as JsonValue, e.segmentIndex, e.x, e.y];
    const hasSettings = Object.keys(e.settings).length > 0;
    if (!opts.removeDefaults || hasSettings) {
      row.push(encodeSettingsWithDict(e.settings, settingsDict, settingsItems));
    }
    if (!opts.removeDefaults || e.isStatic === true) {
      row.push(e.isStatic ? 1 : 0);
    }
    return row;
  });

  const links = state.links.map((l) => {
    const from = idToIndex.get(l.fromEntityId);
    const to = idToIndex.get(l.toEntityId);
    const fromRef: JsonValue = from === undefined ? l.fromEntityId : from;
    const toRef: JsonValue = to === undefined ? l.toEntityId : to;
    const row: Array<JsonValue> = [fromRef, l.fromPort, toRef, l.toPort];
    const optional: Array<number | null> = [
      l.fromSegmentIndex ?? null,
      l.toSegmentIndex ?? null,
      l.sameLayerSegmentDelta ?? null,
      l.crossLayerBlockSlot ?? null,
      l.voidBandInnerOuterCrossLayer ? 1 : null,
    ];
    if (!opts.removeDefaults) {
      row.push(...optional);
      return row;
    }
    while (optional.length > 0 && optional[optional.length - 1] === null) optional.pop();
    row.push(...optional);
    return row;
  });

  return {
    v: state.version,
    n: state.nextId,
    f: {
      e: ["type", "layer", "segmentIndex", "x", "y", "settings?", "isStatic?"],
      l: ["fromIdx", "fromPort", "toIdx", "toPort", "fromSeg?", "toSeg?", "delta?", "slot?", "void?"],
    },
    d: settingsItems,
    e: entities,
    l: links,
  };
}

function decodeIndexedDense(payload: JsonValue): BuilderState {
  const p = payload as any;
  const settingsItems = (p.d ?? []) as string[];
  const entities = (p.e as any[]).map((row, i) => {
    const typeRaw = row[0];
    const layerRaw = row[1];
    const templateType = typeof typeRaw === "number" ? [...templateCode.entries()].find((x) => x[1] === typeRaw)?.[0] : typeRaw;
    const layer = typeof layerRaw === "number" ? [...layerCode.entries()].find((x) => x[1] === layerRaw)?.[0] : layerRaw;
    const settingsRefs = Array.isArray(row[5]) ? row[5] : [];
    const settings: Record<string, string> = {};
    for (const refPair of settingsRefs) {
      const ref = Array.isArray(refPair) ? refPair[0] : refPair;
      const s = settingsItems[ref];
      if (typeof s !== "string") continue;
      const split = s.indexOf("\u0000");
      if (split <= 0) continue;
      settings[s.slice(0, split)] = s.slice(split + 1);
    }
    return {
      id: `e${i + 1}`,
      groupId: `e${i + 1}`,
      templateType: templateType ?? "endpoint",
      layer: layer ?? "outer64",
      segmentIndex: row[2] ?? 0,
      x: row[3] ?? 0,
      y: row[4] ?? 0,
      settings,
      ...(row[6] === 1 ? { isStatic: true } : {}),
    };
  });
  const links = (p.l as any[]).map((row, i) => {
    const fromRef = row[0];
    const toRef = row[2];
    const fromEntityId = typeof fromRef === "number" ? `e${fromRef + 1}` : String(fromRef);
    const toEntityId = typeof toRef === "number" ? `e${toRef + 1}` : String(toRef);
    return {
      id: `l${i + 1}`,
      groupId: `l${i + 1}`,
      fromEntityId,
      fromPort: row[1] ?? 0,
      toEntityId,
      toPort: row[3] ?? 0,
      ...(row[4] !== null && row[4] !== undefined ? { fromSegmentIndex: row[4] } : {}),
      ...(row[5] !== null && row[5] !== undefined ? { toSegmentIndex: row[5] } : {}),
      ...(row[6] !== null && row[6] !== undefined ? { sameLayerSegmentDelta: row[6] } : {}),
      ...(row[7] !== null && row[7] !== undefined ? { crossLayerBlockSlot: row[7] } : {}),
      ...(row[8] === 1 ? { voidBandInnerOuterCrossLayer: true } : {}),
    };
  });
  return { version: p.v ?? 1, nextId: p.n ?? entities.length + links.length + 1, entities, links };
}

function pushDict(dict: Map<string, number>, arr: string[], value: string): number {
  let idx = dict.get(value);
  if (idx === undefined) {
    idx = arr.length;
    arr.push(value);
    dict.set(value, idx);
  }
  return idx;
}

function numOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function transformTypedSettingsLinkOpcodes(state: BuilderState): JsonValue {
  const idToIndex = new Map<string, number>();
  state.entities.forEach((e, i) => idToIndex.set(e.id, i));

  const strDict = new Map<string, number>();
  const strings: string[] = [];

  const entities = state.entities.map((e) => {
    const t = templateCode.get(e.templateType) ?? 0;
    const l = layerCode.get(e.layer) ?? 0;
    const row: Array<JsonValue> = [t, l, e.segmentIndex, e.x, e.y];

    if (e.templateType === "endpoint") {
      const address = e.settings.address ?? "0.0.0.0";
      if (address !== "0.0.0.0") row.push([pushDict(strDict, strings, address)]);
    } else if (e.templateType === "relay") {
      const angle = ((numOr(e.settings.angle, 0) % 360) + 360) % 360;
      row.push([Math.floor(angle / 90) % 4]);
    } else if (e.templateType === "hub") {
      const rot = rotationCode.get(e.settings.rotation ?? "clockwise") ?? 0;
      const face = (((numOr(e.settings.faceAngle, 0) % 360) + 360) % 360) / 30;
      row.push([rot, Math.floor(face) % 12]);
    } else if (e.templateType === "text") {
      const label = e.settings.label ?? "";
      const w = numOr(e.settings.widthTiles, 2);
      const h = numOr(e.settings.heightTiles, 2);
      row.push([pushDict(strDict, strings, label), w, h]);
    } else if (e.templateType === "filter") {
      const opPort = numOr(e.settings.operatingPort, 0);
      const af = pushDict(strDict, strings, e.settings.addressField ?? "destination");
      const op = pushDict(strDict, strings, e.settings.operation ?? "differ");
      const mask = pushDict(strDict, strings, e.settings.mask ?? "*.*.*.*");
      const action = pushDict(strDict, strings, e.settings.action ?? "send_back");
      const coll = pushDict(strDict, strings, e.settings.collisionHandling ?? "send_back_outbound");
      row.push([opPort, af, op, mask, action, coll]);
    }

    if (e.isStatic === true) row.push(1);
    return row;
  });

  // Link opcodes:
  // 0: base [f,fp,t,tp,0]
  // 1: same-entity pin [f,fp,t,tp,1,fromSeg,toSeg]
  // 2: same-layer delta [f,fp,t,tp,2,delta]
  // 3: cross-layer slot [f,fp,t,tp,3,slot,void]
  const links = state.links.map((l) => {
    const from = idToIndex.get(l.fromEntityId);
    const to = idToIndex.get(l.toEntityId);
    const fromRef: JsonValue = from === undefined ? l.fromEntityId : from;
    const toRef: JsonValue = to === undefined ? l.toEntityId : to;

    if (l.fromSegmentIndex !== undefined && l.toSegmentIndex !== undefined) {
      return [fromRef, l.fromPort, toRef, l.toPort, 1, l.fromSegmentIndex, l.toSegmentIndex];
    }
    if (l.sameLayerSegmentDelta !== undefined) {
      return [fromRef, l.fromPort, toRef, l.toPort, 2, l.sameLayerSegmentDelta];
    }
    if (l.crossLayerBlockSlot !== undefined || l.voidBandInnerOuterCrossLayer === true) {
      return [fromRef, l.fromPort, toRef, l.toPort, 3, l.crossLayerBlockSlot ?? 0, l.voidBandInnerOuterCrossLayer ? 1 : 0];
    }
    return [fromRef, l.fromPort, toRef, l.toPort, 0];
  });

  return {
    v: 3,
    n: state.nextId,
    s: strings,
    e: entities,
    l: links,
  };
}

function decodeTypedSettingsLinkOpcodes(payload: JsonValue): BuilderState {
  const p = payload as any;
  const strings = (p.s ?? []) as string[];
  const entities = (p.e as any[]).map((row, i) => {
    const t = [...templateCode.entries()].find((x) => x[1] === row[0])?.[0] ?? "endpoint";
    const l = [...layerCode.entries()].find((x) => x[1] === row[1])?.[0] ?? "outer64";
    const settings: Record<string, string> = {};
    const settingsPayload = row[5];
    if (Array.isArray(settingsPayload)) {
      if (t === "endpoint") {
        const idx = settingsPayload[0];
        if (typeof idx === "number") settings.address = strings[idx] ?? "0.0.0.0";
      } else if (t === "relay") {
        const code = settingsPayload[0] ?? 0;
        settings.angle = String((code % 4) * 90);
      } else if (t === "hub") {
        settings.rotation = [...rotationCode.entries()].find((x) => x[1] === (settingsPayload[0] ?? 0))?.[0] ?? "clockwise";
        settings.faceAngle = String(((settingsPayload[1] ?? 0) % 12) * 30);
      } else if (t === "text") {
        const labelIdx = settingsPayload[0];
        settings.label = typeof labelIdx === "number" ? (strings[labelIdx] ?? "") : "";
        settings.widthTiles = String(settingsPayload[1] ?? 2);
        settings.heightTiles = String(settingsPayload[2] ?? 2);
      } else if (t === "filter") {
        settings.operatingPort = String(settingsPayload[0] ?? 0);
        const afIdx = settingsPayload[1];
        settings.addressField = typeof afIdx === "number" ? (strings[afIdx] ?? "destination") : "destination";
        const opIdx = settingsPayload[2];
        settings.operation = typeof opIdx === "number" ? (strings[opIdx] ?? "differ") : "differ";
        const maskIdx = settingsPayload[3];
        settings.mask = typeof maskIdx === "number" ? (strings[maskIdx] ?? "*.*.*.*") : "*.*.*.*";
        const actionIdx = settingsPayload[4];
        settings.action = typeof actionIdx === "number" ? (strings[actionIdx] ?? "send_back") : "send_back";
        const collIdx = settingsPayload[5];
        settings.collisionHandling = typeof collIdx === "number" ? (strings[collIdx] ?? "send_back_outbound") : "send_back_outbound";
      }
    }
    return {
      id: `e${i + 1}`,
      groupId: `e${i + 1}`,
      templateType: t,
      layer: l,
      segmentIndex: row[2] ?? 0,
      x: row[3] ?? 0,
      y: row[4] ?? 0,
      settings,
      ...(row[6] === 1 ? { isStatic: true } : {}),
    };
  });
  const links = (p.l as any[]).map((row, i) => {
    const fromRef = row[0];
    const toRef = row[2];
    const fromEntityId = typeof fromRef === "number" ? `e${fromRef + 1}` : String(fromRef);
    const toEntityId = typeof toRef === "number" ? `e${toRef + 1}` : String(toRef);
    const opcode = row[4] ?? 0;
    return {
      id: `l${i + 1}`,
      groupId: `l${i + 1}`,
      fromEntityId,
      fromPort: row[1] ?? 0,
      toEntityId,
      toPort: row[3] ?? 0,
      ...(opcode === 1 ? { fromSegmentIndex: row[5], toSegmentIndex: row[6] } : {}),
      ...(opcode === 2 ? { sameLayerSegmentDelta: row[5] } : {}),
      ...(opcode === 3 ? { crossLayerBlockSlot: row[5], ...(row[6] === 1 ? { voidBandInnerOuterCrossLayer: true } : {}) } : {}),
    };
  });
  return { version: 1, nextId: p.n ?? entities.length + links.length + 1, entities, links };
}

function semanticSignature(state: BuilderState): string {
  const idToIndex = new Map<string, number>();
  state.entities.forEach((e, i) => idToIndex.set(e.id, i));
  const entities = state.entities.map((e) => ({
    t: e.templateType,
    l: e.layer,
    s: e.segmentIndex,
    x: e.x,
    y: e.y,
    i: e.isStatic === true ? 1 : 0,
    z: Object.entries(e.settings).sort(([a], [b]) => a.localeCompare(b)),
  }));
  const links = state.links.map((l) => ({
    f: idToIndex.get(l.fromEntityId) ?? l.fromEntityId,
    fp: l.fromPort,
    t: idToIndex.get(l.toEntityId) ?? l.toEntityId,
    tp: l.toPort,
    fs: l.fromSegmentIndex ?? null,
    ts: l.toSegmentIndex ?? null,
    d: l.sameLayerSegmentDelta ?? null,
    c: l.crossLayerBlockSlot ?? null,
    v: l.voidBandInnerOuterCrossLayer === true ? 1 : 0,
  }));
  return JSON.stringify({ entities, links });
}

function sortedSettings(settings: Record<string, string>): Array<[string, string]> {
  return Object.entries(settings).sort(([a], [b]) => a.localeCompare(b));
}

function firstStateDifference(expected: BuilderState, actual: BuilderState): string | null {
  if (expected.entities.length !== actual.entities.length) {
    return `entities.length expected=${expected.entities.length} actual=${actual.entities.length}`;
  }
  if (expected.links.length !== actual.links.length) {
    return `links.length expected=${expected.links.length} actual=${actual.links.length}`;
  }

  const expectedEntityById = new Map(expected.entities.map((e) => [e.id, e]));
  const actualEntityById = new Map(actual.entities.map((e) => [e.id, e]));
  const idToIndex = new Map(expected.entities.map((e, i) => [e.id, i]));

  for (const [id, e] of expectedEntityById) {
    const a = actualEntityById.get(id);
    if (!a) return `entities[${id}] missing in reconstructed state`;
    const checks: Array<[string, unknown, unknown]> = [
      ["templateType", e.templateType, a.templateType],
      ["layer", e.layer, a.layer],
      ["segmentIndex", e.segmentIndex, a.segmentIndex],
      ["x", e.x, a.x],
      ["y", e.y, a.y],
      ["isStatic", e.isStatic === true, a.isStatic === true],
    ];
    for (const [k, ev, av] of checks) {
      if (ev !== av) return `entities[${id}].${k} expected=${String(ev)} actual=${String(av)}`;
    }
    const es = sortedSettings(e.settings);
    const as = sortedSettings(a.settings);
    if (es.length !== as.length) {
      return `entities[${id}].settings.length expected=${es.length} actual=${as.length}`;
    }
    for (let i = 0; i < es.length; i += 1) {
      const [ek, ev] = es[i]!;
      const [ak, av] = as[i]!;
      if (ek !== ak || ev !== av) {
        return `entities[${id}].settings[${i}] expected=${ek}=${ev} actual=${ak}=${av}`;
      }
    }
  }

  const normalizeLink = (l: BuilderState["links"][number]) => ({
    f: idToIndex.get(l.fromEntityId) ?? l.fromEntityId,
    fp: l.fromPort,
    t: idToIndex.get(l.toEntityId) ?? l.toEntityId,
    tp: l.toPort,
    fs: l.fromSegmentIndex ?? null,
    ts: l.toSegmentIndex ?? null,
    d: l.sameLayerSegmentDelta ?? null,
    c: l.crossLayerBlockSlot ?? null,
    v: l.voidBandInnerOuterCrossLayer === true ? 1 : 0,
  });

  for (let i = 0; i < expected.links.length; i += 1) {
    const el = normalizeLink(expected.links[i]!);
    const al = normalizeLink(actual.links[i]!);
    const keys: Array<keyof typeof el> = ["f", "fp", "t", "tp", "fs", "ts", "d", "c", "v"];
    for (const k of keys) {
      if (el[k] !== al[k]) {
        return `links[${i}].${k} expected=${String(el[k])} actual=${String(al[k])}`;
      }
    }
  }

  return null;
}

function quantizeToInt(value: number): number {
  return Math.round(value);
}

function transformTypedSettingsLinkOpcodesAggressive(
  state: BuilderState,
  opts: {
    quantizeXY: boolean;
    omitNextId: boolean;
    elideStaticOuterEndpoints: boolean;
  },
): JsonValue {
  let working = state;
  if (opts.elideStaticOuterEndpoints) {
    const keep = working.entities.filter(
      (e) => !(e.templateType === "endpoint" && e.layer === "outer64" && e.isStatic === true),
    );
    const keepIds = new Set(keep.map((e) => e.id));
    const links = working.links.filter((l) => keepIds.has(l.fromEntityId) && keepIds.has(l.toEntityId));
    working = { ...working, entities: keep, links };
  }

  const idToIndex = new Map<string, number>();
  working.entities.forEach((e, i) => idToIndex.set(e.id, i));

  const strDict = new Map<string, number>();
  const strings: string[] = [];

  const entities = working.entities.map((e) => {
    const t = templateCode.get(e.templateType) ?? 0;
    const l = layerCode.get(e.layer) ?? 0;
    const x = opts.quantizeXY ? quantizeToInt(e.x) : e.x;
    const y = opts.quantizeXY ? quantizeToInt(e.y) : e.y;
    const row: Array<JsonValue> = [t, l, e.segmentIndex, x, y];

    if (e.templateType === "endpoint") {
      const address = e.settings.address ?? "0.0.0.0";
      if (address !== "0.0.0.0") row.push([pushDict(strDict, strings, address)]);
    } else if (e.templateType === "relay") {
      const angle = ((numOr(e.settings.angle, 0) % 360) + 360) % 360;
      row.push([Math.floor(angle / 90) % 4]);
    } else if (e.templateType === "hub") {
      const rot = rotationCode.get(e.settings.rotation ?? "clockwise") ?? 0;
      const face = (((numOr(e.settings.faceAngle, 0) % 360) + 360) % 360) / 30;
      row.push([rot, Math.floor(face) % 12]);
    } else if (e.templateType === "text") {
      const label = e.settings.label ?? "";
      const w = numOr(e.settings.widthTiles, 2);
      const h = numOr(e.settings.heightTiles, 2);
      row.push([pushDict(strDict, strings, label), w, h]);
    } else if (e.templateType === "filter") {
      const opPort = numOr(e.settings.operatingPort, 0);
      const af = pushDict(strDict, strings, e.settings.addressField ?? "destination");
      const op = pushDict(strDict, strings, e.settings.operation ?? "differ");
      const mask = pushDict(strDict, strings, e.settings.mask ?? "*.*.*.*");
      const action = pushDict(strDict, strings, e.settings.action ?? "send_back");
      const coll = pushDict(strDict, strings, e.settings.collisionHandling ?? "send_back_outbound");
      row.push([opPort, af, op, mask, action, coll]);
    }

    if (e.isStatic === true) row.push(1);
    return row;
  });

  const links = working.links.map((l) => {
    const from = idToIndex.get(l.fromEntityId);
    const to = idToIndex.get(l.toEntityId);
    const fromRef: JsonValue = from === undefined ? l.fromEntityId : from;
    const toRef: JsonValue = to === undefined ? l.toEntityId : to;

    if (l.fromSegmentIndex !== undefined && l.toSegmentIndex !== undefined) {
      return [fromRef, l.fromPort, toRef, l.toPort, 1, l.fromSegmentIndex, l.toSegmentIndex];
    }
    if (l.sameLayerSegmentDelta !== undefined) {
      return [fromRef, l.fromPort, toRef, l.toPort, 2, l.sameLayerSegmentDelta];
    }
    if (l.crossLayerBlockSlot !== undefined || l.voidBandInnerOuterCrossLayer === true) {
      return [fromRef, l.fromPort, toRef, l.toPort, 3, l.crossLayerBlockSlot ?? 0, l.voidBandInnerOuterCrossLayer ? 1 : 0];
    }
    return [fromRef, l.fromPort, toRef, l.toPort, 0];
  });

  const payload: Record<string, JsonValue> = {
    v: 4,
    s: strings,
    e: entities,
    l: links,
  };
  if (!opts.omitNextId) payload.n = working.nextId;
  if (opts.elideStaticOuterEndpoints) payload.m = 1; // mark that static outer endpoints were elided
  if (opts.quantizeXY) payload.q = 1; // mark quantized coordinates
  return payload;
}

function transformTypedSettingsUndirectedWires(state: BuilderState): JsonValue {
  const idToIndex = new Map<string, number>();
  state.entities.forEach((e, i) => idToIndex.set(e.id, i));

  const strDict = new Map<string, number>();
  const strings: string[] = [];

  const entities = state.entities.map((e) => {
    const t = templateCode.get(e.templateType) ?? 0;
    const l = layerCode.get(e.layer) ?? 0;
    const row: Array<JsonValue> = [t, l, e.segmentIndex, e.x, e.y];
    if (e.templateType === "endpoint") {
      const address = e.settings.address ?? "0.0.0.0";
      if (address !== "0.0.0.0") row.push([pushDict(strDict, strings, address)]);
    } else if (e.templateType === "relay") {
      const angle = ((numOr(e.settings.angle, 0) % 360) + 360) % 360;
      row.push([Math.floor(angle / 90) % 4]);
    } else if (e.templateType === "hub") {
      const rot = rotationCode.get(e.settings.rotation ?? "clockwise") ?? 0;
      const face = (((numOr(e.settings.faceAngle, 0) % 360) + 360) % 360) / 30;
      row.push([rot, Math.floor(face) % 12]);
    } else if (e.templateType === "text") {
      const label = e.settings.label ?? "";
      const w = numOr(e.settings.widthTiles, 2);
      const h = numOr(e.settings.heightTiles, 2);
      row.push([pushDict(strDict, strings, label), w, h]);
    } else if (e.templateType === "filter") {
      const opPort = numOr(e.settings.operatingPort, 0);
      const af = pushDict(strDict, strings, e.settings.addressField ?? "destination");
      const op = pushDict(strDict, strings, e.settings.operation ?? "differ");
      const mask = pushDict(strDict, strings, e.settings.mask ?? "*.*.*.*");
      const action = pushDict(strDict, strings, e.settings.action ?? "send_back");
      const coll = pushDict(strDict, strings, e.settings.collisionHandling ?? "send_back_outbound");
      row.push([opPort, af, op, mask, action, coll]);
    }
    if (e.isStatic === true) row.push(1);
    return row;
  });

  // [aIdx,aPort,bIdx,bPort,kind,arg1?,arg2?]
  const wires = state.links.map((l) => {
    const f = idToIndex.get(l.fromEntityId);
    const t = idToIndex.get(l.toEntityId);
    const fromRef: JsonValue = f === undefined ? l.fromEntityId : f;
    const toRef: JsonValue = t === undefined ? l.toEntityId : t;
    const shouldSwap = typeof fromRef === "number" && typeof toRef === "number"
      ? fromRef > toRef || (fromRef === toRef && l.fromPort > l.toPort)
      : false;
    const aRef = shouldSwap ? toRef : fromRef;
    const bRef = shouldSwap ? fromRef : toRef;
    const aPort = shouldSwap ? l.toPort : l.fromPort;
    const bPort = shouldSwap ? l.fromPort : l.toPort;
    if (l.fromSegmentIndex !== undefined && l.toSegmentIndex !== undefined) {
      const s1 = shouldSwap ? l.toSegmentIndex : l.fromSegmentIndex;
      const s2 = shouldSwap ? l.fromSegmentIndex : l.toSegmentIndex;
      return [aRef, aPort, bRef, bPort, 1, s1, s2];
    }
    if (l.sameLayerSegmentDelta !== undefined) {
      return [aRef, aPort, bRef, bPort, 2, shouldSwap ? -l.sameLayerSegmentDelta : l.sameLayerSegmentDelta];
    }
    if (l.crossLayerBlockSlot !== undefined || l.voidBandInnerOuterCrossLayer === true) {
      return [aRef, aPort, bRef, bPort, 3, l.crossLayerBlockSlot ?? 0, l.voidBandInnerOuterCrossLayer ? 1 : 0];
    }
    return [aRef, aPort, bRef, bPort, 0];
  });

  wires.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { v: 6, n: state.nextId, s: strings, e: entities, w: wires };
}

function decodeTypedSettingsUndirectedWires(payload: JsonValue): BuilderState {
  const p = payload as any;
  const base = decodeTypedSettingsLinkOpcodes({ v: 3, n: p.n, s: p.s, e: p.e, l: [] });
  if (!base) return { version: 1, nextId: 1, entities: [], links: [] };
  const links = ((p.w ?? []) as any[]).map((row, i) => {
    const aRef = row[0];
    const bRef = row[2];
    const fromEntityId = typeof aRef === "number" ? `e${aRef + 1}` : String(aRef);
    const toEntityId = typeof bRef === "number" ? `e${bRef + 1}` : String(bRef);
    const kind = row[4] ?? 0;
    return {
      id: `l${i + 1}`,
      groupId: `l${i + 1}`,
      fromEntityId,
      fromPort: row[1] ?? 0,
      toEntityId,
      toPort: row[3] ?? 0,
      ...(kind === 1 ? { fromSegmentIndex: row[5], toSegmentIndex: row[6] } : {}),
      ...(kind === 2 ? { sameLayerSegmentDelta: row[5] } : {}),
      ...(kind === 3 ? { crossLayerBlockSlot: row[5], ...(row[6] === 1 ? { voidBandInnerOuterCrossLayer: true } : {}) } : {}),
    };
  });
  return { ...base, links };
}

function runBenchmark(token: string, sourceLabel: string): void {
  const state = decodeLayoutTokenToState(token);
  const baselineJson = JSON.stringify(state);
  const baselineToken = gzipTokenFromString(baselineJson);

  const variants: BenchmarkVariant[] = [
    { name: "baseline.current-shape", payload: state as unknown as JsonValue, decode: (x) => x as BuilderState },
    { name: "short-keys-only", payload: transformShortKeysOnly(state), decode: decodeShortKeysOnly },
    { name: "tuple-rows", payload: transformTupleRows(state), decode: decodeTupleRows },
    {
      name: "indexed-dense",
      payload: transformIndexedDense(state, { removeDefaults: false, enumInts: false }),
      decode: decodeIndexedDense,
    },
    {
      name: "indexed-dense+enum-ints",
      payload: transformIndexedDense(state, { removeDefaults: false, enumInts: true }),
      decode: decodeIndexedDense,
    },
    {
      name: "indexed-dense+enum-ints+omit-defaults",
      payload: transformIndexedDense(state, { removeDefaults: true, enumInts: true }),
      decode: decodeIndexedDense,
    },
    {
      name: "typed-settings+link-opcodes",
      payload: transformTypedSettingsLinkOpcodes(state),
      decode: decodeTypedSettingsLinkOpcodes,
    },
    {
      name: "typed+opcodes+quantized-xy",
      payload: transformTypedSettingsLinkOpcodesAggressive(state, {
        quantizeXY: true,
        omitNextId: false,
        elideStaticOuterEndpoints: false,
      }),
      decode: decodeTypedSettingsLinkOpcodes,
    },
    {
      name: "typed+opcodes+quantized-xy+omit-nextId",
      payload: transformTypedSettingsLinkOpcodesAggressive(state, {
        quantizeXY: true,
        omitNextId: true,
        elideStaticOuterEndpoints: false,
      }),
      decode: decodeTypedSettingsLinkOpcodes,
    },
    {
      name: "typed+undirected-wires",
      payload: transformTypedSettingsUndirectedWires(state),
      decode: decodeTypedSettingsUndirectedWires,
    },
  ];

  const baselineSignature = semanticSignature(state);
  const scored = variants.map((v) => {
    const json = JSON.stringify(v.payload);
    const tok = gzipTokenFromString(json);
    let roundtrip = "N/A";
    let firstDiff: string | null = null;
    if (v.decode) {
      try {
        const restored = v.decode(v.payload);
        if (semanticSignature(restored) === baselineSignature) {
          roundtrip = "PASS";
        } else {
          roundtrip = "FAIL";
          firstDiff = firstStateDifference(state, restored) ?? "unknown semantic mismatch";
        }
      } catch {
        roundtrip = "FAIL";
        firstDiff = "decoder threw";
      }
    }
    return {
      name: v.name,
      rawJsonBytes: compactJsonLength(v.payload),
      tokenLen: tok.length,
      deltaVsCurrentToken: tok.length - baselineToken.length,
      percentVsCurrent: ((tok.length / baselineToken.length) * 100).toFixed(2),
      roundtrip,
      firstDiff,
    };
  });

  scored.sort((a, b) => a.tokenLen - b.tokenLen);

  console.log(`\nLayout token benchmark (${sourceLabel})`);
  console.log(`Current token length: ${token.length}`);
  console.log(`Baseline re-encoded token length: ${baselineToken.length}`);
  console.log(`Baseline raw JSON bytes: ${Buffer.byteLength(baselineJson, "utf8")}`);
  console.log("\nSorted by shortest final token:\n");

  for (const row of scored) {
    const sign = row.deltaVsCurrentToken <= 0 ? "" : "+";
    console.log(
      `${row.name.padEnd(56)} token=${String(row.tokenLen).padStart(5)}  raw=${String(row.rawJsonBytes).padStart(6)}  vsCurrent=${sign}${row.deltaVsCurrentToken} (${row.percentVsCurrent}%)  roundtrip=${row.roundtrip}`,
    );
    if (row.roundtrip === "FAIL" && row.firstDiff) {
      console.log(`  firstDiff: ${row.firstDiff}`);
    }
  }

  const best = scored[0];
  console.log(`\nBest variant: ${best.name} (${best.tokenLen} chars)`);
}

function main(): void {
  const inputPath = process.argv[2] ?? DEFAULT_TEMP_PATH;
  const raw = readFileSync(inputPath, "utf8");
  const token = extractLayoutToken(raw);
  runBenchmark(token, inputPath);
}

main();
