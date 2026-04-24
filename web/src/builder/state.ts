export type BuilderLayer = "outer64" | "middle16" | "inner4";
export type BuilderTemplateType = "endpoint" | "relay" | "hub" | "filter";

export interface BuilderEntityRoot {
  id: string;
  groupId: string;
  templateType: BuilderTemplateType;
  layer: BuilderLayer;
  segmentIndex: number;
  x: number;
  y: number;
  settings: Record<string, string>;
  /** Omitted for entities from older saved JSON; set for fixed outer-leaf endpoints. */
  isStatic?: boolean;
}

export interface BuilderLinkRoot {
  id: string;
  groupId: string;
  fromEntityId: string;
  fromPort: number;
  toEntityId: string;
  toPort: number;
  /**
   * Same root only: template segments; expand mirrors every clone with toSeg = fromSeg + (to-from).
   * fromPort / toPort may differ (e.g. hub port 0 → port 1 on offset mirrors).
   */
  fromSegmentIndex?: number;
  toSegmentIndex?: number;
  /**
   * Same layer only (two different roots): each clone at segment s connects to segment s + delta.
   * Omitted or 0: parallel mirrors (s → s). Example delta 2: hub A@0 → hub B@2, A@1 → B@3, …
   */
  sameLayerSegmentDelta?: number;
  /**
   * Coarse↔fine only (different segment counts): which of r fine cells in the coarse block (0..r-1).
   * Set from the port you click so e.g. middle→outer uses one outer mirror per middle column, not all r.
   */
  crossLayerBlockSlot?: number;
}

export interface BuilderState {
  version: 1;
  entities: BuilderEntityRoot[];
  links: BuilderLinkRoot[];
  nextId: number;
}

function normalizeEntitySettings(
  templateType: BuilderTemplateType,
  settings: Record<string, string> | undefined,
): Record<string, string> {
  const src = settings ?? {};
  if (templateType === "relay") {
    const angleRaw = Number.parseFloat(src.angle ?? "0");
    const angle = Number.isFinite(angleRaw) ? angleRaw : 0;
    const snapped = Math.round(angle / 90) * 90;
    const normalized = ((snapped % 360) + 360) % 360;
    return { angle: String(normalized) };
  }
  return { ...src };
}

export const LAYER_COUNTS: Record<BuilderLayer, number> = {
  outer64: 64,
  middle16: 16,
  inner4: 4,
};

export const LAYER_ORDER: BuilderLayer[] = ["outer64", "middle16", "inner4"];

/** 0.0.3.0 – 0.0.3.3 have no devices; outer column indices 12–15 = one void band (1 middle width). */
export const OUTER_LEAF_VOID_START = 12;
export const OUTER_LEAF_VOID_END = 15;
export const OUTER_CANVAS_VOID_MERGE_KEY = "outer64:12-15-merged";

/**
 * 60 preplaced static endpoints (segments 0–11 and 16–63), excluding 12–15. Addresses: first 60 in
 * nibble order after skipping 0.0.3.0 – 0.0.3.3.
 */
export const OUTER_LEAF_ADDRESS_LIST_60: string[] = (() => {
  const out: string[] = [];
  for (let a = 0; a < 4; a += 1) {
    for (let b = 0; b < 4; b += 1) {
      for (let c = 0; c < 4; c += 1) {
        for (let d = 0; d < 4; d += 1) {
          if (a === 0 && b === 0 && c === 3) continue;
          out.push(`${a}.${b}.${c}.${d}`);
          if (out.length === 60) return out;
        }
      }
    }
  }
  return out;
})();

export function isOuterLeafVoidSegment(segmentIndex: number): boolean {
  return segmentIndex >= OUTER_LEAF_VOID_START && segmentIndex <= OUTER_LEAF_VOID_END;
}

/** 0-59 when segment is a non-void column; otherwise null. */
function outerLeafAddressIndexIn60(segmentIndex: number): number | null {
  if (isOuterLeafVoidSegment(segmentIndex)) return null;
  if (segmentIndex < 12) return segmentIndex;
  return segmentIndex - 4;
}

