import {
  BuilderEntityRoot,
  BuilderLayer,
  BuilderTemplateType,
  createEntityRoot,
  addLinkRootOneWirePerPort,
  createEmptyBuilderState,
  crossLayerBlockSlotFromSegments,
  defaultSettings,
  isStaticOuterLeafEndpoint,
  isOuterLeafVoidSegment,
  OUTER_CANVAS_VOID_MERGE_KEY,
  rebuildStateWithOuterLeafEndpoints,
  removeEntityGroup,
  removeLinkGroup,
  updateEntityPosition,
  updateEntitySettings,
} from "./state";
import {
  expandBuilderState,
  expandLinks,
  layerColumns,
  layerTitle,
  parseBuilderInstanceId,
  outerLayerBuilderColumnSlots,
  orderedLayersTopDown,
  segmentLabel,
} from "./clone-engine";
import {
  exportBuilderStateText,
  importBuilderStateText,
  loadBuilderState,
  saveBuilderState,
} from "./persistence";
import { compileBuilderToViewerPayload } from "./compile";

const VIEWER_PREVIEW_KEY = "tunnet.builder.previewPayload";

/** One mask nibble cycles * → 0 → 1 → 2 → 3 → * (matches game semantics). */
const MASK_VALUE_CYCLE = ["*", "0", "1", "2", "3"] as const;

