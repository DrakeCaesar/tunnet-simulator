import { Network } from "vis-network";
import { DataSet } from "vis-data";
import "vis-network/styles/vis-network.css";
import "./style.css";

type ViewerNode = {
  id: string;
  label: string;
  type: string;
  color: string;
  settings: string;
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
    const m = /^ep:0\.(\d)\./.exec(node.id);
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
  const em = /^ep:0\.(\d)\./.exec(id);
  if (em) return em[1];
  const rm = /:region:(\d):/.exec(id);
  return rm?.[1];
}

function nodeSubnetFromId(id: string, region: string): string | undefined {
  const ep = new RegExp(`^ep:0\\.${region}\\.(\\d)\\.`).exec(id);
  if (ep) return ep[1];
  const hub = new RegExp(`^hub:region:${region}:ep:0\\.${region}\\.(\\d)\\.`).exec(id);
  if (hub) return hub[1];
  const filt = new RegExp(`^filter:region:${region}:ep:0\\.${region}\\.(\\d)\\.`).exec(id);
  if (filt) return filt[1];
  const gw = new RegExp(`^hub:region:${region}:subnet:(\\d):gateway$`).exec(id);
  if (gw) return gw[1];
  const fg = new RegExp(`^filter:region:${region}:subnet:(\\d):gateway$`).exec(id);
  if (fg) return fg[1];
  const up = new RegExp(`^hub:region:${region}:subnet:(\\d):uplink$`).exec(id);
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
  const coreHubs = ["0", "1", "2", "3"].map((r) => `hub:core:${r}`);
  placeOnCircle(coreHubs, { x: 0, y: 0 }, 260).forEach((p, id) => {
    pos.set(id, p);
  });

  const regionOrder = ["0", "1", "2", "3"];
  regionOrder.forEach((r, i) => {
    const a = (i / regionOrder.length) * Math.PI * 2 - Math.PI / 2;
    regionCenters.set(r, { x: Math.cos(a) * 980, y: Math.sin(a) * 980 });
  });

  for (const r of regionOrder) {
    const center = regionCenters.get(r)!;
    const hubOrder = regionalHubRingOrder(r, payload).filter((id) =>
      payload.nodes.some((n) => n.id === id),
    );
    const radius = Math.max(220, hubOrder.length * 28);
    const coreHubId = `hub:core:${r}`;
    const corePos = pos.get(coreHubId);
    const gatewayId = `hub:region:${r}:gateway`;
    const alignAngle =
      corePos !== undefined
        ? Math.atan2(corePos.y - center.y, corePos.x - center.x)
        : -Math.PI / 2;
    const baseRing = placeOnCircleAligned(hubOrder, center, radius, gatewayId, alignAngle);

    // Keep gateway on the outer regional loop (bridge toward core).
    const gatewayPos = baseRing.get(gatewayId);
    if (gatewayPos) {
      pos.set(gatewayId, gatewayPos);
    }

    // Split x.x.0.0..x.x.3.3 into four subnet rings (third dibit s=0..3).
    const subnetOrder = ["0", "1", "2", "3"].filter((s) =>
      payload.nodes.some((n) => n.id.startsWith(`ep:`) && n.id.includes(`.${r}.${s}.`)),
    );
    const subnetCenterRadius = radius * 0.52;
    const subnetCenters = placeOnCircleAligned(
      subnetOrder,
      center,
      subnetCenterRadius,
      subnetOrder[0] ?? "0",
      alignAngle,
    );
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
      const outwardAngle = Math.atan2(subnetCenter.y - center.y, subnetCenter.x - center.x);
      const subnetRadius = Math.max(70, hubs.length * 18);
      placeOnCircleAligned(hubs, subnetCenter, subnetRadius, hubs[0], outwardAngle).forEach(
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
      const filterR = 78;
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
  leaves.forEach((id, i) => {
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
    const jitter = ((i % 7) - 3) * 12;
    pos.set(id, {
      x: base.x + nx * 240 - ny * jitter,
      y: base.y + ny * 240 + nx * jitter,
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

function render(payload: ViewerPayload): void {
  const { metaEl, detailsEl, graphEl } = mountLayout();
  const theme = graphThemeFromCss();
  const seedPos = computeInitialPositions(payload);

  metaEl.textContent =
    `Phase: ${payload.metadata.phase}\n` +
    `Generated: ${payload.metadata.generatedAt}\n` +
    `Devices: ${payload.metadata.deviceCount}  Links: ${payload.metadata.linkCount}  Flows: ${payload.metadata.flowCount}`;

  const nodes = new DataSet<any>(
    payload.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      color: n.color,
      shape: n.type === "endpoint" ? "dot" : "box",
      size: n.type === "endpoint" ? 12 : 16,
      borderWidth: 1,
      margin: { top: 8, right: 8, bottom: 8, left: 8 },
      font: {
        color: n.type === "endpoint" ? theme.endpointTextColor : theme.deviceTextColor,
        size: 12,
      },
      ...(seedPos.get(n.id) ?? {}),
      raw: n,
      title: n.settings,
    })),
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
        enabled: true,
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
