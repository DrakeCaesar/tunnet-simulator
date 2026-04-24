import { Network } from "vis-network";
import { DataSet } from "vis-data";
import "vis-network/styles/vis-network.css";
import "./style.css";
import { Packet, Topology, TunnetSimulator } from "./simulation";
import { mountBuilderView, VIEWER_PREVIEW_KEY } from "./builder/canvas";

type ViewerNode = {
  id: string;
  label: string;
  type: string;
  color: string;
  settings: string | Record<string, string>;
  settingsText?: string;
};

type ViewerEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
};

type ViewerPayload = {
  metadata: {
    generatedAt: string;
    phase: string;
    boundaryOrder?: number;
    deviceCount: number;
    linkCount: number;
    flowCount: number;
  };
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  topology: Topology;
};

type XY = { x: number; y: number };

function vecSub(a: XY, b: XY): XY {
  return { x: a.x - b.x, y: a.y - b.y };
}

function vecAdd(a: XY, b: XY): XY {
  return { x: a.x + b.x, y: a.y + b.y };
}

function vecMul(a: XY, s: number): XY {
  return { x: a.x * s, y: a.y * s };
}

function vecLen(a: XY): number {
  return Math.hypot(a.x, a.y);
}

function vecNorm(a: XY): XY {
  const L = vecLen(a) || 1;
  return { x: a.x / L, y: a.y / L };
}

/** Perpendicular (CCW 90°) — lane offset sits beside the edge. */
function vecPerp(u: XY): XY {
  return { x: -u.y, y: u.x };
}

