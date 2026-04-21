import { Network } from "vis-network";
import { DataSet } from "vis-data";
import "vis-network/styles/vis-network.css";
import "./style.css";

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
    deviceCount: number;
    linkCount: number;
    flowCount: number;
  };
  nodes: ViewerNode[];
  edges: ViewerEdge[];
};

type XY = { x: number; y: number };

type GraphTheme = {
  endpointTextColor: string;
  deviceTextColor: string;
  edgeColor: string;
  edgeTextColor: string;
};

// Layout tuning knobs for seeded positions (non-physics).
const LAYOUT = {
  regionOrder: ["0", "1", "2", "3"] as const,
  coreRingRadius: 700 ,
  regionCenterRadius: 10000,
  regionRingRadiusMin: 1000  ,
  regionRingRadiusPerHub: 300,
  subnetCenterRadiusFactor: 3,
  subnetRingRadiusMin: 1000,
  subnetRingRadiusPerHub: 180,
  filterOffsetFromHub: 500 ,
  leafOffsetFromParent: 500 ,
} as const;

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
): Map<string, XY> {
  const out = new Map<string, XY>();
  const n = hubOrder.length;
  if (n === 0) {
    return out;
  }
  const g = hubOrder.indexOf(alignId);
  const step = (2 * Math.PI) / n;
  const baseAngle = g >= 0 ? alignAngle - g * step : -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const a = baseAngle + i * step;
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
  const hubs = subnets.map((s) => `hub:region:${region}:subnet:${s}:uplink`);
  hubs.push(`hub:region:${region}:gateway`);
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
  const hubs = addresses.map((a) => `hub:region:${region}:ep:${a}`);
  hubs.push(`hub:region:${region}:subnet:${subnet}:gateway`);
  return hubs;
}

function filterIdToHubId(filterId: string): string | null {
  if (!filterId.startsWith("filter:region:")) {
    return null;
  }
  return filterId.replace(/^filter:/, "hub:");
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
  const gw = new RegExp(`^hub:region:${region}:subnet:(\\d+):gateway$`).exec(id);
  if (gw) return gw[1];
  const fg = new RegExp(`^filter:region:${region}:subnet:(\\d+):gateway$`).exec(id);
  if (fg) return fg[1];
  const up = new RegExp(`^hub:region:${region}:subnet:(\\d+):uplink$`).exec(id);
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

  /** Core ring order matches synthesis: region index 0→1→2→3. */
  const coreHubs = LAYOUT.regionOrder.map((r) => `hub:core:${r}`);
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
    const coreHubId = `hub:core:${r}`;
    const corePos = pos.get(coreHubId);
    const gatewayId = `hub:region:${r}:gateway`;
    const alignAngle =
      corePos !== undefined
        ? Math.atan2(corePos.y - center.y, corePos.x - center.x)
        : -Math.PI / 2;
    const baseRing = placeOnCircleAligned(hubOrder, center, radius, gatewayId, alignAngle);

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
      const uplinkId = `hub:region:${r}:subnet:${s}:uplink`;
      const uplinkPos = baseRing.get(uplinkId);
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
      const gatewayId = `hub:region:${r}:subnet:${s}:gateway`;
      const alignId = hubs.includes(gatewayId) ? gatewayId : hubs[0];
      placeOnCircleAligned(hubs, subnetCenter, subnetRadius, alignId, inwardAngle).forEach(
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

function mountLayout(): {
  metaEl: HTMLDivElement;
  detailsEl: HTMLDivElement;
  graphEl: HTMLDivElement;
} {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("Missing #app root");
  }
  app.innerHTML = `
    <div class="layout">
      <div id="graph" class="graph"></div>
      <div class="panel">
        <h1 class="panel-title">Tunnet Topology Viewer</h1>
        <div id="meta" class="meta"></div>
        <div class="hint">Drag nodes, zoom, and click a node to inspect settings.</div>
        <div id="details" class="details">No node selected.</div>
      </div>
    </div>
  `;

  return {
    metaEl: app.querySelector<HTMLDivElement>("#meta")!,
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

function render(payload: ViewerPayload): void {
  const { metaEl, detailsEl, graphEl } = mountLayout();
  const theme = graphThemeFromCss();
  const seedPos = computeInitialPositions(payload);
  const degree = new Map<string, number>();
  payload.nodes.forEach((n) => degree.set(n.id, 0));
  payload.edges.forEach((e) => {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  });

  metaEl.textContent =
    `Phase: ${payload.metadata.phase}\n` +
    `Generated: ${payload.metadata.generatedAt}\n` +
    `Devices: ${payload.metadata.deviceCount}  Links: ${payload.metadata.linkCount}  Flows: ${payload.metadata.flowCount}`;

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
          face: n.type === "filter" ? "Consolas, Menlo, monospace" : "Inter, Segoe UI, Arial, sans-serif",
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

  const network = new Network(
    graphEl,
    { nodes, edges },
    {
      interaction: { hover: true, multiselect: false, dragView: true, zoomView: true },
      physics: {
        enabled: false,
        solver: "forceAtlas2Based",
        stabilization: { iterations: 800, fit: true },
        forceAtlas2Based: {
          gravitationalConstant: -90,
          centralGravity: 0.001,
          springLength: 150,
          springConstant: 0.1,
          damping: 0.5,
          avoidOverlap: 0.5,
        },
      },
      layout: { improvedLayout: true, randomSeed: 7 },
      edges: { selectionWidth: 2 },
    },
  );

  let physicsEnabled = false;
  const setPhysicsEnabled = (enabled: boolean): void => {
    physicsEnabled = enabled;
    network.setOptions({ physics: { enabled } });
    if (enabled) {
      network.startSimulation();
    } else {
      network.stopSimulation();
    }
  };
  setPhysicsEnabled(false);

  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Space") return;
    ev.preventDefault();
    setPhysicsEnabled(!physicsEnabled);
  });

  network.on("click", (params) => {
    if (!params.nodes.length) {
      detailsEl.textContent = "No node selected.";
      return;
    }
    const node = nodes.get(params.nodes[0]) as { raw?: ViewerNode } | null;
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

async function main(): Promise<void> {
  try {
    const res = await fetch("/data/topology.json");
    if (!res.ok) {
      throw new Error(`Unable to load /data/topology.json (${res.status})`);
    }
    const payload = (await res.json()) as ViewerPayload;
    render(payload);
  } catch (err) {
    const { detailsEl } = mountLayout();
    detailsEl.textContent = `Failed to load topology data.\nRun: pnpm viewer:build\n\n${String(err)}`;
  }
}

void main();
