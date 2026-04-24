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
}

export interface BuilderState {
  version: 1;
  entities: BuilderEntityRoot[];
  links: BuilderLinkRoot[];
  nextId: number;
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
  const rest: BuilderEntityRoot[] = s.entities.filter(
    (e) => !(e.templateType === "endpoint" && e.layer === "outer64"),
  );
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
      x: 0.5,
      y: 0.04,
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

export function createEntityRoot(
  state: BuilderState,
  templateType: BuilderTemplateType,
  layer: BuilderLayer,
  segmentIndex: number,
  x = 0.08,
  y = 0.08,
): BuilderEntityRoot {
  const id = nextBuilderId(state, "e");
  return {
    id,
    groupId: id,
    templateType,
    layer,
    segmentIndex,
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    settings: defaultSettings(templateType),
  };
}

export function createLinkRoot(
  state: BuilderState,
  fromEntityId: string,
  fromPort: number,
  toEntityId: string,
  toPort: number,
): BuilderLinkRoot {
  const id = nextBuilderId(state, "l");
  return {
    id,
    groupId: id,
    fromEntityId,
    fromPort,
    toEntityId,
    toPort,
  };
}

function linkTouchesPort(l: BuilderLinkRoot, entityId: string, port: number): boolean {
  return (
    (l.fromEntityId === entityId && l.fromPort === port) || (l.toEntityId === entityId && l.toPort === port)
  );
}

/** Replaces any existing link that uses either endpoint (entity+port) so each port has at most one wire. */
export function addLinkRootOneWirePerPort(
  state: BuilderState,
  fromEntityId: string,
  fromPort: number,
  toEntityId: string,
  toPort: number,
): { state: BuilderState; link: BuilderLinkRoot | null } {
  if (fromEntityId === toEntityId) {
    return { state, link: null };
  }
  const without = state.links.filter(
    (l) =>
      !linkTouchesPort(l, fromEntityId, fromPort) && !linkTouchesPort(l, toEntityId, toPort),
  );
  const next: BuilderState = { ...state, links: without };
  const link = createLinkRoot(next, fromEntityId, fromPort, toEntityId, toPort);
  return { state: { ...next, links: [...without, link] }, link };
}

export function templatePortCount(type: BuilderTemplateType): number {
  if (type === "endpoint") return 1;
  if (type === "relay") return 2;
  if (type === "filter") return 2;
  return 3;
}

export function defaultSettings(type: BuilderTemplateType): Record<string, string> {
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
  return { mode: "pass-through" };
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
    entities: state.entities.map((x) => (x.id === entityId ? { ...x, settings: { ...settings } } : x)),
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
  const nx = Math.max(0, Math.min(1, x));
  const ny = Math.max(0, Math.min(1, y));
  return {
    ...state,
    entities: state.entities.map((ent) => (ent.id === entityId ? { ...ent, x: nx, y: ny } : ent)),
  };
}
