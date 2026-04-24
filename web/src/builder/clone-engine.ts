import {
  BuilderEntityRoot,
  BuilderLayer,
  BuilderLinkRoot,
  BuilderState,
  isOuterLeafVoidSegment,
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

/** Parse `rootId@segment` from port / entity `data-instance-id` (last `@` is the split). */
export function parseBuilderInstanceId(id: string): { rootId: string; segmentIndex: number } | null {
  const at = id.lastIndexOf("@");
  if (at < 0) return null;
  const rootId = id.slice(0, at);
  const seg = Number(id.slice(at + 1));
  if (rootId.length === 0 || !Number.isInteger(seg) || seg < 0) return null;
  return { rootId, segmentIndex: seg };
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
      if (
        view &&
        root.layer === "outer64" &&
        (
          // For roots placed in the merged 0.0.3.* area, keep only their primary instance.
          isOuterLeafVoidSegment(root.segmentIndex)
            ? segment !== root.segmentIndex
            : // For non-void outer roots, never mirror into 0.0.3.* segments.
              isOuterLeafVoidSegment(segment) && segment !== root.segmentIndex
        )
      ) {
        continue;
      }
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
    const pFrom = root.fromSegmentIndex;
    const pTo = root.toSegmentIndex;
    if (pFrom != null && pTo != null && from.id === to.id) {
      if (pFrom < 0 || pFrom >= fromCount || pTo < 0 || pTo >= toCount) {
        continue;
      }
      const d = pTo - pFrom;
      for (let fromSeg = 0; fromSeg < fromCount; fromSeg += 1) {
        const toSeg = fromSeg + d;
        if (toSeg < 0 || toSeg >= toCount) {
          continue;
        }
        out.push({
          instanceId: `${root.id}@se-${fromSeg}-${toSeg}`,
          rootId: root.id,
          groupId: root.groupId,
          fromInstanceId: instanceId(from.id, fromSeg),
          fromPort: root.fromPort,
          toInstanceId: instanceId(to.id, toSeg),
          toPort: root.toPort,
          isShadow: fromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
        });
      }
      continue;
    }
    if ((pFrom == null) !== (pTo == null)) {
      continue;
    }
    if (fromCount === toCount) {
      const d = root.sameLayerSegmentDelta ?? 0;
      for (let fromSeg = 0; fromSeg < fromCount; fromSeg += 1) {
        const toSeg = fromSeg + d;
        if (toSeg < 0 || toSeg >= toCount) {
          continue;
        }
        out.push({
          instanceId: `${root.id}@sl-${fromSeg}-${toSeg}`,
          rootId: root.id,
          groupId: root.groupId,
          fromInstanceId: instanceId(from.id, fromSeg),
          fromPort: root.fromPort,
          toInstanceId: instanceId(to.id, toSeg),
          toPort: root.toPort,
          isShadow: fromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
        });
      }
      continue;
    }

    const slot = root.crossLayerBlockSlot;

    if (fromCount > toCount) {
      const r = fromCount / toCount;
      if (!Number.isInteger(r) || r < 1) {
        continue;
      }
      if (slot != null) {
        if (slot < 0 || slot >= r) {
          continue;
        }
        for (let toSeg = 0; toSeg < toCount; toSeg += 1) {
          const fromSeg = toSeg * r + slot;
          if (fromSeg < 0 || fromSeg >= fromCount) {
            continue;
          }
          out.push({
            instanceId: `${root.id}@f2c-s${toSeg}-${fromSeg}`,
            rootId: root.id,
            groupId: root.groupId,
            fromInstanceId: instanceId(from.id, fromSeg),
            fromPort: root.fromPort,
            toInstanceId: instanceId(to.id, toSeg),
            toPort: root.toPort,
            isShadow: fromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
          });
        }
        continue;
      }
      for (let base = 0; base < 64; base += 1) {
        const fromSeg = segmentByBaseColumn(from.layer, base);
        const toSeg = segmentByBaseColumn(to.layer, base);
        if (fromSeg < 0 || fromSeg >= fromCount || toSeg < 0 || toSeg >= toCount) {
          continue;
        }
        out.push({
          instanceId: `${root.id}@f2c-b${base}`,
          rootId: root.id,
          groupId: root.groupId,
          fromInstanceId: instanceId(from.id, fromSeg),
          fromPort: root.fromPort,
          toInstanceId: instanceId(to.id, toSeg),
          toPort: root.toPort,
          isShadow: fromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
        });
      }
      continue;
    }

    if (toCount > fromCount) {
      const r = toCount / fromCount;
      if (!Number.isInteger(r) || r < 1) {
        continue;
      }
      if (slot != null) {
        if (slot < 0 || slot >= r) {
          continue;
        }
        for (let fromSeg = 0; fromSeg < fromCount; fromSeg += 1) {
          const toSeg = fromSeg * r + slot;
          if (toSeg < 0 || toSeg >= toCount) {
            continue;
          }
          out.push({
            instanceId: `${root.id}@c2f-s${fromSeg}-${toSeg}`,
            rootId: root.id,
            groupId: root.groupId,
            fromInstanceId: instanceId(from.id, fromSeg),
            fromPort: root.fromPort,
            toInstanceId: instanceId(to.id, toSeg),
            toPort: root.toPort,
            isShadow: fromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
          });
        }
        continue;
      }
      for (let base = 0; base < 64; base += 1) {
        const fromSeg = segmentByBaseColumn(from.layer, base);
        const toSeg = segmentByBaseColumn(to.layer, base);
        if (fromSeg < 0 || fromSeg >= fromCount || toSeg < 0 || toSeg >= toCount) {
          continue;
        }
        out.push({
          instanceId: `${root.id}@c2f-b${base}`,
          rootId: root.id,
          groupId: root.groupId,
          fromInstanceId: instanceId(from.id, fromSeg),
          fromPort: root.fromPort,
          toInstanceId: instanceId(to.id, toSeg),
          toPort: root.toPort,
          isShadow: fromSeg !== from.segmentIndex || toSeg !== to.segmentIndex,
        });
      }
      continue;
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
