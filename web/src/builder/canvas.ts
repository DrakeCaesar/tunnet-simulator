import {
  BuilderEntityRoot,
  BuilderLayer,
  BuilderTemplateType,
  createEntityRoot,
  createLinkRoot,
  createEmptyBuilderState,
  defaultSettings,
  removeEntityGroup,
  removeLinkGroup,
  updateEntityPosition,
  updateEntitySettings,
} from "./state";
import {
  expandBuilderState,
  expandLinksForBuilderCanvas,
  layerColumns,
  layerTitle,
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
}

function templateList(): BuilderTemplateType[] {
  return ["endpoint", "relay", "hub", "filter"];
}

function templateLabel(type: BuilderTemplateType): string {
  if (type === "endpoint") return "Endpoint";
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
  let state = loadBuilderState();
  if (!state || state.version !== 1) {
    state = createEmptyBuilderState();
  }

  let draggingTemplate: BuilderTemplateType | null = null;
  let dragLayer: BuilderLayer | null = null;
  let dragSegment: number | null = null;
  let selection: Selection = null;
  let linkMode = false;
  let pendingLinkSource: LinkSourceSelection | null = null;

  root.innerHTML = `
    <div class="builder-layout">
      <aside class="builder-sidebar card">
        <div class="section-title">Templates</div>
        <div id="builder-templates"></div>
        <div class="section-title builder-spacer">Actions</div>
        <div class="builder-actions">
          <button id="builder-link-mode" type="button">Link Mode: Off</button>
          <button id="builder-delete" type="button">Delete Selected</button>
          <button id="builder-export" type="button">Export Text</button>
          <button id="builder-import" type="button">Import Text</button>
          <button id="builder-preview" type="button">Preview In Viewer</button>
        </div>
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
  const linkModeBtn = root.querySelector<HTMLButtonElement>("#builder-link-mode")!;
  const deleteBtn = root.querySelector<HTMLButtonElement>("#builder-delete")!;
  const exportBtn = root.querySelector<HTMLButtonElement>("#builder-export")!;
  const importBtn = root.querySelector<HTMLButtonElement>("#builder-import")!;
  const previewBtn = root.querySelector<HTMLButtonElement>("#builder-preview")!;

  function persist(): void {
    saveBuilderState(state);
  }

  function setSelection(next: Selection): void {
    selection = next;
    pendingLinkSource = null;
    renderInspector();
    renderCanvas();
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
      expandBuilderState({ version: 1, entities: [previewRoot], links: [], nextId: 0 }).entities.map(
        (entity) => `${entity.layer}:${entity.segmentIndex}`,
      ),
    );
  }

  function renderWireOverlay(): void {
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    const viewLinks = expandLinksForBuilderCanvas(state.links, state.entities);
    const wrapRect = wrap.getBoundingClientRect();
    const overlayWidth = Math.max(wrap.clientWidth, wrap.scrollWidth);
    wireOverlayEl.setAttribute("width", String(Math.ceil(overlayWidth)));
    wireOverlayEl.setAttribute("height", String(Math.ceil(wrapRect.height)));
    wireOverlayEl.innerHTML = "";
    for (const link of viewLinks) {
      const from = canvasEl.querySelector<HTMLButtonElement>(
        `.builder-port[data-instance-id="${link.fromInstanceId}"][data-port="${link.fromPort}"]`,
      );
      const to = canvasEl.querySelector<HTMLButtonElement>(
        `.builder-port[data-instance-id="${link.toInstanceId}"][data-port="${link.toPort}"]`,
      );
      if (!from || !to) continue;
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const x1 = fromRect.left + fromRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y1 = fromRect.top + fromRect.height / 2 - wrapRect.top;
      const x2 = toRect.left + toRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y2 = toRect.top + toRect.height / 2 - wrapRect.top;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("stroke", link.isShadow ? "#6c768a" : "#f9e2af");
      line.setAttribute("stroke-opacity", link.isShadow ? "0.35" : "0.9");
      line.setAttribute("stroke-width", link.isShadow ? "1" : "1.5");
      wireOverlayEl.appendChild(line);
    }
  }

  function renderCanvas(): void {
    const expanded = expandBuilderState(state);
    const previewKeys = previewInstances();
    const entitiesByLayerSegment = new Map<string, typeof expanded.entities>();
    expanded.entities.forEach((entity) => {
      const key = `${entity.layer}:${entity.segmentIndex}`;
      if (!entitiesByLayerSegment.has(key)) entitiesByLayerSegment.set(key, []);
      entitiesByLayerSegment.get(key)!.push(entity);
    });

    canvasEl.innerHTML = orderedLayersTopDown()
      .map((layer) => {
        const columns = layerColumns(layer);
        return `
          <section class="builder-layer">
            <div class="builder-layer-title">${layerTitle(layer)}</div>
            <div class="builder-layer-grid builder-layer-${layer}" data-layer="${layer}">
              ${columns
                .map((segment) => {
                  const key = `${layer}:${segment}`;
                  const entities = entitiesByLayerSegment.get(key) ?? [];
                  const isDropTarget = dragLayer === layer && dragSegment === segment;
                  return `
                    <div class="builder-segment ${isDropTarget ? "drop-target" : ""}" data-layer="${layer}" data-segment="${segment}">
                      <div class="builder-segment-label">${segmentLabel(layer, segment)}</div>
                      <div class="builder-segment-entities">
                        ${entities
                          .map((entity) => {
                            const selected =
                              selection?.kind === "entity" && selection.rootId === entity.rootId ? "selected" : "";
                            const shadow = entity.isShadow ? "shadow" : "";
                            const linkSource =
                              pendingLinkSource && pendingLinkSource.rootId === entity.rootId
                                ? "link-source"
                                : "";
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
                            const entityShapeClass =
                              entity.templateType === "filter"
                                ? " builder-entity--filter"
                                : entity.templateType === "hub"
                                  ? " builder-entity--hub"
                                  : "";
                            const settingsBlock =
                              entity.templateType === "filter" || entity.templateType === "hub"
                                ? ""
                                : `<div class="builder-entity-settings">${settingsText}</div>`;
                            const portBtn = (port: number): string =>
                              `<button class="builder-port" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="${port}" type="button">${port}</button>`;
                            const portsRow =
                              entity.templateType === "filter"
                                ? `<div class="builder-ports builder-ports--filter-bottom">${portBtn(1)}</div>`
                                : entity.templateType === "hub"
                                  ? ""
                                  : `<div class="builder-ports">${entity.ports.map((p) => portBtn(p)).join("")}</div>`;
                            return `
                              <div
                                class="builder-entity ${selected} ${shadow} ${linkSource}${entityShapeClass}"
                                data-instance-id="${entity.instanceId}"
                                data-root-id="${entity.rootId}"
                                style="left:${entity.x * 100}%;top:${entity.y * 100}%"
                              >
                                ${
                                  entity.templateType === "filter"
                                    ? `<div class="builder-ports builder-ports--filter-top">${portBtn(0)}</div>`
                                    : ""
                                }
                                ${entity.templateType === "hub" ? "" : `<div class="builder-entity-title">${entity.templateType}</div>`}
                                ${settingsBlock}
                                ${filterControls}
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

    const setHoverFromEvent = (ev: DragEvent): void => {
      const target = ev.target as HTMLElement | null;
      const cell = target?.closest<HTMLElement>(".builder-segment");
      if (!cell) return;
      const nextLayer = cell.dataset.layer as BuilderLayer;
      const nextSegment = Number(cell.dataset.segment);
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
      const droppedTemplate =
        draggingTemplate ??
        ((ev.dataTransfer?.getData("text/plain") as BuilderTemplateType | "") || null);
      if (!droppedTemplate) return;
      const layer = cell.dataset.layer as BuilderLayer;
      const segment = Number(cell.dataset.segment);
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
    canvasEl.ondragenter = (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      setHoverFromEvent(ev);
    };
    canvasEl.ondragover = (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
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

    canvasEl.querySelectorAll<HTMLElement>(".builder-entity").forEach((entityEl) => {
      entityEl.addEventListener("click", () => {
        const rootId = entityEl.dataset.rootId!;
        setSelection({ kind: "entity", rootId });
      });
    });

    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-port").forEach((portEl) => {
      portEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!linkMode) return;
        const rootId = portEl.dataset.rootId!;
        const port = Number(portEl.dataset.port);
        if (!pendingLinkSource) {
          pendingLinkSource = { rootId, port };
          renderCanvas();
          return;
        }
        if (pendingLinkSource.rootId === rootId && pendingLinkSource.port === port) {
          pendingLinkSource = null;
          renderCanvas();
          return;
        }
        const fromRoot = state.entities.find((e) => e.id === pendingLinkSource!.rootId);
        const toRoot = state.entities.find((e) => e.id === rootId);
        if (!fromRoot || !toRoot) {
          pendingLinkSource = null;
          renderCanvas();
          return;
        }
        const link = createLinkRoot(state, fromRoot.id, pendingLinkSource.port, toRoot.id, port);
        state = { ...state, links: [...state.links, link] };
        persist();
        pendingLinkSource = null;
        setSelection({ kind: "link", rootId: link.id });
      });
    });

    const cycleValue = (value: string, options: string[], direction: "next" | "prev"): string => {
      const idx = options.indexOf(value);
      const safeIdx = idx >= 0 ? idx : 0;
      const delta = direction === "next" ? 1 : -1;
      return options[(safeIdx + delta + options.length) % options.length];
    };
    const setFilterSetting = (rootId: string, key: string, direction: "next" | "prev"): void => {
      const root = state.entities.find((e) => e.id === rootId);
      if (!root) return;
      const current = root.settings[key] ?? "";
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
      state = updateEntitySettings(state, root.id, { ...root.settings, [key]: next });
      persist();
      renderCanvas();
      renderInspector();
    };
    const updateMaskAt = (rootId: string, maskIdx: number, dir: "up" | "down"): void => {
      const root = state.entities.find((e) => e.id === rootId);
      if (!root) return;
      const parts = (root.settings.mask ?? "*.*.*.*").split(".");
      while (parts.length < 4) parts.push("*");
      for (let i = 0; i < 4; i++) parts[i] = parts[i] ?? "*";

      const raw = parts[maskIdx] ?? "*";
      let poolIdx = MASK_VALUE_CYCLE.indexOf(raw as (typeof MASK_VALUE_CYCLE)[number]);
      if (poolIdx < 0) poolIdx = 0;

      const n = MASK_VALUE_CYCLE.length;
      poolIdx = dir === "up" ? (poolIdx + 1) % n : (poolIdx + n - 1) % n;

      const nextParts: string[] = ["*", "*", "*", "*"];
      nextParts[maskIdx] = MASK_VALUE_CYCLE[poolIdx];
      state = updateEntitySettings(state, root.id, { ...root.settings, mask: nextParts.join(".") });
      persist();
      renderCanvas();
      renderInspector();
    };

    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-cycle-btn[data-setting-cycle]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rootId = btn.dataset.rootId;
        const key = btn.dataset.settingCycle;
        const direction = btn.dataset.dir === "prev" ? "prev" : "next";
        if (!rootId || !key) return;
        setFilterSetting(rootId, key, direction);
      });
    });
    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-mask-arrow").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rootId = btn.dataset.rootId;
        const rawIdx = btn.dataset.maskIdx;
        const dir = btn.dataset.maskDir === "down" ? "down" : "up";
        if (!rootId || rawIdx === undefined) return;
        updateMaskAt(rootId, Number(rawIdx), dir);
      });
    });

    canvasEl.querySelectorAll<HTMLButtonElement>("[data-hub-toggle-rotation]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rootId = btn.dataset.rootId;
        if (!rootId) return;
        const root = state.entities.find((e) => e.id === rootId);
        if (!root || root.templateType !== "hub") return;
        const next =
          (root.settings.rotation ?? "clockwise") === "counterclockwise" ? "clockwise" : "counterclockwise";
        state = updateEntitySettings(state, root.id, { ...root.settings, rotation: next });
        persist();
        renderCanvas();
        renderInspector();
      });
    });

    canvasEl.querySelectorAll<HTMLElement>(".builder-entity").forEach((entityEl) => {
      entityEl.addEventListener("mousedown", (ev) => {
        const target = ev.target as HTMLElement;
        if (target.closest("button")) return;
        const rootId = entityEl.dataset.rootId!;
        const root = state.entities.find((e) => e.id === rootId);
        const seg = entityEl.closest<HTMLElement>(".builder-segment");
        if (!root || !seg) return;
        if (root.templateType === "hub") {
          const hubEl = entityEl.querySelector<HTMLElement>(".builder-hub");
          if (!hubEl) return;
          const r0 = hubEl.getBoundingClientRect();
          const localX = ev.clientX - r0.left;
          const localY = ev.clientY - r0.top;
          const faceDeg = ((Number.parseFloat(root.settings.faceAngle ?? "0") % 360) + 360) % 360;
          const hubMode = hubPointerMode(localX, localY, faceDeg);
          if (hubMode === "none") return;
          ev.preventDefault();
          if (hubMode === "move") {
            const segRect = seg.getBoundingClientRect();
            const anchorX = (ev.clientX - segRect.left) / Math.max(1, segRect.width);
            const anchorY = (ev.clientY - segRect.top) / Math.max(1, segRect.height);
            const rx = root.x;
            const ry = root.y;
            const dx = anchorX - rx;
            const dy = anchorY - ry;
            const onMove = (mv: MouseEvent): void => {
              const x = (mv.clientX - segRect.left) / Math.max(1, segRect.width) - dx;
              const y = (mv.clientY - segRect.top) / Math.max(1, segRect.height) - dy;
              state = updateEntityPosition(state, root.id, x, y);
              renderCanvas();
            };
            const onUp = (): void => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
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
            const cur = state.entities.find((e) => e.id === root.id);
            if (!cur) return;
            state = updateEntitySettings(state, cur.id, { ...cur.settings, faceAngle: String(newDeg) });
            renderCanvas();
          };
          const onUp = (): void => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.removeProperty("cursor");
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
        const dx = anchorX - root.x;
        const dy = anchorY - root.y;
        const onMove = (mv: MouseEvent): void => {
          const x = (mv.clientX - segRect.left) / Math.max(1, segRect.width) - dx;
          const y = (mv.clientY - segRect.top) / Math.max(1, segRect.height) - dy;
          state = updateEntityPosition(state, root.id, x, y);
          renderCanvas();
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          persist();
          renderInspector();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    });

    canvasEl.querySelectorAll<HTMLElement>(".builder-hub").forEach((hub) => {
      const setHover = (ev: MouseEvent): void => {
        if ((ev.target as Element).closest("button")) {
          hub.classList.remove("builder-hub--hover-move", "builder-hub--hover-rotate");
          return;
        }
        const r = hub.getBoundingClientRect();
        const localX = ev.clientX - r.left;
        const localY = ev.clientY - r.top;
        const faceRaw = Number.parseFloat(hub.dataset.faceAngle ?? "0");
        const face = (((Number.isFinite(faceRaw) ? faceRaw : 0) % 360) + 360) % 360;
        const mode = hubPointerMode(localX, localY, face);
        hub.classList.toggle("builder-hub--hover-move", mode === "move");
        hub.classList.toggle("builder-hub--hover-rotate", mode === "rotate");
      };
      const clear = (): void => {
        hub.classList.remove("builder-hub--hover-move", "builder-hub--hover-rotate");
      };
      hub.addEventListener("mousemove", setHover);
      hub.addEventListener("mouseleave", clear);
    });

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
      inspectorEl.innerHTML = `
        <div class="kv"><span>Type</span><strong>Link</strong></div>
        <div class="kv"><span>From</span><strong>${link.fromEntityId}:${link.fromPort}</strong></div>
        <div class="kv"><span>To</span><strong>${link.toEntityId}:${link.toPort}</strong></div>
      `;
      return;
    }
    const entity = state.entities.find((e) => e.id === selection.rootId);
    if (!entity) {
      inspectorEl.textContent = "Entity missing.";
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

  linkModeBtn.addEventListener("click", () => {
    linkMode = !linkMode;
    linkModeBtn.textContent = `Link Mode: ${linkMode ? "On" : "Off"}`;
    pendingLinkSource = null;
    renderCanvas();
  });

  deleteBtn.addEventListener("click", () => {
    if (!selection) return;
    if (selection.kind === "entity") {
      state = removeEntityGroup(state, selection.rootId);
    } else {
      state = removeLinkGroup(state, selection.rootId);
    }
    persist();
    selection = null;
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
    state = parsed;
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

  renderTemplates();
  renderInspector();
  renderCanvas();
}

export { VIEWER_PREVIEW_KEY };
