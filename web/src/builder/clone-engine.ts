import {
  BuilderEntityRoot,
  BuilderLayer,
  BuilderLinkRoot,
  BuilderState,
  isStaticOuterLeafEndpoint,
  LAYER_COUNTS,
  LAYER_ORDER,
  segmentStride,
  templatePortCount,
} from "./state";

export interface BuilderEntityInstance {
  instanceId: string;
  rootId: string;
  groupId: string;
  templateType: BuilderEntityRoot["templateType"];
  layer: BuilderLayer;
  segmentIndex: number;
  x: number;
  y: number;
  isShadow: boolean;
  settings: Record<string, string>;
  ports: number[];
}

export interface BuilderLinkInstance {
  instanceId: string;
  rootId: string;
  groupId: string;
  fromInstanceId: string;
  fromPort: number;
  toInstanceId: string;
  toPort: number;
  isShadow: boolean;
}

export interface ExpandedBuilderState {
  entities: BuilderEntityInstance[];
  links: BuilderLinkInstance[];
}

function wrappedAdd(value: number, add: number): number {
  return (value + add) % 4;
}

function strideForMask(layer: BuilderLayer, fixedIndex: number): number | null {
  if (layer === "inner4") {
    return fixedIndex === 1 ? 1 : null;
  }
  if (layer === "middle16") {
    if (fixedIndex === 1) return 4;
    if (fixedIndex === 2) return 1;
    return null;
  }
  if (fixedIndex === 1) return 16;
  if (fixedIndex === 2) return 4;
  if (fixedIndex === 3) return 1;
  return null;
}

export function mapMaskForSegment(mask: string, layer: BuilderLayer, deltaSegments: number): string {
  const parts = mask.split(".");
  if (parts.length !== 4) return mask;
  const fixed = parts
    .map((value, idx) => ({ value, idx }))
    .filter((entry) => entry.value !== "*")
    .filter((entry) => /^\d+$/.test(entry.value));
  if (fixed.length !== 1) return mask;
  const fixedIndex = fixed[0].idx;
  const stride = strideForMask(layer, fixedIndex);
  if (!stride) return mask;
  const delta = Math.floor(deltaSegments / stride);
  const original = Number(parts[fixedIndex]);
  if (!Number.isFinite(original)) return mask;
  parts[fixedIndex] = String(wrappedAdd(original, delta));
  return parts.join(".");
}

function transformSettingsForSegment(
  root: BuilderEntityRoot,
  segmentIndex: number,
): Record<string, string> {
  const settings = { ...root.settings };
  if (root.templateType !== "filter") {
    return settings;
  }
  const delta = (segmentIndex - root.segmentIndex + LAYER_COUNTS[root.layer]) % LAYER_COUNTS[root.layer];
  if (typeof settings.mask === "string") {
    settings.mask = mapMaskForSegment(settings.mask, root.layer, delta);
  }
  return settings;
}

function instanceId(rootId: string, segment: number): string {
  return `${rootId}@${segment}`;
}

/**
 * In builder UI we only need one (non-shadow) view per fixed outer endpoint; a full
 * expansion would be 64 roots × 64 columns = 4096 entities and is unusable.
 * Simulation/compile use the full expand (builderView off).
 */
function expandEntities(roots: BuilderEntityRoot[], opts?: { builderView?: boolean }): BuilderEntityInstance[] {
  const view = opts?.builderView === true;
  const out: BuilderEntityInstance[] = [];
  for (const root of roots) {
    if (view && isStaticOuterLeafEndpoint(root)) {
      const segment = root.segmentIndex;
      out.push({
        instanceId: instanceId(root.id, segment),
        rootId: root.id,
        groupId: root.groupId,
        templateType: root.templateType,
        layer: root.layer,
        segmentIndex: segment,
        x: root.x,
        y: root.y,
        isShadow: false,
        settings: transformSettingsForSegment(root, segment),
        ports: Array.from({ length: templatePortCount(root.templateType) }, (_, i) => i),
      });
      continue;
    }
    const count = LAYER_COUNTS[root.layer];
    for (let segment = 0; segment < count; segment += 1) {
      out.push({
        instanceId: instanceId(root.id, segment),
        rootId: root.id,
        groupId: root.groupId,
        templateType: root.templateType,
        layer: root.layer,
        segmentIndex: segment,
        x: root.x,
        y: root.y,
        isShadow: segment !== root.segmentIndex,
        settings: transformSettingsForSegment(root, segment),
        ports: Array.from({ length: templatePortCount(root.templateType) }, (_, i) => i),
      });
    }
  }
  return out;
}

function segmentByBaseColumn(layer: BuilderLayer, baseColumn: number): number {
  const stride = segmentStride(layer);
  return Math.max(0, Math.min(LAYER_COUNTS[layer] - 1, Math.floor(baseColumn / stride)));
}

