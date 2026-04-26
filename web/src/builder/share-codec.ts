import type { BuilderEntityRoot, BuilderLinkRoot, BuilderState, BuilderTemplateType, BuilderLayer } from "./state";

const SHARE_STATE_VERSION = 1;

const TEMPLATE_TYPES: BuilderTemplateType[] = ["endpoint", "relay", "hub", "filter", "text"];
const LAYERS: BuilderLayer[] = ["outer64", "middle16", "inner4", "core1"];

type CompactEntityRow = [number, number, number, number, number, number[]?, 1?];
type CompactLinkRow = [number, number, number, number, number?, number?, number?, number?, 1?];

interface CompactShareStateV1 {
  v: 1;
  n: number;
  d: string[];
  e: CompactEntityRow[];
  l: CompactLinkRow[];
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function encodeSettingsDictionary(
  settings: Record<string, string>,
  indexByPair: Map<string, number>,
  pairs: string[],
): number[] | undefined {
  const refs: number[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const pair = `${key}\u0000${value}`;
    let idx = indexByPair.get(pair);
    if (idx === undefined) {
      idx = pairs.length;
      pairs.push(pair);
      indexByPair.set(pair, idx);
    }
    refs.push(idx);
  }
  return refs.length > 0 ? refs : undefined;
}

function decodeSettingsDictionary(refs: number[] | undefined, pairs: string[]): Record<string, string> {
  if (!refs || refs.length === 0) return {};
  const settings: Record<string, string> = {};
  for (const ref of refs) {
    if (!isFiniteInteger(ref) || ref < 0 || ref >= pairs.length) continue;
    const pair = pairs[ref] ?? "";
    const splitIdx = pair.indexOf("\u0000");
    if (splitIdx <= 0) continue;
    const key = pair.slice(0, splitIdx);
    const value = pair.slice(splitIdx + 1);
    settings[key] = value;
  }
  return settings;
}

export function encodeBuilderShareState(state: BuilderState): unknown {
  const settingsPairIndex = new Map<string, number>();
  const settingsPairs: string[] = [];
  const entityIndexById = new Map<string, number>();

  const entities: CompactEntityRow[] = state.entities.map((entity, index) => {
    entityIndexById.set(entity.id, index);
    const typeCode = TEMPLATE_TYPES.indexOf(entity.templateType);
    const layerCode = LAYERS.indexOf(entity.layer);
    const settingsRefs = encodeSettingsDictionary(entity.settings, settingsPairIndex, settingsPairs);
    const row: CompactEntityRow = [
      Math.max(0, typeCode),
      Math.max(0, layerCode),
      entity.segmentIndex,
      entity.x,
      entity.y,
    ];
    if (settingsRefs) row.push(settingsRefs);
    if (entity.isStatic === true) row.push(1);
    return row;
  });

  const links: CompactLinkRow[] = state.links.map((link) => {
    const fromIdx = entityIndexById.get(link.fromEntityId);
    const toIdx = entityIndexById.get(link.toEntityId);
    if (fromIdx === undefined || toIdx === undefined) return [0, 0, 0, 0];
    const optionals: Array<number | undefined> = [
      link.fromSegmentIndex,
      link.toSegmentIndex,
      link.sameLayerSegmentDelta,
      link.crossLayerBlockSlot,
      link.voidBandInnerOuterCrossLayer ? 1 : undefined,
    ];
    while (optionals.length > 0 && optionals[optionals.length - 1] === undefined) optionals.pop();
    return [fromIdx, link.fromPort, toIdx, link.toPort, ...optionals] as CompactLinkRow;
  });

  return {
    v: SHARE_STATE_VERSION,
    n: state.nextId,
    d: settingsPairs,
    e: entities,
    l: links,
  } satisfies CompactShareStateV1;
}

export function decodeBuilderShareState(payload: unknown): BuilderState | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<CompactShareStateV1>;
  if (p.v !== SHARE_STATE_VERSION || !Array.isArray(p.d) || !Array.isArray(p.e) || !Array.isArray(p.l)) return null;
  if (!isFiniteInteger(p.n) || p.n < 1) return null;
  if (!p.d.every((x) => typeof x === "string")) return null;

  const entities: BuilderEntityRoot[] = [];
  for (let i = 0; i < p.e.length; i += 1) {
    const row = p.e[i];
    if (!Array.isArray(row) || row.length < 5) return null;
    const [typeCode, layerCode, segmentIndex, x, y, settingsRefs, isStaticFlag] = row;
    if (
      !isFiniteInteger(typeCode) ||
      !isFiniteInteger(layerCode) ||
      !isFiniteInteger(segmentIndex) ||
      typeof x !== "number" ||
      typeof y !== "number"
    ) {
      return null;
    }
    const templateType = TEMPLATE_TYPES[typeCode];
    const layer = LAYERS[layerCode];
    if (!templateType || !layer) return null;
    const id = `e${i + 1}`;
    const settings = decodeSettingsDictionary(Array.isArray(settingsRefs) ? settingsRefs : undefined, p.d);
    entities.push({
      id,
      groupId: id,
      templateType,
      layer,
      segmentIndex,
      x,
      y,
      settings,
      ...(isStaticFlag === 1 ? { isStatic: true } : {}),
    });
  }

  const links: BuilderLinkRoot[] = [];
  let nextLinkId = entities.length + 1;
  for (let i = 0; i < p.l.length; i += 1) {
    const row = p.l[i];
    if (!Array.isArray(row) || row.length < 4) return null;
    const [fromIdx, fromPort, toIdx, toPort, fromSegmentIndex, toSegmentIndex, sameLayerSegmentDelta, crossLayerBlockSlot, voidBand] = row;
    if (!isFiniteInteger(fromIdx) || !isFiniteInteger(fromPort) || !isFiniteInteger(toIdx) || !isFiniteInteger(toPort)) {
      return null;
    }
    const fromEntity = entities[fromIdx];
    const toEntity = entities[toIdx];
    if (!fromEntity || !toEntity) return null;
    const id = `l${nextLinkId}`;
    nextLinkId += 1;
    links.push({
      id,
      groupId: id,
      fromEntityId: fromEntity.id,
      fromPort,
      toEntityId: toEntity.id,
      toPort,
      ...(isFiniteInteger(fromSegmentIndex) ? { fromSegmentIndex } : {}),
      ...(isFiniteInteger(toSegmentIndex) ? { toSegmentIndex } : {}),
      ...(isFiniteInteger(sameLayerSegmentDelta) ? { sameLayerSegmentDelta } : {}),
      ...(isFiniteInteger(crossLayerBlockSlot) ? { crossLayerBlockSlot } : {}),
      ...(voidBand === 1 ? { voidBandInnerOuterCrossLayer: true } : {}),
    });
  }

  const minNext = entities.length + links.length + 1;
  return {
    version: 1,
    entities,
    links,
    nextId: Math.max(p.n, minNext),
  };
}

