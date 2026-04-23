import {
  BuilderEntityRoot,
  BuilderLayer,
  BuilderLinkRoot,
  BuilderState,
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

function expandEntities(roots: BuilderEntityRoot[]): BuilderEntityInstance[] {
  const out: BuilderEntityInstance[] = [];
  for (const root of roots) {
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

function expandLinks(roots: BuilderLinkRoot[], entityRoots: BuilderEntityRoot[]): BuilderLinkInstance[] {
  const out: BuilderLinkInstance[] = [];
  const byId = new Map(entityRoots.map((e) => [e.id, e]));
  for (const root of roots) {
    const from = byId.get(root.fromEntityId);
    const to = byId.get(root.toEntityId);
    if (!from || !to) continue;
    const seenPairs = new Set<string>();
    for (let base = 0; base < 64; base += 1) {
      const fromSeg = segmentByBaseColumn(from.layer, base);
      const toSeg = segmentByBaseColumn(to.layer, base);
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

export function expandBuilderState(state: BuilderState): ExpandedBuilderState {
  const entities = expandEntities(state.entities);
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

export function segmentLabel(layer: BuilderLayer, segment: number): string {
  if (layer === "outer64") return `${segment}`;
  if (layer === "middle16") return `${segment * 4}-${segment * 4 + 3}`;
  return `${segment * 16}-${segment * 16 + 15}`;
}

export function orderedLayersTopDown(): BuilderLayer[] {
  return [...LAYER_ORDER];
}
