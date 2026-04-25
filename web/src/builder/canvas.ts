import {
  BuilderState,
  BuilderEntityRoot,
  BuilderLayer,
  BuilderTemplateType,
  createEntityRoot,
  addLinkRootOneWirePerPort,
  createLinkRoot,
  createEmptyBuilderState,
  crossLayerBlockSlotFromSegments,
  defaultSettings,
  isStaticOuterLeafEndpoint,
  isOuterLeafVoidSegment,
  linkTreatedAsInnerOuterVoidBand,
  linkTreatedAsSlottedInnerMiddle,
  OUTER_CANVAS_VOID_MERGE_KEY,
  rebuildStateWithOuterLeafEndpoints,
  removeEntityGroup,
  removeLinkGroup,
  removeLinksTouchingInstancePort,
  updateEntityPlacement,
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
import { compileBuilderPayload } from "./compile";
import type { Device, Packet, PortRef, SimulationStats, SimulatorRuntimeState, Topology } from "../simulation";
import { buildPortAdjacency, getHubEgressPort, portKey, TunnetSimulator } from "../simulation";
import {
  formatSendRateLabel,
  formatSpeedLabel,
  sendRateMultiplierFromExponent,
  SEND_RATE_EXP_DEFAULT,
  SEND_RATE_EXP_MAX,
  SEND_RATE_EXP_MIN,
  speedMultiplierFromExponent,
  SPEED_EXP_DEFAULT,
  SPEED_EXP_MAX,
  SPEED_EXP_MIN,
} from "../sim-controls";

const BUILDER_CANVAS_SCALE_KEY = "tunnet.builder.canvasScale";
const BUILDER_HIDE_PROP_LABELS_KEY = "tunnet.builder.hidePropertyLabels";
const BUILDER_LAYER_GAP_PX = 5;
const BUILDER_GRID_TILE_SIZE_X_PX = 20;
const BUILDER_GRID_TILE_SIZE_Y_PX = 20;
const CANVAS_SCALE_X_STEPS = [1 / 16, 1 / 8, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4] as const;

/** One mask nibble cycles * → 0 → 1 → 2 → 3 → * (matches game semantics). */
const MASK_VALUE_CYCLE = ["*", "0", "1", "2", "3"] as const;

function hubMarkerId(instanceId: string): string {
  return `hubmk-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Single hub size knob: all hub render/interaction geometry scales from this side length.
 * Change this one number to resize hubs.
 */
const HUB_TRIANGLE_SIDE = 45;
const HUB_BASE_TRIANGLE_SIDE = 45;
const HUB_SCALE = HUB_TRIANGLE_SIDE / HUB_BASE_TRIANGLE_SIDE;
/** SVG / hit box for hub (mirrors original proportions at side=70). */
const HUB_VIEW = { w: 108 * HUB_SCALE, h: 96 * HUB_SCALE } as const;
const HUB_PORT_RADIUS = 8 * HUB_SCALE;
const HUB_TOP_PADDING = 18 * HUB_SCALE;
const HUB_ROTATE_OUTER_BAND_PX = 8 * HUB_SCALE;
const HUB_REVERSE_BUTTON_SIZE = 16 * HUB_SCALE;
const HUB_REVERSE_ICON_SIZE = 13 * HUB_SCALE;

type HubVec = { x: number; y: number };

type HubLayout = { T: HubVec; L: HubVec; R: HubVec; r: number; G: HubVec };

/** Equilateral triangle: apex up, base horizontal; `r` matches half of global `.builder-port` (16px). */
function hubEquilateralLayout(): HubLayout {
  const r = HUB_PORT_RADIUS;
  const s = HUB_TRIANGLE_SIDE;
  const h = (s * Math.sqrt(3)) / 2;
  const cx = HUB_VIEW.w / 2;
  const ty = HUB_TOP_PADDING;
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
  // The visible hub body is a rounded triangle built around the core equilateral by radius `HUB_LAYOUT.r`.
  // Treat that rounded band as "move" so pointer behavior matches the rendered shape.
  if (d <= HUB_LAYOUT.r) return "move";
  if (d <= HUB_LAYOUT.r + HUB_ROTATE_OUTER_BAND_PX) return "rotate";
  return "none";
}

function relayPointerMode(
  localX: number,
  localY: number,
  outerWidth: number,
  outerHeight: number,
  coreLeft: number,
  coreTop: number,
  coreWidth: number,
  coreHeight: number,
): "move" | "rotate" | "none" {
  const ow = Math.max(1, outerWidth);
  const oh = Math.max(1, outerHeight);
  if (localX < 0 || localY < 0 || localX > ow || localY > oh) return "none";
  const insideCore =
    localX >= coreLeft &&
    localX <= coreLeft + coreWidth &&
    localY >= coreTop &&
    localY <= coreTop + coreHeight;
  return insideCore ? "move" : "rotate";
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
      <marker id="${mid}-tip" viewBox="0 0 6 6" refX="5.1" refY="3" markerWidth="4.5" markerHeight="4.5" orient="auto">
        <path d="M1,0.8 L5,3 L1,5.2" fill="none" stroke="#d9e1f3" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
      </marker>
    </defs>
    <path class="builder-hub-rotate-hint" d="${d}" />
    <path class="builder-hub-triangle" d="${d}" />
    <g pointer-events="none">${arrows}</g>
  </svg>`;
}

interface BuilderMountOptions {
  root: HTMLDivElement;
}

type CanvasScale = {
  x: number;
  yByLayer: Record<BuilderLayer, number>;
};

type EntitySelection = { kind: "entity"; rootId: string };
type LinkSelection = { kind: "link"; rootId: string };
type PacketSelection = { kind: "packet"; packetId: number };
type Selection = EntitySelection | LinkSelection | PacketSelection | null;
type BoxSelectionState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  mode: "replace" | "add" | "remove";
} | null;

function sanitizeDuplicateTypePlacements(input: BuilderState): { state: BuilderState; changed: boolean } {
  const seen = new Set<string>();
  const entities: BuilderEntityRoot[] = [];
  let changed = false;
  input.entities.forEach((ent) => {
    const key = `${ent.templateType}:${ent.layer}:${ent.segmentIndex}:${ent.x}:${ent.y}`;
    if (seen.has(key)) {
      changed = true;
      return;
    }
    seen.add(key);
    entities.push(ent);
  });
  const validIds = new Set(entities.map((e) => e.id));
  const links = input.links.filter((l) => validIds.has(l.fromEntityId) && validIds.has(l.toEntityId));
  if (links.length !== input.links.length) {
    changed = true;
  }
  if (!changed) {
    return { state: input, changed: false };
  }
  return {
    state: {
      ...input,
      entities,
      links,
    },
    changed: true,
  };
}

interface LinkSourceSelection {
  rootId: string;
  port: number;
  /** Port DOM identity for this clone (mirrors share rootId). */
  instanceId: string;
}