export function outerLeafAddressForNonVoidSegment(segmentIndex: number): string {
  const idx = outerLeafAddressIndexIn60(segmentIndex);
  if (idx === null) {
    return "0.0.0.0";
  }
  return OUTER_LEAF_ADDRESS_LIST_60[idx]!;
}

export const OUTER_LEAF_ENDPOINT_PREFIX = "ol-ep-";

export function outerLeafEntityId(segmentIndex: number): string {
  return `${OUTER_LEAF_ENDPOINT_PREFIX}${String(segmentIndex).padStart(2, "0")}`;
}

export function isStaticOuterLeafEndpoint(e: BuilderEntityRoot): boolean {
  return e.templateType === "endpoint" && e.layer === "outer64" && (e.isStatic || e.id.startsWith(OUTER_LEAF_ENDPOINT_PREFIX));
}

/**
 * Strips and re-adds 64 static outer leaf endpoints, remaps links from any prior outer
 * endpoint id by segment, and prunes dead links. Call after load/import.
 */
export function rebuildStateWithOuterLeafEndpoints(s: BuilderState): BuilderState {
  const rem = new Map<string, string>();
  for (const e of s.entities) {
    if (e.templateType === "endpoint" && e.layer === "outer64") {
      const seg = e.segmentIndex;
      if (seg >= 0 && seg < 64) {
        const nid = outerLeafEntityId(seg);
        if (!rem.has(e.id)) rem.set(e.id, nid);
      }
    }
  }
  const rest: BuilderEntityRoot[] = s.entities
    .filter((e) => !(e.templateType === "endpoint" && e.layer === "outer64"))
    .map((e) => ({
      ...e,
      settings: normalizeEntitySettings(e.templateType, e.settings),
    }));
  const staticEndps: BuilderEntityRoot[] = [];
  for (let seg = 0; seg < 64; seg += 1) {
    if (isOuterLeafVoidSegment(seg)) continue;
    const id = outerLeafEntityId(seg);
    staticEndps.push({
      id,
      groupId: id,
      templateType: "endpoint" as const,
      layer: "outer64" as const,
      segmentIndex: seg,
      x: 0,
      y: 0,
      settings: { address: outerLeafAddressForNonVoidSegment(seg) },
      isStatic: true,
    });
  }
  const allIds = new Set([...rest.map((e) => e.id), ...staticEndps.map((e) => e.id)]);
  const links = s.links
    .map((l) => ({
      ...l,
      fromEntityId: rem.get(l.fromEntityId) ?? l.fromEntityId,
      toEntityId: rem.get(l.toEntityId) ?? l.toEntityId,
    }))
    .filter((l) => allIds.has(l.fromEntityId) && allIds.has(l.toEntityId));
  return { ...s, entities: [...rest, ...staticEndps], links };
}

export function createEmptyBuilderState(): BuilderState {
  return rebuildStateWithOuterLeafEndpoints({
    version: 1,
    entities: [],
    links: [],
    nextId: 1,
  });
}

export function nextBuilderId(state: BuilderState, prefix: "e" | "l"): string {
  const id = `${prefix}${state.nextId}`;
  state.nextId += 1;
  return id;
}

export function segmentStride(layer: BuilderLayer): number {
  return 64 / LAYER_COUNTS[layer];
}

/**
 * From the two endpoint segments of a cross-layer link, derive the fine-grid lane within the coarse
 * block. Returns undefined if layers are the same or segments are not in the same alignment block.
 */
export function crossLayerBlockSlotFromSegments(
  fromLayer: BuilderLayer,
  fromSeg: number,
  toLayer: BuilderLayer,
  toSeg: number,
): number | undefined {
  const cf = LAYER_COUNTS[fromLayer];
  const ct = LAYER_COUNTS[toLayer];
  if (cf === ct) {
    return undefined;
  }
  if (ct > cf) {
    const r = ct / cf;
    if (!Number.isInteger(r) || r < 1) {
      return undefined;
    }
    if (Math.floor(toSeg / r) !== fromSeg) {
      return undefined;
    }
    const slot = toSeg - fromSeg * r;
    if (slot < 0 || slot >= r) {
      return undefined;
    }
    return slot;
  }
  const r = cf / ct;
  if (!Number.isInteger(r) || r < 1) {
    return undefined;
  }
  if (Math.floor(fromSeg / r) !== toSeg) {
    return undefined;
  }
  const slot = fromSeg - toSeg * r;
  if (slot < 0 || slot >= r) {
    return undefined;
  }
  return slot;
}