function vecLerp(a: XY, b: XY, t: number): XY {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** C¹ cubic Hermite: P(0)=p0, P(1)=p1, P'(0)=m0, P'(1)=m1 */
function cubicHermite(p0: XY, m0: XY, p1: XY, m1: XY, t: number): XY {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return vecAdd(vecAdd(vecMul(p0, h00), vecMul(m0, h10)), vecAdd(vecMul(p1, h01), vecMul(m1, h11)));
}

/** Packet motion: end of last hop for C¹ joins at the next node. */
type PacketMotionState = {
  endPos: XY;
  endVel: XY;
  lastTo: string;
};

type GraphTheme = {
  endpointTextColor: string;
  deviceTextColor: string;
  edgeColor: string;
  edgeTextColor: string;
};

// Layout tuning knobs for seeded positions (non-physics).
const LAYOUT = {
  regionOrder: ["0", "1", "2", "3"] as const,
  coreRingRadius: 600 ,
  regionCenterRadius: 10000,
  regionRingRadiusMin: 500  ,
  regionRingRadiusPerHub: 200,
  subnetCenterRadiusFactor: 2,
  subnetRingRadiusMin: 100,
  subnetRingRadiusPerHub: 100 ,
  filterOffsetFromHub: 200 ,
  leafOffsetFromParent: 200 ,
} as const;

/** Packets run beside links (lanes) with inset from node centers; corners use Hermite blends. */
const PACKET_EDGE_INSET = 28;
const PACKET_LANE_WIDTH = 12;

function packetLaneOffset(packetId: number, u: XY): XY {
  const n = vecNorm(vecPerp(u));
  const laneSign = (packetId % 3) - 1; // -1, 0, 1
  return vecMul(n, laneSign * PACKET_LANE_WIDTH);
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function graphThemeFromCss(): GraphTheme {
  return {
    endpointTextColor: cssVar("--graph-node-endpoint-text", "#f0f2f7"),
    deviceTextColor: cssVar("--graph-node-device-text", "#111111"),
    edgeColor: cssVar("--graph-edge-color", "#7b8496"),
    edgeTextColor: cssVar("--graph-edge-text", "#9aa3b2"),
  };
}

function placeOnCircle(items: string[], center: XY, radius: number): Map<string, XY> {
  const out = new Map<string, XY>();
  if (!items.length) {
    return out;
  }
  items.forEach((id, i) => {
    const a = (i / items.length) * Math.PI * 2 - Math.PI / 2;
    out.set(id, {
      x: center.x + Math.cos(a) * radius,
      y: center.y + Math.sin(a) * radius,
    });
  });
  return out;
}

/**
 * Place hubs along a circle in graph order (hubOrder[i] adjacent to hubOrder[i+1]),
 * rotated so `alignId` sits at `alignAngle` (rad). Prevents the gateway→core chord from cutting the ring.
 */
function placeOnCircleAligned(
  hubOrder: string[],
  center: XY,
  radius: number,
  alignId: string,
  alignAngle: number,
  direction: 1 | -1 = 1,
): Map<string, XY> {
  const out = new Map<string, XY>();
  const n = hubOrder.length;
  if (n === 0) {
    return out;
  }
  const g = hubOrder.indexOf(alignId);
  const step = (2 * Math.PI) / n;
  const signedStep = step * direction;
  const baseAngle = g >= 0 ? alignAngle - g * signedStep : -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const a = baseAngle + i * signedStep;
    out.set(hubOrder[i], {
      x: center.x + Math.cos(a) * radius,
      y: center.y + Math.sin(a) * radius,
    });
  }
  return out;
}

function inferRegion(node: ViewerNode): string | undefined {
  if (node.type === "endpoint") {
    const m = /^ep:\d+\.(\d+)\./.exec(node.id);
    return m?.[1];
  }
  const r = /:region:(\d):/.exec(node.id);
  return r?.[1];
}

const BOUNDARY_CHANNELS = ["a", "b", "c", "d"] as const;

/** Matches Phase 5 synthesis: regional ring = subnet uplinks in order, then region gateway hub. */
function regionalHubRingOrder(region: string, payload: ViewerPayload): string[] {
  const addresses = payload.nodes
    .filter((n) => n.type === "endpoint" && inferRegion(n) === region)
    .map((n) => {
      const m = /^ep:(.+)$/.exec(n.id);
      return m?.[1] ?? "";
    })
    .filter(Boolean)
    .sort();
  const subnets = Array.from(new Set(addresses.map((a) => a.split(".")[2]))).sort();
  const nodeIds = new Set(payload.nodes.map((n) => n.id));
  const hubs: string[] = [];
  for (const s of subnets) {
    const legacy = `hub:region:${region}:subnet:${s}:uplink`;
    if (nodeIds.has(legacy)) {
      hubs.push(legacy);
    } else {
      for (const channel of BOUNDARY_CHANNELS) {
        const id = `hub:region:${region}:subnet:${s}:uplink:${channel}`;
        if (nodeIds.has(id)) hubs.push(id);
      }
    }
  }
  const legacyGateway = `hub:region:${region}:gateway`;
  if (nodeIds.has(legacyGateway)) {
    hubs.push(legacyGateway);
  } else {
    for (const channel of BOUNDARY_CHANNELS) {
      const id = `hub:region:${region}:gateway:${channel}`;
      if (nodeIds.has(id)) hubs.push(id);
    }
  }
  return hubs;
}

/** Matches Phase 5 synthesis: subnet ring = endpoint hubs in subnet order, then subnet gateway hub. */
function subnetHubRingOrder(region: string, subnet: string, payload: ViewerPayload): string[] {
  const addresses = payload.nodes
    .filter((n) => n.type === "endpoint" && inferRegion(n) === region)
    .map((n) => {
      const m = /^ep:(.+)$/.exec(n.id);
      return m?.[1] ?? "";
    })
    .filter(Boolean)
    .filter((a) => a.split(".")[2] === subnet)
    .sort();
  const nodeIds = new Set(payload.nodes.map((n) => n.id));
  const hubs = addresses.map((a) => `hub:region:${region}:ep:${a}`);
  const legacyGateway = `hub:region:${region}:subnet:${subnet}:gateway`;
  if (nodeIds.has(legacyGateway)) {
    hubs.push(legacyGateway);
  } else {
    for (const channel of BOUNDARY_CHANNELS) {
      const id = `hub:region:${region}:subnet:${subnet}:gateway:${channel}`;
      if (nodeIds.has(id)) hubs.push(id);
    }
  }
  return hubs;
}

/** Core ring placement order grouped by region. */
function coreHubRingOrder(payload: ViewerPayload): string[] {
  const nodeIds = new Set(payload.nodes.map((n) => n.id));
  const ordered: string[] = [];
  for (const region of LAYOUT.regionOrder) {
    const legacy = `hub:core:${region}`;
    if (nodeIds.has(legacy)) {
      ordered.push(legacy);
      continue;
    }
    for (const channel of BOUNDARY_CHANNELS) {
      const id = `hub:core:${region}:${channel}`;
      if (nodeIds.has(id)) {
        ordered.push(id);
      }
    }
  }
  if (ordered.length > 0) {
    return ordered;
  }
  return payload.nodes
    .map((n) => n.id)
    .filter((id) => id.startsWith("hub:core:"))
    .sort((a, b) => a.localeCompare(b));
}

function filterIdToHubId(filterId: string): string | null {
  if (!filterId.startsWith("filter:region:")) {
    return null;
  }
  return filterId
    .replace(/^filter:/, "hub:")
    .replace(/:(inbound|outbound)$/, "")
    .replace(/:(out-r|out-s|in-r|in-s)$/, "")
    .replace(/:d[0-3]$/, "");
}

function nodeRegionFromId(id: string): string | undefined {
  const em = /^ep:\d+\.(\d+)\./.exec(id);
  if (em) return em[1];
  const rm = /:region:(\d+):/.exec(id);
  return rm?.[1];
}

function nodeSubnetFromId(id: string, region: string): string | undefined {
  const ep = new RegExp(`^ep:\\d+\\.${region}\\.(\\d+)\\.`).exec(id);
  if (ep) return ep[1];
  const hub = new RegExp(`^hub:region:${region}:ep:\\d+\\.${region}\\.(\\d+)\\.`).exec(id);
  if (hub) return hub[1];
  const filt = new RegExp(`^filter:region:${region}:ep:\\d+\\.${region}\\.(\\d+)\\.`).exec(id);
  if (filt) return filt[1];
  const gw = new RegExp(`^hub:region:${region}:subnet:(\\d+):gateway(?::[a-z0-9_-]+)?$`).exec(id);
  if (gw) return gw[1];
  const fg = new RegExp(`^filter:region:${region}:subnet:(\\d+):gateway(?::[^:]+)+$`).exec(id);
  if (fg) return fg[1];
  const up = new RegExp(`^hub:region:${region}:subnet:(\\d+):uplink(?::[a-z0-9_-]+)?$`).exec(id);
  if (up) return up[1];
  return undefined;
}

function computeInitialPositions(payload: ViewerPayload): Map<string, XY> {
  const degree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const regionCenters = new Map<string, XY>();
  const subnetCentersByRegion = new Map<string, XY>();
  for (const n of payload.nodes) {
    degree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of payload.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }

  const pos = new Map<string, XY>();

  /** Core ring order from synthesized topology (supports multi-channel core hubs). */
  const coreHubs = coreHubRingOrder(payload);
  placeOnCircle(coreHubs, { x: 0, y: 0 }, LAYOUT.coreRingRadius).forEach((p, id) => {
    pos.set(id, p);
  });

  LAYOUT.regionOrder.forEach((r, i) => {
    const a = (i / LAYOUT.regionOrder.length) * Math.PI * 2 - Math.PI / 2;
    regionCenters.set(r, {
      x: Math.cos(a) * LAYOUT.regionCenterRadius,
      y: Math.sin(a) * LAYOUT.regionCenterRadius,
    });
  });

  for (const r of LAYOUT.regionOrder) {
    const center = regionCenters.get(r)!;
    const hubOrder = regionalHubRingOrder(r, payload).filter((id) =>
      payload.nodes.some((n) => n.id === id),
    );
    const radius = Math.max(LAYOUT.regionRingRadiusMin, hubOrder.length * LAYOUT.regionRingRadiusPerHub);
    const coreHubId =
      coreHubs.find((id) => id === `hub:core:${r}:a`) ??
      coreHubs.find((id) => id.startsWith(`hub:core:${r}:`)) ??
      coreHubs.find((id) => id === `hub:core:${r}`);
    const corePos = coreHubId ? pos.get(coreHubId) : undefined;
    const gatewayIdCandidates = [
      ...BOUNDARY_CHANNELS.map((c) => `hub:region:${r}:gateway:${c}`),
      `hub:region:${r}:gateway`,
    ];
    const gatewayId = gatewayIdCandidates.find((id) => hubOrder.includes(id)) ?? hubOrder[0];
    const alignAngle =
      corePos !== undefined
        ? Math.atan2(corePos.y - center.y, corePos.x - center.x)
        : -Math.PI / 2;
    const baseRing = placeOnCircleAligned(hubOrder, center, radius, gatewayId, alignAngle, -1);

    // Place all regional-ring hubs (subnet uplinks + region gateway).
    baseRing.forEach((p, id) => {
      pos.set(id, p);
    });

    // Split x.x.0.0..x.x.3.3 into four subnet rings (third dibit s=0..3).
    const subnetOrder = ["0", "1", "2", "3"].filter((s) =>
      payload.nodes.some((n) => n.id.startsWith(`ep:`) && n.id.includes(`.${r}.${s}.`)),
    );
    const subnetCenterRadius = radius * LAYOUT.subnetCenterRadiusFactor;
    const subnetCenters = new Map<string, XY>();
    const fallbackSubnetCenters = placeOnCircleAligned(
      subnetOrder,
      center,
      subnetCenterRadius,
      subnetOrder[0] ?? "0",
      alignAngle,
    );
    subnetOrder.forEach((s) => {
      const uplinkIdCandidates = [
        ...BOUNDARY_CHANNELS.map((c) => `hub:region:${r}:subnet:${s}:uplink:${c}`),
        `hub:region:${r}:subnet:${s}:uplink`,
      ];
      const uplinkId = uplinkIdCandidates.find((id) => baseRing.has(id));
      const uplinkPos = uplinkId ? baseRing.get(uplinkId) : undefined;
      if (!uplinkPos) {
        const fallback = fallbackSubnetCenters.get(s);
        if (fallback) {
          subnetCenters.set(s, fallback);
        }
        return;
      }
      const dx = uplinkPos.x - center.x;
      const dy = uplinkPos.y - center.y;
      const len = Math.hypot(dx, dy) || 1;
      subnetCenters.set(s, {
        x: center.x + (dx / len) * subnetCenterRadius,
        y: center.y + (dy / len) * subnetCenterRadius,
      });
    });
    subnetCenters.forEach((p, s) => {
      subnetCentersByRegion.set(`${r}:${s}`, p);
    });

    subnetOrder.forEach((s) => {
      const hubs = subnetHubRingOrder(r, s, payload).filter((id) =>
        payload.nodes.some((n) => n.id === id),
      );
      const subnetCenter = subnetCenters.get(s);
      if (!subnetCenter || hubs.length === 0) {
        return;
      }
      const inwardAngle = Math.atan2(center.y - subnetCenter.y, center.x - subnetCenter.x);
      const subnetRadius = Math.max(LAYOUT.subnetRingRadiusMin, hubs.length * LAYOUT.subnetRingRadiusPerHub);
      const gatewayIdCandidates = [
        ...BOUNDARY_CHANNELS.map((c) => `hub:region:${r}:subnet:${s}:gateway:${c}`),
        `hub:region:${r}:subnet:${s}:gateway`,
      ];
      const gatewayId = gatewayIdCandidates.find((id) => hubs.includes(id));
      const alignId = gatewayId && hubs.includes(gatewayId) ? gatewayId : hubs[0];
      placeOnCircleAligned(hubs, subnetCenter, subnetRadius, alignId, inwardAngle, 1).forEach(
        (p, id) => {
          pos.set(id, p);
        },
      );
    });

    const filterIds = payload.nodes
      .map((n) => n.id)
      .filter((id) => id.startsWith(`filter:region:${r}:`));
    for (const fid of filterIds) {
      const hid = filterIdToHubId(fid);
      if (!hid || !pos.has(hid)) {
        continue;
      }
      const hubPos = pos.get(hid)!;
      const subnet = nodeSubnetFromId(hid, r);
      const anchor = (subnet && subnetCentersByRegion.get(`${r}:${subnet}`)) || center;
      const vx = hubPos.x - anchor.x;
      const vy = hubPos.y - anchor.y;
      const len = Math.hypot(vx, vy) || 1;
      const outwardX = vx / len;
      const outwardY = vy / len;
      const filterR = LAYOUT.filterOffsetFromHub;
      pos.set(fid, {
        x: hubPos.x + outwardX * filterR,
        y: hubPos.y + outwardY * filterR,
      });
    }
  }

  const leftovers = payload.nodes
    .filter((n) => !pos.has(n.id))
    .filter((n) => !(n.type === "endpoint" && (degree.get(n.id) ?? 0) <= 1))
    .map((n) => n.id)
    .sort();
  placeOnCircle(leftovers, { x: 0, y: 0 }, 1550).forEach((p, id) => {
    pos.set(id, p);
  });

  const leaves = payload.nodes
    .filter((n) => n.type === "endpoint" && (degree.get(n.id) ?? 0) <= 1)
    .map((n) => n.id)
    .sort();
  leaves.forEach((id) => {
    const parent = adj.get(id)?.[0];
    if (!parent || !pos.has(parent)) {
      return;
    }
    const base = pos.get(parent)!;
    const region = nodeRegionFromId(parent);
    const subnet = region ? nodeSubnetFromId(parent, region) : undefined;
    const anchor =
      (region && subnet && subnetCentersByRegion.get(`${region}:${subnet}`)) ||
      (region && regionCenters.get(region)) || { x: 0, y: 0 };
    const dx = base.x - anchor.x;
    const dy = base.y - anchor.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    pos.set(id, {
      x: base.x + nx * LAYOUT.leafOffsetFromParent,
      y: base.y + ny * LAYOUT.leafOffsetFromParent,
    });
  });

  return pos;
}

/** Send rate = 2^exponent (each slider step doubles/halves emission rate). */
const SEND_RATE_EXP_MIN = -6;
const SEND_RATE_EXP_MAX = 6;
const SEND_RATE_EXP_DEFAULT = 0;

function sendRateMultiplierFromExponent(exp: number): number {
  return 2 ** exp;
}

function formatSendRateLabel(exp: number): string {
  const m = sendRateMultiplierFromExponent(exp);
  return `${m}× (2^${exp})`;
}

/** Tick animation speed = 2^exponent (0.25× … 64×). */
const SPEED_EXP_MIN = -2;
const SPEED_EXP_MAX = 6;
const SPEED_EXP_DEFAULT = 1;

function speedMultiplierFromExponent(exp: number): number {
  return 2 ** exp;
}

function formatSpeedLabel(exp: number): string {
  const m = speedMultiplierFromExponent(exp);
  return `${m}× (2^${exp})`;
}

function mountLayout(): {
  tabViewerEl: HTMLButtonElement;
  tabBuilderEl: HTMLButtonElement;
  viewerViewEl: HTMLDivElement;
  builderViewEl: HTMLDivElement;
  metaEl: HTMLDivElement;
  simEl: HTMLDivElement;
  timingBodyEl: HTMLTableSectionElement;
  topologyOrderEl: HTMLInputElement;
  topologyOrderValueEl: HTMLSpanElement;
  playBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
  stepBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  speedEl: HTMLInputElement;
  speedValueEl: HTMLSpanElement;
  sendRateEl: HTMLInputElement;
  sendRateValueEl: HTMLSpanElement;
  detailsEl: HTMLDivElement;
  graphEl: HTMLDivElement;
} {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("Missing #app root");
  }
  app.innerHTML = `
    <div class="app-tabs">
      <button id="tab-viewer" type="button" class="app-tab active">Viewer</button>
      <button id="tab-builder" type="button" class="app-tab">Builder</button>
    </div>
    <div id="viewer-view" class="layout">
      <div id="graph" class="graph"></div>
      <div class="panel">
        <h1 class="panel-title">Tunnet Topology Viewer</h1>
        <div id="meta" class="meta card"></div>
        <div class="sim-controls card">
          <div class="sim-send-rate-block">
            <label class="sim-send-rate-label" for="topology-order">Topology order (boundary channels)</label>
            <div class="sim-send-rate-row">
              <input id="topology-order" type="range" min="1" max="4" step="1" value="2" />
              <span id="topology-order-value" class="sim-send-rate-value"></span>
            </div>
          </div>
          <div class="sim-buttons">
            <button id="sim-play" type="button">Play</button>
            <button id="sim-pause" type="button">Pause</button>
            <button id="sim-step" type="button">Step</button>
            <button id="sim-clear" type="button">Clear</button>
          </div>
          <div class="sim-send-rate-block">
            <label class="sim-send-rate-label" for="sim-speed">Sim speed (0.25×–64×, each step ×2)</label>
            <div class="sim-send-rate-row">
              <input
                id="sim-speed"
                type="range"
                min="${SPEED_EXP_MIN}"
                max="${SPEED_EXP_MAX}"
                step="1"
                value="${SPEED_EXP_DEFAULT}"
              />
              <span id="sim-speed-value" class="sim-send-rate-value"></span>
            </div>
          </div>
          <div class="sim-send-rate-block">
            <label class="sim-send-rate-label" for="sim-send-rate">Send rate (each step ×2)</label>
            <div class="sim-send-rate-row">
              <input
                id="sim-send-rate"
                type="range"
                min="${SEND_RATE_EXP_MIN}"
                max="${SEND_RATE_EXP_MAX}"
                step="1"
                value="${SEND_RATE_EXP_DEFAULT}"
              />
              <span id="sim-send-rate-value" class="sim-send-rate-value"></span>
            </div>
          </div>
          <div id="sim-meta" class="sim-meta">Simulation paused.</div>
        </div>
        <div class="card timings-card">
          <div class="section-title">Step Timing</div>
          <div class="timings-wrap">
            <table class="timings-table">
              <thead>
                <tr>
                  <th>tick</th>
                  <th>interval</th>
                  <th>step</th>
                  <th>animate</th>
                  <th>sched</th>
                  <th>sum</th>
                  <th>delta</th>
                </tr>
              </thead>
              <tbody id="timing-body"></tbody>
            </table>
          </div>
        </div>
        <div class="hint">Space toggles play/pause. Click nodes or packets for details.</div>
        <div class="section-title">Selection</div>
        <div id="details" class="details">No node selected.</div>
      </div>
    </div>
    <div id="builder-view" class="builder-view hidden"></div>
  `;

  return {
    tabViewerEl: app.querySelector<HTMLButtonElement>("#tab-viewer")!,
    tabBuilderEl: app.querySelector<HTMLButtonElement>("#tab-builder")!,
    viewerViewEl: app.querySelector<HTMLDivElement>("#viewer-view")!,
    builderViewEl: app.querySelector<HTMLDivElement>("#builder-view")!,
    metaEl: app.querySelector<HTMLDivElement>("#meta")!,
    simEl: app.querySelector<HTMLDivElement>("#sim-meta")!,
    timingBodyEl: app.querySelector<HTMLTableSectionElement>("#timing-body")!,
    topologyOrderEl: app.querySelector<HTMLInputElement>("#topology-order")!,
    topologyOrderValueEl: app.querySelector<HTMLSpanElement>("#topology-order-value")!,
    playBtn: app.querySelector<HTMLButtonElement>("#sim-play")!,
    pauseBtn: app.querySelector<HTMLButtonElement>("#sim-pause")!,
    stepBtn: app.querySelector<HTMLButtonElement>("#sim-step")!,
    clearBtn: app.querySelector<HTMLButtonElement>("#sim-clear")!,
    speedEl: app.querySelector<HTMLInputElement>("#sim-speed")!,
    speedValueEl: app.querySelector<HTMLSpanElement>("#sim-speed-value")!,
    sendRateEl: app.querySelector<HTMLInputElement>("#sim-send-rate")!,
    sendRateValueEl: app.querySelector<HTMLSpanElement>("#sim-send-rate-value")!,
    detailsEl: app.querySelector<HTMLDivElement>("#details")!,
    graphEl: app.querySelector<HTMLDivElement>("#graph")!,
  };
}