function buildTemplateDragImage(templateType: BuilderTemplateType): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "builder-drag-image";
  const portBtn = (port: number): string =>
    `<button class="builder-port" type="button" disabled>${port}</button>`;
  if (templateType === "hub") {
    const faceDeg = 0;
    const hubOriginX = (HUB_LAYOUT.G.x / HUB_VIEW.w) * 100;
    const hubOriginY = (HUB_LAYOUT.G.y / HUB_VIEW.h) * 100;
    wrap.innerHTML = `
      <div class="builder-entity builder-entity--hub">
        <div class="builder-hub" data-face-angle="${faceDeg}" style="--hub-w:${HUB_VIEW.w}px;--hub-h:${HUB_VIEW.h}px;--hub-reverse-size:${HUB_REVERSE_BUTTON_SIZE}px;--hub-reverse-icon-size:${HUB_REVERSE_ICON_SIZE}px;">
          <div class="builder-hub-rot" style="transform:rotate(${faceDeg}deg);transform-origin:${hubOriginX}% ${hubOriginY}%;">
            ${hubTriangleSvg("drag-preview", "clockwise")}
            <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.T, faceDeg)}" disabled>0</button>
            <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.R, faceDeg)}" disabled>1</button>
            <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.L, faceDeg)}" disabled>2</button>
          </div>
          <button type="button" class="builder-hub-reverse" style="left:${hubOriginX}%;top:${hubOriginY}%;transform:translate(-50%,-50%)" disabled><span class="builder-hub-reverse-icon" aria-hidden="true">↻</span></button>
        </div>
      </div>
    `;
    return wrap;
  }
  if (templateType === "filter") {
    const settings = defaultSettings("filter");
    const maskParts = (settings.mask ?? "*.*.*.*").split(".");
    while (maskParts.length < 4) maskParts.push("*");
    const displayAddressField =
      (settings.addressField ?? "destination") === "source"
        ? "Source"
        : "Destination";
    const displayOperation =
      (settings.operation ?? "differ") === "match" ? "Match" : "Differ";
    const displayAction =
      (settings.action ?? "send_back") === "drop" ? "Drop" : "Send back";
    const displayCollision =
      (() => {
        const value = settings.collisionHandling ?? "send_back_outbound";
        if (value === "drop_inbound") return "Drop<br/>Inbound";
        if (value === "drop_outbound") return "Drop<br/>Outbound";
        return "Send back<br/>Outbound";
      })();
    wrap.innerHTML = `
      <div class="builder-entity builder-entity--filter">
        <div class="builder-ports builder-ports--filter-top">${portBtn(0)}</div>
        <div class="builder-entity-title">filter</div>
        <div class="builder-filter-ui" data-root-id="drag-preview">
          <div class="builder-filter-left">
            <div class="builder-row">
              <span class="builder-row-label">Port:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${settings.operatingPort ?? "0"}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row">
              <span class="builder-row-label">Address:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayAddressField}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row">
              <span class="builder-row-label">Operation:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayOperation}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row builder-row-mask">
              <span class="builder-row-label">Mask:</span>
              <div class="builder-mask-row">
                ${[0, 1, 2, 3]
                  .map(
                    (idx) => `
                      <div class="builder-mask-cell">
                        <button class="builder-mask-arrow" type="button" disabled>+</button>
                        <span>${maskParts[idx] ?? "*"}</span>
                        <button class="builder-mask-arrow" type="button" disabled>-</button>
                      </div>
                    `,
                  )
                  .join(`<span class="builder-mask-dot" aria-hidden="true">.</span>`)}
              </div>
            </div>
            <div class="builder-row">
              <span class="builder-row-label">Action:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayAction}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row builder-row-collision">
              <span class="builder-row-label">Collision<br/>handling:</span>
              <div class="builder-cycle builder-cycle--tall">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayCollision}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
          </div>
        </div>
        <div class="builder-ports builder-ports--filter-bottom">${portBtn(1)}</div>
      </div>
    `;
    return wrap;
  }
  wrap.innerHTML = `
    <div class="builder-entity builder-entity--relay">
      <div class="builder-relay-core">
        <div class="builder-relay-port-dock builder-relay-port-a">${portBtn(0)}</div>
        <div class="builder-relay-port-dock builder-relay-port-b">${portBtn(1)}</div>
      </div>
    </div>
  `;
  return wrap;
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
  | "wire.lineBuild"
  | "packet.total"
  | "packet.overlayResize"
  | "packet.compute"
  | "packet.polyline"
  | "packet.interpolate"
  | "packet.domCommit";

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
  const { root } = options;
  let raw = loadBuilderState();
  if (!raw || raw.version !== 1) {
    raw = createEmptyBuilderState();
  }
  const rebuiltInitialState = rebuildStateWithOuterLeafEndpoints(raw);
  const sanitizedInitial = sanitizeDuplicateTypePlacements(rebuiltInitialState);
  let state = sanitizedInitial.state;
  if (sanitizedInitial.changed) {
    saveBuilderState(state);
  }

  let selection: Selection = null;
  let linkDrag: { from: LinkSourceSelection; endClient: { x: number; y: number } } | null = null;
  let dragRenderRaf: number | null = null;
  let wireDragRaf: number | null = null;
  let wireOverlayRaf: number | null = null;
  let portElByInstancePort = new Map<string, HTMLButtonElement>();
  let selectedEntityRootIds = new Set<string>();
  let boxSelection: BoxSelectionState = null;
  let suppressNextEntityClickToggle = false;
  const nearestCanvasScaleXStep = (v: number): number => {
    let best = CANVAS_SCALE_X_STEPS[0];
    let bestDelta = Math.abs(v - best);
    for (const step of CANVAS_SCALE_X_STEPS) {
      const delta = Math.abs(v - step);
      if (delta < bestDelta) {
        best = step;
        bestDelta = delta;
      }
    }
    return best;
  };
  const clampCanvasScaleX = (v: number): number => nearestCanvasScaleXStep(Math.max(CANVAS_SCALE_X_STEPS[0], Math.min(4, v)));
  const canvasScaleXIndexFromValue = (v: number): number =>
    Math.max(0, CANVAS_SCALE_X_STEPS.findIndex((step) => step === clampCanvasScaleX(v)));
  const canvasScaleXValueFromIndex = (index: number): number => {
    const i = Math.max(0, Math.min(CANVAS_SCALE_X_STEPS.length - 1, Math.round(index)));
    return CANVAS_SCALE_X_STEPS[i];
  };
  const formatCanvasScaleX = (v: number): string => {
    if (Math.abs(v - 1 / 32) < 1e-9) return "1/32x";
    if (Math.abs(v - 1 / 16) < 1e-9) return "1/16x";
    if (Math.abs(v - 1 / 8) < 1e-9) return "1/8x";
    return `${v.toFixed(2)}x`;
  };
  const clampCanvasScaleY = (v: number): number => Math.max(0.25, Math.min(3, v));
  const loadCanvasScale = (): CanvasScale => {
    try {
      const rawScale = window.localStorage.getItem(BUILDER_CANVAS_SCALE_KEY);
      if (!rawScale) return { x: 1, yByLayer: { outer64: 1, middle16: 1, inner4: 1, core1: 1 } };
      const parsed = JSON.parse(rawScale) as Partial<CanvasScale> & {
        y?: number;
        yByLayer?: Partial<Record<BuilderLayer, number>>;
      };
      const x = clampCanvasScaleX(Number(parsed.x));
      const legacyY = clampCanvasScaleY(Number(parsed.y));
      const yOuter = clampCanvasScaleY(Number(parsed.yByLayer?.outer64));
      const yMiddle = clampCanvasScaleY(Number(parsed.yByLayer?.middle16));
      const yInner = clampCanvasScaleY(Number(parsed.yByLayer?.inner4));
      const yCore = clampCanvasScaleY(Number(parsed.yByLayer?.core1));
      return {
        x: Number.isFinite(x) ? x : 1,
        yByLayer: {
          outer64: Number.isFinite(yOuter) ? yOuter : Number.isFinite(legacyY) ? legacyY : 1,
          middle16: Number.isFinite(yMiddle) ? yMiddle : Number.isFinite(legacyY) ? legacyY : 1,
          inner4: Number.isFinite(yInner) ? yInner : Number.isFinite(legacyY) ? legacyY : 1,
          core1: Number.isFinite(yCore) ? yCore : Number.isFinite(legacyY) ? legacyY : 1,
        },
      };
    } catch {
      return { x: 1, yByLayer: { outer64: 1, middle16: 1, inner4: 1, core1: 1 } };
    }
  };
  let canvasScale = loadCanvasScale();
  const loadHidePropertyLabels = (): boolean => {
    try {
      return window.localStorage.getItem(BUILDER_HIDE_PROP_LABELS_KEY) === "1";
    } catch {
      return false;
    }
  };

  root.innerHTML = `
    <div class="builder-layout">
      <aside class="builder-sidebar card">
        <div class="section-title">Templates</div>
        <div id="builder-templates"></div>
        <div class="section-title builder-spacer">Actions</div>
        <div class="builder-actions">
          <button id="builder-delete" type="button">Delete selected</button>
          <button id="builder-delete-all" type="button">Delete all</button>
          <button id="builder-toggle-prop-labels" type="button">Hide property labels</button>
          <button id="builder-export" type="button">Export Text</button>
          <button id="builder-import" type="button">Import Text</button>
        </div>
        <div class="section-title builder-spacer">Simulation</div>
        <div class="builder-sim-toolbar">
          <button id="builder-sim-play" type="button">Play</button>
          <button id="builder-sim-pause" type="button">Pause</button>
          <button id="builder-sim-step" type="button">Step</button>
          <button id="builder-sim-reset" type="button">Reset</button>
        </div>
        <label class="builder-scale-row" for="builder-sim-speed">
          <span>Tick pace</span>
          <input id="builder-sim-speed" type="range" min="${SPEED_EXP_MIN}" max="${SPEED_EXP_MAX}" step="1" value="${SPEED_EXP_DEFAULT}" />
          <span id="builder-sim-speed-value">${formatSpeedLabel(SPEED_EXP_DEFAULT)}</span>
        </label>
        <label class="builder-scale-row" for="builder-sim-send-rate">
          <span>Send rate</span>
          <input id="builder-sim-send-rate" type="range" min="${SEND_RATE_EXP_MIN}" max="${SEND_RATE_EXP_MAX}" step="1" value="${SEND_RATE_EXP_DEFAULT}" />
          <span id="builder-sim-send-rate-value">${formatSendRateLabel(SEND_RATE_EXP_DEFAULT)}</span>
        </label>
        <div id="builder-sim-meta" class="builder-sim-meta">Initializing…</div>
        <div class="section-title builder-spacer">Performance</div>
        <pre id="builder-perf" class="builder-perf">Collecting samples...</pre>
        <div class="section-title builder-spacer">Canvas Scale</div>
        <div class="builder-scale-controls">
          <label class="builder-scale-row" for="builder-scale-x">
            <span>Horizontal</span>
            <input id="builder-scale-x" type="range" min="0" max="${CANVAS_SCALE_X_STEPS.length - 1}" step="1" value="${canvasScaleXIndexFromValue(canvasScale.x)}" />
            <span id="builder-scale-x-value">${formatCanvasScaleX(canvasScale.x)}</span>
          </label>
          <label class="builder-scale-row" for="builder-scale-y-outer64">
            <span>Vertical Outer</span>
            <input id="builder-scale-y-outer64" type="range" min="0.25" max="3" step="0.25" value="${canvasScale.yByLayer.outer64.toFixed(2)}" />
            <span id="builder-scale-y-outer64-value">${canvasScale.yByLayer.outer64.toFixed(2)}x</span>
          </label>
          <label class="builder-scale-row" for="builder-scale-y-middle16">
            <span>Vertical Middle</span>
            <input id="builder-scale-y-middle16" type="range" min="0.25" max="3" step="0.25" value="${canvasScale.yByLayer.middle16.toFixed(2)}" />
            <span id="builder-scale-y-middle16-value">${canvasScale.yByLayer.middle16.toFixed(2)}x</span>
          </label>
          <label class="builder-scale-row" for="builder-scale-y-inner4">
            <span>Vertical Inner</span>
            <input id="builder-scale-y-inner4" type="range" min="0.25" max="3" step="0.25" value="${canvasScale.yByLayer.inner4.toFixed(2)}" />
            <span id="builder-scale-y-inner4-value">${canvasScale.yByLayer.inner4.toFixed(2)}x</span>
          </label>
          <label class="builder-scale-row" for="builder-scale-y-core1">
            <span>Vertical Core</span>
            <input id="builder-scale-y-core1" type="range" min="0.25" max="3" step="0.25" value="${canvasScale.yByLayer.core1.toFixed(2)}" />
            <span id="builder-scale-y-core1-value">${canvasScale.yByLayer.core1.toFixed(2)}x</span>
          </label>
        </div>
        <div class="section-title builder-spacer">Inspector</div>
        <div id="builder-inspector">No selection.</div>
      </aside>
      <main class="builder-main card">
        <div class="builder-canvas-wrap">
          <svg id="builder-wire-overlay" class="builder-wire-overlay"></svg>
          <svg id="builder-packet-overlay" class="builder-packet-overlay" aria-hidden="true"></svg>
          <div id="builder-canvas" class="builder-canvas"></div>
        </div>
      </main>
    </div>
  `;

  const templatesEl = root.querySelector<HTMLDivElement>("#builder-templates")!;
  const canvasEl = root.querySelector<HTMLDivElement>("#builder-canvas")!;
  const wireOverlayEl = root.querySelector<SVGSVGElement>("#builder-wire-overlay")!;
  const packetOverlayEl = root.querySelector<SVGSVGElement>("#builder-packet-overlay")!;
  const inspectorEl = root.querySelector<HTMLDivElement>("#builder-inspector")!;
  const perfEl = root.querySelector<HTMLPreElement>("#builder-perf")!;
  const scaleXEl = root.querySelector<HTMLInputElement>("#builder-scale-x")!;
  const scaleYOuterEl = root.querySelector<HTMLInputElement>("#builder-scale-y-outer64")!;
  const scaleYMiddleEl = root.querySelector<HTMLInputElement>("#builder-scale-y-middle16")!;
  const scaleYInnerEl = root.querySelector<HTMLInputElement>("#builder-scale-y-inner4")!;
  const scaleYCoreEl = root.querySelector<HTMLInputElement>("#builder-scale-y-core1")!;
  const scaleXValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-x-value")!;
  const scaleYOuterValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-outer64-value")!;
  const scaleYMiddleValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-middle16-value")!;
  const scaleYInnerValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-inner4-value")!;
  const scaleYCoreValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-core1-value")!;
  const deleteBtn = root.querySelector<HTMLButtonElement>("#builder-delete")!;
  const deleteAllBtn = root.querySelector<HTMLButtonElement>("#builder-delete-all")!;
  const togglePropLabelsBtn = root.querySelector<HTMLButtonElement>("#builder-toggle-prop-labels")!;
  const exportBtn = root.querySelector<HTMLButtonElement>("#builder-export")!;
  const importBtn = root.querySelector<HTMLButtonElement>("#builder-import")!;
  const simPlayBtn = root.querySelector<HTMLButtonElement>("#builder-sim-play")!;
  const simPauseBtn = root.querySelector<HTMLButtonElement>("#builder-sim-pause")!;
  const simStepBtn = root.querySelector<HTMLButtonElement>("#builder-sim-step")!;
  const simResetBtn = root.querySelector<HTMLButtonElement>("#builder-sim-reset")!;
  const simSpeedEl = root.querySelector<HTMLInputElement>("#builder-sim-speed")!;
  const simSpeedValueEl = root.querySelector<HTMLSpanElement>("#builder-sim-speed-value")!;
  const simSendRateEl = root.querySelector<HTMLInputElement>("#builder-sim-send-rate")!;
  const simSendRateValueEl = root.querySelector<HTMLSpanElement>("#builder-sim-send-rate-value")!;
  const simMetaEl = root.querySelector<HTMLDivElement>("#builder-sim-meta")!;
  const canvasWrapEl = wireOverlayEl.parentElement as HTMLDivElement | null;
  const boxEl = document.createElement("div");
  boxEl.className = "builder-box-selection";
  const dragBoundsEl = document.createElement("div");
  dragBoundsEl.className = "builder-drag-bounds";
  if (canvasWrapEl) {
    canvasWrapEl.appendChild(boxEl);
    canvasWrapEl.appendChild(dragBoundsEl);
  }
  const perfStats = new Map<BuilderPerfKey, BuilderPerfStat>();
  const PERF_EMA_ALPHA = 0.18;
  let perfCounts = { expandedEntities: 0, stateLinks: 0, expandedLinks: 0, packetsInFlight: 0 };
  let nextPerfPanelAtMs = 0;
  let hideEntityPropertyLabels = loadHidePropertyLabels();

  function persistCanvasScale(): void {
    window.localStorage.setItem(BUILDER_CANVAS_SCALE_KEY, JSON.stringify(canvasScale));
  }

  function persistHidePropertyLabels(): void {
    window.localStorage.setItem(BUILDER_HIDE_PROP_LABELS_KEY, hideEntityPropertyLabels ? "1" : "0");
  }

  function applyCanvasScale(): void {
    const wrap = wireOverlayEl.parentElement;
    if (wrap) {
      const middleBasePx = Math.max(320, wrap.clientWidth);
      const layerCount = orderedLayersTopDown().length;
      const totalGapPx = Math.max(0, layerCount - 1) * BUILDER_LAYER_GAP_PX;
      const usableHeight = Math.max(120, wrap.clientHeight - totalGapPx);
      const layerBasePx = Math.max(120, usableHeight / Math.max(1, layerCount));
      const middleColWidthPx = (middleBasePx + BUILDER_LAYER_GAP_PX) * canvasScale.x - BUILDER_LAYER_GAP_PX;
      root.style.setProperty("--builder-middle-col-base-px", `${middleBasePx.toFixed(2)}px`);
      root.style.setProperty("--builder-middle-col-width-px", `${middleColWidthPx.toFixed(2)}px`);
      root.style.setProperty("--builder-layer-base-height-px", `${layerBasePx.toFixed(2)}px`);
    }
    root.style.setProperty("--builder-scale-x", canvasScale.x.toFixed(3));
    root.style.setProperty("--builder-scale-y-outer64", canvasScale.yByLayer.outer64.toFixed(3));
    root.style.setProperty("--builder-scale-y-middle16", canvasScale.yByLayer.middle16.toFixed(3));
    root.style.setProperty("--builder-scale-y-inner4", canvasScale.yByLayer.inner4.toFixed(3));
    root.style.setProperty("--builder-scale-y-core1", canvasScale.yByLayer.core1.toFixed(3));
    root.style.setProperty("--builder-grid-step-x", `${BUILDER_GRID_TILE_SIZE_X_PX}px`);
    root.style.setProperty("--builder-grid-step-y", `${BUILDER_GRID_TILE_SIZE_Y_PX}px`);
    scaleXEl.value = String(canvasScaleXIndexFromValue(canvasScale.x));
    scaleXValueEl.textContent = formatCanvasScaleX(canvasScale.x);
    scaleYOuterValueEl.textContent = `${canvasScale.yByLayer.outer64.toFixed(2)}x`;
    scaleYMiddleValueEl.textContent = `${canvasScale.yByLayer.middle16.toFixed(2)}x`;
    scaleYInnerValueEl.textContent = `${canvasScale.yByLayer.inner4.toFixed(2)}x`;
    scaleYCoreValueEl.textContent = `${canvasScale.yByLayer.core1.toFixed(2)}x`;
    scheduleWireOverlayRender();
  }

  function layerViewportSizes(): Record<BuilderLayer, { width: number; height: number } | null> {
    const readLayer = (layer: BuilderLayer): { width: number; height: number } | null => {
      const host = canvasEl.querySelector<HTMLElement>(
        `.builder-segment[data-layer="${layer}"] .builder-segment-entities`,
      );
      if (!host) return null;
      return {
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
      };
    };
    return {
      outer64: readLayer("outer64"),
      middle16: readLayer("middle16"),
      inner4: readLayer("inner4"),
      core1: readLayer("core1"),
    };
  }

  function looksLikeLegacyNormalizedEntityPosition(x: number, y: number): boolean {
    const inUnitRange = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (!inUnitRange) return false;
    // New grid coordinates are integral tile indices; legacy values are mostly fractional.
    return !Number.isInteger(x) || !Number.isInteger(y);
  }

  function migrateLegacyNormalizedEntityPositionsToGrid(): void {
    const sizes = layerViewportSizes();
    let changed = false;
    state = {
      ...state,
      entities: state.entities.map((entity) => {
        if (!looksLikeLegacyNormalizedEntityPosition(entity.x, entity.y)) {
          return entity;
        }
        const layerSize = sizes[entity.layer];
        if (!layerSize) return entity;
        changed = true;
        return {
          ...entity,
          x: Math.round((entity.x * layerSize.width) / BUILDER_GRID_TILE_SIZE_X_PX),
          y: Math.round((entity.y * layerSize.height) / BUILDER_GRID_TILE_SIZE_Y_PX),
        };
      }),
    };
    if (changed) {
      persist();
    }
  }

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
      "packet.total",
      "packet.overlayResize",
      "packet.compute",
      "packet.polyline",
      "packet.interpolate",
      "packet.domCommit",
    ];
    const totalCanvas = Math.max(0.0001, get("canvas.total").lastMs);
    const totalWire = Math.max(0.0001, get("wire.total").lastMs);
    const totalPacket = Math.max(0.0001, get("packet.total").lastMs);
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
    const topPacket = ([
      "packet.overlayResize",
      "packet.compute",
      "packet.polyline",
      "packet.interpolate",
      "packet.domCommit",
    ] as BuilderPerfKey[])
      .map((k) => ({ k, v: get(k).lastMs }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    const lines = [
      `entities=${perfCounts.expandedEntities}  stateLinks=${perfCounts.stateLinks}  expandedLinks=${perfCounts.expandedLinks}  packets=${perfCounts.packetsInFlight}`,
      `sim mode=main  step compute=${(simLastStepComputeMs ?? 0).toFixed(2)}ms  ema=${(simEmaStepComputeMs ?? 0).toFixed(2)}ms`,
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
      "",
      `Top packet contributors (last=${totalPacket.toFixed(2)}ms):`,
      ...topPacket.map((x) => `  ${x.k.padEnd(22, " ")} ${(x.v / totalPacket * 100).toFixed(1).padStart(5)}% (${x.v.toFixed(2)}ms)`),
    ];
    perfEl.textContent = lines.join("\n");
  }

  function maybeRenderPerfPanel(nowMs = performance.now()): void {
    if (nowMs < nextPerfPanelAtMs) return;
    nextPerfPanelAtMs = nowMs + 200;
    renderPerfPanel();
  }

  function persist(): void {
    saveBuilderState(state);
    initOrRefreshBuilderSimulatorIfTopologyChanged();
  }

  let builderTopologySig = "";
  type SimFrame = {
    prevOccupancy: Array<{ port: PortRef; packet: Packet }>;
    currentOccupancy: Array<{ port: PortRef; packet: Packet }>;
    stats: SimulationStats;
    stepComputeMs: number;
  };
  let builderSimulator: TunnetSimulator | null = null;
  let builderSimulatorOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let simPlaying = false;
  let simAnimating = false;
  let simAnimHandle: number | null = null;
  let simSpeedExponent = Number(simSpeedEl.value);
  if (!Number.isFinite(simSpeedExponent)) {
    simSpeedExponent = SPEED_EXP_DEFAULT;
  }
  let simSpeed = speedMultiplierFromExponent(simSpeedExponent);
  let simSendRateExponent = Number(simSendRateEl.value);
  if (!Number.isFinite(simSendRateExponent)) {
    simSendRateExponent = SEND_RATE_EXP_DEFAULT;
  }
  let simStats: SimulationStats = {
    tick: 0,
    emitted: 0,
    delivered: 0,
    dropped: 0,
    bounced: 0,
    ttlExpired: 0,
    collisions: 0,
  };
  let simPreviousStatsTotals: SimulationStats = { ...simStats };
  let simDeliveredPerTick: number | null = null;
  let simDeliveredPerTickAvg100: number | null = null;
  const simDeliveredHistory: number[] = [];
  const SIM_DELIVERED_AVG_WINDOW = 100;
  let simDropPctTick: number | null = null;
  let simDropPctCumulative: number | null = null;
  let simEmaAchievedSpeed: number | null = null;
  let simLastStepComputeMs: number | null = null;
  let simEmaStepComputeMs: number | null = null;
  const SIM_ACHIEVED_SPEED_EMA_ALPHA = 0.12;
  const SIM_STEP_COMPUTE_EMA_ALPHA = 0.2;
  let simPreviousOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let simCurrentOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let simPreviousOccupancyByPacketId = new Map<number, { port: PortRef; packet: Packet }>();
  let simPacketProgress = 1;
  const builderEndpointIdByAddress = new Map<string, string>();
  let builderSimDevices: Record<string, Device> = {};
  let builderSimAdj: Map<string, PortRef> = new Map();
  const packetRouteTemplateByKey = new Map<string, PortRef[] | null>();
  let simPreparedPacketRenders: SimPreparedPacketRender[] = [];
  let simPreparedPacketRenderDirty = true;
  let packetCircleGroupEl: SVGGElement | null = null;
  const packetCirclePool: SVGCircleElement[] = [];
  let activePacketCircleCount = 0;

  function cloneSimOccupancy(occ: Array<{ port: PortRef; packet: Packet }>): Array<{ port: PortRef; packet: Packet }> {
    return occ.map((e) => ({ port: { ...e.port }, packet: e.packet }));
  }

  function cloneSimOccupancyWithPackets(occ: Array<{ port: PortRef; packet: Packet }>): Array<{ port: PortRef; packet: Packet }> {
    return occ.map((e) => ({ port: { ...e.port }, packet: { ...e.packet } }));
  }

  function simPortCountForDevice(device: Device): number {
    if (device.type === "endpoint") return 1;
    if (device.type === "relay") return 2;
    if (device.type === "filter") return 2;
    return 3;
  }

  function projectRuntimeStateToTopology(
    runtime: SimulatorRuntimeState,
    topology: Topology,
  ): SimulatorRuntimeState {
    const occupancy = runtime.occupancy.filter(({ port }) => {
      const device = topology.devices[port.deviceId];
      if (!device) return false;
      return Number.isInteger(port.port) && port.port >= 0 && port.port < simPortCountForDevice(device);
    });
    const endpointNextSendTickById: Record<string, number> = {};
    for (const dev of Object.values(topology.devices)) {
      if (dev.type !== "endpoint") continue;
      const existing = runtime.endpointNextSendTickById[dev.id];
      if (Number.isFinite(existing)) {
        endpointNextSendTickById[dev.id] = existing;
      }
    }
    return {
      ...runtime,
      occupancy,
      endpointNextSendTickById,
    };
  }

  function applyBuilderSimulatorSnapshot(
    occupancy: Array<{ port: PortRef; packet: Packet }>,
    stats: SimulationStats,
  ): void {
    simPreviousOccupancy = [];
    simPreviousOccupancyByPacketId = new Map();
    simCurrentOccupancy = cloneSimOccupancy(occupancy);
    simStats = { ...stats };
    simPreviousStatsTotals = { ...stats };
    simPacketProgress = 1;
    invalidateBuilderPacketRenderCache();
    if (selection?.kind === "packet") {
      const packetSel = selection;
      const stillThere = simCurrentOccupancy.some((e) => e.packet.id === packetSel.packetId);
      if (!stillThere) {
        selection = null;
        renderInspector();
      }
    }
    updateBuilderSimMeta();
    renderBuilderPacketCircles(1);
  }

  function initBuilderSimulator(topology: Topology): void {
    builderSimulator = new TunnetSimulator(topology, 1337);
    builderSimulator.setSendRateMultiplier(sendRateMultiplierFromExponent(simSendRateExponent));
    builderSimulatorOccupancy = cloneSimOccupancyWithPackets(builderSimulator.getPortOccupancy());
    applyBuilderSimulatorSnapshot(builderSimulatorOccupancy, {
      tick: 0,
      emitted: 0,
      delivered: 0,
      dropped: 0,
      bounced: 0,
      ttlExpired: 0,
      collisions: 0,
    });
  }

  function updateBuilderSimulatorTopology(topology: Topology): void {
    if (!builderSimulator) {
      initBuilderSimulator(topology);
      return;
    }
    const runtime = builderSimulator.exportRuntimeState();
    const projected = projectRuntimeStateToTopology(runtime, topology);
    const next = new TunnetSimulator(topology, projected.rndState);
    next.importRuntimeState(projected);
    builderSimulator = next;
    builderSimulatorOccupancy = cloneSimOccupancyWithPackets(builderSimulator.getPortOccupancy());
    applyBuilderSimulatorSnapshot(builderSimulatorOccupancy, { ...projected.stats });
  }

  function computeNextBuilderSimFrame(): SimFrame | null {
    if (!builderSimulator) return null;
    const prev = cloneSimOccupancyWithPackets(builderSimulatorOccupancy);
    const t0 = performance.now();
    const snap = builderSimulator.step();
    const stepComputeMs = performance.now() - t0;
    builderSimulatorOccupancy = cloneSimOccupancyWithPackets(builderSimulator.getPortOccupancy());
    return {
      prevOccupancy: prev,
      currentOccupancy: cloneSimOccupancyWithPackets(builderSimulatorOccupancy),
      stats: { ...snap.stats },
      stepComputeMs,
    };
  }

  function rebuildBuilderSimEndpointIndex(topology: Topology): void {
    builderEndpointIdByAddress.clear();
    for (const dev of Object.values(topology.devices)) {
      if (dev.type === "endpoint") {
        builderEndpointIdByAddress.set(dev.address, dev.id);
      }
    }
  }

  function rebuildBuilderSimTopologyCache(top: Topology): void {
    builderSimDevices = top.devices;
    builderSimAdj = buildPortAdjacency(top);
    packetRouteTemplateByKey.clear();
  }

  function syncBuilderSimSliderLabels(): void {
    simSpeedValueEl.textContent = formatSpeedLabel(simSpeedExponent);
    simSendRateValueEl.textContent = formatSendRateLabel(simSendRateExponent);
  }

  function updateBuilderSimMeta(): void {
    const achievedValue =
      simEmaAchievedSpeed === null
        ? `— (no tick finished yet)`
        : `${simEmaAchievedSpeed.toFixed(2)}× (${Math.min(999, Math.round((simEmaAchievedSpeed / Math.max(simSpeed, 1e-9)) * 100))}% of ${simSpeed.toFixed(2)}× target)`;
    const stepComputeValue =
      simLastStepComputeMs === null
        ? `—`
        : `${simLastStepComputeMs.toFixed(2)}ms (ema ${(simEmaStepComputeMs ?? simLastStepComputeMs).toFixed(2)}ms)`;
    simMetaEl.innerHTML = `
      <div class="stats-subtitle">Runtime</div>
      <div class="stats-row">
        <div class="stat-pill"><span>State</span><strong>${simPlaying ? "running" : "paused"}</strong></div>
        <div class="stat-pill"><span>Tick pace</span><strong>${formatSpeedLabel(simSpeedExponent)}</strong></div>
        <div class="stat-pill"><span>Achieved</span><strong>${achievedValue}</strong></div>
        <div class="stat-pill"><span>Send rate</span><strong>${formatSendRateLabel(simSendRateExponent)}</strong></div>
        <div class="stat-pill"><span>Step compute</span><strong>${stepComputeValue}</strong></div>
      </div>
      <div class="stats-subtitle stats-subtitle-gap">Simulation</div>
      <div class="stats-row">
        <div class="stat-pill"><span>Tick</span><strong>${simStats.tick}</strong></div>
        <div class="stat-pill"><span>In-flight</span><strong>${simCurrentOccupancy.length}</strong></div>
        <div class="stat-pill"><span>Emitted</span><strong>${simStats.emitted}</strong></div>
        <div class="stat-pill"><span>Delivered</span><strong>${simStats.delivered}</strong></div>
        <div class="stat-pill"><span>Dropped</span><strong>${simStats.dropped}</strong></div>
        <div class="stat-pill"><span>Bounced</span><strong>${simStats.bounced}</strong></div>
        <div class="stat-pill"><span>TTL expired</span><strong>${simStats.ttlExpired}</strong></div>
        <div class="stat-pill"><span>Collisions</span><strong>${simStats.collisions}</strong></div>
        <div class="stat-pill"><span>Delivered/tick</span><strong>${simDeliveredPerTick === null ? "—" : simDeliveredPerTick.toFixed(2)}</strong></div>
        <div class="stat-pill"><span>Delivered avg100</span><strong>${simDeliveredPerTickAvg100 === null ? "—" : simDeliveredPerTickAvg100.toFixed(2)}</strong></div>
        <div class="stat-pill"><span>Drop % tick</span><strong>${simDropPctTick === null ? "—" : `${simDropPctTick.toFixed(1)}%`}</strong></div>
        <div class="stat-pill"><span>Drop % cumulative</span><strong>${simDropPctCumulative === null ? "—" : `${simDropPctCumulative.toFixed(1)}%`}</strong></div>
      </div>
    `;
  }

  function resetBuilderSimulation(resumeIfWasPlaying = false): void {
    const shouldResume = resumeIfWasPlaying && simPlaying;
    if (simAnimHandle !== null) {
      cancelAnimationFrame(simAnimHandle);
      simAnimHandle = null;
    }
    simPlaying = false;
    simAnimating = false;
    const payload = compileBuilderPayload(state);
    const topo = payload.topology as unknown as Topology;
    builderTopologySig = JSON.stringify(payload.topology);
    rebuildBuilderSimTopologyCache(topo);
    simStats = {
      tick: 0,
      emitted: 0,
      delivered: 0,
      dropped: 0,
      bounced: 0,
      ttlExpired: 0,
      collisions: 0,
    };
    simPreviousStatsTotals = { ...simStats };
    simDeliveredPerTick = null;
    simDeliveredPerTickAvg100 = null;
    simDeliveredHistory.length = 0;
    simDropPctTick = null;
    simDropPctCumulative = null;
    simEmaAchievedSpeed = null;
    simLastStepComputeMs = null;
    simEmaStepComputeMs = null;
    rebuildBuilderSimEndpointIndex(topo);
    simPreviousOccupancy = [];
    simPreviousOccupancyByPacketId = new Map();
    simCurrentOccupancy = [];
    simPacketProgress = 1;
    invalidateBuilderPacketRenderCache();
    if (selection?.kind === "packet") {
      selection = null;
      renderInspector();
    }
    clearBuilderPacketCirclePool();
    updateBuilderSimMeta();
    scheduleWireOverlayRender();
    initBuilderSimulator(topo);
    if (shouldResume) {
      simPlaying = true;
      runOneBuilderSimTick();
    }
  }

  function initOrRefreshBuilderSimulatorIfTopologyChanged(): void {
    const payload = compileBuilderPayload(state);
    const sig = JSON.stringify(payload.topology);
    if (sig === builderTopologySig) return;
    builderTopologySig = sig;
    const topo = payload.topology as unknown as Topology;
    rebuildBuilderSimTopologyCache(topo);
    rebuildBuilderSimEndpointIndex(topo);

    const shouldResume = simPlaying;
    if (simAnimHandle !== null) {
      cancelAnimationFrame(simAnimHandle);
      simAnimHandle = null;
    }
    simAnimating = false;
    simPlaying = false;
    updateBuilderSimulatorTopology(topo);
    if (shouldResume) {
      simPlaying = true;
      runOneBuilderSimTick();
    }
  }

  function runOneBuilderSimTick(): void {
    if (simAnimating) return;
    const tickWallStartMs = performance.now();
    const frame = computeNextBuilderSimFrame();
    if (!frame) return;
    simAnimating = true;
    simPreviousOccupancy = frame.prevOccupancy;
    simPreviousOccupancyByPacketId = simOccupancyByPacketId(simPreviousOccupancy);
    const emittedTick = frame.stats.emitted - simPreviousStatsTotals.emitted;
    const deliveredTickCount = frame.stats.delivered - simPreviousStatsTotals.delivered;
    const droppedTickCount = frame.stats.dropped - simPreviousStatsTotals.dropped;
    simDeliveredPerTick = deliveredTickCount;
    simDeliveredHistory.push(deliveredTickCount);
    if (simDeliveredHistory.length > SIM_DELIVERED_AVG_WINDOW) {
      simDeliveredHistory.shift();
    }
    simDeliveredPerTickAvg100 =
      simDeliveredHistory.length > 0
        ? simDeliveredHistory.reduce((sum, v) => sum + v, 0) / simDeliveredHistory.length
        : null;
    simDropPctTick = emittedTick > 0 ? (droppedTickCount / emittedTick) * 100 : null;
    simDropPctCumulative =
      frame.stats.emitted > 0 ? (frame.stats.dropped / frame.stats.emitted) * 100 : null;
    simPreviousStatsTotals = { ...frame.stats };
    const stepMs = frame.stepComputeMs;
    simLastStepComputeMs = stepMs;
    simEmaStepComputeMs =
      simEmaStepComputeMs === null
        ? stepMs
        : SIM_STEP_COMPUTE_EMA_ALPHA * stepMs + (1 - SIM_STEP_COMPUTE_EMA_ALPHA) * simEmaStepComputeMs;
    simStats = frame.stats;
    simCurrentOccupancy = frame.currentOccupancy;
    invalidateBuilderPacketRenderCache();
    if (selection && selection.kind === "packet") {
      const packetSel = selection;
      const stillThere = simCurrentOccupancy.some((e) => e.packet.id === packetSel.packetId);
      if (!stillThere) {
        selection = null;
        renderInspector();
        renderWireOverlay();
      }
    }
    updateBuilderSimMeta();
    const durationMs = Math.max(1, 1000 / Math.max(simSpeed, 0.1));
    const animStart = performance.now();
    const animate = (now: number): void => {
      const t = Math.min(1, (now - animStart) / durationMs);
      simPacketProgress = t;
      renderBuilderPacketCircles(t);
      if (t < 1) {
        simAnimHandle = requestAnimationFrame(animate);
        return;
      }
      const wallMs = performance.now() - tickWallStartMs;
      if (wallMs > 1) {
        const instantAchieved = 1000 / wallMs;
        simEmaAchievedSpeed =
          simEmaAchievedSpeed === null
            ? instantAchieved
            : SIM_ACHIEVED_SPEED_EMA_ALPHA * instantAchieved + (1 - SIM_ACHIEVED_SPEED_EMA_ALPHA) * simEmaAchievedSpeed;
      }
      simAnimating = false;
      simAnimHandle = null;
      simPacketProgress = 1;
      renderBuilderPacketCircles(1);
      updateBuilderSimMeta();
      if (simPlaying) {
        runOneBuilderSimTick();
      }
    };
    simPacketProgress = 0;
    renderBuilderPacketCircles(0);
    simAnimHandle = requestAnimationFrame(animate);
  }

  function setBuilderSimPlaying(enabled: boolean): void {
    simPlaying = enabled;
    if (!simPlaying && simAnimHandle !== null) {
      cancelAnimationFrame(simAnimHandle);
      simAnimHandle = null;
      simAnimating = false;
      simPacketProgress = 1;
      renderBuilderPacketCircles(1);
    }
    if (simPlaying && !simAnimating) {
      runOneBuilderSimTick();
    }
    updateBuilderSimMeta();
  }

  function applyPropertyLabelVisibility(): void {
    root.classList.toggle("builder-hide-property-labels", hideEntityPropertyLabels);
    togglePropLabelsBtn.textContent = hideEntityPropertyLabels
      ? "Show property labels"
      : "Hide property labels";
  }

  function applySelectionToCanvas(): void {
    canvasEl.querySelectorAll<HTMLElement>(".builder-entity.selected").forEach((el) => {
      el.classList.remove("selected");
    });
    const ids = selectedEntityRootIds.size
      ? Array.from(selectedEntityRootIds)
      : selection?.kind === "entity"
        ? [selection.rootId]
        : [];
    ids.forEach((id) => {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${id}"]`)
        .forEach((el) => {
          el.classList.add("selected");
        });
    });
  }

  function showDragGroupBounds(ids: string[]): void {
    if (!canvasWrapEl) return;
    if (!ids.length) {
      dragBoundsEl.style.display = "none";
      return;
    }
    const wrapRect = canvasWrapEl.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ids.forEach((id) => {
      const ent = state.entities.find((e) => e.id === id);
      if (!ent) return;
      const host = segmentEntitiesHost(ent.layer, ent.segmentIndex);
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const hostLeft = hostRect.left - wrapRect.left + canvasWrapEl.scrollLeft;
      const hostTop = hostRect.top - wrapRect.top + canvasWrapEl.scrollTop;
      const fp = entityFootprintOffsets(ent);
      const gx1 = ent.x + fp.left;
      const gy1 = ent.y + fp.top;
      const gx2 = ent.x + fp.right + 1;
      const gy2 = ent.y + fp.bottom + 1;
      const x1 = hostLeft + gx1 * BUILDER_GRID_TILE_SIZE_X_PX;
      const y1 = hostTop + gy1 * BUILDER_GRID_TILE_SIZE_Y_PX;
      const x2 = hostLeft + gx2 * BUILDER_GRID_TILE_SIZE_X_PX;
      const y2 = hostTop + gy2 * BUILDER_GRID_TILE_SIZE_Y_PX;
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      dragBoundsEl.style.display = "none";
      return;
    }
    dragBoundsEl.style.display = "block";
    dragBoundsEl.style.left = `${minX}px`;
    dragBoundsEl.style.top = `${minY}px`;
    dragBoundsEl.style.width = `${Math.max(0, maxX - minX)}px`;
    dragBoundsEl.style.height = `${Math.max(0, maxY - minY)}px`;
  }

  function hideDragGroupBounds(): void {
    dragBoundsEl.style.display = "none";
    dragBoundsEl.style.width = "0px";
    dragBoundsEl.style.height = "0px";
  }

  function entityFootprintOffsets(entity: BuilderEntityRoot): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    if (entity.templateType === "hub") {
      // Hub anchor is its center cell.
      return { left: -1, right: 1, top: -1, bottom: 1 };
    }
    if (entity.templateType === "relay") {
      // Relay anchor is top-left of a 2x2 footprint.
      return { left: 0, right: 1, top: 0, bottom: 1 };
    }
    if (entity.templateType === "filter") {
      // Filter anchor is top-left.
      const width = hideEntityPropertyLabels ? 6 : 9;
      const height = 11;
      return { left: 0, right: width - 1, top: 0, bottom: height - 1 };
    }
    if (entity.templateType === "endpoint") {
      // Endpoint anchor is top-left.
      const width = hideEntityPropertyLabels ? 6 : 9;
      const height = 3;
      return { left: 0, right: width - 1, top: 0, bottom: height - 1 };
    }
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }

  function setSelection(next: Selection): void {
    selection = next;
    selectedEntityRootIds.clear();
    linkDrag = null;
    renderInspector();
    applySelectionToCanvas();
    renderWireOverlay();
  }

  function setEntitySelectionSet(ids: Set<string>): void {
    selectedEntityRootIds = new Set(ids);
    const firstId = selectedEntityRootIds.values().next().value as string | undefined;
    selection = firstId ? { kind: "entity", rootId: firstId } : null;
    linkDrag = null;
    renderInspector();
    applySelectionToCanvas();
    renderWireOverlay();
  }

  function entityPositionCss(templateType: BuilderTemplateType, x: number, y: number): { left: string; top: string } {
    const isHub = templateType === "hub";
    const left = isHub
      ? `calc((${x} + 0.5) * var(--builder-grid-step-x) - ${HUB_LAYOUT.G.x.toFixed(3)}px)`
      : `calc(${x} * var(--builder-grid-step-x))`;
    const top = isHub
      ? `calc((${y} + 0.5) * var(--builder-grid-step-y) - ${HUB_LAYOUT.G.y.toFixed(3)}px)`
      : `calc(${y} * var(--builder-grid-step-y))`;
    return { left, top };
  }

  function previewPositionCss(rootId: string, x: number, y: number): { left: string; top: string } {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    return entityPositionCss(rootEnt?.templateType ?? "relay", x, y);
  }

  type DragPlacement = { layer: BuilderLayer; segment: number; x: number; y: number };

  function hasSameTypePlacementConflict(
    templateType: BuilderTemplateType,
    layer: BuilderLayer,
    segment: number,
    x: number,
    y: number,
    ignoreIds?: Set<string>,
  ): boolean {
    return state.entities.some((e) => {
      if (ignoreIds?.has(e.id)) return false;
      return (
        e.templateType === templateType &&
        e.layer === layer &&
        e.segmentIndex === segment &&
        e.x === x &&
        e.y === y
      );
    });
  }

  function hasPlacementMapConflicts(placements: Map<string, DragPlacement>): boolean {
    const movingIds = new Set(placements.keys());
    const seen = new Set<string>();
    let conflict = false;
    placements.forEach((placement, id) => {
      if (conflict) return;
      const ent = state.entities.find((e) => e.id === id);
      if (!ent) return;
      const key = `${ent.templateType}:${placement.layer}:${placement.segment}:${placement.x}:${placement.y}`;
      if (seen.has(key)) {
        conflict = true;
        return;
      }
      seen.add(key);
      if (
        hasSameTypePlacementConflict(
          ent.templateType,
          placement.layer,
          placement.segment,
          placement.x,
          placement.y,
          movingIds,
        )
      ) {
        conflict = true;
      }
    });
    return conflict;
  }

  function segmentEntitiesHost(layer: BuilderLayer, segment: number): HTMLElement | null {
    if (layer === "outer64" && isOuterLeafVoidSegment(segment)) {
      const outerVoidCell = canvasEl.querySelector<HTMLElement>('.builder-segment[data-layer="outer64"][data-void-outer="1"]');
      return outerVoidCell?.querySelector<HTMLElement>(".builder-segment-entities") ?? outerVoidCell ?? null;
    }
    const cell = canvasEl.querySelector<HTMLElement>(
      `.builder-segment[data-layer="${layer}"][data-segment="${segment}"]`,
    );
    return cell?.querySelector<HTMLElement>(".builder-segment-entities") ?? cell ?? null;
  }

  function segmentFromClientPoint(clientX: number, clientY: number): {
    layer: BuilderLayer;
    segment: number;
    host: HTMLElement;
    rect: DOMRect;
    widthPx: number;
    heightPx: number;
  } | null {
    const cell =
      document
        .elementsFromPoint(clientX, clientY)
        .map((node) => node.closest<HTMLElement>(".builder-segment"))
        .find((seg): seg is HTMLElement => seg !== null) ?? null;
    if (!cell) return null;
    const layer = cell.dataset.layer as BuilderLayer;
    const host = cell.querySelector<HTMLElement>(".builder-segment-entities") ?? cell;
    const rect = host.getBoundingClientRect();
    const widthPx = Math.max(1, host.clientWidth);
    const heightPx = Math.max(1, host.clientHeight);
    if (cell.dataset.voidOuter === "1") {
      const relX = (clientX - rect.left) / Math.max(1, host.clientWidth);
      const slot = Math.max(0, Math.min(3, Math.floor(relX * 4)));
      return { layer: "outer64", segment: 12 + slot, host, rect, widthPx, heightPx };
    }
    const segment = Number(cell.dataset.segment);
    if (Number.isNaN(segment)) return null;
    return { layer, segment, host, rect, widthPx, heightPx };
  }

  function applyCopyGhostPositions(posById: Map<string, DragPlacement>): void {
    canvasEl.querySelectorAll<HTMLElement>(".builder-entity.copy-ghost-preview").forEach((el) => {
      el.remove();
    });
    posById.forEach((pos, id) => {
      const { left, top } = previewPositionCss(id, pos.x, pos.y);
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${id}"]`)
        .forEach((srcEl) => {
          const ghostEl = srcEl.cloneNode(true) as HTMLElement;
          ghostEl.classList.remove("selected");
          ghostEl.classList.add("copy-ghost", "copy-ghost-preview");
          ghostEl.removeAttribute("data-root-id");
          ghostEl.style.left = left;
          ghostEl.style.top = top;
          (segmentEntitiesHost(pos.layer, pos.segment) ?? srcEl.parentElement)?.appendChild(ghostEl);
        });
    });
  }

  function commitCopiedGroup(
    sourceRootIds: string[],
    targetPosBySourceId: Map<string, DragPlacement>,
  ): void {
    const sourceSet = new Set(sourceRootIds);
    let nextState = state;
    const idMap = new Map<string, string>();
    sourceRootIds.forEach((srcId) => {
      const src = state.entities.find((e) => e.id === srcId);
      const targetPos = targetPosBySourceId.get(srcId);
      if (!src || !targetPos || isStaticOuterLeafEndpoint(src)) return;
      if (
        hasSameTypePlacementConflict(
          src.templateType,
          targetPos.layer,
          targetPos.segment,
          targetPos.x,
          targetPos.y,
        )
      ) {
        return;
      }
      const created = createEntityRoot(
        nextState,
        src.templateType,
        targetPos.layer,
        targetPos.segment,
        targetPos.x,
        targetPos.y,
      );
      nextState = { ...nextState, entities: [...nextState.entities, created] };
      nextState = updateEntitySettings(nextState, created.id, { ...src.settings });
      idMap.set(srcId, created.id);
    });
    state.links.forEach((link) => {
      if (!sourceSet.has(link.fromEntityId) || !sourceSet.has(link.toEntityId)) return;
      const fromId = idMap.get(link.fromEntityId);
      const toId = idMap.get(link.toEntityId);
      if (!fromId || !toId) return;
      const createdLink = createLinkRoot(
        nextState,
        fromId,
        link.fromPort,
        toId,
        link.toPort,
        {
          fromSegmentIndex: link.fromSegmentIndex,
          toSegmentIndex: link.toSegmentIndex,
          sameLayerSegmentDelta: link.sameLayerSegmentDelta,
          crossLayerBlockSlot: link.crossLayerBlockSlot,
          voidBandInnerOuterCrossLayer: link.voidBandInnerOuterCrossLayer,
        },
      );
      nextState = { ...nextState, links: [...nextState.links, createdLink] };
    });
    state = nextState;
    setEntitySelectionSet(new Set(Array.from(idMap.values())));
    persist();
    renderCanvas();
    renderInspector();
  }

  function createCopiedGroupInPlace(sourceRootIds: string[]): Map<string, string> {
    const sourceSet = new Set(sourceRootIds);
    let nextState = state;
    const idMap = new Map<string, string>();
    sourceRootIds.forEach((srcId) => {
      const src = state.entities.find((e) => e.id === srcId);
      if (!src || isStaticOuterLeafEndpoint(src)) return;
      if (
        hasSameTypePlacementConflict(
          src.templateType,
          src.layer,
          src.segmentIndex,
          src.x,
          src.y,
          sourceSet,
        )
      ) {
        return;
      }
      const created = createEntityRoot(
        nextState,
        src.templateType,
        src.layer,
        src.segmentIndex,
        src.x,
        src.y,
      );
      nextState = { ...nextState, entities: [...nextState.entities, created] };
      nextState = updateEntitySettings(nextState, created.id, { ...src.settings });
      idMap.set(srcId, created.id);
    });
    state.links.forEach((link) => {
      if (!sourceSet.has(link.fromEntityId) || !sourceSet.has(link.toEntityId)) return;
      const fromId = idMap.get(link.fromEntityId);
      const toId = idMap.get(link.toEntityId);
      if (!fromId || !toId) return;
      const createdLink = createLinkRoot(
        nextState,
        fromId,
        link.fromPort,
        toId,
        link.toPort,
        {
          fromSegmentIndex: link.fromSegmentIndex,
          toSegmentIndex: link.toSegmentIndex,
          sameLayerSegmentDelta: link.sameLayerSegmentDelta,
          crossLayerBlockSlot: link.crossLayerBlockSlot,
          voidBandInnerOuterCrossLayer: link.voidBandInnerOuterCrossLayer,
        },
      );
      nextState = { ...nextState, links: [...nextState.links, createdLink] };
    });
    state = nextState;
    return idMap;
  }

  function currentEntitySelectionSet(): Set<string> {
    if (selectedEntityRootIds.size) return new Set(selectedEntityRootIds);
    if (selection?.kind === "entity") return new Set([selection.rootId]);
    return new Set<string>();
  }

  function applyEntitySelectionWithMode(
    ids: Set<string>,
    mode: "replace" | "add" | "remove",
  ): void {
    if (mode === "replace") {
      setEntitySelectionSet(ids);
      return;
    }
    const base = currentEntitySelectionSet();
    if (mode === "add") {
      ids.forEach((id) => base.add(id));
    } else {
      ids.forEach((id) => base.delete(id));
    }
    setEntitySelectionSet(base);
  }

  function selectedEntityIdsForAction(primaryRootId: string): string[] {
    if (selectedEntityRootIds.has(primaryRootId)) {
      return Array.from(selectedEntityRootIds);
    }
    return [primaryRootId];
  }

  function templatePlacementInSection(
    templateType: BuilderTemplateType,
    section: { layer: BuilderLayer; segment: number; rect: DOMRect; widthPx: number; heightPx: number },
    clientX: number,
    clientY: number,
  ): DragPlacement {
    const rawX = (clientX - section.rect.left) / BUILDER_GRID_TILE_SIZE_X_PX;
    const rawY = (clientY - section.rect.top) / BUILDER_GRID_TILE_SIZE_Y_PX;
    const footprint = entityFootprintOffsets({
      id: "template-preview",
      groupId: "template-preview",
      templateType,
      layer: section.layer,
      segmentIndex: section.segment,
      x: 0,
      y: 0,
      settings: defaultSettings(templateType),
    });
    const maxX = Math.max(0, Math.floor(Math.max(1, section.widthPx) / BUILDER_GRID_TILE_SIZE_X_PX) - 1);
    const maxY = Math.max(0, Math.floor(Math.max(1, section.heightPx) / BUILDER_GRID_TILE_SIZE_Y_PX) - 1);
    const minAnchorX = -footprint.left;
    const minAnchorY = -footprint.top;
    const maxAnchorX = Math.max(minAnchorX, maxX - footprint.right);
    const maxAnchorY = Math.max(minAnchorY, maxY - footprint.bottom);
    return {
      layer: section.layer,
      segment: section.segment,
      x: Math.max(minAnchorX, Math.min(maxAnchorX, Math.floor(rawX))),
      y: Math.max(minAnchorY, Math.min(maxAnchorY, Math.floor(rawY))),
    };
  }

  function startTemplateDragFromSidebar(templateType: BuilderTemplateType, ev: MouseEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    let createdRootId: string | null = null;
    let lastPlacementKey = "";
    const floatingGhostEl = buildTemplateDragImage(templateType);
    floatingGhostEl.classList.toggle("builder-hide-property-labels", hideEntityPropertyLabels);
    document.body.appendChild(floatingGhostEl);

    const moveFloatingGhost = (clientX: number, clientY: number): void => {
      if (createdRootId) return;
      floatingGhostEl.style.left = `${clientX + 12}px`;
      floatingGhostEl.style.top = `${clientY + 12}px`;
    };

    const updateDraggedEntity = (clientX: number, clientY: number): void => {
      moveFloatingGhost(clientX, clientY);
      const section = segmentFromClientPoint(clientX, clientY);
      if (!section) return;
      const placement = templatePlacementInSection(templateType, section, clientX, clientY);
      const key = `${placement.layer}:${placement.segment}:${placement.x}:${placement.y}`;
      if (key === lastPlacementKey) return;
      if (hasSameTypePlacementConflict(
        templateType,
        placement.layer,
        placement.segment,
        placement.x,
        placement.y,
        createdRootId ? new Set([createdRootId]) : undefined,
      )) {
        return;
      }

      if (!createdRootId) {
        floatingGhostEl.remove();
        const rootEntity = createEntityRoot(
          state,
          templateType,
          placement.layer,
          placement.segment,
          placement.x,
          placement.y,
        );
        createdRootId = rootEntity.id;
        state = { ...state, entities: [...state.entities, rootEntity] };
        selection = { kind: "entity", rootId: rootEntity.id };
        selectedEntityRootIds.clear();
        lastPlacementKey = key;
        renderCanvas();
        renderInspector();
        return;
      }

      const current = state.entities.find((e) => e.id === createdRootId);
      if (!current) return;
      lastPlacementKey = key;
      if (current.layer !== placement.layer || current.segmentIndex !== placement.segment) {
        state = updateEntityPlacement(
          state,
          createdRootId,
          placement.layer,
          placement.segment,
          placement.x,
          placement.y,
        );
        renderCanvas();
      } else {
        state = updateEntityPosition(state, createdRootId, placement.x, placement.y);
        setEntityDomPosition(createdRootId, placement.x, placement.y);
      }
    };

    const onMove = (mv: MouseEvent): void => {
      updateDraggedEntity(mv.clientX, mv.clientY);
    };

    const onUp = (up: MouseEvent): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.removeProperty("cursor");
      floatingGhostEl.remove();
      if (!createdRootId) return;
      persist();
      renderCanvas();
      renderInspector();
      up.preventDefault();
    };

    document.body.style.cursor = "grabbing";
    updateDraggedEntity(ev.clientX, ev.clientY);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function renderTemplates(): void {
    templatesEl.innerHTML = templateList()
      .map(
        (type) =>
          `<div class="builder-template" data-template="${type}">${templateLabel(type)}</div>`,
      )
      .join("");
    templatesEl.querySelectorAll<HTMLElement>(".builder-template").forEach((el) => {
      el.addEventListener("mousedown", (ev) => {
        const templateType = el.dataset.template;
        if (!isBuilderTemplateType(templateType)) return;
        startTemplateDragFromSidebar(templateType, ev);
      });
    });
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

  function simRestingPortOffset(port: number): { x: number; y: number } {
    const a = (port % 4) * (Math.PI / 2);
    return { x: Math.cos(a) * 6, y: Math.sin(a) * 6 };
  }

  function simOccupancyByPacketId(
    occ: Array<{ port: PortRef; packet: Packet }>,
  ): Map<number, { port: PortRef; packet: Packet }> {
    const m = new Map<number, { port: PortRef; packet: Packet }>();
    for (const e of occ) {
      m.set(e.packet.id, e);
    }
    return m;
  }

  function builderPortCenterInOverlayCoords(
    ref: PortRef,
    cache?: Map<string, { x: number; y: number } | null>,
  ): { x: number; y: number } | null {
    const key = portKey(ref);
    if (cache?.has(key)) {
      return cache.get(key) ?? null;
    }
    const wrap = packetOverlayEl.parentElement;
    if (!wrap) {
      cache?.set(key, null);
      return null;
    }
    const el = resolveBuilderPortForWireOverlay(ref.deviceId, ref.port);
    if (!el) {
      cache?.set(key, null);
      return null;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const center = {
      x: r.left + r.width / 2 - wrapRect.left + wrap.scrollLeft,
      y: r.top + r.height / 2 - wrapRect.top + wrap.scrollTop,
    };
    cache?.set(key, center);
    return center;
  }

  type SimXY = { x: number; y: number };
  type SimPreparedPolyline = {
    points: SimXY[];
    segLens: number[];
    totalLen: number;
  };
  type SimPreparedPacketRender = {
    packetId: number;
    line: SimPreparedPolyline | null;
    fallback: SimXY;
    fill: string;
    stroke: string;
    x: number;
    y: number;
    selected: boolean;
  };

  function preparePolyline(points: SimXY[]): SimPreparedPolyline | null {
    if (points.length === 0) return null;
    if (points.length === 1) {
      return { points, segLens: [], totalLen: 0 };
    }
    const segLens: number[] = new Array(Math.max(0, points.length - 1));
    let totalLen = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const p = points[i]!;
      const q = points[i + 1]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      segLens[i] = len;
      totalLen += len;
    }
    return { points, segLens, totalLen };
  }

  function simPointOnPreparedPolylineAt(line: SimPreparedPolyline, t: number): SimXY | null {
    const pts = line.points;
    if (pts.length === 0) return null;
    if (pts.length === 1) {
      return pts[0] ?? null;
    }
    if (line.totalLen < 1e-6) {
      return pts[0] ?? null;
    }
    let d = t * line.totalLen;
    for (let i = 0; i < line.segLens.length; i += 1) {
      const L = line.segLens[i] ?? 0;
      if (d <= L) {
        const u = d / (L < 1e-9 ? 1 : L);
        const p0 = pts[i]!;
        const p1 = pts[i + 1]!;
        return { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u };
      }
      d -= L;
    }
    return pts[pts.length - 1] ?? null;
  }

  function packetRouteKey(from: PortRef, to: PortRef): string {
    return `${from.deviceId}:${from.port}>${to.deviceId}:${to.port}`;
  }

  function buildPacketRouteTemplate(from: PortRef, to: PortRef): PortRef[] | null {
    if (from.deviceId === to.deviceId && from.port === to.port) {
      return [{ ...from }];
    }
    if (Object.keys(builderSimDevices).length === 0) {
      return [{ ...from }, { ...to }];
    }
    const dFrom = builderSimDevices[from.deviceId];
    if (dFrom && dFrom.id !== to.deviceId) {
      if (dFrom.type === "hub") {
        const egress = getHubEgressPort(dFrom.rotation, from.port);
        const nbr = builderSimAdj.get(portKey({ deviceId: from.deviceId, port: egress }));
        if (nbr && nbr.deviceId === to.deviceId && nbr.port === to.port) {
          return [{ ...from }, { deviceId: from.deviceId, port: egress }, { ...to }];
        }
      } else if (dFrom.type === "relay") {
        const outPort: 0 | 1 = from.port === 0 ? 1 : 0;
        const nbr = builderSimAdj.get(portKey({ deviceId: from.deviceId, port: outPort }));
        if (nbr && nbr.deviceId === to.deviceId && nbr.port === to.port) {
          return [{ ...from }, { deviceId: from.deviceId, port: outPort }, { ...to }];
        }
      } else if (dFrom.type === "filter") {
        for (const outPort of [0, 1] as const) {
          const nbr = builderSimAdj.get(portKey({ deviceId: from.deviceId, port: outPort }));
          if (!nbr || nbr.deviceId !== to.deviceId || nbr.port !== to.port) continue;
          if (outPort === from.port) {
            return [{ ...from }, { ...to }];
          }
          return [{ ...from }, { deviceId: from.deviceId, port: outPort }, { ...to }];
        }
      }
    }
    return [{ ...from }, { ...to }];
  }

  function buildPacketAnimationPolylinePrepared(
    from: PortRef,
    to: PortRef,
    centerCache: Map<string, SimXY | null>,
  ): SimPreparedPolyline | null {
    const key = packetRouteKey(from, to);
    let template = packetRouteTemplateByKey.get(key);
    if (template === undefined) {
      template = buildPacketRouteTemplate(from, to);
      packetRouteTemplateByKey.set(key, template);
    }
    if (!template || template.length === 0) return null;
    const points: SimXY[] = [];
    for (const ref of template) {
      const c = builderPortCenterInOverlayCoords(ref, centerCache);
      if (!c) {
        return null;
      }
      points.push(c);
    }
    return preparePolyline(points);
  }

  function syncBuilderPacketOverlayDimensions(overlayWidth: number, overlayHeight: number): void {
    const w = Math.ceil(overlayWidth);
    const h = Math.ceil(overlayHeight);
    packetOverlayEl.setAttribute("width", String(w));
    packetOverlayEl.setAttribute("height", String(h));
    packetOverlayEl.style.width = `${w}px`;
    packetOverlayEl.style.height = `${h}px`;
  }

  function invalidateBuilderPacketRenderCache(): void {
    simPreparedPacketRenderDirty = true;
  }

  function clearBuilderPacketCirclePool(): void {
    packetOverlayEl.innerHTML = "";
    packetCircleGroupEl = null;
    packetCirclePool.length = 0;
    activePacketCircleCount = 0;
  }

  function ensureBuilderPacketCircleGroup(): SVGGElement {
    if (packetCircleGroupEl?.parentNode === packetOverlayEl) {
      return packetCircleGroupEl;
    }
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    packetOverlayEl.appendChild(group);
    packetCircleGroupEl = group;
    return group;
  }

  function ensureBuilderPacketCircle(index: number): SVGCircleElement {
    const existing = packetCirclePool[index];
    if (existing) {
      return existing;
    }
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "builder-packet-dot");
    ensureBuilderPacketCircleGroup().appendChild(circle);
    packetCirclePool[index] = circle;
    return circle;
  }

  function prepareBuilderPacketRenders(): number {
    const centerCache = new Map<string, SimXY | null>();
    const preparedRouteByKey = new Map<string, SimPreparedPolyline | null>();
    const prepared: SimPreparedPacketRender[] = [];
    let polylineMs = 0;

    for (const { port, packet } of simCurrentOccupancy) {
      const fromEntry = simPreviousOccupancyByPacketId.get(packet.id);
      const spawnId = builderEndpointIdByAddress.get(packet.src);
      const fromDeviceId = fromEntry?.port.deviceId ?? spawnId ?? port.deviceId;
      const fromPortNum = fromEntry?.port.port ?? 0;
      const fromRef: PortRef = { deviceId: fromDeviceId, port: fromPortNum };
      const toRef: PortRef = { ...port };
      const pa = builderPortCenterInOverlayCoords(fromRef, centerCache) ?? builderPortCenterInOverlayCoords(toRef, centerCache);
      const pb = builderPortCenterInOverlayCoords(toRef, centerCache);
      if (!pa || !pb) continue;

      const o = simRestingPortOffset(port.port);
      const fallback = { x: pa.x + o.x, y: pa.y + o.y };
      let line: SimPreparedPolyline | null = null;
      if (fromDeviceId !== port.deviceId || fromPortNum !== port.port) {
        const routeKey = packetRouteKey(fromRef, toRef);
        const tPoly0 = performance.now();
        line = preparedRouteByKey.get(routeKey);
        if (line === undefined) {
          line = buildPacketAnimationPolylinePrepared(fromRef, toRef, centerCache);
          preparedRouteByKey.set(routeKey, line);
        }
        polylineMs += performance.now() - tPoly0;
        if (!line || line.points.length < 2 || line.totalLen < 1) {
          line = null;
        }
      }

      const hue = (packet.id * 47) % 360;
      prepared.push({
        packetId: packet.id,
        line,
        fallback,
        fill: `hsl(${hue} 82% 58%)`,
        stroke: `hsl(${hue} 82% 38%)`,
        x: fallback.x,
        y: fallback.y,
        selected: false,
      });
    }

    simPreparedPacketRenders = prepared;
    simPreparedPacketRenderDirty = false;
    return polylineMs;
  }

  function renderBuilderPacketCircles(t: number): void {
    const t0 = performance.now();
    const wrap = packetOverlayEl.parentElement;
    if (!wrap) return;
    const tResize0 = performance.now();
    const contentWidth = Math.max(canvasEl.scrollWidth, canvasEl.clientWidth);
    const contentHeight = Math.max(canvasEl.scrollHeight, canvasEl.clientHeight);
    const overlayWidth = Math.max(wrap.clientWidth, contentWidth);
    const overlayHeight = Math.max(wrap.clientHeight, contentHeight);
    syncBuilderPacketOverlayDimensions(overlayWidth, overlayHeight);
    const tResize1 = performance.now();

    const dotR = 5;
    let polylineMs = 0;
    let interpolateMs = 0;
    const tCompute0 = performance.now();
    if (simPreparedPacketRenderDirty) {
      polylineMs = prepareBuilderPacketRenders();
    }
    for (const render of simPreparedPacketRenders) {
      let x = render.fallback.x;
      let y = render.fallback.y;
      if (render.line) {
        const tInterp0 = performance.now();
        const p = simPointOnPreparedPolylineAt(render.line, t);
        interpolateMs += performance.now() - tInterp0;
        if (p) {
          x = p.x;
          y = p.y;
        }
      }
      render.x = x;
      render.y = y;
      render.selected = selection?.kind === "packet" && selection.packetId === render.packetId;
    }
    const tCompute1 = performance.now();
    const tCommit0 = performance.now();
    if (simPreparedPacketRenders.length > 0) {
      ensureBuilderPacketCircleGroup();
    }
    for (let i = 0; i < simPreparedPacketRenders.length; i += 1) {
      const render = simPreparedPacketRenders[i]!;
      const circle = ensureBuilderPacketCircle(i);
      const selected = render.selected;
      circle.removeAttribute("display");
      circle.setAttribute("class", selected ? "builder-packet-dot builder-packet-dot--selected" : "builder-packet-dot");
      circle.setAttribute("cx", render.x.toFixed(2));
      circle.setAttribute("cy", render.y.toFixed(2));
      circle.setAttribute("r", String(selected ? 7 : dotR));
      circle.setAttribute("fill", render.fill);
      circle.setAttribute("stroke", selected ? "#f9e2af" : render.stroke);
      circle.setAttribute("stroke-width", String(selected ? 2.2 : 1.2));
      circle.setAttribute("data-packet-id", String(render.packetId));
    }
    for (let i = simPreparedPacketRenders.length; i < activePacketCircleCount; i += 1) {
      const circle = packetCirclePool[i];
      if (!circle) continue;
      circle.setAttribute("display", "none");
      circle.removeAttribute("data-packet-id");
    }
    activePacketCircleCount = simPreparedPacketRenders.length;
    const tCommit1 = performance.now();
    perfCounts.packetsInFlight = simCurrentOccupancy.length;
    recordPerf("packet.overlayResize", tResize1 - tResize0);
    recordPerf("packet.compute", tCompute1 - tCompute0);
    recordPerf("packet.polyline", polylineMs);
    recordPerf("packet.interpolate", interpolateMs);
    recordPerf("packet.domCommit", tCommit1 - tCommit0);
    recordPerf("packet.total", tCommit1 - t0);
    maybeRenderPerfPanel(tCommit1);
  }

  function setEntityDomPosition(rootId: string, x: number, y: number): void {
    const { left, top } = previewPositionCss(rootId, x, y);
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

  function setRelayAngleDom(rootId: string, angleDeg: number): void {
    const normalized = ((angleDeg % 360) + 360) % 360;
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity.builder-entity--relay[data-root-id="${rootId}"]`)
      .forEach((entityEl) => {
        entityEl.dataset.relayAngle = String(normalized);
      });
  }

  function snapPixelToGridX(pixelX: number): number {
    return Math.round(pixelX / BUILDER_GRID_TILE_SIZE_X_PX);
  }

  function snapPixelToGridY(pixelY: number): number {
    return Math.round(pixelY / BUILDER_GRID_TILE_SIZE_Y_PX);
  }

  function clampGridToSectionBounds(
    x: number,
    y: number,
    sectionWidthPx: number,
    sectionHeightPx: number,
  ): { x: number; y: number } {
    const maxX = Math.max(0, Math.floor(Math.max(1, sectionWidthPx) / BUILDER_GRID_TILE_SIZE_X_PX) - 1);
    const maxY = Math.max(0, Math.floor(Math.max(1, sectionHeightPx) / BUILDER_GRID_TILE_SIZE_Y_PX) - 1);
    return {
      x: Math.max(0, Math.min(maxX, x)),
      y: Math.max(0, Math.min(maxY, y)),
    };
  }

  function boxIntersectsHubTriangle(
    boxL: number,
    boxT: number,
    boxR: number,
    boxB: number,
    hubEl: HTMLElement,
    faceDeg: number,
    wrapRect: DOMRect,
    wrapScrollLeft: number,
    wrapScrollTop: number,
  ): boolean {
    const hubRect = hubEl.getBoundingClientRect();
    const hx1 = hubRect.left - wrapRect.left + wrapScrollLeft;
    const hy1 = hubRect.top - wrapRect.top + wrapScrollTop;
    const hx2 = hx1 + hubRect.width;
    const hy2 = hy1 + hubRect.height;
    const ix1 = Math.max(boxL, hx1);
    const iy1 = Math.max(boxT, hy1);
    const ix2 = Math.min(boxR, hx2);
    const iy2 = Math.min(boxB, hy2);
    if (ix2 < ix1 || iy2 < iy1) return false;
    const sampleXs = [ix1, (ix1 + ix2) / 2, ix2];
    const sampleYs = [iy1, (iy1 + iy2) / 2, iy2];
    for (const sx of sampleXs) {
      for (const sy of sampleYs) {
        const localX = sx - hx1;
        const localY = sy - hy1;
        const p = hubLocalToModel(localX, localY, faceDeg);
        if (hubPointInOrOnTri(p, HUB_LAYOUT.T, HUB_LAYOUT.L, HUB_LAYOUT.R)) {
          return true;
        }
        const d = Math.min(
          hubDistToSeg(p, HUB_LAYOUT.T, HUB_LAYOUT.L),
          hubDistToSeg(p, HUB_LAYOUT.L, HUB_LAYOUT.R),
          hubDistToSeg(p, HUB_LAYOUT.R, HUB_LAYOUT.T),
        );
        if (d <= HUB_LAYOUT.r) {
          return true;
        }
      }
    }
    return false;
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
    const contentWidth = Math.max(canvasEl.scrollWidth, canvasEl.clientWidth);
    const contentHeight = Math.max(canvasEl.scrollHeight, canvasEl.clientHeight);
    const overlayWidth = Math.max(wrap.clientWidth, contentWidth);
    const overlayHeight = Math.max(wrap.clientHeight, contentHeight);
    wireOverlayEl.setAttribute("width", String(Math.ceil(overlayWidth)));
    wireOverlayEl.setAttribute("height", String(Math.ceil(overlayHeight)));
    wireOverlayEl.style.width = `${Math.ceil(overlayWidth)}px`;
    wireOverlayEl.style.height = `${Math.ceil(overlayHeight)}px`;
    let lineMarkup = "";
    let resolveCost = 0;
    const tLine0 = performance.now();
    const lineEndpointsAtPortEdges = (
      x1: number,
      y1: number,
      r1: number,
      x2: number,
      y2: number,
      r2: number,
    ): { sx: number; sy: number; ex: number; ey: number } => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        return { sx: x1, sy: y1, ex: x2, ey: y2 };
      }
      const ux = dx / d;
      const uy = dy / d;
      const startInset = Math.min(r1, d * 0.45);
      const endInset = Math.min(r2, d * 0.45);
      return {
        sx: x1 + ux * startInset,
        sy: y1 + uy * startInset,
        ex: x2 - ux * endInset,
        ey: y2 - uy * endInset,
      };
    };
    for (const link of viewLinks) {
      const tr0 = performance.now();
      const from = resolveBuilderPortForWireOverlay(String(link.fromInstanceId), link.fromPort);
      const to = resolveBuilderPortForWireOverlay(String(link.toInstanceId), link.toPort);
      resolveCost += performance.now() - tr0;
      if (!from || !to) continue;
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const x1 = fromRect.left + fromRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y1 = fromRect.top + fromRect.height / 2 - wrapRect.top + wrap.scrollTop;
      const x2 = toRect.left + toRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y2 = toRect.top + toRect.height / 2 - wrapRect.top + wrap.scrollTop;
      const e = lineEndpointsAtPortEdges(x1, y1, fromRect.width / 2, x2, y2, toRect.width / 2);
      lineMarkup += `<line x1="${e.sx}" y1="${e.sy}" x2="${e.ex}" y2="${e.ey}" stroke="#f9e2af" stroke-opacity="0.9" stroke-width="1.5"></line>`;
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
        const y1 = fromRect.top + fromRect.height / 2 - wrapRect.top + wrap.scrollTop;
        const x2 = linkDrag.endClient.x - wrapRect.left + wrap.scrollLeft;
        const y2 = linkDrag.endClient.y - wrapRect.top + wrap.scrollTop;
        const e = lineEndpointsAtPortEdges(x1, y1, fromRect.width / 2, x2, y2, 0);
        lineMarkup += `<line x1="${e.sx}" y1="${e.sy}" x2="${e.ex}" y2="${e.ey}" class="builder-wire-drag" pointer-events="none"></line>`;
      }
    }
    wireOverlayEl.innerHTML = lineMarkup;
    invalidateBuilderPacketRenderCache();
    renderBuilderPacketCircles(simPacketProgress);
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
  let hoveredRelayEl: HTMLElement | null = null;

  const clearHubHover = (hub: HTMLElement | null): void => {
    if (!hub) return;
    hub.classList.remove("builder-hub--hover-move", "builder-hub--hover-rotate");
    hub.closest<HTMLElement>(".builder-entity--hub")?.classList.remove(
      "builder-hub--hover-move",
      "builder-hub--hover-rotate",
    );
  };

  const updateHubHoverFromPointer = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const hub =
      target.closest<HTMLElement>(".builder-hub") ??
      target.closest<HTMLElement>(".builder-entity--hub")?.querySelector<HTMLElement>(".builder-hub") ??
      null;
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
    const hubEntity = hub.closest<HTMLElement>(".builder-entity--hub");
    if (hubEntity) {
      hubEntity.classList.toggle("builder-hub--hover-move", mode === "move");
      hubEntity.classList.toggle("builder-hub--hover-rotate", mode === "rotate");
    }
  };

  const clearRelayHover = (relay: HTMLElement | null): void => {
    if (!relay) return;
    relay.classList.remove("builder-relay--hover-rotate");
  };

  const updateRelayHoverFromPointer = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target || target.closest("button")) {
      clearRelayHover(hoveredRelayEl);
      hoveredRelayEl = null;
      return;
    }
    const relay = target.closest<HTMLElement>(".builder-entity--relay");
    if (!relay) {
      clearRelayHover(hoveredRelayEl);
      hoveredRelayEl = null;
      return;
    }
    if (hoveredRelayEl && hoveredRelayEl !== relay) {
      clearRelayHover(hoveredRelayEl);
    }
    hoveredRelayEl = relay;
    const outerRect = relay.getBoundingClientRect();
    const coreEl = relay.querySelector<HTMLElement>(".builder-relay-core");
    if (!coreEl) {
      clearRelayHover(hoveredRelayEl);
      hoveredRelayEl = null;
      return;
    }
    const coreRect = coreEl.getBoundingClientRect();
    const localX = ev.clientX - outerRect.left;
    const localY = ev.clientY - outerRect.top;
    const mode = relayPointerMode(
      localX,
      localY,
      outerRect.width,
      outerRect.height,
      coreRect.left - outerRect.left,
      coreRect.top - outerRect.top,
      coreRect.width,
      coreRect.height,
    );
    relay.classList.toggle("builder-relay--hover-rotate", mode === "rotate");
  };

  const startEntityDragFromElement = (entityEl: HTMLElement, ev: MouseEvent): void => {
    const target = ev.target as HTMLElement;
    if (target.closest("button")) return;
    const rootId = entityEl.dataset.rootId!;
    const rootEnt = state.entities.find((e) => e.id === rootId);
    const seg = entityEl.closest<HTMLElement>(".builder-segment");
    if (!rootEnt || !seg) return;
    if (isStaticOuterLeafEndpoint(rootEnt)) return;
    let movingRootIds = selectedEntityIdsForAction(rootEnt.id)
      .filter((id) => {
        const e = state.entities.find((x) => x.id === id);
        return !!e && !isStaticOuterLeafEndpoint(e);
      });
    let rootDragId = rootEnt.id;
    if (rootEnt.templateType === "relay") {
      const relayRect = entityEl.getBoundingClientRect();
      const coreEl = entityEl.querySelector<HTMLElement>(".builder-relay-core");
      if (!coreEl) return;
      const coreRect = coreEl.getBoundingClientRect();
      const localX = ev.clientX - relayRect.left;
      const localY = ev.clientY - relayRect.top;
      const mode = relayPointerMode(
        localX,
        localY,
        relayRect.width,
        relayRect.height,
        coreRect.left - relayRect.left,
        coreRect.top - relayRect.top,
        coreRect.width,
        coreRect.height,
      );
      if (mode === "none") return;
      if (mode === "rotate") {
        ev.preventDefault();
        const rotatingRootIds = selectedEntityIdsForAction(rootEnt.id).filter((id) => {
          const e = state.entities.find((x) => x.id === id);
          return e?.templateType === "relay";
        });
        const baseById = new Map<string, number>();
        rotatingRootIds.forEach((id) => {
          const ent = state.entities.find((x) => x.id === id);
          const raw = Number.parseFloat(ent?.settings.angle ?? "0");
          const base = ((Number.isFinite(raw) ? raw : 0) % 360 + 360) % 360;
          baseById.set(id, base);
        });
        const cx = relayRect.left + relayRect.width / 2;
        const cy = relayRect.top + relayRect.height / 2;
        const a0 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        const onMove = (mv: MouseEvent): void => {
          const a1 = Math.atan2(mv.clientY - cy, mv.clientX - cx);
          const deltaDeg = ((a1 - a0) * 180) / Math.PI;
          let changed = false;
          rotatingRootIds.forEach((id) => {
            const cur = state.entities.find((e) => e.id === id);
            const base = baseById.get(id);
            if (!cur || base === undefined) return;
            let newDeg = base + deltaDeg;
            newDeg = ((newDeg % 360) + 360) % 360;
            newDeg = Math.round(newDeg / 90) * 90;
            newDeg = ((newDeg % 360) + 360) % 360;
            const curRaw = Number.parseFloat(cur.settings.angle ?? "0");
            const curDeg = ((Number.isFinite(curRaw) ? curRaw : 0) % 360 + 360) % 360;
            if (Math.abs(curDeg - newDeg) < 0.001) return;
            state = updateEntitySettings(state, cur.id, { ...cur.settings, angle: String(newDeg) });
            setRelayAngleDom(cur.id, newDeg);
            changed = true;
          });
          if (!changed) return;
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
    }
    if (rootEnt.templateType === "hub") {
      const hubEl = entityEl.querySelector<HTMLElement>(".builder-hub");
      if (!hubEl) return;
      const r0 = hubEl.getBoundingClientRect();
      const localX = ev.clientX - r0.left;
      const localY = ev.clientY - r0.top;
      const faceDeg = ((Number.parseFloat(rootEnt.settings.faceAngle ?? "0") % 360) + 360) % 360;
      const hubMode = hubPointerMode(localX, localY, faceDeg);
      if (hubMode === "none") return;
      if (!selectedEntityRootIds.has(rootEnt.id)) {
        setSelection({ kind: "entity", rootId: rootEnt.id });
      }
      ev.preventDefault();
      if (hubMode === "move") {
        if (ev.ctrlKey) {
          const idMap = createCopiedGroupInPlace(movingRootIds);
          const copiedIds = Array.from(idMap.values());
          if (!copiedIds.length) return;
          movingRootIds = copiedIds;
          rootDragId = idMap.get(rootEnt.id) ?? rootEnt.id;
          setEntitySelectionSet(new Set(movingRootIds));
          renderCanvas();
        }
        const rootDragEnt = state.entities.find((e) => e.id === rootDragId);
        if (!rootDragEnt) return;
        const initialPlacementById = new Map<string, { layer: BuilderLayer; segment: number; x: number; y: number }>();
        movingRootIds.forEach((id) => {
          const e = state.entities.find((x) => x.id === id);
          if (!e) return;
          initialPlacementById.set(id, { layer: e.layer, segment: e.segmentIndex, x: e.x, y: e.y });
        });
        const layerOrder = orderedLayersTopDown();
        const rootInitialLayerIdx = Math.max(0, layerOrder.indexOf(rootDragEnt.layer));
        const rootInitialSegment = rootDragEnt.segmentIndex;
        const boundsCache = new Map<string, { maxX: number; maxY: number }>();
        const boundsFor = (layer: BuilderLayer, segment: number): { maxX: number; maxY: number } => {
          const key = `${layer}:${segment}`;
          const cached = boundsCache.get(key);
          if (cached) return cached;
          const host = segmentEntitiesHost(layer, segment);
          const w = Math.max(1, host?.clientWidth ?? 1);
          const h = Math.max(1, host?.clientHeight ?? 1);
          const next = {
            maxX: Math.max(0, Math.floor(w / BUILDER_GRID_TILE_SIZE_X_PX) - 1),
            maxY: Math.max(0, Math.floor(h / BUILDER_GRID_TILE_SIZE_Y_PX) - 1),
          };
          boundsCache.set(key, next);
          return next;
        };
        const clampToRange = (value: number, min: number, max: number): number =>
          Math.max(min, Math.min(max, value));
        const buildGroupPlacements = (
          section: { layer: BuilderLayer; segment: number },
          primaryX: number,
          primaryY: number,
        ): Map<string, DragPlacement> => {
          const placements = new Map<string, DragPlacement>();
          const primaryInitial = initialPlacementById.get(rootDragEnt.id) ?? {
            layer: rootDragEnt.layer,
            segment: rootDragEnt.segmentIndex,
            x: rootDragEnt.x,
            y: rootDragEnt.y,
          };
          const rawLayerDelta = layerOrder.indexOf(section.layer) - rootInitialLayerIdx;
          let minLayerDelta = -Infinity;
          let maxLayerDelta = Infinity;
          movingRootIds.forEach((id) => {
            const p0 = initialPlacementById.get(id);
            if (!p0) return;
            const idx = layerOrder.indexOf(p0.layer);
            minLayerDelta = Math.max(minLayerDelta, -idx);
            maxLayerDelta = Math.min(maxLayerDelta, layerOrder.length - 1 - idx);
          });
          if (minLayerDelta > maxLayerDelta) {
            return placements;
          }
          const layerDelta = clampToRange(rawLayerDelta, minLayerDelta, maxLayerDelta);
          const targetById = new Map<string, { p0: { layer: BuilderLayer; segment: number; x: number; y: number }; layer: BuilderLayer; segment: number }>();
          let minSegmentDelta = -Infinity;
          let maxSegmentDelta = Infinity;
          movingRootIds.forEach((id) => {
            const p0 = initialPlacementById.get(id);
            if (!p0) return;
            const baseLayerIdx = layerOrder.indexOf(p0.layer);
            const targetLayer = layerOrder[baseLayerIdx + layerDelta]!;
            const layerMaxSegment = layerColumns(targetLayer).length - 1;
            minSegmentDelta = Math.max(minSegmentDelta, -p0.segment);
            maxSegmentDelta = Math.min(maxSegmentDelta, layerMaxSegment - p0.segment);
            targetById.set(id, { p0, layer: targetLayer, segment: p0.segment });
          });
          const rawSegmentDelta = section.segment - rootInitialSegment;
          const segmentDelta = clampToRange(rawSegmentDelta, minSegmentDelta, maxSegmentDelta);
          if (minSegmentDelta > maxSegmentDelta) {
            return placements;
          }
          let minDx = -Infinity;
          let maxDx = Infinity;
          let minDy = -Infinity;
          let maxDy = Infinity;
          targetById.forEach((t, id) => {
            const targetSegment = t.p0.segment + segmentDelta;
            t.segment = targetSegment;
            const b = boundsFor(t.layer, targetSegment);
            const ent = state.entities.find((e) => e.id === id);
            if (!ent) {
              minDx = Infinity;
              maxDx = -Infinity;
              minDy = Infinity;
              maxDy = -Infinity;
              return;
            }
            const fp = entityFootprintOffsets(ent);
            const minX = -fp.left;
            const maxX = b.maxX - fp.right;
            const minY = -fp.top;
            const maxY = b.maxY - fp.bottom;
            if (minX > maxX || minY > maxY) {
              minDx = Infinity;
              maxDx = -Infinity;
              minDy = Infinity;
              maxDy = -Infinity;
              return;
            }
            minDx = Math.max(minDx, minX - t.p0.x);
            maxDx = Math.min(maxDx, maxX - t.p0.x);
            minDy = Math.max(minDy, minY - t.p0.y);
            maxDy = Math.min(maxDy, maxY - t.p0.y);
          });
          if (minDx > maxDx || minDy > maxDy) {
            return placements;
          }
          const dxGrid = clampToRange(primaryX - primaryInitial.x, minDx, maxDx);
          const dyGrid = clampToRange(primaryY - primaryInitial.y, minDy, maxDy);
          targetById.forEach((t, id) => {
            placements.set(id, {
              layer: t.layer,
              segment: t.segment,
              x: t.p0.x + dxGrid,
              y: t.p0.y + dyGrid,
            });
          });
          return placements;
        };
        const initialSection = segmentFromClientPoint(ev.clientX, ev.clientY);
        const initialHost =
          initialSection?.host ?? segmentEntitiesHost(rootDragEnt.layer, rootDragEnt.segmentIndex) ?? seg;
        const initialRect = initialSection?.rect ?? initialHost.getBoundingClientRect();
        const anchorX = (ev.clientX - initialRect.left) / BUILDER_GRID_TILE_SIZE_X_PX - 0.5;
        const anchorY = (ev.clientY - initialRect.top) / BUILDER_GRID_TILE_SIZE_Y_PX - 0.5;
        const rx = rootDragEnt.x;
        const ry = rootDragEnt.y;
        const dx = anchorX - rx;
        const dy = anchorY - ry;
        let lastX = rx;
        let lastY = ry;
        let lastLayer = rootEnt.layer;
        let lastSegment = rootEnt.segmentIndex;
        const onMove = (mv: MouseEvent): void => {
          const hoveredSection = segmentFromClientPoint(mv.clientX, mv.clientY);
          if (!hoveredSection) return;
          const section = hoveredSection;
          const rawX = (mv.clientX - section.rect.left) / BUILDER_GRID_TILE_SIZE_X_PX - 0.5 - dx;
          const rawY = (mv.clientY - section.rect.top) / BUILDER_GRID_TILE_SIZE_Y_PX - 0.5 - dy;
          const clamped = clampGridToSectionBounds(
            Math.round(rawX),
            Math.round(rawY),
            section.widthPx,
            section.heightPx,
          );
          const x = clamped.x;
          const y = clamped.y;
          const placements = buildGroupPlacements(section, x, y);
          const rootPlacement = placements.get(rootDragEnt.id);
          if (!rootPlacement) return;
          if (hasPlacementMapConflicts(placements)) return;
          if (
            rootPlacement.x === lastX &&
            rootPlacement.y === lastY &&
            rootPlacement.layer === lastLayer &&
            rootPlacement.segment === lastSegment
          ) {
            return;
          }
          lastX = rootPlacement.x;
          lastY = rootPlacement.y;
          lastLayer = rootPlacement.layer;
          lastSegment = rootPlacement.segment;
          let shouldRerender = false;
          placements.forEach((nextPlacement, id) => {
            const p0 = initialPlacementById.get(id);
            if (!p0) return;
            const nx = nextPlacement.x;
            const ny = nextPlacement.y;
            const targetLayer = nextPlacement.layer;
            const targetSegment = nextPlacement.segment;
            const cur = state.entities.find((e) => e.id === id);
            if (!cur) return;
            if (cur.layer !== targetLayer || cur.segmentIndex !== targetSegment) {
              shouldRerender = true;
              state = updateEntityPlacement(state, id, targetLayer, targetSegment, nx, ny);
            } else {
              state = updateEntityPosition(state, id, nx, ny);
              setEntityDomPosition(id, nx, ny);
            }
          });
          if (shouldRerender) {
            renderCanvas();
          }
          showDragGroupBounds(movingRootIds);
          scheduleWireOverlayRender();
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (dragRenderRaf !== null) {
            window.cancelAnimationFrame(dragRenderRaf);
            dragRenderRaf = null;
          }
          hideDragGroupBounds();
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
      const rotatingRootIds = selectedEntityIdsForAction(rootEnt.id).filter((id) => {
        const e = state.entities.find((x) => x.id === id);
        return e?.templateType === "hub";
      });
      const baseById = new Map<string, number>();
      rotatingRootIds.forEach((id) => {
        const ent = state.entities.find((x) => x.id === id);
        const raw = Number.parseFloat(ent?.settings.faceAngle ?? "0");
        const base = ((Number.isFinite(raw) ? raw : 0) % 360 + 360) % 360;
        baseById.set(id, base);
      });
      const onMove = (mv: MouseEvent): void => {
        const a1 = Math.atan2(mv.clientY - py, mv.clientX - px);
        const deltaDeg = ((a1 - a0) * 180) / Math.PI;
        const SNAP_DEG = 30;
        let changed = false;
        rotatingRootIds.forEach((id) => {
          const cur = state.entities.find((e) => e.id === id);
          const base = baseById.get(id);
          if (!cur || base === undefined) return;
          let newDeg = base + deltaDeg;
          newDeg = ((newDeg % 360) + 360) % 360;
          newDeg = Math.round(newDeg / SNAP_DEG) * SNAP_DEG;
          newDeg = ((newDeg % 360) + 360) % 360;
          const curDegRaw = Number.parseFloat(cur.settings.faceAngle ?? "0");
          const curDeg = ((Number.isFinite(curDegRaw) ? curDegRaw : 0) % 360 + 360) % 360;
          if (Math.abs(curDeg - newDeg) < 0.001) return;
          state = updateEntitySettings(state, cur.id, { ...cur.settings, faceAngle: String(newDeg) });
          setHubFaceAngleDom(cur.id, newDeg);
          changed = true;
        });
        if (!changed) return;
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
    const entitiesHost =
      seg.querySelector<HTMLElement>(".builder-segment-entities") ?? seg;
    const segRect = entitiesHost.getBoundingClientRect();
    const anchorX = (ev.clientX - segRect.left) / BUILDER_GRID_TILE_SIZE_X_PX;
    const anchorY = (ev.clientY - segRect.top) / BUILDER_GRID_TILE_SIZE_Y_PX;
    if (ev.ctrlKey) {
      const idMap = createCopiedGroupInPlace(movingRootIds);
      const copiedIds = Array.from(idMap.values());
      if (!copiedIds.length) return;
      movingRootIds = copiedIds;
      rootDragId = idMap.get(rootEnt.id) ?? rootEnt.id;
      setEntitySelectionSet(new Set(movingRootIds));
      renderCanvas();
    }
    const rootDragEnt = state.entities.find((e) => e.id === rootDragId);
    if (!rootDragEnt) return;
    const initialPlacementById = new Map<string, { layer: BuilderLayer; segment: number; x: number; y: number }>();
    movingRootIds.forEach((id) => {
      const e = state.entities.find((x) => x.id === id);
      if (!e) return;
      initialPlacementById.set(id, { layer: e.layer, segment: e.segmentIndex, x: e.x, y: e.y });
    });
    const layerOrder = orderedLayersTopDown();
    const rootInitialLayerIdx = Math.max(0, layerOrder.indexOf(rootDragEnt.layer));
    const rootInitialSegment = rootDragEnt.segmentIndex;
    const boundsCache = new Map<string, { maxX: number; maxY: number }>();
    const boundsFor = (layer: BuilderLayer, segment: number): { maxX: number; maxY: number } => {
      const key = `${layer}:${segment}`;
      const cached = boundsCache.get(key);
      if (cached) return cached;
      const host = segmentEntitiesHost(layer, segment);
      const w = Math.max(1, host?.clientWidth ?? 1);
      const h = Math.max(1, host?.clientHeight ?? 1);
      const next = {
        maxX: Math.max(0, Math.floor(w / BUILDER_GRID_TILE_SIZE_X_PX) - 1),
        maxY: Math.max(0, Math.floor(h / BUILDER_GRID_TILE_SIZE_Y_PX) - 1),
      };
      boundsCache.set(key, next);
      return next;
    };
    const clampToRange = (value: number, min: number, max: number): number =>
      Math.max(min, Math.min(max, value));
    const buildGroupPlacements = (
      section: { layer: BuilderLayer; segment: number },
      primaryX: number,
      primaryY: number,
    ): Map<string, DragPlacement> => {
      const placements = new Map<string, DragPlacement>();
      const primaryInitial = initialPlacementById.get(rootDragEnt.id) ?? {
        layer: rootDragEnt.layer,
        segment: rootDragEnt.segmentIndex,
        x: rootDragEnt.x,
        y: rootDragEnt.y,
      };
      const rawLayerDelta = layerOrder.indexOf(section.layer) - rootInitialLayerIdx;
      let minLayerDelta = -Infinity;
      let maxLayerDelta = Infinity;
      movingRootIds.forEach((id) => {
        const p0 = initialPlacementById.get(id);
        if (!p0) return;
        const idx = layerOrder.indexOf(p0.layer);
        minLayerDelta = Math.max(minLayerDelta, -idx);
        maxLayerDelta = Math.min(maxLayerDelta, layerOrder.length - 1 - idx);
      });
      if (minLayerDelta > maxLayerDelta) {
        return placements;
      }
      const layerDelta = clampToRange(rawLayerDelta, minLayerDelta, maxLayerDelta);
      const targetById = new Map<string, { p0: { layer: BuilderLayer; segment: number; x: number; y: number }; layer: BuilderLayer; segment: number }>();
      let minSegmentDelta = -Infinity;
      let maxSegmentDelta = Infinity;
      movingRootIds.forEach((id) => {
        const p0 = initialPlacementById.get(id);
        if (!p0) return;
        const baseLayerIdx = layerOrder.indexOf(p0.layer);
        const targetLayer = layerOrder[baseLayerIdx + layerDelta]!;
        const layerMaxSegment = layerColumns(targetLayer).length - 1;
        minSegmentDelta = Math.max(minSegmentDelta, -p0.segment);
        maxSegmentDelta = Math.min(maxSegmentDelta, layerMaxSegment - p0.segment);
        targetById.set(id, { p0, layer: targetLayer, segment: p0.segment });
      });
      const rawSegmentDelta = section.segment - rootInitialSegment;
      const segmentDelta = clampToRange(rawSegmentDelta, minSegmentDelta, maxSegmentDelta);
      if (minSegmentDelta > maxSegmentDelta) {
        return placements;
      }
      let minDx = -Infinity;
      let maxDx = Infinity;
      let minDy = -Infinity;
      let maxDy = Infinity;
      targetById.forEach((t, id) => {
        const targetSegment = t.p0.segment + segmentDelta;
        t.segment = targetSegment;
        const b = boundsFor(t.layer, targetSegment);
        const ent = state.entities.find((e) => e.id === id);
        if (!ent) {
          minDx = Infinity;
          maxDx = -Infinity;
          minDy = Infinity;
          maxDy = -Infinity;
          return;
        }
        const fp = entityFootprintOffsets(ent);
        const minX = -fp.left;
        const maxX = b.maxX - fp.right;
        const minY = -fp.top;
        const maxY = b.maxY - fp.bottom;
        if (minX > maxX || minY > maxY) {
          minDx = Infinity;
          maxDx = -Infinity;
          minDy = Infinity;
          maxDy = -Infinity;
          return;
        }
        minDx = Math.max(minDx, minX - t.p0.x);
        maxDx = Math.min(maxDx, maxX - t.p0.x);
        minDy = Math.max(minDy, minY - t.p0.y);
        maxDy = Math.min(maxDy, maxY - t.p0.y);
      });
      if (minDx > maxDx || minDy > maxDy) {
        return placements;
      }
      const dxGrid = clampToRange(primaryX - primaryInitial.x, minDx, maxDx);
      const dyGrid = clampToRange(primaryY - primaryInitial.y, minDy, maxDy);
      targetById.forEach((t, id) => {
        placements.set(id, {
          layer: t.layer,
          segment: t.segment,
          x: t.p0.x + dxGrid,
          y: t.p0.y + dyGrid,
        });
      });
      return placements;
    };
    const dx = anchorX - rootDragEnt.x;
    const dy = anchorY - rootDragEnt.y;
    let lastX = rootDragEnt.x;
    let lastY = rootDragEnt.y;
    let lastLayer = rootDragEnt.layer;
    let lastSegment = rootDragEnt.segmentIndex;
    const onMove = (mv: MouseEvent): void => {
      const hoveredSection = segmentFromClientPoint(mv.clientX, mv.clientY);
      if (!hoveredSection) return;
      const section = hoveredSection;
      const rawX = (mv.clientX - section.rect.left) / BUILDER_GRID_TILE_SIZE_X_PX - dx;
      const rawY = (mv.clientY - section.rect.top) / BUILDER_GRID_TILE_SIZE_Y_PX - dy;
      const clamped = clampGridToSectionBounds(
        Math.round(rawX),
        Math.round(rawY),
        section.widthPx,
        section.heightPx,
      );
      const x = clamped.x;
      const y = clamped.y;
      const placements = buildGroupPlacements(section, x, y);
      const rootPlacement = placements.get(rootDragEnt.id);
      if (!rootPlacement) return;
      if (hasPlacementMapConflicts(placements)) return;
      if (
        rootPlacement.x === lastX &&
        rootPlacement.y === lastY &&
        rootPlacement.layer === lastLayer &&
        rootPlacement.segment === lastSegment
      ) {
        return;
      }
      lastX = rootPlacement.x;
      lastY = rootPlacement.y;
      lastLayer = rootPlacement.layer;
      lastSegment = rootPlacement.segment;
      let shouldRerender = false;
      placements.forEach((nextPlacement, id) => {
        const p0 = initialPlacementById.get(id);
        if (!p0) return;
        const nx = nextPlacement.x;
        const ny = nextPlacement.y;
        const targetLayer = nextPlacement.layer;
        const targetSegment = nextPlacement.segment;
        const cur = state.entities.find((e) => e.id === id);
        if (!cur) return;
        if (cur.layer !== targetLayer || cur.segmentIndex !== targetSegment) {
          shouldRerender = true;
          state = updateEntityPlacement(state, id, targetLayer, targetSegment, nx, ny);
        } else {
          state = updateEntityPosition(state, id, nx, ny);
          setEntityDomPosition(id, nx, ny);
        }
      });
      if (shouldRerender) {
        renderCanvas();
      }
      showDragGroupBounds(movingRootIds);
      scheduleWireOverlayRender();
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragRenderRaf !== null) {
        window.cancelAnimationFrame(dragRenderRaf);
        dragRenderRaf = null;
      }
      hideDragGroupBounds();
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
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      const toPort =
        stack
          .map((node) => node.closest<HTMLButtonElement>(".builder-port"))
          .find((port): port is HTMLButtonElement => port !== null) ?? null;
      linkDrag = null;
      renderWireOverlay();
      if (!toPort) {
        const fromInst = parseBuilderInstanceId(from.instanceId);
        if (!fromInst || fromInst.rootId !== from.rootId) return;
        const next = removeLinksTouchingInstancePort(state, fromInst.rootId, fromInst.segmentIndex, from.port);
        if (next !== state) {
          state = next;
          persist();
          {
            const sel = selection;
            if (sel && sel.kind === "link" && !state.links.some((l) => l.id === sel.rootId)) {
              selection = null;
              renderInspector();
            }
          }
          renderCanvas();
        }
        return;
      }
      const toRootId = toPort.dataset.rootId;
      const toP = Number(toPort.dataset.port);
      const toInstanceRaw = toPort.dataset.instanceId ?? "";
      if (!toRootId) return;
      if (toInstanceRaw && toInstanceRaw === from.instanceId) return;
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
          <section class="builder-layer builder-layer-section-${layer}">
            <div class="builder-layer-grid builder-layer-${layer}" data-layer="${layer}">
              ${columns
                .map((segment) => {
                  const isOuterVoid = layer === "outer64" && segment === "void-12-15";
                  const key = isOuterVoid
                    ? OUTER_CANVAS_VOID_MERGE_KEY
                    : `${layer}:${segment as number}`;
                  const entities = entitiesByLayerSegment.get(key) ?? [];
                  return `
                    <div class="builder-segment ${
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
                            const relayAngleDeg =
                              ((Number.parseFloat(entity.settings.angle ?? "0") % 360) + 360) % 360;
                            const hubOriginX = (HUB_LAYOUT.G.x / HUB_VIEW.w) * 100;
                            const hubOriginY = (HUB_LAYOUT.G.y / HUB_VIEW.h) * 100;
                            const hubBlock =
                              entity.templateType === "hub"
                                ? `<div class="builder-hub" data-face-angle="${hubFaceDeg}" style="--hub-w:${HUB_VIEW.w}px;--hub-h:${HUB_VIEW.h}px;--hub-reverse-size:${HUB_REVERSE_BUTTON_SIZE}px;--hub-reverse-icon-size:${HUB_REVERSE_ICON_SIZE}px;">
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
                                : entity.templateType === "relay"
                                  ? " builder-entity--relay"
                                : entity.templateType === "hub"
                                  ? " builder-entity--hub"
                                  : "";
                            const settingsBlock =
                              entity.templateType === "relay" ||
                              entity.templateType === "filter" ||
                              entity.templateType === "hub" ||
                              isOuterStatic ||
                              settingsText.length === 0
                                ? ""
                                : `<div class="builder-entity-settings">${settingsText}</div>`;
                            const portBtn = (port: number): string =>
                              `<button class="builder-port" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="${port}" type="button">${port}</button>`;
                            const portsRow = isOuterStatic
                              ? `<div class="builder-ports builder-ports--filter-bottom builder-ports--endpoint-bottom">${portBtn(0)}</div>`
                              : entity.templateType === "filter"
                                ? `<div class="builder-ports builder-ports--filter-bottom">${portBtn(1)}</div>`
                                : entity.templateType === "relay"
                                  ? ""
                                : entity.templateType === "hub"
                                  ? ""
                                  : `<div class="builder-ports">${entity.ports.map((p) => portBtn(p)).join("")}</div>`;
                            return `
                              <div
                                class="builder-entity ${selected}${entityShapeClass}"
                                data-instance-id="${entity.instanceId}"
                                data-root-id="${entity.rootId}"
                                data-static-endpoint="${isOuterStatic ? "1" : "0"}"
                                data-relay-angle="${entity.templateType === "relay" ? String(relayAngleDeg) : ""}"
                                style="left:${
                                  entity.templateType === "hub"
                                    ? `calc((${entity.x} + 0.5) * var(--builder-grid-step-x) - ${HUB_LAYOUT.G.x.toFixed(3)}px)`
                                    : `calc(${entity.x} * var(--builder-grid-step-x))`
                                };top:${
                                  entity.templateType === "hub"
                                    ? `calc((${entity.y} + 0.5) * var(--builder-grid-step-y) - ${HUB_LAYOUT.G.y.toFixed(3)}px)`
                                    : `calc(${entity.y} * var(--builder-grid-step-y))`
                                }"
                              >
                                ${
                                  entity.templateType === "filter"
                                    ? `<div class="builder-ports builder-ports--filter-top">${portBtn(0)}</div>`
                                    : ""
                                }
                                ${
                                  entity.templateType === "hub" || isOuterStatic
                                    ? ""
                                    : entity.templateType === "relay"
                                      ? ""
                                    : `<div class="builder-entity-title">${entity.templateType}</div>`
                                }
                                ${settingsBlock}
                                ${filterControls}
                                ${endpointAddressBlock}
                                ${hubBlock}
                                ${
                                  entity.templateType === "relay"
                                    ? `<div class="builder-relay-core">
                                        <div class="builder-relay-port-dock builder-relay-port-a">${portBtn(0)}</div>
                                        <div class="builder-relay-port-dock builder-relay-port-b">${portBtn(1)}</div>
                                      </div>`
                                    : ""
                                }
                                ${portsRow}
                              </div>
                            `;
                          })
                          .join("")}
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
    applySelectionToCanvas();

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
      const lSel = selection;
      const link = state.links.find((l) => l.id === lSel.rootId);
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
      const byEntityId = new Map(state.entities.map((e) => [e.id, e]));
      let slottedScopeExtra = "";
      if (isCrossLayerSlot) {
        if (linkTreatedAsInnerOuterVoidBand(link, byEntityId)) {
          slottedScopeExtra = " — to/from outer 0.0.3. void; does not displace other slotted cross-layer";
        } else if (linkTreatedAsSlottedInnerMiddle(link, byEntityId)) {
          slottedScopeExtra = " — inner↔middle (per 0.0.n. block lane); does not displace other lanes, or inner↔outer";
        }
      }
      const scopeNote = isSameRootPin
        ? `<div class="kv"><span>Scope</span><strong>Same device: mirrors port ${link.fromPort} → port ${link.toPort} with toSeg = fromSeg + ${sameRootDelta}</strong></div>`
        : isSameLayerTwoRoots
          ? `<div class="kv"><span>Scope</span><strong>Same layer: each mirror uses toSeg = fromSeg + ${link.sameLayerSegmentDelta}</strong></div>`
          : isCrossLayerSlot
            ? `<div class="kv"><span>Scope</span><strong>Cross-layer: one fine column per coarse segment (lane ${
                link.crossLayerBlockSlot
              } in each block)${slottedScopeExtra}</strong></div>`
            : `<div class="kv"><span>Scope</span><strong>Cross-layer (legacy): one wire per base column (64)</strong></div>`;
      inspectorEl.innerHTML = `
        <div class="kv"><span>Type</span><strong>Link</strong></div>
        <div class="kv"><span>From</span><strong>${fromText} port ${link.fromPort}</strong></div>
        <div class="kv"><span>To</span><strong>${toText} port ${link.toPort}</strong></div>
        ${scopeNote}
      `;
      return;
    }
    if (selection.kind === "packet") {
      const pSel = selection;
      const inFlight = simCurrentOccupancy.find((e) => e.packet.id === pSel.packetId);
      if (!inFlight) {
        selection = null;
        renderInspector();
        renderWireOverlay();
        return;
      }
      const p = inFlight.packet;
      const { deviceId, port } = inFlight.port;
      inspectorEl.innerHTML = `
        <div class="kv"><span>Type</span><strong>Packet</strong></div>
        <div class="kv"><span>Id</span><strong>${p.id}</strong></div>
        <div class="kv"><span>At device</span><strong>${deviceId}</strong></div>
        <div class="kv"><span>At port</span><strong>${port}</strong></div>
        <div class="kv"><span>Source</span><strong>${p.src}</strong></div>
        <div class="kv"><span>Destination</span><strong>${p.dest}</strong></div>
        <div class="kv"><span>TTL</span><strong>${p.ttl === undefined ? "inf" : String(p.ttl)}</strong></div>
        <div class="kv"><span>Sensitive</span><strong>${p.sensitive ? "yes" : "no"}</strong></div>
        <div class="kv"><span>Subject</span><strong>${p.subject ?? "—"}</strong></div>
        <div class="kv"><span>Sim tick</span><strong>${simStats.tick}</strong></div>
      `;
      return;
    }
    if (selection.kind !== "entity") {
      inspectorEl.textContent = "Unknown selection.";
      return;
    }
    const eSel = selection;
    const entity = state.entities.find((e) => e.id === eSel.rootId);
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
      ${
        entries.length
          ? `<div class="builder-settings">
        ${entries
          .map(
            ([k, v]) =>
              `<label class="builder-setting"><span>${k}</span><input data-setting-key="${k}" type="text" value="${v}" /></label>`,
          )
          .join("")}
      </div>`
          : ""
      }
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
    if (selection.kind === "packet") {
      selection = null;
      linkDrag = null;
      renderInspector();
      applySelectionToCanvas();
      renderWireOverlay();
      return;
    }
    if (selection.kind === "entity" || selectedEntityRootIds.size) {
      const ids = selectedEntityRootIds.size
        ? Array.from(selectedEntityRootIds)
        : selection.kind === "entity"
          ? [selection.rootId]
          : [];
      ids.forEach((id) => {
        const ent = state.entities.find((e) => e.id === id);
        if (ent && !isStaticOuterLeafEndpoint(ent)) {
          state = removeEntityGroup(state, id);
        }
      });
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

  togglePropLabelsBtn.addEventListener("click", () => {
    hideEntityPropertyLabels = !hideEntityPropertyLabels;
    applyPropertyLabelVisibility();
    persistHidePropertyLabels();
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
    const rebuiltImportedState = rebuildStateWithOuterLeafEndpoints(parsed);
    state = sanitizeDuplicateTypePlacements(rebuiltImportedState).state;
    persist();
    selection = null;
    renderInspector();
    renderCanvas();
  });

  packetOverlayEl.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const el = t.closest("circle.builder-packet-dot");
    if (!el) return;
    const idRaw = el.getAttribute("data-packet-id");
    if (idRaw === null) return;
    const packetId = Number(idRaw);
    if (!Number.isFinite(packetId)) return;
    ev.stopPropagation();
    setSelection({ kind: "packet", packetId });
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
      const targetIds = selectedEntityRootIds.has(rootId)
        ? Array.from(selectedEntityRootIds).filter((id) => state.entities.find((e) => e.id === id)?.templateType === "hub")
        : [rootId];
      targetIds.forEach((id) => {
        const ent = state.entities.find((e) => e.id === id);
        if (!ent || ent.templateType !== "hub") return;
        const next =
          (ent.settings.rotation ?? "clockwise") === "counterclockwise" ? "clockwise" : "counterclockwise";
        state = updateEntitySettings(state, ent.id, { ...ent.settings, rotation: next });
      });
      persist();
      renderCanvas();
      applySelectionToCanvas();
      renderInspector();
      return;
    }

    const entityEl = target.closest<HTMLElement>(".builder-entity");
    if (entityEl) {
      const rootId = entityEl.dataset.rootId!;
      if (suppressNextEntityClickToggle) {
        suppressNextEntityClickToggle = false;
        return;
      }
      const rootEnt = state.entities.find((e) => e.id === rootId);
      if (ev.shiftKey) {
        const next = currentEntitySelectionSet();
        if (next.has(rootId)) next.delete(rootId);
        else next.add(rootId);
        setEntitySelectionSet(next);
        return;
      }
      if (rootEnt?.templateType === "hub") {
        return;
      }
      setSelection({ kind: "entity", rootId });
    }
  });

  canvasEl.addEventListener("pointerdown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const directPort = target.closest<HTMLButtonElement>(".builder-port");
    const stackedPort =
      document
        .elementsFromPoint(ev.clientX, ev.clientY)
        .map((node) => node.closest<HTMLButtonElement>(".builder-port"))
        .find((port): port is HTMLButtonElement => port !== null) ?? null;
    const portEl = directPort ?? stackedPort;
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
    if (rootId && ev.shiftKey) {
      const next = currentEntitySelectionSet();
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      setEntitySelectionSet(next);
      suppressNextEntityClickToggle = true;
      return;
    }
    const rootEnt = rootId ? state.entities.find((e) => e.id === rootId) : null;
    const preserveMulti = !!rootId && selectedEntityRootIds.has(rootId);
    if (rootEnt?.templateType === "hub") {
      ev.stopImmediatePropagation();
      startEntityDragFromElement(entityEl, ev);
      return;
    }
    if (rootId && !preserveMulti && !ev.shiftKey && !ev.ctrlKey) {
      setSelection({ kind: "entity", rootId });
    }
    ev.stopImmediatePropagation();
    startEntityDragFromElement(entityEl, ev);
  });

  canvasEl.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (ev.button !== 0) return;
    if (target.closest("button")) return;
    const entityUnder = target.closest<HTMLElement>(".builder-entity");
    if (entityUnder) {
      const rootId = entityUnder.dataset.rootId;
      const rootEnt = rootId ? state.entities.find((e) => e.id === rootId) : null;
      if (rootEnt?.templateType !== "hub") return;
      const hubEl = entityUnder.querySelector<HTMLElement>(".builder-hub");
      if (!hubEl) return;
      const hubRect = hubEl.getBoundingClientRect();
      const localX = ev.clientX - hubRect.left;
      const localY = ev.clientY - hubRect.top;
      const faceRaw = Number.parseFloat(hubEl.dataset.faceAngle ?? rootEnt.settings.faceAngle ?? "0");
      const faceDeg = ((Number.isFinite(faceRaw) ? faceRaw : 0) % 360 + 360) % 360;
      const mode = hubPointerMode(localX, localY, faceDeg);
      if (mode !== "none") return;
    }
    if (!canvasWrapEl) return;
    const wrapRect = canvasWrapEl.getBoundingClientRect();
    const startX = ev.clientX - wrapRect.left + canvasWrapEl.scrollLeft;
    const startY = ev.clientY - wrapRect.top + canvasWrapEl.scrollTop;
    const mode: "replace" | "add" | "remove" = ev.ctrlKey ? "remove" : ev.shiftKey ? "add" : "replace";
    boxSelection = { startX, startY, currentX: startX, currentY: startY, mode };
    boxEl.style.display = "block";
    const clearBoxPreview = (): void => {
      canvasEl.querySelectorAll<HTMLElement>(".builder-entity.box-preview").forEach((el) => {
        el.classList.remove("box-preview");
      });
    };
    const collectBoxSelectionIds = (l: number, t: number, r: number, b: number): Set<string> => {
      const ids = new Set<string>();
      canvasEl.querySelectorAll<HTMLElement>(".builder-entity[data-root-id]").forEach((el) => {
        const id = el.dataset.rootId;
        if (!id) return;
        const ent = state.entities.find((e) => e.id === id);
        if (!ent || isStaticOuterLeafEndpoint(ent)) return;
        if (ent.templateType === "hub") {
          const hubEl = el.querySelector<HTMLElement>(".builder-hub");
          if (!hubEl) return;
          const faceRaw = Number.parseFloat(hubEl.dataset.faceAngle ?? ent.settings.faceAngle ?? "0");
          const faceDeg = ((Number.isFinite(faceRaw) ? faceRaw : 0) % 360 + 360) % 360;
          const hubHit = boxIntersectsHubTriangle(
            l,
            t,
            r,
            b,
            hubEl,
            faceDeg,
            wrapRect,
            canvasWrapEl.scrollLeft,
            canvasWrapEl.scrollTop,
          );
          if (hubHit) ids.add(id);
          return;
        }
        const relayCore =
          ent.templateType === "relay"
            ? el.querySelector<HTMLElement>(".builder-relay-core")
            : null;
        const rect = (relayCore ?? el).getBoundingClientRect();
        const ex1 = rect.left - wrapRect.left + canvasWrapEl.scrollLeft;
        const ey1 = rect.top - wrapRect.top + canvasWrapEl.scrollTop;
        const ex2 = ex1 + rect.width;
        const ey2 = ey1 + rect.height;
        const hit = ex1 <= r && ex2 >= l && ey1 <= b && ey2 >= t;
        if (hit) ids.add(id);
      });
      return ids;
    };
    const applyBoxPreview = (ids: Set<string>): void => {
      clearBoxPreview();
      ids.forEach((id) => {
        canvasEl
          .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${id}"]`)
          .forEach((el) => el.classList.add("box-preview"));
      });
    };
    const updateBox = (): void => {
      if (!boxSelection) return;
      const left = Math.min(boxSelection.startX, boxSelection.currentX);
      const top = Math.min(boxSelection.startY, boxSelection.currentY);
      const width = Math.abs(boxSelection.currentX - boxSelection.startX);
      const height = Math.abs(boxSelection.currentY - boxSelection.startY);
      boxEl.style.left = `${left}px`;
      boxEl.style.top = `${top}px`;
      boxEl.style.width = `${width}px`;
      boxEl.style.height = `${height}px`;
      applyBoxPreview(collectBoxSelectionIds(left, top, left + width, top + height));
    };
    updateBox();
    const onMove = (mv: MouseEvent): void => {
      if (!boxSelection) return;
      boxSelection.currentX = mv.clientX - wrapRect.left + canvasWrapEl.scrollLeft;
      boxSelection.currentY = mv.clientY - wrapRect.top + canvasWrapEl.scrollTop;
      updateBox();
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!boxSelection) return;
      const l = Math.min(boxSelection.startX, boxSelection.currentX);
      const t = Math.min(boxSelection.startY, boxSelection.currentY);
      const r = Math.max(boxSelection.startX, boxSelection.currentX);
      const b = Math.max(boxSelection.startY, boxSelection.currentY);
      const ids = collectBoxSelectionIds(l, t, r, b);
      applyEntitySelectionWithMode(ids, boxSelection.mode);
      clearBoxPreview();
      boxSelection = null;
      boxEl.style.display = "none";
      boxEl.style.width = "0px";
      boxEl.style.height = "0px";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  canvasEl.addEventListener("mousemove", (ev) => {
    updateHubHoverFromPointer(ev);
    updateRelayHoverFromPointer(ev);
  });
  canvasEl.addEventListener("mouseleave", () => {
    clearHubHover(hoveredHubEl);
    hoveredHubEl = null;
    clearRelayHover(hoveredRelayEl);
    hoveredRelayEl = null;
  });

  const wrap = wireOverlayEl.parentElement;
  if (wrap) {
    wrap.addEventListener("scroll", scheduleWireOverlayRender, { passive: true });
    const wrapResizeObserver = new ResizeObserver(() => {
      applyCanvasScale();
    });
    wrapResizeObserver.observe(wrap);
  }
  window.addEventListener("resize", scheduleWireOverlayRender);
  window.addEventListener("resize", applyCanvasScale);

  scaleXEl.addEventListener("input", () => {
    const parsed = Number(scaleXEl.value);
    canvasScale.x = canvasScaleXValueFromIndex(Number.isFinite(parsed) ? parsed : canvasScaleXIndexFromValue(1));
    applyCanvasScale();
  });
  scaleXEl.addEventListener("change", () => {
    persistCanvasScale();
    persist();
  });
  scaleYOuterEl.addEventListener("input", () => {
    const parsed = Number(scaleYOuterEl.value);
    canvasScale.yByLayer.outer64 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  scaleYMiddleEl.addEventListener("input", () => {
    const parsed = Number(scaleYMiddleEl.value);
    canvasScale.yByLayer.middle16 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  scaleYInnerEl.addEventListener("input", () => {
    const parsed = Number(scaleYInnerEl.value);
    canvasScale.yByLayer.inner4 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  scaleYCoreEl.addEventListener("input", () => {
    const parsed = Number(scaleYCoreEl.value);
    canvasScale.yByLayer.core1 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  const onChangeY = (): void => {
    persistCanvasScale();
    persist();
  };
  scaleYOuterEl.addEventListener("change", onChangeY);
  scaleYMiddleEl.addEventListener("change", onChangeY);
  scaleYInnerEl.addEventListener("change", onChangeY);
  scaleYCoreEl.addEventListener("change", onChangeY);

  simPlayBtn.addEventListener("click", () => setBuilderSimPlaying(true));
  simPauseBtn.addEventListener("click", () => setBuilderSimPlaying(false));
  simStepBtn.addEventListener("click", () => {
    if (!simPlaying) {
      runOneBuilderSimTick();
    }
  });
  simResetBtn.addEventListener("click", () => resetBuilderSimulation());

  const applyBuilderSimSpeedFromSlider = (): void => {
    simSpeedExponent = Number(simSpeedEl.value);
    if (!Number.isFinite(simSpeedExponent)) {
      simSpeedExponent = SPEED_EXP_DEFAULT;
    }
    simSpeed = speedMultiplierFromExponent(simSpeedExponent);
    simEmaAchievedSpeed = null;
    if (simPlaying && simAnimHandle !== null) {
      cancelAnimationFrame(simAnimHandle);
      simAnimHandle = null;
      simAnimating = false;
      runOneBuilderSimTick();
    }
    syncBuilderSimSliderLabels();
    updateBuilderSimMeta();
  };
  simSpeedEl.addEventListener("input", applyBuilderSimSpeedFromSlider);
  simSpeedEl.addEventListener("change", applyBuilderSimSpeedFromSlider);

  const applyBuilderSimSendRateFromSlider = (): void => {
    simSendRateExponent = Number(simSendRateEl.value);
    if (!Number.isFinite(simSendRateExponent)) {
      simSendRateExponent = SEND_RATE_EXP_DEFAULT;
    }
    if (builderSimulator) {
      builderSimulator.setSendRateMultiplier(sendRateMultiplierFromExponent(simSendRateExponent));
    }
    syncBuilderSimSliderLabels();
    updateBuilderSimMeta();
  };
  simSendRateEl.addEventListener("input", applyBuilderSimSendRateFromSlider);
  simSendRateEl.addEventListener("change", applyBuilderSimSendRateFromSlider);

  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Space") return;
    const bv = root.closest(".builder-view");
    if (!bv || bv.classList.contains("hidden")) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
    ev.preventDefault();
    setBuilderSimPlaying(!simPlaying);
  });

  renderTemplates();
  renderInspector();
  renderCanvas();
  applyCanvasScale();
  migrateLegacyNormalizedEntityPositionsToGrid();
  renderCanvas();
  applyPropertyLabelVisibility();
  requestAnimationFrame(() => {
    applyCanvasScale();
  });
  resetBuilderSimulation();
}