export function createEntityRoot(
  state: BuilderState,
  templateType: BuilderTemplateType,
  layer: BuilderLayer,
  segmentIndex: number,
  x = 0,
  y = 0,
): BuilderEntityRoot {
  const id = nextBuilderId(state, "e");
  return {
    id,
    groupId: id,
    templateType,
    layer,
    segmentIndex,
    x,
    y,
    settings: normalizeEntitySettings(templateType, defaultSettings(templateType)),
  };
}

export function createLinkRoot(
  state: BuilderState,
  fromEntityId: string,
  fromPort: number,
  toEntityId: string,
  toPort: number,
  extras?: {
    fromSegmentIndex?: number;
    toSegmentIndex?: number;
    sameLayerSegmentDelta?: number;
    crossLayerBlockSlot?: number;
  },
): BuilderLinkRoot {
  const id = nextBuilderId(state, "l");
  return {
    id,
    groupId: id,
    fromEntityId,
    fromPort,
    toEntityId,
    toPort,
    fromSegmentIndex: extras?.fromSegmentIndex,
    toSegmentIndex: extras?.toSegmentIndex,
    sameLayerSegmentDelta: extras?.sameLayerSegmentDelta,
    crossLayerBlockSlot: extras?.crossLayerBlockSlot,
  };
}

function linkTouchesPort(l: BuilderLinkRoot, entityId: string, port: number): boolean {
  return (l.fromEntityId === entityId && l.fromPort === port) || (l.toEntityId === entityId && l.toPort === port);
}

function sameDirectedEndpoints(
  l: BuilderLinkRoot,
  fromEntityId: string,
  fromPort: number,
  toEntityId: string,
  toPort: number,
): boolean {
  return (
    l.fromEntityId === fromEntityId &&
    l.fromPort === fromPort &&
    l.toEntityId === toEntityId &&
    l.toPort === toPort
  );
}

function instancePortKey(entityId: string, segmentIndex: number, port: number): string {
  return `${entityId}@${segmentIndex}#${port}`;
}

function buildInstancePortSetForLink(
  link: BuilderLinkRoot,
  byId: Map<string, BuilderEntityRoot>,
): Set<string> | null {
  const from = byId.get(link.fromEntityId);
  const to = byId.get(link.toEntityId);
  if (!from || !to) {
    return null;
  }
  const fromCount = LAYER_COUNTS[from.layer];
  const toCount = LAYER_COUNTS[to.layer];
  const out = new Set<string>();

  // Same-root template: mirrors with toSeg = fromSeg + (pTo - pFrom).
  if (link.fromEntityId === link.toEntityId && link.fromSegmentIndex !== undefined && link.toSegmentIndex !== undefined) {
    const d = link.toSegmentIndex - link.fromSegmentIndex;
    for (let s = 0; s < fromCount; s += 1) {
      const t = s + d;
      if (t < 0 || t >= toCount) continue;
      out.add(instancePortKey(link.fromEntityId, s, link.fromPort));
      out.add(instancePortKey(link.toEntityId, t, link.toPort));
    }
    return out;
  }

  // Same-layer two roots: mirrors with toSeg = fromSeg + delta.
  if (fromCount === toCount) {
    const d = link.sameLayerSegmentDelta ?? 0;
    for (let s = 0; s < fromCount; s += 1) {
      const t = s + d;
      if (t < 0 || t >= toCount) continue;
      out.add(instancePortKey(link.fromEntityId, s, link.fromPort));
      out.add(instancePortKey(link.toEntityId, t, link.toPort));
    }
    return out;
  }

  // Cross-layer with explicit lane (slot): one fine per coarse segment.
  const slot = link.crossLayerBlockSlot;
  if (slot !== undefined) {
    if (toCount > fromCount) {
      const r = toCount / fromCount;
      if (!Number.isInteger(r) || slot < 0 || slot >= r) return null;
      for (let s = 0; s < fromCount; s += 1) {
        const t = s * r + slot;
        if (t < 0 || t >= toCount) continue;
        out.add(instancePortKey(link.fromEntityId, s, link.fromPort));
        out.add(instancePortKey(link.toEntityId, t, link.toPort));
      }
      return out;
    }
    const r = fromCount / toCount;
    if (!Number.isInteger(r) || slot < 0 || slot >= r) return null;
    for (let t = 0; t < toCount; t += 1) {
      const s = t * r + slot;
      if (s < 0 || s >= fromCount) continue;
      out.add(instancePortKey(link.fromEntityId, s, link.fromPort));
      out.add(instancePortKey(link.toEntityId, t, link.toPort));
    }
    return out;
  }

  // Legacy cross-layer behavior: all aligned base columns (occupies all segments on both sides).
  for (let s = 0; s < fromCount; s += 1) {
    out.add(instancePortKey(link.fromEntityId, s, link.fromPort));
  }
  for (let t = 0; t < toCount; t += 1) {
    out.add(instancePortKey(link.toEntityId, t, link.toPort));
  }
  return out;
}

