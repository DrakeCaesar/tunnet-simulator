/**
 * **Hub** triangle layout, SVG shell, and pointer hit-testing (`hubPointerMode`).
 *
 * **`relayPointerMode`** (ring vs core) lives in this file too — same “discriminate move vs rotate from local coords” pattern as the hub triangle band; it could move beside `relay-entity-rotate-drag.ts` later if you want strict per-type files.
 *
 * Used by builder [`canvas.ts`](../../builder/canvas.ts) (render + drag + wire hit-test) and [`template-sidebar.ts`](../../builder/template-sidebar.ts) (template drag preview).
 */

export type HubVec = { x: number; y: number };

export type HubLayout = { T: HubVec; L: HubVec; R: HubVec; r: number; G: HubVec };

const HUB_TRIANGLE_SIDE = 50;
const HUB_BASE_TRIANGLE_SIDE = 50;
const HUB_SCALE = HUB_TRIANGLE_SIDE / HUB_BASE_TRIANGLE_SIDE;

/** SVG / hit box for hub (mirrors original proportions at side=70). */
export const HUB_VIEW = { w: 108 * HUB_SCALE, h: 96 * HUB_SCALE } as const;

const HUB_PORT_RADIUS = 8.5 * HUB_SCALE;
const HUB_TOP_PADDING = 18 * HUB_SCALE;

export const HUB_ROTATE_OUTER_BAND_PX = 8 * HUB_SCALE;

// Keep center reverse button visually aligned with `.builder-port` (17px).
export const HUB_REVERSE_BUTTON_SIZE = 17;
export const HUB_REVERSE_ICON_SIZE = 11;

/** Equilateral triangle: apex up, base horizontal; `r` matches half of global `.builder-port` (17px). */
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

export const HUB_LAYOUT = hubEquilateralLayout();

export function hubMarkerId(instanceId: string): string {
  return `hubmk-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function hubPortPinStyle(c: HubVec): string {
  return `left:${(c.x / HUB_VIEW.w) * 100}%;top:${(c.y / HUB_VIEW.h) * 100}%;transform:translate(-50%,-50%)`;
}

/** Port pins on a rotating layer: keep port labels world-upright. */
export function hubPortPinUprightStyle(c: HubVec, faceDeg: number): string {
  return `left:${(c.x / HUB_VIEW.w) * 100}%;top:${(c.y / HUB_VIEW.h) * 100}%;transform:translate(-50%,-50%) rotate(${-faceDeg}deg)`;
}

export function hubLocalToModel(localX: number, localY: number, faceDeg: number): HubVec {
  const g = HUB_LAYOUT.G;
  const rad = (-faceDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const relx = localX - g.x;
  const rely = localY - g.y;
  return { x: g.x + relx * c - rely * s, y: g.y + relx * s + rely * c };
}

export function hubPointInOrOnTri(p: HubVec, t: HubVec, l: HubVec, r: HubVec): boolean {
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

export function hubDistToSeg(p: HubVec, a: HubVec, b: HubVec): number {
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

export function hubPointerMode(
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

export function relayPointerMode(
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
export function hubTriangleSvg(instanceId: string, rotation: string | undefined): string {
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