function getSettingsMap(node: ViewerNode): Record<string, string> {
  if (typeof node.settings === "object" && node.settings !== null) {
    return node.settings;
  }
  const out: Record<string, string> = {};
  const settingsText = typeof node.settings === "string" ? node.settings : "";
  for (const line of settingsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

function formatFilterSpecLabel(node: ViewerNode): string {
  const map = getSettingsMap(node);
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return node.label;
  }
  const keyWidth = entries.reduce((m, [k]) => Math.max(m, k.length), 0);
  const rows = entries.map(([k, v]) => `${k.padEnd(keyWidth, " ")}   ${v}`);
  return `${node.id}\n${rows.join("\n")}`;
}

function render(payload: ViewerPayload, boundaryOrder: number, initialTab: "viewer" | "builder"): void {
  const {
    tabViewerEl,
    tabBuilderEl,
    viewerViewEl,
    builderViewEl,
    metaEl,
    simEl,
    timingBodyEl,
    topologyOrderEl,
    topologyOrderValueEl,
    playBtn,
    pauseBtn,
    stepBtn,
    clearBtn,
    speedEl,
    speedValueEl,
    sendRateEl,
    sendRateValueEl,
    detailsEl,
    graphEl,
  } = mountLayout();

  let builderMounted = false;
  let activeTab: "viewer" | "builder" = initialTab;
  let viewerControlReady = false;
  let resumePlayingWhenViewerReturns = false;
  let restorePhysicsWhenViewerReturns = false;
  const setActiveTab = (tab: "viewer" | "builder"): void => {
    activeTab = tab;
    const viewerActive = tab === "viewer";
    viewerViewEl.classList.toggle("hidden", !viewerActive);
    builderViewEl.classList.toggle("hidden", viewerActive);
    tabViewerEl.classList.toggle("active", viewerActive);
    tabBuilderEl.classList.toggle("active", !viewerActive);
    if (!builderMounted && tab === "builder") {
      mountBuilderView({
        root: builderViewEl,
        onPreviewReady: () => {
          const url = new URL(window.location.href);
          url.searchParams.set("tab", "viewer");
          url.searchParams.set("preview", "builder");
          window.location.href = url.toString();
        },
      });
      builderMounted = true;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
    if (viewerControlReady) {
      applyViewerExecutionForActiveTab();
    }
  };
  tabViewerEl.addEventListener("click", () => setActiveTab("viewer"));
  tabBuilderEl.addEventListener("click", () => setActiveTab("builder"));
  setActiveTab(initialTab);
  const theme = graphThemeFromCss();
  const seedPos = computeInitialPositions(payload);
  const degree = new Map<string, number>();
  payload.nodes.forEach((n) => degree.set(n.id, 0));
  payload.edges.forEach((e) => {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  });

  metaEl.innerHTML = `
    <div class="section-title">Build</div>
    <div class="kv"><span>Phase</span><strong>${payload.metadata.phase}</strong></div>
    <div class="kv"><span>Boundary order</span><strong>${boundaryOrder}</strong></div>
    <div class="kv"><span>Generated</span><strong>${payload.metadata.generatedAt}</strong></div>
    <div class="stats-row">
      <div class="stat-pill"><span>Devices</span><strong>${payload.metadata.deviceCount}</strong></div>
      <div class="stat-pill"><span>Links</span><strong>${payload.metadata.linkCount}</strong></div>
      <div class="stat-pill"><span>Flows</span><strong>${payload.metadata.flowCount}</strong></div>
    </div>
  `;
  topologyOrderEl.value = String(boundaryOrder);
  topologyOrderValueEl.textContent = `${boundaryOrder}`;

  const nodes = new DataSet<any>(
    payload.nodes.map((n) => {
      const isLeafEndpoint = n.type === "endpoint" && (degree.get(n.id) ?? 0) <= 1;
      return {
        id: n.id,
        label:
          n.type === "filter"
            ? formatFilterSpecLabel(n)
            : isLeafEndpoint
              ? n.id.replace(/^ep:/, "")
              : n.label,
        color: n.color,
        shape: isLeafEndpoint ? "box" : n.type === "endpoint" ? "dot" : "box",
        size: n.type === "endpoint" ? 12 : 16,
        borderWidth: 1,
        margin: { top: 8, right: 8, bottom: 8, left: 8 },
        font: {
          color: n.type === "endpoint" ? theme.endpointTextColor : theme.deviceTextColor,
          size: 12,
          align: n.type === "filter" ? ("left" as const) : ("center" as const),
          face:
            "\"FiraCode Nerd Font\", \"Fira Code Nerd Font\", \"Fira Code\", ui-monospace, SFMono-Regular, Menlo, monospace",
        },
        ...(seedPos.get(n.id) ?? {}),
        raw: n,
        title:
          n.type === "filter"
            ? undefined
            : n.settingsText ?? (typeof n.settings === "string" ? n.settings : ""),
      };
    }),
  );

  const edges = new DataSet<any>(
    payload.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label,
      color: { color: theme.edgeColor, opacity: 0.6 },
      width: 1,
      smooth: { enabled: true, type: "dynamic", roundness: 0.5 },
      font: { color: theme.edgeTextColor, size: 10, align: "middle" as const },
      arrows: { to: { enabled: false } },
    })),
  );

  const networkOptions = {
    interaction: { hover: true, multiselect: false, dragView: true, zoomView: true },
    physics: {
      enabled: true,
      solver: "forceAtlas2Based",
      stabilization: { iterations: 800, fit: true },
      forceAtlas2Based: {
        gravitationalConstant: -30,
        centralGravity: 0.001,
        springLength: 150,
        springConstant: 0.1,
        damping: 0.5,
        avoidOverlap: 0.4,
      },
    },
    layout: { improvedLayout: true, randomSeed: 7 },
    edges: { selectionWidth: 2 },
  };
  const network = new Network(graphEl, { nodes, edges }, networkOptions);

  let physicsEnabled = Boolean(networkOptions.physics.enabled);
  const setPhysicsEnabled = (enabled: boolean): void => {
    physicsEnabled = enabled;
    network.setOptions({ physics: { enabled } });
    if (enabled) {
      network.startSimulation();
    } else {
      network.stopSimulation();
    }
  };
  setPhysicsEnabled(physicsEnabled);

  let simulator = new TunnetSimulator(payload.topology, 1337);
  let currentOccupancy = simulator.getPortOccupancy();
  let previousOccupancy = currentOccupancy;
  let progress = 1;
  let animationHandle: number | null = null;
  let playing = false;
  let speedExponent = Number(speedEl.value);
  if (!Number.isFinite(speedExponent)) {
    speedExponent = SPEED_EXP_DEFAULT;
  }
  let speed = speedMultiplierFromExponent(speedExponent);
  let sendRateExponent = Number(sendRateEl.value);
  if (!Number.isFinite(sendRateExponent)) {
    sendRateExponent = SEND_RATE_EXP_DEFAULT;
  }
  let animating = false;
  const packetNodeIds = new Set<string>();
  let selectedPacketNodeId: string | null = null;
  const selectedPacketGuideEdgeId = "pkt:selected:guide";
  let stats = {
    tick: 0,
    emitted: 0,
    delivered: 0,
    dropped: 0,
    bounced: 0,
    ttlExpired: 0,
    collisions: 0,
  };
  let previousStatsTotals = { ...stats };
  let deliveredPerTick: number | null = null;
  let deliveredPerTickAvg100: number | null = null;
  const deliveredHistory: number[] = [];
  const DELIVERED_AVG_WINDOW = 100;
  let dropPctTick: number | null = null;
  let dropPctCumulative: number | null = null;

  /** Smoothed sim ticks per wall second; null until first completed tick. */
  let emaAchievedSpeed: number | null = null;
  const ACHIEVED_SPEED_EMA_ALPHA = 0.12;
  /** Actual render framerate from renderPackets(...) cadence. */
  let emaFps: number | null = null;
  let lastRenderFrameMs: number | null = null;
  const FPS_EMA_ALPHA = 0.12;
  /** Render frame breakdown (ms) for bottleneck analysis. */
  let lastRenderTotalMs: number | null = null;
  let lastRenderBuildMs: number | null = null;
  let lastRenderApplyMs: number | null = null;
  let lastRenderGuideMs: number | null = null;
  let lastRenderOverheadMs: number | null = null;
  let emaRenderTotalMs: number | null = null;
  let emaRenderBuildMs: number | null = null;
  let emaRenderApplyMs: number | null = null;
  let emaRenderGuideMs: number | null = null;
  let emaRenderOverheadMs: number | null = null;
  const RENDER_BREAKDOWN_EMA_ALPHA = 0.18;
  /** Next-state compute time for simulator.step() only (ms). */
  let lastStepComputeMs: number | null = null;
  let emaStepComputeMs: number | null = null;
  const STEP_COMPUTE_EMA_ALPHA = 0.2;
  type StepTimingRow = {
    tick: number;
    intervalMs: number | null;
    stepMs: number;
    animateMs: number;
    schedulingMs: number | null;
    sumMs: number;
    deltaMs: number | null;
  };
  const timingRows: StepTimingRow[] = [];
  const MAX_TIMING_ROWS = 160;
  let pendingTimingIndex: number | null = null;
  let previousStepStartMs: number | null = null;

  const formatPacketDetails = (packet: Packet, portDeviceId: string): string =>
    `packet=${packet.id}\n` +
    `at=${portDeviceId}\n` +
    `src=${packet.src}\n` +
    `dst=${packet.dest}\n` +
    `ttl=${packet.ttl ?? "inf"}\n` +
    `sensitive=${packet.sensitive}\n` +
    `subject=${packet.subject ?? ""}`;

  const syncSendRateDisplay = (): void => {
    sendRateValueEl.textContent = formatSendRateLabel(sendRateExponent);
  };

  const syncSpeedDisplay = (): void => {
    speedValueEl.textContent = formatSpeedLabel(speedExponent);
  };

  const fmtMs = (n: number | null): string => (n === null ? "—" : n.toFixed(2));

  const renderTimingTable = (): void => {
    const rows = timingRows
      .slice()
      .reverse()
      .map((r) => {
        const deltaClass = r.deltaMs !== null && Math.abs(r.deltaMs) > 0.2 ? "warn" : "";
        return `<tr>
          <td>${r.tick}</td>
          <td>${fmtMs(r.intervalMs)}</td>
          <td>${fmtMs(r.stepMs)}</td>
          <td>${fmtMs(r.animateMs)}</td>
          <td>${fmtMs(r.schedulingMs)}</td>
          <td>${fmtMs(r.sumMs)}</td>
          <td class="${deltaClass}">${fmtMs(r.deltaMs)}</td>
        </tr>`;
      })
      .join("");
    timingBodyEl.innerHTML =
      rows ||
      `<tr><td colspan="7" class="table-empty">No completed steps yet.</td></tr>`;
  };

  const updateSimMeta = (): void => {
    const achievedValue =
      emaAchievedSpeed === null
        ? `— (no tick finished yet)`
        : `${emaAchievedSpeed.toFixed(2)}× (${Math.min(999, Math.round((emaAchievedSpeed / Math.max(speed, 1e-9)) * 100))}% of ${speed.toFixed(2)}× target)`;
    const stepComputeValue =
      lastStepComputeMs === null
        ? `—`
        : `${lastStepComputeMs.toFixed(2)}ms (ema ${(emaStepComputeMs ?? lastStepComputeMs).toFixed(2)}ms)`;
    const fpsValue = emaFps === null ? "—" : emaFps.toFixed(1);
    simEl.innerHTML = `
      <div class="stats-subtitle">Render & Runtime</div>
      <div class="stats-row">
        <div class="stat-pill"><span>State</span><strong>${playing ? "running" : "paused"}</strong></div>
        <div class="stat-pill"><span>Speed</span><strong>${formatSpeedLabel(speedExponent)}</strong></div>
        <div class="stat-pill"><span>Achieved</span><strong>${achievedValue}</strong></div>
        <div class="stat-pill"><span>FPS</span><strong>${fpsValue}</strong></div>
        <div class="stat-pill"><span>Send rate</span><strong>${formatSendRateLabel(sendRateExponent)}</strong></div>
        <div class="stat-pill"><span>Step compute</span><strong>${stepComputeValue}</strong></div>
        <div class="stat-pill"><span>Render total</span><strong>${lastRenderTotalMs === null ? "—" : `${lastRenderTotalMs.toFixed(2)} (ema ${(emaRenderTotalMs ?? lastRenderTotalMs).toFixed(2)})`}</strong></div>
        <div class="stat-pill"><span>Render build</span><strong>${lastRenderBuildMs === null ? "—" : lastRenderBuildMs.toFixed(2)}</strong></div>
        <div class="stat-pill"><span>Render apply</span><strong>${lastRenderApplyMs === null ? "—" : lastRenderApplyMs.toFixed(2)}</strong></div>
        <div class="stat-pill"><span>Render guide</span><strong>${lastRenderGuideMs === null ? "—" : lastRenderGuideMs.toFixed(2)}</strong></div>
        <div class="stat-pill"><span>Render overhead</span><strong>${lastRenderOverheadMs === null ? "—" : lastRenderOverheadMs.toFixed(2)}</strong></div>
      </div>
      <div class="stats-subtitle stats-subtitle-gap">Simulation Counters</div>
      <div class="stats-row">
        <div class="stat-pill"><span>Tick</span><strong>${stats.tick}</strong></div>
        <div class="stat-pill"><span>In-flight</span><strong>${currentOccupancy.length}</strong></div>
        <div class="stat-pill"><span>Emitted</span><strong>${stats.emitted}</strong></div>
        <div class="stat-pill"><span>Delivered</span><strong>${stats.delivered}</strong></div>
        <div class="stat-pill"><span>Dropped</span><strong>${stats.dropped}</strong></div>
        <div class="stat-pill"><span>Bounced</span><strong>${stats.bounced}</strong></div>
        <div class="stat-pill"><span>TTL expired</span><strong>${stats.ttlExpired}</strong></div>
        <div class="stat-pill"><span>Collisions</span><strong>${stats.collisions}</strong></div>
        <div class="stat-pill"><span>Delivered/tick</span><strong>${deliveredPerTick === null ? "—" : deliveredPerTick.toFixed(2)}</strong></div>
        <div class="stat-pill"><span>Delivered avg100</span><strong>${deliveredPerTickAvg100 === null ? "—" : deliveredPerTickAvg100.toFixed(2)}</strong></div>
        <div class="stat-pill"><span>Drop % tick</span><strong>${dropPctTick === null ? "—" : `${dropPctTick.toFixed(1)}%`}</strong></div>
        <div class="stat-pill"><span>Drop % cumulative</span><strong>${dropPctCumulative === null ? "—" : `${dropPctCumulative.toFixed(1)}%`}</strong></div>
      </div>
    `;
  };

  const byPacketId = (
    occupancy: Array<{ port: { deviceId: string; port: number }; packet: Packet }>,
  ): Map<number, { deviceId: string; port: number; packet: Packet }> => {
    const out = new Map<number, { deviceId: string; port: number; packet: Packet }>();
    occupancy.forEach((entry) => {
      out.set(entry.packet.id, { deviceId: entry.port.deviceId, port: entry.port.port, packet: entry.packet });
    });
    return out;
  };

  const packetMotionStore = new Map<number, PacketMotionState>();
  const packetBirthTick = new Map<number, number>();

  const restingPortOffset = (port: number): XY => {
    const a = (port % 4) * (Math.PI / 2);
    return { x: Math.cos(a) * 8, y: Math.sin(a) * 8 };
  };

  const renderPackets = (t: number): void => {
    const frameStart = performance.now();
    const now = performance.now();
    if (lastRenderFrameMs !== null) {
      const dt = now - lastRenderFrameMs;
      if (dt > 0) {
        const instantFps = 1000 / dt;
        emaFps =
          emaFps === null
            ? instantFps
            : FPS_EMA_ALPHA * instantFps + (1 - FPS_EMA_ALPHA) * emaFps;
      }
    }
    lastRenderFrameMs = now;
    progress = t;
    const prev = byPacketId(previousOccupancy);
    const curr = byPacketId(currentOccupancy);
    const nextPacketIds = new Set<string>();
    const seenPacketIds = new Set<number>();
    const updates: any[] = [];
    curr.forEach(({ deviceId, port, packet }, packetId) => {
      seenPacketIds.add(packetId);
      if (!packetBirthTick.has(packetId)) {
        packetBirthTick.set(packetId, stats.tick);
      }
      const birthTick = packetBirthTick.get(packetId) ?? stats.tick;
      const packetAge = Math.max(0, stats.tick - birthTick);
      const hue = (packetId * 47) % 360;
      const normalBg = `hsl(${hue} 82% 64%)`;
      const normalBorder = `hsl(${hue} 82% 44%)`;
      const packetNodeId = `pkt:${packetId}`;
      nextPacketIds.add(packetNodeId);
      const from = prev.get(packetId);
      const sourceEndpointId = `ep:${packet.src}`;
      const fallbackSpawnDevice = nodes.get(sourceEndpointId) ? sourceEndpointId : deviceId;
      const fromDevice = from?.deviceId ?? fallbackSpawnDevice;
      const pa = network.getPosition(fromDevice);
      const pb = network.getPosition(deviceId);
      let x: number;
      let y: number;
      if (fromDevice === deviceId) {
        packetMotionStore.delete(packetId);
        const o = restingPortOffset(port);
        x = pa.x + o.x;
        y = pa.y + o.y;
      } else {
        const chord = vecSub(pb, pa);
        const chordLen = vecLen(chord) || 1;
        const u = vecNorm(chord);
        const lane = packetLaneOffset(packetId, u);
        const inset = Math.min(PACKET_EDGE_INSET, chordLen * 0.38);
        const S = vecAdd(vecAdd(pa, vecMul(u, inset)), lane);
        const E = vecAdd(vecSub(pb, vecMul(u, inset)), lane);
        const segVel = vecSub(E, S);
        const st = packetMotionStore.get(packetId);
        const useHermite = Boolean(st && st.lastTo === fromDevice);
        let pos: XY;
        if (useHermite) {
          pos = cubicHermite(st!.endPos, st!.endVel, E, segVel, t);
        } else {
          pos = vecLerp(S, E, t);
        }
        x = pos.x;
        y = pos.y;
        if (t >= 0.999) {
          packetMotionStore.set(packetId, { endPos: E, endVel: segVel, lastTo: deviceId });
        }
      }
      updates.push({
        id: packetNodeId,
        x,
        y,
        fixed: { x: true, y: true },
        physics: false,
        shape: "dot",
        size: packetNodeId === selectedPacketNodeId ? 10 : 7,
        color:
          packetNodeId === selectedPacketNodeId
            ? { background: "#fab387", border: "#f9e2af" }
            : { background: normalBg, border: normalBorder },
        borderWidth: packetNodeId === selectedPacketNodeId ? 3 : 1,
        label: "",
        rawPacket: packet,
        packetAt: deviceId,
        title: `id=${packet.id}\nage=${packetAge}\nsrc=${packet.src}\ndst=${packet.dest}\nttl=${packet.ttl ?? "inf"}`,
      });
    });
    for (const packetId of Array.from(packetBirthTick.keys())) {
      if (!seenPacketIds.has(packetId)) {
        packetBirthTick.delete(packetId);
      }
    }
    for (const pid of Array.from(packetMotionStore.keys())) {
      if (!curr.has(pid)) {
        packetMotionStore.delete(pid);
      }
    }
    const buildEnd = performance.now();
    nodes.update(updates);
    packetNodeIds.forEach((oldId) => {
      if (!nextPacketIds.has(oldId)) {
        nodes.remove(oldId);
      }
    });
    packetNodeIds.clear();
    nextPacketIds.forEach((id) => packetNodeIds.add(id));
    const applyEnd = performance.now();

    const guideStart = performance.now();
    if (!selectedPacketNodeId) {
      edges.remove(selectedPacketGuideEdgeId);
    } else {
      const selected = nodes.get(selectedPacketNodeId) as { rawPacket?: Packet } | null;
      const selectedPacket = selected?.rawPacket;
      if (!selectedPacket) {
        edges.remove(selectedPacketGuideEdgeId);
      } else {
        const destinationNodeId = `ep:${selectedPacket.dest}`;
        if (!nodes.get(destinationNodeId)) {
          edges.remove(selectedPacketGuideEdgeId);
        } else {
          edges.update({
            id: selectedPacketGuideEdgeId,
            from: selectedPacketNodeId,
            to: destinationNodeId,
            color: { color: "#f9e2af", opacity: 0.25 },
            width: 1,
            dashes: [4, 8],
            smooth: false,
            physics: false,
            selectable: false,
            hoverWidth: 0,
            label: "",
          });
        }
      }
    }
    const guideEnd = performance.now();
    const total = guideEnd - frameStart;
    const build = buildEnd - frameStart;
    const apply = applyEnd - buildEnd;
    const guide = guideEnd - guideStart;
    const overhead = total - (build + apply + guide);
    lastRenderTotalMs = total;
    lastRenderBuildMs = build;
    lastRenderApplyMs = apply;
    lastRenderGuideMs = guide;
    lastRenderOverheadMs = overhead;
    const alpha = RENDER_BREAKDOWN_EMA_ALPHA;
    emaRenderTotalMs = emaRenderTotalMs === null ? total : alpha * total + (1 - alpha) * emaRenderTotalMs;
    emaRenderBuildMs = emaRenderBuildMs === null ? build : alpha * build + (1 - alpha) * emaRenderBuildMs;
    emaRenderApplyMs = emaRenderApplyMs === null ? apply : alpha * apply + (1 - alpha) * emaRenderApplyMs;
    emaRenderGuideMs = emaRenderGuideMs === null ? guide : alpha * guide + (1 - alpha) * emaRenderGuideMs;
    emaRenderOverheadMs =
      emaRenderOverheadMs === null ? overhead : alpha * overhead + (1 - alpha) * emaRenderOverheadMs;
  };

  const resetSimulationState = (): void => {
    if (animationHandle !== null) {
      cancelAnimationFrame(animationHandle);
      animationHandle = null;
    }
    playing = false;
    animating = false;

    // Clear runtime packet visuals before reinitializing.
    packetNodeIds.forEach((id) => nodes.remove(id));
    packetNodeIds.clear();
    edges.remove(selectedPacketGuideEdgeId);
    selectedPacketNodeId = null;
    detailsEl.textContent = "No node selected.";

    simulator = new TunnetSimulator(payload.topology, 1337);
    simulator.setSendRateMultiplier(sendRateMultiplierFromExponent(sendRateExponent));
    currentOccupancy = simulator.getPortOccupancy();
    previousOccupancy = currentOccupancy;
    progress = 1;

    stats = {
      tick: 0,
      emitted: 0,
      delivered: 0,
      dropped: 0,
      bounced: 0,
      ttlExpired: 0,
      collisions: 0,
    };
    previousStatsTotals = { ...stats };
    deliveredPerTick = null;
    deliveredPerTickAvg100 = null;
    deliveredHistory.length = 0;
    dropPctTick = null;
    dropPctCumulative = null;

    emaAchievedSpeed = null;
    lastStepComputeMs = null;
    emaStepComputeMs = null;
    emaFps = null;
    lastRenderFrameMs = null;
    lastRenderTotalMs = null;
    lastRenderBuildMs = null;
    lastRenderApplyMs = null;
    lastRenderGuideMs = null;
    lastRenderOverheadMs = null;
    emaRenderTotalMs = null;
    emaRenderBuildMs = null;
    emaRenderApplyMs = null;
    emaRenderGuideMs = null;
    emaRenderOverheadMs = null;

    timingRows.length = 0;
    pendingTimingIndex = null;
    previousStepStartMs = null;
    packetMotionStore.clear();
    packetBirthTick.clear();

    renderPackets(1);
    renderTimingTable();
    updateSimMeta();
  };

  const runOneTick = (): void => {
    if (animating) return;
    const tickWallStartMs = performance.now();
    if (pendingTimingIndex !== null && previousStepStartMs !== null) {
      const prev = timingRows[pendingTimingIndex];
      const intervalMs = tickWallStartMs - previousStepStartMs;
      const schedulingMs = Math.max(0, intervalMs - prev.sumMs);
      const recomposed = prev.stepMs + prev.animateMs + schedulingMs;
      prev.intervalMs = intervalMs;
      prev.schedulingMs = schedulingMs;
      prev.deltaMs = intervalMs - recomposed;
      renderTimingTable();
    }
    previousStepStartMs = tickWallStartMs;
    animating = true;
    previousOccupancy = currentOccupancy;
    const stepStartMs = performance.now();
    const snapshot = simulator.step();
    const emittedTick = snapshot.stats.emitted - previousStatsTotals.emitted;
    const deliveredTickCount = snapshot.stats.delivered - previousStatsTotals.delivered;
    const droppedTickCount = snapshot.stats.dropped - previousStatsTotals.dropped;
    deliveredPerTick = deliveredTickCount;
    deliveredHistory.push(deliveredTickCount);
    if (deliveredHistory.length > DELIVERED_AVG_WINDOW) {
      deliveredHistory.shift();
    }
    deliveredPerTickAvg100 =
      deliveredHistory.length > 0
        ? deliveredHistory.reduce((sum, v) => sum + v, 0) / deliveredHistory.length
        : null;
    dropPctTick = emittedTick > 0 ? (droppedTickCount / emittedTick) * 100 : null;
    dropPctCumulative =
      snapshot.stats.emitted > 0 ? (snapshot.stats.dropped / snapshot.stats.emitted) * 100 : null;
    previousStatsTotals = { ...snapshot.stats };
    const stepMs = performance.now() - stepStartMs;
    lastStepComputeMs = stepMs;
    emaStepComputeMs =
      emaStepComputeMs === null
        ? stepMs
        : STEP_COMPUTE_EMA_ALPHA * stepMs + (1 - STEP_COMPUTE_EMA_ALPHA) * emaStepComputeMs;
    stats = snapshot.stats;
    currentOccupancy = simulator.getPortOccupancy();
    updateSimMeta();
    const durationMs = Math.max(1, 1000 / Math.max(speed, 0.1));
    const start = performance.now();
    const animate = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      renderPackets(t);
      if (t < 1) {
        animationHandle = requestAnimationFrame(animate);
        return;
      }
      const animateMs = performance.now() - start;
      timingRows.push({
        tick: stats.tick,
        intervalMs: null,
        stepMs,
        animateMs,
        schedulingMs: null,
        sumMs: stepMs + animateMs,
        deltaMs: null,
      });
      if (timingRows.length > MAX_TIMING_ROWS) {
        timingRows.splice(0, timingRows.length - MAX_TIMING_ROWS);
      }
      pendingTimingIndex = timingRows.length - 1;
      renderTimingTable();
      const wallMs = performance.now() - tickWallStartMs;
      if (wallMs > 1) {
        const instantAchieved = 1000 / wallMs;
        emaAchievedSpeed =
          emaAchievedSpeed === null
            ? instantAchieved
            : ACHIEVED_SPEED_EMA_ALPHA * instantAchieved + (1 - ACHIEVED_SPEED_EMA_ALPHA) * emaAchievedSpeed;
      }
      animating = false;
      animationHandle = null;
      updateSimMeta();
      if (playing) {
        runOneTick();
      }
    };
    animationHandle = requestAnimationFrame(animate);
  };

  const setPlaying = (enabled: boolean): void => {
    playing = enabled;
    if (!playing && animationHandle !== null) {
      cancelAnimationFrame(animationHandle);
      animationHandle = null;
      animating = false;
      renderPackets(1);
    }
    if (playing && !animating) {
      runOneTick();
    }
    updateSimMeta();
  };

  const applyViewerExecutionForActiveTab = (): void => {
    if (!viewerControlReady) return;
    const viewerActive = activeTab === "viewer";
    if (!viewerActive) {
      resumePlayingWhenViewerReturns = playing;
      setPlaying(false);
      restorePhysicsWhenViewerReturns = physicsEnabled;
      setPhysicsEnabled(false);
      return;
    }
    if (restorePhysicsWhenViewerReturns) {
      setPhysicsEnabled(true);
    }
    restorePhysicsWhenViewerReturns = false;
    if (resumePlayingWhenViewerReturns) {
      resumePlayingWhenViewerReturns = false;
      setPlaying(true);
    }
  };

  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Space") return;
    if (activeTab !== "viewer") return;
    ev.preventDefault();
    setPlaying(!playing);
  });

  const applySendRateFromSlider = (): void => {
    sendRateExponent = Number(sendRateEl.value);
    if (!Number.isFinite(sendRateExponent)) {
      sendRateExponent = SEND_RATE_EXP_DEFAULT;
    }
    simulator.setSendRateMultiplier(sendRateMultiplierFromExponent(sendRateExponent));
    syncSendRateDisplay();
    updateSimMeta();
  };

  simulator.setSendRateMultiplier(sendRateMultiplierFromExponent(sendRateExponent));
  syncSendRateDisplay();
  playBtn.addEventListener("click", () => setPlaying(true));
  pauseBtn.addEventListener("click", () => setPlaying(false));
  stepBtn.addEventListener("click", () => {
    if (!playing) {
      runOneTick();
    }
  });
  clearBtn.addEventListener("click", resetSimulationState);
  const applySpeedFromSlider = (): void => {
    speedExponent = Number(speedEl.value);
    if (!Number.isFinite(speedExponent)) {
      speedExponent = SPEED_EXP_DEFAULT;
    }
    speed = speedMultiplierFromExponent(speedExponent);
    emaAchievedSpeed = null;
    if (playing && animationHandle !== null) {
      cancelAnimationFrame(animationHandle);
      animationHandle = null;
      animating = false;
      runOneTick();
    }
    syncSpeedDisplay();
    updateSimMeta();
  };

  syncSpeedDisplay();
  speedEl.addEventListener("input", applySpeedFromSlider);
  speedEl.addEventListener("change", applySpeedFromSlider);
  sendRateEl.addEventListener("input", applySendRateFromSlider);
  sendRateEl.addEventListener("change", applySendRateFromSlider);
  const applyTopologyOrderFromSlider = (): void => {
    const parsed = Number(topologyOrderEl.value);
    const nextOrder = Number.isFinite(parsed) ? Math.max(1, Math.min(4, Math.round(parsed))) : 2;
    topologyOrderValueEl.textContent = String(nextOrder);
    if (nextOrder === boundaryOrder) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("order", String(nextOrder));
    window.location.href = url.toString();
  };
  topologyOrderEl.addEventListener("input", () => {
    const parsed = Number(topologyOrderEl.value);
    const nextOrder = Number.isFinite(parsed) ? Math.max(1, Math.min(4, Math.round(parsed))) : 2;
    topologyOrderValueEl.textContent = String(nextOrder);
  });
  topologyOrderEl.addEventListener("change", applyTopologyOrderFromSlider);

  network.on("dragging", () => renderPackets(progress));
  network.on("zoom", () => renderPackets(progress));
  renderPackets(1);
  renderTimingTable();
  updateSimMeta();
  viewerControlReady = true;
  applyViewerExecutionForActiveTab();

  network.on("click", (params) => {
    if (!params.nodes.length) {
      detailsEl.textContent = "No node selected.";
      return;
    }
    const node = nodes.get(params.nodes[0]) as
      | { raw?: ViewerNode; rawPacket?: Packet; packetAt?: string }
      | null;
    if (node?.rawPacket) {
      selectedPacketNodeId = params.nodes[0];
      renderPackets(progress);
      const birthTick = packetBirthTick.get(node.rawPacket.id) ?? stats.tick;
      const age = Math.max(0, stats.tick - birthTick);
      detailsEl.textContent =
        `${formatPacketDetails(node.rawPacket, node.packetAt ?? "?")}\n` + `age=${age}`;
      return;
    }
    if (!node?.raw) {
      detailsEl.textContent = "No details.";
      return;
    }
    detailsEl.textContent =
      `id=${node.raw.id}\n` +
      `type=${node.raw.type}\n` +
      `label=${node.raw.label}\n` +
      `settings:\n${node.raw.settings}`;
  });
}