function overlapsAnyInstancePort(
  a: BuilderLinkRoot,
  b: BuilderLinkRoot,
  byId: Map<string, BuilderEntityRoot>,
): boolean {
  const aSet = buildInstancePortSetForLink(a, byId);
  const bSet = buildInstancePortSetForLink(b, byId);
  if (!aSet || !bSet) return false;
  let hit = false;
  aSet.forEach((key) => {
    if (!hit && bSet.has(key)) hit = true;
  });
  return hit;
}

export type AddLinkRootOpts = {
  /** Same root: template segments; mirrors all clones with same port pair and segment offset. */
  sameEntityPin?: { fromSegmentIndex: number; toSegmentIndex: number };
  /** Same layer, two roots: mirrored offset toSegment = fromSegment + delta (0 = parallel). */
  sameLayerSegmentDelta?: number;
  /** Coarse↔fine cross-layer: lane 0..r-1 from the clicked fine segment. */
  crossLayerBlockSlot?: number;
};

/**
 * Default: unpinned cross-layer (or same-layer parallel when delta omitted).
 * Same-entity pin / same-layer delta: segment template from the ports you connect.
 */
export function addLinkRootOneWirePerPort(
  state: BuilderState,
  fromEntityId: string,
  fromPort: number,
  toEntityId: string,
  toPort: number,
  opts?: AddLinkRootOpts,
): { state: BuilderState; link: BuilderLinkRoot | null } {
  const byId = new Map(state.entities.map((e) => [e.id, e]));
  const pin = opts?.sameEntityPin;
  const delta = opts?.sameLayerSegmentDelta;
  if (pin) {
    if (fromEntityId !== toEntityId) {
      return { state, link: null };
    }
    if (pin.fromSegmentIndex === pin.toSegmentIndex) {
      return { state, link: null };
    }
    const { fromSegmentIndex, toSegmentIndex } = pin;
    const candidate: BuilderLinkRoot = {
      id: "__candidate__",
      groupId: "__candidate__",
      fromEntityId,
      fromPort,
      toEntityId,
      toPort,
      fromSegmentIndex,
      toSegmentIndex,
    };
    const without = state.links.filter((l) => !overlapsAnyInstancePort(l, candidate, byId));
    const next: BuilderState = { ...state, links: without };
    const link = createLinkRoot(next, fromEntityId, fromPort, toEntityId, toPort, {
      fromSegmentIndex,
      toSegmentIndex,
    });
    return { state: { ...next, links: [...without, link] }, link };
  }
  if (delta !== undefined) {
    if (fromEntityId === toEntityId) {
      return { state, link: null };
    }
    const fromEnt = state.entities.find((e) => e.id === fromEntityId);
    const toEnt = state.entities.find((e) => e.id === toEntityId);
    if (!fromEnt || !toEnt || fromEnt.layer !== toEnt.layer) {
      return { state, link: null };
    }
    const candidate: BuilderLinkRoot = {
      id: "__candidate__",
      groupId: "__candidate__",
      fromEntityId,
      fromPort,
      toEntityId,
      toPort,
      sameLayerSegmentDelta: delta,
    };
    const without = state.links.filter((l) => !overlapsAnyInstancePort(l, candidate, byId));
    const next: BuilderState = { ...state, links: without };
    const link = createLinkRoot(next, fromEntityId, fromPort, toEntityId, toPort, {
      sameLayerSegmentDelta: delta,
    });
    return { state: { ...next, links: [...without, link] }, link };
  }
  if (fromEntityId === toEntityId) {
    return { state, link: null };
  }
  const slot = opts?.crossLayerBlockSlot;
  const candidate: BuilderLinkRoot = {
    id: "__candidate__",
    groupId: "__candidate__",
    fromEntityId,
    fromPort,
    toEntityId,
    toPort,
    crossLayerBlockSlot: slot,
  };
  const without = state.links.filter((l) => !overlapsAnyInstancePort(l, candidate, byId));
  const next: BuilderState = { ...state, links: without };
  const link = createLinkRoot(
    next,
    fromEntityId,
    fromPort,
    toEntityId,
    toPort,
    slot !== undefined ? { crossLayerBlockSlot: slot } : undefined,
  );
  return { state: { ...next, links: [...without, link] }, link };
}