export function expandLinks(roots: BuilderLinkRoot[], entityRoots: BuilderEntityRoot[]): BuilderLinkInstance[] {
  const out: BuilderLinkInstance[] = [];
  const byId = new Map(entityRoots.map((e) => [e.id, e]));
  for (const root of roots) {
    const from = byId.get(root.fromEntityId);
    const to = byId.get(root.toEntityId);
    if (!from || !to) continue;
    const fromCount = LAYER_COUNTS[from.layer];
    const toCount = LAYER_COUNTS[to.layer];
    const seenPairs = new Set<string>();

    for (let base = 0; base < 64; base += 1) {
      const fromSeg = segmentByBaseColumn(from.layer, base);
      const toSeg = segmentByBaseColumn(to.layer, base);
      if (fromCount > toCount) {
        // Finer → coarser: each segment on the coarser (upper) side corresponds to a block of
        // fromCount / toCount columns on the finer (lower) side. One link per (toSeg), not one per
        // base column in that block.
        const r = fromCount / toCount;
        if (!Number.isInteger(r) || r < 1) continue;
        const f2cKey = `f2c-${toSeg}`;
        if (seenPairs.has(f2cKey)) continue;
        seenPairs.add(f2cKey);
        const repFromSeg = toSeg * r;
        if (repFromSeg > fromCount - 1) continue;
        out.push({
          instanceId: `${root.id}@f2c${toSeg}`,
          rootId: root.id,
          groupId: root.groupId,
          fromInstanceId: instanceId(from.id, repFromSeg),
          fromPort: root.fromPort,
          toInstanceId: instanceId(to.id, toSeg),
          toPort: root.toPort,
          isShadow: repFromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
        });
        continue;
      }
      if (toCount > fromCount) {
        // Coarser → finer: one segment on the coarser (e.g. middle) maps to a block of toCount
        // / fromCount fine segments (e.g. 4 outers). One link per (fromSeg); use the first column in
        // the block. To get 4 distinct connections, the user places 4 devices on the coarse row.
        const r = toCount / fromCount;
        if (!Number.isInteger(r) || r < 1) continue;
        const c2fKey = `c2f-${fromSeg}`;
        if (seenPairs.has(c2fKey)) continue;
        seenPairs.add(c2fKey);
        const repToSeg = fromSeg * r;
        if (repToSeg > toCount - 1) continue;
        out.push({
          instanceId: `${root.id}@c2f${fromSeg}`,
          rootId: root.id,
          groupId: root.groupId,
          fromInstanceId: instanceId(from.id, fromSeg),
          fromPort: root.fromPort,
          toInstanceId: instanceId(to.id, repToSeg),
          toPort: root.toPort,
          isShadow: fromSeg !== from.segmentIndex || repToSeg !== to.segmentIndex,
        });
        continue;
      }
      // Same layer: one wire per (fromSeg, toSeg) along the 64 column grid.
      const key = `${fromSeg}:${toSeg}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      out.push({
        instanceId: `${root.id}@${fromSeg}:${toSeg}`,
        rootId: root.id,
        groupId: root.groupId,
        fromInstanceId: instanceId(from.id, fromSeg),
        fromPort: root.fromPort,
        toInstanceId: instanceId(to.id, toSeg),
        toPort: root.toPort,
        isShadow: fromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
      });
    }
  }
  return out;
}

export function expandBuilderState(
  state: BuilderState,
  options?: { builderView?: boolean },
): ExpandedBuilderState {
  const entities = expandEntities(state.entities, options);
  const links = expandLinks(state.links, state.entities);
  return { entities, links };
}

export function layerTitle(layer: BuilderLayer): string {
  if (layer === "outer64") return "Outer (64)";
  if (layer === "middle16") return "Middle (16)";
  return "Inner (4)";
}

export function layerColumns(layer: BuilderLayer): number[] {
  const count = LAYER_COUNTS[layer];
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * 61 grid slots: columns 0–11, one merged cell for outer indices 12–15 (0.0.3.*, no endpoints),
 * then 16–63. Span 4 matches one middle-16 column width.
 */
export type OuterBuilderColumnSlot = number | "void-12-15";

export function outerLayerBuilderColumnSlots(): OuterBuilderColumnSlot[] {
  return [
    ...Array.from({ length: 12 }, (_, i) => i as OuterBuilderColumnSlot),
    "void-12-15" as const,
    ...Array.from({ length: 48 }, (_, i) => (i + 16) as OuterBuilderColumnSlot),
  ];
}

export function segmentLabel(layer: BuilderLayer, segment: number): string {
  if (layer === "outer64") return `${segment}`;
  if (layer === "middle16") return `${segment * 4}-${segment * 4 + 3}`;
  return `${segment * 16}-${segment * 16 + 15}`;
}

export function orderedLayersTopDown(): BuilderLayer[] {
  return [...LAYER_ORDER];
}