function hubMarkerId(instanceId: string): string {
  return `hubmk-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** SVG / hit box for hub (matches `.builder-hub` in CSS). */
const HUB_VIEW = { w: 108, h: 96 } as const;

type HubVec = { x: number; y: number };

type HubLayout = { T: HubVec; L: HubVec; R: HubVec; r: number; G: HubVec };

/** Equilateral triangle: apex up, base horizontal; `r` matches half of global `.builder-port` (16px). */
function hubEquilateralLayout(): HubLayout {
  const r = 8;
  const s = 70;
  const h = (s * Math.sqrt(3)) / 2;
  const cx = HUB_VIEW.w / 2;
  const ty = 18;
  const by = ty + h;
  const T: HubVec = { x: cx, y: ty };
  const L: HubVec = { x: cx - s / 2, y: by };
  const R: HubVec = { x: cx + s / 2, y: by };
  const G: HubVec = { x: (T.x + L.x + R.x) / 3, y: (T.y + L.y + R.y) / 3 };
  return { T, L, R, r, G };
}

const HUB_LAYOUT = hubEquilateralLayout();

function hubPortPinStyle(c: HubVec): string {
  return `left:${(c.x / HUB_VIEW.w) * 100}%;top:${(c.y / HUB_VIEW.h) * 100}%;transform:translate(-50%,-50%)`;
}

/** Port pins on a rotating layer: keep port labels world-upright. */
function hubPortPinUprightStyle(c: HubVec, faceDeg: number): string {
  return `left:${(c.x / HUB_VIEW.w) * 100}%;top:${(c.y / HUB_VIEW.h) * 100}%;transform:translate(-50%,-50%) rotate(${-faceDeg}deg)`;
}

/** Band outside the equilateral (model space) for rotation; inside = move. */
const HUB_RING_PX = 30;

function hubLocalToModel(localX: number, localY: number, faceDeg: number): HubVec {
  const g = HUB_LAYOUT.G;
  const rad = (-faceDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const relx = localX - g.x;
  const rely = localY - g.y;
  return { x: g.x + relx * c - rely * s, y: g.y + relx * s + rely * c };
}

function hubPointInOrOnTri(p: HubVec, t: HubVec, l: HubVec, r: HubVec): boolean {
  const v0x = l.x - t.x;
  const v0y = l.y - t.y;
  const v1x = r.x - t.x;
  const v1y = r.y - t.y;
  const v2x = p.x - t.x;
  const v2y = p.y - t.y;
  const d00 = v0x * v0x + v0y * v0y;
  const d01 = v0x * v1x + v0y * v1y;
  const d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y;
  const d21 = v2x * v1x + v2y * v1y;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-9) return false;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  const e = 1e-4;
  return u >= -e && v >= -e && w >= -e;
}

function hubDistToSeg(p: HubVec, a: HubVec, b: HubVec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}

function hubPointerMode(
  localX: number,
  localY: number,
  faceDeg: number,
): "move" | "rotate" | "none" {
  const t = HUB_LAYOUT.T;
  const l = HUB_LAYOUT.L;
  const r = HUB_LAYOUT.R;
  const p = hubLocalToModel(localX, localY, faceDeg);
  if (hubPointInOrOnTri(p, t, l, r)) return "move";
  const d = Math.min(
    hubDistToSeg(p, t, l),
    hubDistToSeg(p, l, r),
    hubDistToSeg(p, r, t),
  );
  if (d <= HUB_RING_PX) return "rotate";
  return "none";
}

function hvDist(a: HubVec, b: HubVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hvUnit(v: HubVec): HubVec {
  const d = Math.hypot(v.x, v.y);
  return { x: v.x / d, y: v.y / d };
}

function hvAdd(a: HubVec, b: HubVec): HubVec {
  return { x: a.x + b.x, y: a.y + b.y };
}

function hvSub(a: HubVec, b: HubVec): HubVec {
  return { x: a.x - b.x, y: a.y - b.y };
}

function hvScale(v: HubVec, s: number): HubVec {
  return { x: v.x * s, y: v.y * s };
}

function hvPerpL(v: HubVec): HubVec {
  return { x: -v.y, y: v.x };
}

/** Same-radius outer tangent segment [on a, on b] whose midpoint is farther from ref (outside the cluster). */
function hubOuterTangent(a: HubVec, b: HubVec, r: number, ref: HubVec): [HubVec, HubVec] {
  const u = hvUnit(hvSub(b, a));
  const n = hvPerpL(u);
  const p0 = hvAdd(a, hvScale(n, r));
  const p1 = hvAdd(b, hvScale(n, r));
  const m0 = hvAdd(a, hvScale(n, -r));
  const m1 = hvAdd(b, hvScale(n, -r));
  const midP = hvScale(hvAdd(p0, p1), 0.5);
  const midM = hvScale(hvAdd(m0, m1), 0.5);
  return hvDist(midP, ref) > hvDist(midM, ref) ? [p0, p1] : [m0, m1];
}

function hubAngle(c: HubVec, p: HubVec): number {
  return Math.atan2(p.y - c.y, p.x - c.x);
}

function hubPolylineArc(c: HubVec, r: number, p0: HubVec, p1: HubVec, ref: HubVec, steps: number): string {
  const a0 = hubAngle(c, p0);
  const a1 = hubAngle(c, p1);
  let delta = a1 - a0;
  const normalize = (): void => {
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta <= -Math.PI) delta += 2 * Math.PI;
  };
  normalize();
  let alt = delta > 0 ? delta - 2 * Math.PI : delta + 2 * Math.PI;
  const mid0 = a0 + delta * 0.5;
  const mid1 = a0 + alt * 0.5;
  const pt0 = { x: c.x + r * Math.cos(mid0), y: c.y + r * Math.sin(mid0) };
  const pt1 = { x: c.x + r * Math.cos(mid1), y: c.y + r * Math.sin(mid1) };
  if (hvDist(pt1, ref) > hvDist(pt0, ref)) delta = alt;
  let s = "";
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ang = a0 + delta * t;
    s += ` L ${c.x + r * Math.cos(ang)} ${c.y + r * Math.sin(ang)}`;
  }
  return s;
}

function hubArrowBetween(a: HubVec, b: HubVec, r: number, pad: number): string {
  const u = hvUnit(hvSub(b, a));
  const start = hvAdd(a, hvScale(u, r + pad));
  const end = hvSub(b, hvScale(u, r + pad));
  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}

/** Pool-rack outline + arrows between port circles. ViewBox matches `HUB_VIEW` / `.builder-hub`. */
function hubTriangleSvg(instanceId: string, rotation: string | undefined): string {
  const mid = hubMarkerId(instanceId);
  const cw = (rotation ?? "clockwise") !== "counterclockwise";
  const { T, L, R, r, G } = HUB_LAYOUT;

  const [tTL, lTL] = hubOuterTangent(T, L, r, G);
  const [lLR, rLR] = hubOuterTangent(L, R, r, G);
  const [rRT, tRT] = hubOuterTangent(R, T, r, G);

  const arcSteps = 16;
  const d = [
    `M ${tRT.x} ${tRT.y}`,
    hubPolylineArc(T, r, tRT, tTL, G, arcSteps),
    ` L ${lTL.x} ${lTL.y}`,
    hubPolylineArc(L, r, lTL, lLR, G, arcSteps),
    ` L ${rLR.x} ${rLR.y}`,
    hubPolylineArc(R, r, rLR, rRT, G, arcSteps),
    " Z",
  ].join("");

  const pad = 3.5;
  /* Clockwise sim 0→1→2→0 matches screen-clockwise around triangle: top → bottom-right → bottom-left. */
  const arrows = cw
    ? [
        hubArrowBetween(T, R, r, pad),
        hubArrowBetween(R, L, r, pad),
        hubArrowBetween(L, T, r, pad),
      ]
        .map((p) => `<path class="builder-hub-arrow" marker-end="url(#${mid}-tip)" d="${p}" />`)
        .join("")
    : [
        hubArrowBetween(T, L, r, pad),
        hubArrowBetween(L, R, r, pad),
        hubArrowBetween(R, T, r, pad),
      ]
        .map((p) => `<path class="builder-hub-arrow" marker-end="url(#${mid}-tip)" d="${p}" />`)
        .join("");

  return `<svg class="builder-hub-svg" viewBox="0 0 ${HUB_VIEW.w} ${HUB_VIEW.h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <defs>
      <marker id="${mid}-tip" viewBox="0 0 4 4" refX="3.1" refY="2" markerWidth="3" markerHeight="3" orient="auto">
        <path d="M0,0 L4,2 L0,4 Z" fill="rgba(255,255,255,0.4)" />
      </marker>
    </defs>
    <path class="builder-hub-rotate-hint" d="${d}" />
    <path class="builder-hub-triangle" d="${d}" pointer-events="visiblePainted" />
    <g pointer-events="none">${arrows}</g>
  </svg>`;
}

interface BuilderMountOptions {
  root: HTMLDivElement;
  onPreviewReady?: () => void;
}

type EntitySelection = { kind: "entity"; rootId: string };
type LinkSelection = { kind: "link"; rootId: string };
type Selection = EntitySelection | LinkSelection | null;

interface LinkSourceSelection {
  rootId: string;
  port: number;
  /** Port DOM identity for this clone (mirrors share rootId). */
  instanceId: string;
}

type BuilderPerfKey =
  | "canvas.total"
  | "canvas.expand"
  | "canvas.bucketSort"
  | "canvas.htmlBuild"
  | "canvas.domCommit"
  | "canvas.portCache"
  | "wire.total"
  | "wire.expandLinks"
  | "wire.portResolve"
  | "wire.lineBuild";

type BuilderPerfStat = { lastMs: number; emaMs: number; maxMs: number; samples: number };

function templateList(): BuilderTemplateType[] {
  return ["relay", "hub", "filter"];
}

function isBuilderTemplateType(value: string): value is BuilderTemplateType {
  return value === "relay" || value === "hub" || value === "filter";
}

function templateLabel(type: BuilderTemplateType): string {
  if (type === "relay") return "Relay";
  if (type === "hub") return "Hub";
  return "Filter";
}

function buildFilterDescription(settings: Record<string, string>): string {
  const operatingPort = settings.operatingPort === "1" ? 1 : 0;
  const nonOperatingPort = operatingPort === 0 ? 1 : 0;
  const addressField = settings.addressField === "source" ? "source" : "destination";
  const operation = settings.operation === "match" ? "match" : "differ";
  const action = settings.action === "drop" ? "drop" : "send_back";
  const collisionHandling =
    settings.collisionHandling === "drop_inbound" || settings.collisionHandling === "drop_outbound"
      ? settings.collisionHandling
      : "send_back_outbound";
  const mask = settings.mask ?? "*.*.*.*";

  const fieldText = addressField === "destination" ? `addressed to ${mask}` : `emitted by ${mask}`;
  const qualifier = operation === "match" ? `which are ${fieldText}` : `which are not ${fieldText}`;
  const actionText = action === "drop" ? "Drops" : "Sends back";
  const firstLine = `${actionText} packets received on port ${operatingPort} ${qualifier}.`;
  if (action === "drop") {
    return firstLine;
  }
  if (collisionHandling === "drop_inbound") {
    return `${firstLine}\nIn case of collision, the packet received on port ${operatingPort} is dropped.`;
  }
  if (collisionHandling === "drop_outbound") {
    return `${firstLine}\nIn case of collision, the packet received on port ${nonOperatingPort} is dropped.`;
  }
  return `${firstLine}\nIn case of collision, the packet received on port ${nonOperatingPort} is sent back.`;
}

export function mountBuilderView(options: BuilderMountOptions): void {
  const { root, onPreviewReady } = options;
  let raw = loadBuilderState();
  if (!raw || raw.version !== 1) {
    raw = createEmptyBuilderState();
  }
  let state = rebuildStateWithOuterLeafEndpoints(raw);

  let draggingTemplate: BuilderTemplateType | null = null;
  let dragLayer: BuilderLayer | null = null;
  let dragSegment: number | null = null;
  let selection: Selection = null;
  let linkDrag: { from: LinkSourceSelection; endClient: { x: number; y: number } } | null = null;
  let dragRenderRaf: number | null = null;
  let wireDragRaf: number | null = null;
  let wireOverlayRaf: number | null = null;
  let portElByInstancePort = new Map<string, HTMLButtonElement>();

  root.innerHTML = `
    <div class="builder-layout">
      <aside class="builder-sidebar card">
        <div class="section-title">Templates</div>
        <div id="builder-templates"></div>
        <div class="section-title builder-spacer">Actions</div>
        <div class="builder-actions">
          <button id="builder-delete" type="button">Delete selected</button>
          <button id="builder-delete-all" type="button">Delete all</button>
          <button id="builder-export" type="button">Export Text</button>
          <button id="builder-import" type="button">Import Text</button>
          <button id="builder-preview" type="button">Preview In Viewer</button>
        </div>
        <div class="section-title builder-spacer">Performance</div>
        <pre id="builder-perf" class="builder-perf">Collecting samples...</pre>
      </aside>
      <main class="builder-main card">
        <div class="section-title">Canvas (64 -> 16 -> 4)</div>
        <div class="builder-canvas-wrap">
          <svg id="builder-wire-overlay" class="builder-wire-overlay"></svg>
          <div id="builder-canvas" class="builder-canvas"></div>
        </div>
      </main>
      <aside class="builder-inspector card">
        <div class="section-title">Inspector</div>
        <div id="builder-inspector">No selection.</div>
      </aside>
    </div>
  `;

  const templatesEl = root.querySelector<HTMLDivElement>("#builder-templates")!;
  const canvasEl = root.querySelector<HTMLDivElement>("#builder-canvas")!;
  const wireOverlayEl = root.querySelector<SVGSVGElement>("#builder-wire-overlay")!;
  const inspectorEl = root.querySelector<HTMLDivElement>("#builder-inspector")!;
  const perfEl = root.querySelector<HTMLPreElement>("#builder-perf")!;
  const deleteBtn = root.querySelector<HTMLButtonElement>("#builder-delete")!;
  const deleteAllBtn = root.querySelector<HTMLButtonElement>("#builder-delete-all")!;
  const exportBtn = root.querySelector<HTMLButtonElement>("#builder-export")!;
  const importBtn = root.querySelector<HTMLButtonElement>("#builder-import")!;
  const previewBtn = root.querySelector<HTMLButtonElement>("#builder-preview")!;
  const perfStats = new Map<BuilderPerfKey, BuilderPerfStat>();
  const PERF_EMA_ALPHA = 0.18;
  let perfCounts = { expandedEntities: 0, stateLinks: 0, expandedLinks: 0 };

  function recordPerf(key: BuilderPerfKey, ms: number): void {
    const prev = perfStats.get(key);
    if (!prev) {
      perfStats.set(key, { lastMs: ms, emaMs: ms, maxMs: ms, samples: 1 });
      return;
    }
    prev.lastMs = ms;
    prev.emaMs = PERF_EMA_ALPHA * ms + (1 - PERF_EMA_ALPHA) * prev.emaMs;
    prev.maxMs = Math.max(prev.maxMs, ms);
    prev.samples += 1;
  }

  function fmtPerf(ms: number): string {
    return `${ms.toFixed(2).padStart(6)}ms`;
  }

  function renderPerfPanel(): void {
    const get = (key: BuilderPerfKey): BuilderPerfStat =>
      perfStats.get(key) ?? { lastMs: 0, emaMs: 0, maxMs: 0, samples: 0 };
    const ordered: BuilderPerfKey[] = [
      "canvas.total",
      "canvas.expand",
      "canvas.bucketSort",
      "canvas.htmlBuild",
      "canvas.domCommit",
      "canvas.portCache",
      "wire.total",
      "wire.expandLinks",
      "wire.portResolve",
      "wire.lineBuild",
    ];
    const totalCanvas = Math.max(0.0001, get("canvas.total").lastMs);
    const totalWire = Math.max(0.0001, get("wire.total").lastMs);
    const topCanvas = ([
      "canvas.expand",
      "canvas.bucketSort",
      "canvas.htmlBuild",
      "canvas.domCommit",
      "canvas.portCache",
    ] as BuilderPerfKey[])
      .map((k) => ({ k, v: get(k).lastMs }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    const topWire = ([
      "wire.expandLinks",
      "wire.portResolve",
      "wire.lineBuild",
    ] as BuilderPerfKey[])
      .map((k) => ({ k, v: get(k).lastMs }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    const lines = [
      `entities=${perfCounts.expandedEntities}  stateLinks=${perfCounts.stateLinks}  expandedLinks=${perfCounts.expandedLinks}`,
      "",
      "Metric                      last      ema      max   n",
      ...ordered.map((k) => {
        const s = get(k);
        const label = k.padEnd(24, " ");
        return `${label}${fmtPerf(s.lastMs)} ${fmtPerf(s.emaMs)} ${fmtPerf(s.maxMs)} ${String(s.samples).padStart(4)}`;
      }),
      "",
      `Top canvas contributors (last=${totalCanvas.toFixed(2)}ms):`,
      ...topCanvas.map((x) => `  ${x.k.padEnd(22, " ")} ${(x.v / totalCanvas * 100).toFixed(1).padStart(5)}% (${x.v.toFixed(2)}ms)`),
      "",
      `Top wire contributors (last=${totalWire.toFixed(2)}ms):`,
      ...topWire.map((x) => `  ${x.k.padEnd(22, " ")} ${(x.v / totalWire * 100).toFixed(1).padStart(5)}% (${x.v.toFixed(2)}ms)`),
    ];
    perfEl.textContent = lines.join("\n");
  }

  function persist(): void {
    saveBuilderState(state);
  }

  function applySelectionToCanvas(): void {
    canvasEl.querySelectorAll<HTMLElement>(".builder-entity.selected").forEach((el) => {
      el.classList.remove("selected");
    });
    if (selection?.kind !== "entity") return;
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${selection.rootId}"]`)
      .forEach((el) => {
        el.classList.add("selected");
      });
  }

  function setSelection(next: Selection): void {
    selection = next;
    linkDrag = null;
    renderInspector();
    applySelectionToCanvas();
    renderWireOverlay();
  }

  function renderTemplates(): void {
    templatesEl.innerHTML = templateList()
      .map(
        (type) =>
          `<div class="builder-template" draggable="true" data-template="${type}">${templateLabel(type)}</div>`,
      )
      .join("");
    templatesEl.querySelectorAll<HTMLElement>(".builder-template").forEach((el) => {
      el.addEventListener("dragstart", (ev) => {
        draggingTemplate = el.dataset.template as BuilderTemplateType;
        if (ev.dataTransfer) {
          ev.dataTransfer.setData("text/plain", draggingTemplate);
          ev.dataTransfer.effectAllowed = "copy";
        }
      });
      el.addEventListener("dragend", () => {
        draggingTemplate = null;
        dragLayer = null;
        dragSegment = null;
        renderCanvas();
      });
    });
  }

  function previewInstances(): Set<string> {
    if (!draggingTemplate || dragLayer === null || dragSegment === null) {
      return new Set<string>();
    }
    const previewRoot: BuilderEntityRoot = {
      id: "preview",
      groupId: "preview",
      templateType: draggingTemplate,
      layer: dragLayer,
      segmentIndex: dragSegment,
      x: 0.08,
      y: 0.08,
      settings: defaultSettings(draggingTemplate),
    };
    return new Set(
      expandBuilderState(
        { version: 1, entities: [previewRoot], links: [], nextId: 0 },
        { builderView: true },
      ).entities.map((entity) => {
        if (entity.layer === "outer64" && isOuterLeafVoidSegment(entity.segmentIndex)) {
          return OUTER_CANVAS_VOID_MERGE_KEY;
        }
        return `${entity.layer}:${entity.segmentIndex}`;
      }),
    );
  }

  function portCacheKey(instanceId: string, port: number): string {
    return `${instanceId}#${port}`;
  }

  function rebuildPortElementCache(): void {
    const next = new Map<string, HTMLButtonElement>();
    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-port[data-instance-id][data-port]").forEach((portEl) => {
      const instanceId = portEl.dataset.instanceId ?? "";
      const p = Number(portEl.dataset.port);
      if (!instanceId || Number.isNaN(p)) return;
      next.set(portCacheKey(instanceId, p), portEl);
    });
    portElByInstancePort = next;
  }

  function resolveBuilderPortForWireOverlay(instanceId: string, port: number): HTMLButtonElement | null {
    const byInstance = portElByInstancePort.get(portCacheKey(instanceId, port)) ?? null;
    if (byInstance) return byInstance;
    const m = instanceId.match(/^(.+)@(\d+)$/);
    if (!m) return null;
    const rootId = m[1] ?? "";
    const seg = Number(m[2]);
    if (!Number.isInteger(seg) || seg < 0 || seg > 63) return null;
    const root = state.entities.find((e) => e.id === rootId);
    if (!root || !isStaticOuterLeafEndpoint(root) || root.layer !== "outer64") {
      return null;
    }
    if (isOuterLeafVoidSegment(seg)) {
      return canvasEl.querySelector<HTMLButtonElement>(
        `.builder-segment[data-void-outer="1"] .builder-port[data-instance-id="${instanceId}"][data-port="${port}"]`,
      );
    }
    return canvasEl.querySelector<HTMLButtonElement>(
      `.builder-segment[data-layer="outer64"][data-segment="${seg}"] [data-static-endpoint="1"] .builder-port[data-port="${port}"]`,
    );
  }

  function setEntityDomPosition(rootId: string, x: number, y: number): void {
    const left = `${x * 100}%`;
    const top = `${y * 100}%`;
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`)
      .forEach((entityEl) => {
        entityEl.style.left = left;
        entityEl.style.top = top;
      });
  }

  function setHubFaceAngleDom(rootId: string, faceDeg: number): void {
    const normalizedFace = ((faceDeg % 360) + 360) % 360;
    const portStyleFor = (port: string): string => {
      if (port === "0") return hubPortPinUprightStyle(HUB_LAYOUT.T, normalizedFace);
      if (port === "1") return hubPortPinUprightStyle(HUB_LAYOUT.R, normalizedFace);
      return hubPortPinUprightStyle(HUB_LAYOUT.L, normalizedFace);
    };
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`)
      .forEach((entityEl) => {
        const hub = entityEl.querySelector<HTMLElement>(".builder-hub");
        if (!hub) return;
        hub.dataset.faceAngle = String(normalizedFace);
        const rot = hub.querySelector<HTMLElement>(".builder-hub-rot");
        if (rot) {
          rot.style.transform = `rotate(${normalizedFace}deg)`;
        }
        hub.querySelectorAll<HTMLButtonElement>(".builder-hub-port[data-port]").forEach((portEl) => {
          portEl.style.cssText = portStyleFor(portEl.dataset.port ?? "2");
        });
      });
  }

  function renderWireOverlay(): void {
    const t0 = performance.now();
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    const tExpand0 = performance.now();
    const viewLinks = expandLinks(state.links, state.entities);
    const tExpand1 = performance.now();
    recordPerf("wire.expandLinks", tExpand1 - tExpand0);
    perfCounts.stateLinks = state.links.length;
    perfCounts.expandedLinks = viewLinks.length;
    const wrapRect = wrap.getBoundingClientRect();
    const overlayWidth = Math.max(wrap.clientWidth, wrap.scrollWidth);
    wireOverlayEl.setAttribute("width", String(Math.ceil(overlayWidth)));
    wireOverlayEl.setAttribute("height", String(Math.ceil(wrapRect.height)));
    wireOverlayEl.style.width = `${Math.ceil(overlayWidth)}px`;
    let lineMarkup = "";
    let resolveCost = 0;
    const tLine0 = performance.now();
    for (const link of viewLinks) {
      const tr0 = performance.now();
      const from = resolveBuilderPortForWireOverlay(String(link.fromInstanceId), link.fromPort);
      const to = resolveBuilderPortForWireOverlay(String(link.toInstanceId), link.toPort);
      resolveCost += performance.now() - tr0;
      if (!from || !to) continue;
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const x1 = fromRect.left + fromRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y1 = fromRect.top + fromRect.height / 2 - wrapRect.top;
      const x2 = toRect.left + toRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y2 = toRect.top + toRect.height / 2 - wrapRect.top;
      lineMarkup += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#f9e2af" stroke-opacity="0.9" stroke-width="1.5"></line>`;
    }
    recordPerf("wire.portResolve", resolveCost);
    recordPerf("wire.lineBuild", performance.now() - tLine0);
    if (linkDrag) {
      const fromPort =
        resolveBuilderPortForWireOverlay(String(linkDrag.from.instanceId), linkDrag.from.port) ??
        (linkDrag.from.instanceId
          ? null
          : canvasEl.querySelector<HTMLButtonElement>(
              `.builder-port[data-root-id="${linkDrag.from.rootId}"][data-port="${linkDrag.from.port}"]`,
            ));
      if (fromPort) {
        const fromRect = fromPort.getBoundingClientRect();
        const x1 = fromRect.left + fromRect.width / 2 - wrapRect.left + wrap.scrollLeft;
        const y1 = fromRect.top + fromRect.height / 2 - wrapRect.top;
        const x2 = linkDrag.endClient.x - wrapRect.left + wrap.scrollLeft;
        const y2 = linkDrag.endClient.y - wrapRect.top;
        lineMarkup += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="builder-wire-drag" pointer-events="none"></line>`;
      }
    }
    wireOverlayEl.innerHTML = lineMarkup;
    recordPerf("wire.total", performance.now() - t0);
    renderPerfPanel();
  }

  function scheduleWireOverlayRender(): void {
    if (wireOverlayRaf !== null) return;
    wireOverlayRaf = window.requestAnimationFrame(() => {
      wireOverlayRaf = null;
      renderWireOverlay();
    });
  }

  function scheduleDragRender(): void {
    if (dragRenderRaf !== null) return;
    dragRenderRaf = window.requestAnimationFrame(() => {
      dragRenderRaf = null;
      renderCanvas();
    });
  }

  function scheduleWireDragPaint(): void {
    if (wireDragRaf !== null) return;
    wireDragRaf = window.requestAnimationFrame(() => {
      wireDragRaf = null;
      renderWireOverlay();
    });
  }

  const cycleValue = (value: string, options: string[], direction: "next" | "prev"): string => {
    const idx = options.indexOf(value);
    const safeIdx = idx >= 0 ? idx : 0;
    const delta = direction === "next" ? 1 : -1;
    return options[(safeIdx + delta + options.length) % options.length];
  };

  const setFilterSetting = (rootId: string, key: string, direction: "next" | "prev"): void => {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    if (!rootEnt) return;
    const current = rootEnt.settings[key] ?? "";
    let next = current;
    if (key === "operatingPort") next = cycleValue(current || "0", ["0", "1"], direction);
    if (key === "addressField") next = cycleValue(current || "destination", ["destination", "source"], direction);
    if (key === "operation") next = cycleValue(current || "differ", ["differ", "match"], direction);
    if (key === "action") next = cycleValue(current || "send_back", ["send_back", "drop"], direction);
    if (key === "collisionHandling") {
      next = cycleValue(
        current || "send_back_outbound",
        ["send_back_outbound", "drop_inbound", "drop_outbound"],
        direction,
      );
    }
    state = updateEntitySettings(state, rootEnt.id, { ...rootEnt.settings, [key]: next });
    persist();
    renderCanvas();
    renderInspector();
  };

  const updateMaskAt = (rootId: string, maskIdx: number, dir: "up" | "down"): void => {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    if (!rootEnt) return;
    const parts = (rootEnt.settings.mask ?? "*.*.*.*").split(".");
    while (parts.length < 4) parts.push("*");
    for (let i = 0; i < 4; i += 1) parts[i] = parts[i] ?? "*";

    const raw = parts[maskIdx] ?? "*";
    let poolIdx = MASK_VALUE_CYCLE.indexOf(raw as (typeof MASK_VALUE_CYCLE)[number]);
    if (poolIdx < 0) poolIdx = 0;
    const n = MASK_VALUE_CYCLE.length;
    poolIdx = dir === "up" ? (poolIdx + 1) % n : (poolIdx + n - 1) % n;

    const nextParts: string[] = ["*", "*", "*", "*"];
    nextParts[maskIdx] = MASK_VALUE_CYCLE[poolIdx];
    state = updateEntitySettings(state, rootEnt.id, { ...rootEnt.settings, mask: nextParts.join(".") });
    persist();
    renderCanvas();
    renderInspector();
  };
  let hoveredHubEl: HTMLElement | null = null;

  const clearHubHover = (hub: HTMLElement | null): void => {
    if (!hub) return;
    hub.classList.remove("builder-hub--hover-move", "builder-hub--hover-rotate");
  };

  const updateHubHoverFromPointer = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const hub = target.closest<HTMLElement>(".builder-hub");
    if (!hub || target.closest("button")) {
      clearHubHover(hoveredHubEl);
      hoveredHubEl = null;
      return;
    }
    if (hoveredHubEl && hoveredHubEl !== hub) {
      clearHubHover(hoveredHubEl);
    }
    hoveredHubEl = hub;
    const r = hub.getBoundingClientRect();
    const localX = ev.clientX - r.left;
    const localY = ev.clientY - r.top;
    const faceRaw = Number.parseFloat(hub.dataset.faceAngle ?? "0");
    const face = (((Number.isFinite(faceRaw) ? faceRaw : 0) % 360) + 360) % 360;
    const mode = hubPointerMode(localX, localY, face);
    hub.classList.toggle("builder-hub--hover-move", mode === "move");
    hub.classList.toggle("builder-hub--hover-rotate", mode === "rotate");
  };

  const startEntityDragFromElement = (entityEl: HTMLElement, ev: MouseEvent): void => {
    const target = ev.target as HTMLElement;
    if (target.closest("button")) return;
    const rootId = entityEl.dataset.rootId!;
    const rootEnt = state.entities.find((e) => e.id === rootId);
    const seg = entityEl.closest<HTMLElement>(".builder-segment");
    if (!rootEnt || !seg) return;
    if (isStaticOuterLeafEndpoint(rootEnt)) return;
    if (rootEnt.templateType === "hub") {
      const hubEl = entityEl.querySelector<HTMLElement>(".builder-hub");
      if (!hubEl) return;
      const r0 = hubEl.getBoundingClientRect();
      const localX = ev.clientX - r0.left;
      const localY = ev.clientY - r0.top;
      const faceDeg = ((Number.parseFloat(rootEnt.settings.faceAngle ?? "0") % 360) + 360) % 360;
      const hubMode = hubPointerMode(localX, localY, faceDeg);
      if (hubMode === "none") return;
      ev.preventDefault();
      if (hubMode === "move") {
        const segRect = seg.getBoundingClientRect();
        const anchorX = (ev.clientX - segRect.left) / Math.max(1, segRect.width);
        const anchorY = (ev.clientY - segRect.top) / Math.max(1, segRect.height);
        const rx = rootEnt.x;
        const ry = rootEnt.y;
        const dx = anchorX - rx;
        const dy = anchorY - ry;
        const onMove = (mv: MouseEvent): void => {
          const x = (mv.clientX - segRect.left) / Math.max(1, segRect.width) - dx;
          const y = (mv.clientY - segRect.top) / Math.max(1, segRect.height) - dy;
          state = updateEntityPosition(state, rootEnt.id, x, y);
          setEntityDomPosition(rootEnt.id, x, y);
          scheduleWireOverlayRender();
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (dragRenderRaf !== null) {
            window.cancelAnimationFrame(dragRenderRaf);
            dragRenderRaf = null;
          }
          renderCanvas();
          persist();
          renderInspector();
        };
        document.body.style.cursor = "grabbing";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return;
      }
      const px = r0.left + (HUB_LAYOUT.G.x / HUB_VIEW.w) * r0.width;
      const py = r0.top + (HUB_LAYOUT.G.y / HUB_VIEW.h) * r0.height;
      const a0 = Math.atan2(ev.clientY - py, ev.clientX - px);
      const base = faceDeg;
      const onMove = (mv: MouseEvent): void => {
        const a1 = Math.atan2(mv.clientY - py, mv.clientX - px);
        let newDeg = base + ((a1 - a0) * 180) / Math.PI;
        newDeg = ((newDeg % 360) + 360) % 360;
        const cur = state.entities.find((e) => e.id === rootEnt.id);
        if (!cur) return;
        state = updateEntitySettings(state, cur.id, { ...cur.settings, faceAngle: String(newDeg) });
        setHubFaceAngleDom(cur.id, newDeg);
        scheduleWireOverlayRender();
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (dragRenderRaf !== null) {
          window.cancelAnimationFrame(dragRenderRaf);
          dragRenderRaf = null;
        }
        document.body.style.removeProperty("cursor");
        renderCanvas();
        persist();
        renderInspector();
      };
      document.body.style.cursor = "grabbing";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }
    ev.preventDefault();
    const segRect = seg.getBoundingClientRect();
    const anchorX = (ev.clientX - segRect.left) / Math.max(1, segRect.width);
    const anchorY = (ev.clientY - segRect.top) / Math.max(1, segRect.height);
    const dx = anchorX - rootEnt.x;
    const dy = anchorY - rootEnt.y;
    const onMove = (mv: MouseEvent): void => {
      const x = (mv.clientX - segRect.left) / Math.max(1, segRect.width) - dx;
      const y = (mv.clientY - segRect.top) / Math.max(1, segRect.height) - dy;
      state = updateEntityPosition(state, rootEnt.id, x, y);
      setEntityDomPosition(rootEnt.id, x, y);
      scheduleWireOverlayRender();
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragRenderRaf !== null) {
        window.cancelAnimationFrame(dragRenderRaf);
        dragRenderRaf = null;
      }
      renderCanvas();
      persist();
      renderInspector();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startLinkDragFromPort = (portEl: HTMLButtonElement, ev: PointerEvent): void => {
    if (ev.button !== 0 || !ev.isPrimary) return;
    ev.stopPropagation();
    ev.preventDefault();
    const rootId = portEl.dataset.rootId!;
    const port = Number(portEl.dataset.port);
    const instanceId = portEl.dataset.instanceId ?? "";
    const from: LinkSourceSelection = { rootId, port, instanceId };
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    const onMove = (e: PointerEvent): void => {
      e.preventDefault();
      linkDrag = { from, endClient: { x: e.clientX, y: e.clientY } };
      scheduleWireDragPaint();
    };
    let ended = false;
    const onEnd = (e: PointerEvent): void => {
      if (ended) return;
      ended = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.style.removeProperty("cursor");
      if (wireDragRaf !== null) {
        window.cancelAnimationFrame(wireDragRaf);
        wireDragRaf = null;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const toPort = el?.closest<HTMLButtonElement>(".builder-port");
      linkDrag = null;
      renderWireOverlay();
      if (!toPort) return;
      const toRootId = toPort.dataset.rootId;
      const toP = Number(toPort.dataset.port);
      const toInstanceRaw = toPort.dataset.instanceId ?? "";
      if (!toRootId) return;
      if (toInstanceRaw && toInstanceRaw === from.instanceId && toP === from.port) return;
      const fromInst = parseBuilderInstanceId(from.instanceId);
      const toInstParsed = parseBuilderInstanceId(toInstanceRaw);
      if (!fromInst || !toInstParsed) return;
      if (fromInst.rootId !== from.rootId || toInstParsed.rootId !== toRootId) return;
      const fromRoot = state.entities.find((ent) => ent.id === fromInst.rootId);
      const toRoot = state.entities.find((ent) => ent.id === toInstParsed.rootId);
      if (!fromRoot || !toRoot) return;
      const linkOpts =
        fromRoot.id === toRoot.id
          ? {
              sameEntityPin: {
                fromSegmentIndex: fromInst.segmentIndex,
                toSegmentIndex: toInstParsed.segmentIndex,
              },
            }
          : fromRoot.layer === toRoot.layer
            ? {
                sameLayerSegmentDelta:
                  toInstParsed.segmentIndex - fromInst.segmentIndex,
              }
            : (() => {
                const slot = crossLayerBlockSlotFromSegments(
                  fromRoot.layer,
                  fromInst.segmentIndex,
                  toRoot.layer,
                  toInstParsed.segmentIndex,
                );
                if (slot === undefined) {
                  return undefined;
                }
                return { crossLayerBlockSlot: slot };
              })();
      if (
        fromRoot.id !== toRoot.id &&
        fromRoot.layer !== toRoot.layer &&
        linkOpts === undefined
      ) {
        return;
      }
      const added = addLinkRootOneWirePerPort(
        state,
        fromRoot.id,
        from.port,
        toRoot.id,
        toP,
        linkOpts,
      );
      if (!added.link) return;
      state = added.state;
      persist();
      setSelection({ kind: "link", rootId: added.link.id });
    };
    linkDrag = { from, endClient: { x: ev.clientX, y: ev.clientY } };
    document.body.style.cursor = "crosshair";
    renderWireOverlay();
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  function renderCanvas(): void {
    const t0 = performance.now();
    const tExpand0 = performance.now();
    const expanded = expandBuilderState(state, { builderView: true });
    const tExpand1 = performance.now();
    recordPerf("canvas.expand", tExpand1 - tExpand0);
    perfCounts.expandedEntities = expanded.entities.length;
    const previewKeys = previewInstances();
    const tBucket0 = performance.now();
    const entitiesByLayerSegment = new Map<string, typeof expanded.entities>();
    expanded.entities.forEach((entity) => {
      const key =
        entity.layer === "outer64" && isOuterLeafVoidSegment(entity.segmentIndex)
          ? OUTER_CANVAS_VOID_MERGE_KEY
          : `${entity.layer}:${entity.segmentIndex}`;
      if (!entitiesByLayerSegment.has(key)) entitiesByLayerSegment.set(key, []);
      entitiesByLayerSegment.get(key)!.push(entity);
    });
    const staticRootIds = new Set(
      state.entities.filter((e) => isStaticOuterLeafEndpoint(e)).map((e) => e.id),
    );
    entitiesByLayerSegment.forEach((list) => {
      list.sort((a, b) => {
        const aS = a.templateType === "endpoint" && a.layer === "outer64" && staticRootIds.has(a.rootId) ? 1 : 0;
        const bS = b.templateType === "endpoint" && b.layer === "outer64" && staticRootIds.has(b.rootId) ? 1 : 0;
        return aS - bS;
      });
    });
    recordPerf("canvas.bucketSort", performance.now() - tBucket0);

    const tHtml0 = performance.now();
    canvasEl.innerHTML = orderedLayersTopDown()
      .map((layer) => {
        const columns = layer === "outer64" ? outerLayerBuilderColumnSlots() : layerColumns(layer);
        return `
          <section class="builder-layer">
            <div class="builder-layer-title">${layerTitle(layer)}</div>
            <div class="builder-layer-grid builder-layer-${layer}" data-layer="${layer}">
              ${columns
                .map((segment) => {
                  const isOuterVoid = layer === "outer64" && segment === "void-12-15";
                  const key = isOuterVoid
                    ? OUTER_CANVAS_VOID_MERGE_KEY
                    : `${layer}:${segment as number}`;
                  const entities = entitiesByLayerSegment.get(key) ?? [];
                  const isDropTarget =
                    !isOuterVoid && dragLayer === layer && dragSegment === (segment as number);
                  return `
                    <div class="builder-segment ${isDropTarget ? "drop-target" : ""} ${
                      isOuterVoid ? "builder-segment--outer-void-merged" : ""
                    }" data-layer="${layer}" data-segment="${isOuterVoid ? "12-15" : String(segment)}"${
                      isOuterVoid ? ` data-void-outer="1"` : ""
                    }>
                      <div class="builder-segment-label">${
                        isOuterVoid
                          ? "0.0.3.* (no endpoints)"
                          : segmentLabel(layer, segment as number)
                      }</div>
                      <div class="builder-segment-entities">
                        ${entities
                          .map((entity) => {
                            const selected =
                              selection?.kind === "entity" && selection.rootId === entity.rootId ? "selected" : "";
                            const settingsText = Object.entries(entity.settings)
                              .slice(0, 3)
                              .map(([k, v]) => `${k}=${v}`)
                              .join("<br/>");
                            const maskParts = (entity.settings.mask ?? "*.*.*.*").split(".");
                            while (maskParts.length < 4) maskParts.push("*");
                            const displayAddressField =
                              (entity.settings.addressField ?? "destination") === "source"
                                ? "Source"
                                : "Destination";
                            const displayOperation =
                              (entity.settings.operation ?? "differ") === "match" ? "Match" : "Differ";
                            const displayAction =
                              (entity.settings.action ?? "send_back") === "drop" ? "Drop" : "Send back";
                            const displayCollision =
                              (() => {
                                const value = entity.settings.collisionHandling ?? "send_back_outbound";
                                if (value === "drop_inbound") return "Drop<br/>Inbound";
                                if (value === "drop_outbound") return "Drop<br/>Outbound";
                                return "Send back<br/>Outbound";
                              })();
                            const isOuterStatic =
                              entity.templateType === "endpoint" &&
                              entity.layer === "outer64" &&
                              staticRootIds.has(entity.rootId);
                            const addrParts = (entity.settings.address ?? "0.0.0.0").split(".");
                            const endpointAddressBlock = isOuterStatic
                              ? `
                                  <div class="builder-filter-ui" data-root-id="${entity.rootId}">
                                    <div class="builder-filter-left">
                                      <div class="builder-row builder-row-endpoint-addr">
                                        <span class="builder-row-label">Address:</span>
                                        <div class="builder-mask-row builder-mask-row--readonly">
                                          ${[0, 1, 2, 3]
                                            .map(
                                              (idx) => `
                                                <div class="builder-mask-cell builder-mask-cell--readonly">
                                                  <span class="builder-endpoint-addr-nib">${addrParts[idx] ?? "0"}</span>
                                                </div>
                                              `,
                                            )
                                            .join(`<span class="builder-mask-dot" aria-hidden="true">.</span>`)}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                `
                              : "";
                            const filterControls =
                              entity.templateType === "filter"
                                ? `
                                  <div class="builder-filter-ui" data-root-id="${entity.rootId}">
                                    <div class="builder-filter-left">
                                      <div class="builder-row">
                                        <span class="builder-row-label">Port:</span>
                                        <div class="builder-cycle">
                                          <button class="builder-cycle-btn" data-setting-cycle="operatingPort" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                                          <span class="builder-cycle-value">${entity.settings.operatingPort ?? "0"}</span>
                                          <button class="builder-cycle-btn" data-setting-cycle="operatingPort" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                                        </div>
                                      </div>
                                      <div class="builder-row">
                                        <span class="builder-row-label">Address:</span>
                                        <div class="builder-cycle">
                                          <button class="builder-cycle-btn" data-setting-cycle="addressField" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                                          <span class="builder-cycle-value">${displayAddressField}</span>
                                          <button class="builder-cycle-btn" data-setting-cycle="addressField" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                                        </div>
                                      </div>
                                      <div class="builder-row">
                                        <span class="builder-row-label">Operation:</span>
                                        <div class="builder-cycle">
                                          <button class="builder-cycle-btn" data-setting-cycle="operation" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                                          <span class="builder-cycle-value">${displayOperation}</span>
                                          <button class="builder-cycle-btn" data-setting-cycle="operation" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                                        </div>
                                      </div>
                                      <div class="builder-row builder-row-mask">
                                        <span class="builder-row-label">Mask:</span>
                                        <div class="builder-mask-row">
                                          ${[0, 1, 2, 3]
                                            .map(
                                              (idx) => `
                                                <div class="builder-mask-cell">
                                                  <button class="builder-mask-arrow" data-mask-dir="up" data-mask-idx="${idx}" data-root-id="${entity.rootId}" type="button">+</button>
                                                  <span>${maskParts[idx] ?? "*"}</span>
                                                  <button class="builder-mask-arrow" data-mask-dir="down" data-mask-idx="${idx}" data-root-id="${entity.rootId}" type="button">-</button>
                                                </div>
                                              `,
                                            )
                                            .join(`<span class="builder-mask-dot" aria-hidden="true">.</span>`)}
                                        </div>
                                      </div>
                                      <div class="builder-row">
                                        <span class="builder-row-label">Action:</span>
                                        <div class="builder-cycle">
                                          <button class="builder-cycle-btn" data-setting-cycle="action" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                                          <span class="builder-cycle-value">${displayAction}</span>
                                          <button class="builder-cycle-btn" data-setting-cycle="action" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                                        </div>
                                      </div>
                                      ${
                                        (entity.settings.action ?? "send_back") === "send_back"
                                          ? `
                                        <div class="builder-row builder-row-collision">
                                          <span class="builder-row-label">Collision<br/>handling:</span>
                                          <div class="builder-cycle builder-cycle--tall">
                                            <button class="builder-cycle-btn" data-setting-cycle="collisionHandling" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                                            <span class="builder-cycle-value">${displayCollision}</span>
                                            <button class="builder-cycle-btn" data-setting-cycle="collisionHandling" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                                          </div>
                                        </div>
                                      `
                                          : ""
                                      }
                                    </div>
                                  </div>
                                `
                                : "";
                            const hubCw = (entity.settings.rotation ?? "clockwise") !== "counterclockwise";
                            const hubFaceDeg =
                              ((Number.parseFloat(entity.settings.faceAngle ?? "0") % 360) + 360) % 360;
                            const hubOriginX = (HUB_LAYOUT.G.x / HUB_VIEW.w) * 100;
                            const hubOriginY = (HUB_LAYOUT.G.y / HUB_VIEW.h) * 100;
                            const hubBlock =
                              entity.templateType === "hub"
                                ? `<div class="builder-hub" data-face-angle="${hubFaceDeg}">
        <div class="builder-hub-rot" style="transform:rotate(${hubFaceDeg}deg);transform-origin:${hubOriginX}% ${hubOriginY}%;">
          ${hubTriangleSvg(entity.instanceId, entity.settings.rotation)}
          <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.T, hubFaceDeg)}" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="0">0</button>
          <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.R, hubFaceDeg)}" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="1">1</button>
          <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.L, hubFaceDeg)}" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="2">2</button>
        </div>
        <button type="button" class="builder-hub-reverse" style="left:${hubOriginX}%;top:${hubOriginY}%;transform:translate(-50%,-50%)" data-hub-toggle-rotation data-root-id="${entity.rootId}" title="Reverse forwarding direction"><span class="builder-hub-reverse-icon" aria-hidden="true">${hubCw ? "↻" : "↺"}</span></button>
      </div>`
                                : "";
                            const entityShapeClass = isOuterStatic
                              ? " builder-entity--filter builder-entity--outer-endpoint"
                              : entity.templateType === "filter"
                                ? " builder-entity--filter"
                                : entity.templateType === "hub"
                                  ? " builder-entity--hub"
                                  : "";
                            const settingsBlock =
                              entity.templateType === "filter" || entity.templateType === "hub" || isOuterStatic
                                ? ""
                                : `<div class="builder-entity-settings">${settingsText}</div>`;
                            const portBtn = (port: number): string =>
                              `<button class="builder-port" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="${port}" type="button">${port}</button>`;
                            const portsRow = isOuterStatic
                              ? `<div class="builder-ports builder-ports--filter-bottom builder-ports--endpoint-bottom">${portBtn(0)}</div>`
                              : entity.templateType === "filter"
                                ? `<div class="builder-ports builder-ports--filter-bottom">${portBtn(1)}</div>`
                                : entity.templateType === "hub"
                                  ? ""
                                  : `<div class="builder-ports">${entity.ports.map((p) => portBtn(p)).join("")}</div>`;
                            return `
                              <div
                                class="builder-entity ${selected}${entityShapeClass}"
                                data-instance-id="${entity.instanceId}"
                                data-root-id="${entity.rootId}"
                                data-static-endpoint="${isOuterStatic ? "1" : "0"}"
                                style="left:${entity.x * 100}%;top:${entity.y * 100}%"
                              >
                                ${
                                  entity.templateType === "filter"
                                    ? `<div class="builder-ports builder-ports--filter-top">${portBtn(0)}</div>`
                                    : ""
                                }
                                ${
                                  entity.templateType === "hub" || isOuterStatic
                                    ? ""
                                    : `<div class="builder-entity-title">${entity.templateType}</div>`
                                }
                                ${settingsBlock}
                                ${filterControls}
                                ${endpointAddressBlock}
                                ${hubBlock}
                                ${portsRow}
                              </div>
                            `;
                          })
                          .join("")}
                        ${previewKeys.has(key) ? `<div class="builder-entity preview">${templateLabel(draggingTemplate!)} preview</div>` : ""}
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </section>
        `;
      })
      .join("");
    const tHtml1 = performance.now();
    recordPerf("canvas.htmlBuild", tHtml1 - tHtml0);
    const tCache0 = performance.now();
    rebuildPortElementCache();
    const tCache1 = performance.now();
    recordPerf("canvas.portCache", tCache1 - tCache0);
    recordPerf("canvas.domCommit", tCache1 - tHtml0);
    recordPerf("canvas.total", performance.now() - t0);
    renderPerfPanel();

    const setHoverFromEvent = (ev: DragEvent): void => {
      const target = ev.target as HTMLElement | null;
      const cell = target?.closest<HTMLElement>(".builder-segment");
      if (!cell) return;
      if (cell.dataset.voidOuter === "1") {
        if (dragLayer !== null || dragSegment !== null) {
          dragLayer = null;
          dragSegment = null;
          renderCanvas();
        }
        return;
      }
      const nextLayer = cell.dataset.layer as BuilderLayer;
      const nextSegment = Number(cell.dataset.segment);
      if (Number.isNaN(nextSegment)) return;
      if (dragLayer !== nextLayer || dragSegment !== nextSegment) {
        dragLayer = nextLayer;
        dragSegment = nextSegment;
        renderCanvas();
      }
    };

    const handleDrop = (ev: DragEvent): void => {
      ev.preventDefault();
      const target = ev.target as HTMLElement | null;
      const cell = target?.closest<HTMLElement>(".builder-segment");
      if (!cell) return;
      if (cell.dataset.voidOuter === "1") return;
      const rawDroppedTemplate =
        draggingTemplate ??
        (ev.dataTransfer?.getData("text/plain") || null);
      if (!rawDroppedTemplate || !isBuilderTemplateType(rawDroppedTemplate)) {
        return;
      }
      const droppedTemplate: BuilderTemplateType = rawDroppedTemplate;
      if (!droppedTemplate) return;
      const layer = cell.dataset.layer as BuilderLayer;
      const segment = Number(cell.dataset.segment);
      if (Number.isNaN(segment)) return;
      const segmentRect = cell.getBoundingClientRect();
      const px = (ev.clientX - segmentRect.left) / Math.max(1, segmentRect.width);
      const py = (ev.clientY - segmentRect.top) / Math.max(1, segmentRect.height);
      const rootEntity = createEntityRoot(state, droppedTemplate, layer, segment, px, py);
      state = { ...state, entities: [...state.entities, rootEntity] };
      persist();
      draggingTemplate = null;
      dragLayer = null;
      dragSegment = null;
      renderCanvas();
    };

    // Delegated DnD handlers are more reliable than per-cell listeners while rerendering.
    const setDropEffectForHover = (ev: DragEvent): void => {
      if (!ev.dataTransfer) return;
      const cell = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".builder-segment");
      ev.dataTransfer.dropEffect = cell?.dataset.voidOuter === "1" ? "none" : "copy";
    };

    canvasEl.ondragenter = (ev) => {
      ev.preventDefault();
      setDropEffectForHover(ev);
      setHoverFromEvent(ev);
    };
    canvasEl.ondragover = (ev) => {
      ev.preventDefault();
      setDropEffectForHover(ev);
      setHoverFromEvent(ev);
    };
    canvasEl.ondragleave = (ev) => {
      const related = ev.relatedTarget as Node | null;
      if (!related || !canvasEl.contains(related)) {
        dragLayer = null;
        dragSegment = null;
        renderCanvas();
      }
    };
    canvasEl.ondrop = handleDrop;

    // entity/port selection and link-drag start are delegated once (outside renderCanvas)

    // filter/hub controls are delegated once (outside renderCanvas)

    // entity drag + hub hover are delegated once (outside renderCanvas)

    requestAnimationFrame(() => {
      renderWireOverlay();
    });
  }

  function renderInspector(): void {
    if (!selection) {
      inspectorEl.textContent = "No selection.";
      return;
    }
    if (selection.kind === "link") {
      const link = state.links.find((l) => l.id === selection.rootId);
      if (!link) {
        inspectorEl.textContent = "Link missing.";
        return;
      }
      const isSameRootPin =
        link.fromEntityId === link.toEntityId &&
        link.fromSegmentIndex !== undefined &&
        link.toSegmentIndex !== undefined;
      const isSameLayerTwoRoots =
        link.fromEntityId !== link.toEntityId && link.sameLayerSegmentDelta !== undefined;
      const isCrossLayerSlot =
        link.fromEntityId !== link.toEntityId &&
        link.crossLayerBlockSlot !== undefined &&
        link.sameLayerSegmentDelta === undefined &&
        !isSameRootPin;
      const sameRootDelta =
        isSameRootPin && link.fromSegmentIndex !== undefined && link.toSegmentIndex !== undefined
          ? link.toSegmentIndex - link.fromSegmentIndex
          : 0;
      const fromText = isSameRootPin
        ? `${link.fromEntityId}@${link.fromSegmentIndex}`
        : link.fromEntityId;
      const toText = isSameRootPin
        ? `${link.toEntityId}@${link.toSegmentIndex}`
        : link.toEntityId;
      const scopeNote = isSameRootPin
        ? `<div class="kv"><span>Scope</span><strong>Same device: mirrors port ${link.fromPort} → port ${link.toPort} with toSeg = fromSeg + ${sameRootDelta}</strong></div>`
        : isSameLayerTwoRoots
          ? `<div class="kv"><span>Scope</span><strong>Same layer: each mirror uses toSeg = fromSeg + ${link.sameLayerSegmentDelta}</strong></div>`
          : isCrossLayerSlot
            ? `<div class="kv"><span>Scope</span><strong>Cross-layer: one fine column per coarse segment (lane ${link.crossLayerBlockSlot} in each block)</strong></div>`
            : `<div class="kv"><span>Scope</span><strong>Cross-layer (legacy): one wire per base column (64)</strong></div>`;
      inspectorEl.innerHTML = `
        <div class="kv"><span>Type</span><strong>Link</strong></div>
        <div class="kv"><span>From</span><strong>${fromText} port ${link.fromPort}</strong></div>
        <div class="kv"><span>To</span><strong>${toText} port ${link.toPort}</strong></div>
        ${scopeNote}
      `;
      return;
    }
    const entity = state.entities.find((e) => e.id === selection.rootId);
    if (!entity) {
      inspectorEl.textContent = "Entity missing.";
      return;
    }
    if (isStaticOuterLeafEndpoint(entity)) {
      const addr = entity.settings.address ?? "0.0.0.0";
      inspectorEl.innerHTML = `
        <div class="kv"><span>Type</span><strong>Endpoint (fixed)</strong></div>
        <div class="kv"><span>Layer</span><strong>${entity.layer}</strong></div>
        <div class="kv"><span>Segment</span><strong>${entity.segmentIndex}</strong></div>
        <div class="kv"><span>Address</span><strong>${addr}</strong></div>
        <p class="builder-inspector-note">This endpoint is preplaced and cannot be moved or deleted.</p>
      `;
      return;
    }
    const entries = Object.entries(entity.settings);
    inspectorEl.innerHTML = `
      <div class="kv"><span>Type</span><strong>${entity.templateType}</strong></div>
      <div class="kv"><span>Layer</span><strong>${entity.layer}</strong></div>
      <div class="kv"><span>Segment</span><strong>${entity.segmentIndex}</strong></div>
      ${
        entity.templateType === "filter"
          ? `<div class="builder-inspector-description">${buildFilterDescription(entity.settings)}</div>`
          : ""
      }
      <div class="builder-settings">
        ${entries
          .map(
            ([k, v]) =>
              `<label class="builder-setting"><span>${k}</span><input data-setting-key="${k}" type="text" value="${v}" /></label>`,
          )
          .join("")}
      </div>
    `;
    inspectorEl.querySelectorAll<HTMLInputElement>("input[data-setting-key]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.settingKey!;
        const next = { ...entity.settings, [key]: input.value };
        state = updateEntitySettings(state, entity.id, next);
        persist();
        renderInspector();
        renderCanvas();
      });
    });
  }

  deleteBtn.addEventListener("click", () => {
    if (!selection) return;
    if (selection.kind === "entity") {
      const ent = state.entities.find((e) => e.id === selection.rootId);
      if (ent && isStaticOuterLeafEndpoint(ent)) {
        return;
      }
      state = removeEntityGroup(state, selection.rootId);
    } else {
      state = removeLinkGroup(state, selection.rootId);
    }
    persist();
    selection = null;
    linkDrag = null;
    renderInspector();
    renderCanvas();
  });

  deleteAllBtn.addEventListener("click", () => {
    if (!state.entities.length && !state.links.length) return;
    if (!window.confirm("Delete all devices and links?")) return;
    state = createEmptyBuilderState();
    selection = null;
    linkDrag = null;
    persist();
    renderInspector();
    renderCanvas();
  });

  exportBtn.addEventListener("click", async () => {
    const text = exportBuilderStateText(state);
    await navigator.clipboard.writeText(text);
    alert("Builder state copied to clipboard.");
  });

  importBtn.addEventListener("click", () => {
    const text = window.prompt("Paste builder JSON:");
    if (!text) return;
    const parsed = importBuilderStateText(text);
    if (!parsed) {
      alert("Invalid builder JSON.");
      return;
    }
    state = rebuildStateWithOuterLeafEndpoints(parsed);
    persist();
    selection = null;
    renderInspector();
    renderCanvas();
  });

  previewBtn.addEventListener("click", () => {
    const payload = compileBuilderToViewerPayload(state);
    window.sessionStorage.setItem(VIEWER_PREVIEW_KEY, JSON.stringify(payload));
    onPreviewReady?.();
  });

  canvasEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    const portEl = target.closest<HTMLButtonElement>(".builder-port");
    if (portEl) {
      ev.stopPropagation();
      return;
    }

    const cycleBtn = target.closest<HTMLButtonElement>(".builder-cycle-btn[data-setting-cycle]");
    if (cycleBtn) {
      ev.stopPropagation();
      const rootId = cycleBtn.dataset.rootId;
      const key = cycleBtn.dataset.settingCycle;
      const direction = cycleBtn.dataset.dir === "prev" ? "prev" : "next";
      if (!rootId || !key) return;
      setFilterSetting(rootId, key, direction);
      return;
    }

    const maskBtn = target.closest<HTMLButtonElement>(".builder-mask-arrow");
    if (maskBtn) {
      ev.stopPropagation();
      const rootId = maskBtn.dataset.rootId;
      const rawIdx = maskBtn.dataset.maskIdx;
      const dir = maskBtn.dataset.maskDir === "down" ? "down" : "up";
      if (!rootId || rawIdx === undefined) return;
      updateMaskAt(rootId, Number(rawIdx), dir);
      return;
    }

    const hubToggle = target.closest<HTMLButtonElement>("[data-hub-toggle-rotation]");
    if (hubToggle) {
      ev.stopPropagation();
      const rootId = hubToggle.dataset.rootId;
      if (!rootId) return;
      const rootEnt = state.entities.find((e) => e.id === rootId);
      if (!rootEnt || rootEnt.templateType !== "hub") return;
      const next =
        (rootEnt.settings.rotation ?? "clockwise") === "counterclockwise" ? "clockwise" : "counterclockwise";
      state = updateEntitySettings(state, rootEnt.id, { ...rootEnt.settings, rotation: next });
      persist();
      renderCanvas();
      renderInspector();
      return;
    }

    const entityEl = target.closest<HTMLElement>(".builder-entity");
    if (entityEl) {
      const rootId = entityEl.dataset.rootId!;
      setSelection({ kind: "entity", rootId });
    }
  });

  canvasEl.addEventListener("pointerdown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const portEl = target.closest<HTMLButtonElement>(".builder-port");
    if (!portEl) return;
    startLinkDragFromPort(portEl, ev);
  });

  canvasEl.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button")) return;
    const entityEl = target.closest<HTMLElement>(".builder-entity");
    if (!entityEl) return;
    const rootId = entityEl.dataset.rootId;
    if (rootId) {
      setSelection({ kind: "entity", rootId });
    }
    startEntityDragFromElement(entityEl, ev);
  });

  canvasEl.addEventListener("mousemove", (ev) => {
    updateHubHoverFromPointer(ev);
  });
  canvasEl.addEventListener("mouseleave", () => {
    clearHubHover(hoveredHubEl);
    hoveredHubEl = null;
  });

  const wrap = wireOverlayEl.parentElement;
  if (wrap) {
    wrap.addEventListener("scroll", scheduleWireOverlayRender, { passive: true });
  }
  window.addEventListener("resize", scheduleWireOverlayRender);

  renderTemplates();
  renderInspector();
  renderCanvas();
}

export { VIEWER_PREVIEW_KEY };