function getBoundaryOrderFromUrl(): number {
  const raw = new URLSearchParams(window.location.search).get("order");
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(4, Math.round(parsed)));
}

function getInitialTabFromUrl(): "viewer" | "builder" {
  const raw = new URLSearchParams(window.location.search).get("tab");
  return raw === "builder" ? "builder" : "viewer";
}

async function main(): Promise<void> {
  try {
    const boundaryOrder = getBoundaryOrderFromUrl();
    const initialTab = getInitialTabFromUrl();
    let payload: ViewerPayload | null = null;
    const params = new URLSearchParams(window.location.search);
    if (params.get("preview") === "builder") {
      const raw = window.sessionStorage.getItem(VIEWER_PREVIEW_KEY);
      if (raw) {
        payload = JSON.parse(raw) as ViewerPayload;
      }
    }
    if (!payload) {
      const dataUrl = `${import.meta.env.BASE_URL}data/topology.${boundaryOrder}.json`;
      const res = await fetch(dataUrl);
      if (!res.ok) {
        throw new Error(`Unable to load topology data (${res.status})`);
      }
      payload = (await res.json()) as ViewerPayload;
    }
    render(payload, boundaryOrder, initialTab);
  } catch (err) {
    const { detailsEl } = mountLayout();
    detailsEl.textContent = `Failed to load topology data.\nRun: pnpm viewer:build\n\n${String(err)}`;
  }
}

void main();