export function templatePortCount(type: BuilderTemplateType): number {
  if (type === "endpoint") return 1;
  if (type === "relay") return 2;
  if (type === "filter") return 2;
  return 3;
}

export function defaultSettings(type: BuilderTemplateType): Record<string, string> {
  if (type === "relay") {
    return { angle: "0" };
  }
  if (type === "filter") {
    return {
      operatingPort: "0",
      addressField: "destination",
      operation: "differ",
      mask: "*.*.*.*",
      action: "send_back",
      collisionHandling: "send_back_outbound",
    };
  }
  if (type === "hub") {
    return { rotation: "clockwise", faceAngle: "0" };
  }
  if (type === "endpoint") {
    return { address: "0.0.0.0" };
  }
  return {};
}

export function removeEntityGroup(state: BuilderState, groupId: string): BuilderState {
  if (state.entities.some((e) => e.groupId === groupId && (e.isStatic || isStaticOuterLeafEndpoint(e)))) {
    return state;
  }
  const entityIds = new Set(state.entities.filter((e) => e.groupId === groupId).map((e) => e.id));
  const entities = state.entities.filter((e) => e.groupId !== groupId);
  const links = state.links.filter((l) => !entityIds.has(l.fromEntityId) && !entityIds.has(l.toEntityId));
  return { ...state, entities, links };
}

export function removeLinkGroup(state: BuilderState, groupId: string): BuilderState {
  return { ...state, links: state.links.filter((l) => l.groupId !== groupId) };
}

export function updateEntitySettings(
  state: BuilderState,
  entityId: string,
  settings: Record<string, string>,
): BuilderState {
  const e = state.entities.find((x) => x.id === entityId);
  if (e && (e.isStatic || isStaticOuterLeafEndpoint(e))) {
    return state;
  }
  return {
    ...state,
    entities: state.entities.map((x) =>
      x.id === entityId ? { ...x, settings: normalizeEntitySettings(x.templateType, settings) } : x,
    ),
  };
}

export function updateEntityPosition(
  state: BuilderState,
  entityId: string,
  x: number,
  y: number,
): BuilderState {
  const ex = state.entities.find((en) => en.id === entityId);
  if (ex && (ex.isStatic || isStaticOuterLeafEndpoint(ex))) {
    return state;
  }
  return {
    ...state,
    entities: state.entities.map((ent) => (ent.id === entityId ? { ...ent, x, y } : ent)),
  };
}
