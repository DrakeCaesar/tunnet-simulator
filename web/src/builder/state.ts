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

export function createEmptyBuilderState(): BuilderState {
  return {
    version: 1,
    entities: [],
    links: [],
    nextId: 1,
  };
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
    return { rotation: "clockwise" };
  }
  if (type === "endpoint") {
    return { address: "0.0.0.0" };
  }
  return { mode: "pass-through" };
}

export function removeEntityGroup(state: BuilderState, groupId: string): BuilderState {
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
  return {
    ...state,
    entities: state.entities.map((e) => (e.id === entityId ? { ...e, settings: { ...settings } } : e)),
  };
}

export function updateEntityPosition(
  state: BuilderState,
  entityId: string,
  x: number,
  y: number,
): BuilderState {
  const nx = Math.max(0, Math.min(1, x));
  const ny = Math.max(0, Math.min(1, y));
  return {
    ...state,
    entities: state.entities.map((e) => (e.id === entityId ? { ...e, x: nx, y: ny } : e)),
  };
}
