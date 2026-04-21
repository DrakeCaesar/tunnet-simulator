import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { synthesizePhase5HierarchicalRings } from "./topology.js";
import { Device, FlowEdge, FlowGraph, Topology } from "./types.js";

interface ViewerNode {
  id: string;
  label: string;
  type: string;
  color: string;
  settings: Record<string, string>;
  settingsText: string;
}

interface ViewerEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

interface ViewerPayload {
  metadata: {
    generatedAt: string;
    phase: string;
    deviceCount: number;
    linkCount: number;
    flowCount: number;
    sourceEndpointCount: number;
  };
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  topology: Topology;
}

interface NormalizedEndpointRow {
  address: string;
  sends_to?: string[];
  receives_from?: string[];
}

interface NormalizedEndpointFile {
  endpoints: NormalizedEndpointRow[];
}

function normalizeColor(input?: string): string {
  if (!input) return "#d9d9d9";
  const raw = input.toLowerCase();
  if (raw.startsWith("#")) return raw;
  const map: Record<string, string> = {
    blue: "#1f77b4",
    red: "#d62728",
    grey: "#7f7f7f",
    gray: "#7f7f7f",
    green: "#2ca02c",
    brown: "#8c564b",
  };
  return map[raw] ?? "#d9d9d9";
}

function deviceSettingsObject(device: Device): Record<string, string> {
  if (device.type === "endpoint") {
    return {
      address: device.address,
      destinations: device.generator ? device.generator.destinations.join(", ") : "",
      interval: device.generator
        ? `${device.generator.minIntervalTicks}-${device.generator.maxIntervalTicks}`
        : "n/a",
      sensitiveChance: device.generator ? String(device.generator.sensitiveChance) : "n/a",
    };
  }
  if (device.type === "relay") {
    return { mode: "pass-through" };
  }
  if (device.type === "hub") {
    return { rotation: device.rotation };
  }
  return {
    operatingPort: String(device.operatingPort),
    addressField: device.addressField,
    operation: device.operation,
    mask: device.mask,
    action: device.action,
    collisionHandling: device.collisionHandling,
  };
}

function settingsToText(settings: Record<string, string>): string {
  return Object.entries(settings)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function nodeColor(device: Device, nodeColors: Map<string, string>): string {
  if (device.type === "endpoint") {
    return normalizeColor(nodeColors.get(device.address));
  }
  if (device.type === "hub") return "#f9e2af";
  if (device.type === "filter") return "#f5c2e7";
  return "#cdd6f4";
}

function nodeLabel(device: Device): string {
  if (device.type === "endpoint") return device.address;
  if (device.type === "relay") return `${device.id}\nrelay`;
  if (device.type === "hub") return `${device.id}\nhub`;
  return `${device.id}\nfilter`;
}

function loadEndpointAddressSet(path: string): Set<string> {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text) as NormalizedEndpointFile;
  return new Set(data.endpoints.map((e) => e.address));
}

function matchMask(mask: string, address: string): boolean {
  const m = mask.split(".");
  const a = address.split(".");
  if (m.length !== 4 || a.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    if (m[i] === "*") continue;
    if (m[i] !== a[i]) return false;
  }
  return true;
}

function expandAddressOrMask(value: string, endpoints: Set<string>): string[] {
  if (!value.includes("*")) {
    return endpoints.has(value) ? [value] : [];
  }
  return [...endpoints].filter((addr) => matchMask(value, addr));
}

function buildFlowGraphFromNormalized(path: string): FlowGraph {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text) as NormalizedEndpointFile;
  const endpointSet = new Set(data.endpoints.map((e) => e.address));
  const edgeSet = new Set<string>();
  const edges: FlowEdge[] = [];

  const addEdge = (src: string, dst: string): void => {
    if (!endpointSet.has(src) || !endpointSet.has(dst)) return;
    const key = `${src}->${dst}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ src, dst });
  };

  for (const row of data.endpoints) {
    const src = row.address;

    for (const target of row.sends_to ?? []) {
      for (const dst of expandAddressOrMask(target, endpointSet)) {
        addEdge(src, dst);
      }
    }

    for (const source of row.receives_from ?? []) {
      for (const sender of expandAddressOrMask(source, endpointSet)) {
        addEdge(sender, src);
      }
    }
  }

  return {
    nodes: new Set(endpointSet),
    nodeColors: new Map<string, string>(),
    edges,
  };
}

function filterFlowGraphToEndpoints(flow: FlowGraph, allowed: Set<string>): FlowGraph {
  const nodes = new Set<string>();
  const edges = flow.edges.filter((e) => allowed.has(e.src) && allowed.has(e.dst));
  for (const edge of edges) {
    nodes.add(edge.src);
    nodes.add(edge.dst);
  }
  const nodeColors = new Map<string, string>();
  for (const [node, color] of flow.nodeColors.entries()) {
    if (nodes.has(node)) {
      nodeColors.set(node, color);
    }
  }
  return { nodes, nodeColors, edges };
}

function buildViewerPayload(): ViewerPayload {
  const sourceEndpoints = loadEndpointAddressSet("data.normalized.json");
  const flowFromData = buildFlowGraphFromNormalized("data.normalized.json");
  const filteredFlow = filterFlowGraphToEndpoints(flowFromData, sourceEndpoints);
  const phase5 = synthesizePhase5HierarchicalRings(filteredFlow);

  const nodes = Object.values(phase5.topology.devices).map((device) => ({
    id: device.id,
    label: nodeLabel(device),
    type: device.type,
    color: nodeColor(device, filteredFlow.nodeColors),
    settings: deviceSettingsObject(device),
    settingsText: settingsToText(deviceSettingsObject(device)),
  }));

  const edges = phase5.topology.links.map((link, idx) => ({
    id: `e${idx}`,
    from: link.a.deviceId,
    to: link.b.deviceId,
    label: `${link.a.port}<->${link.b.port}`,
  }));

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      phase: "phase5-hierarchical-rings",
      deviceCount: nodes.length,
      linkCount: edges.length,
      flowCount: filteredFlow.edges.length,
      sourceEndpointCount: sourceEndpoints.size,
    },
    nodes,
    edges,
    topology: phase5.topology,
  };
}

function main(): void {
  const payload = buildViewerPayload();
  mkdirSync("web/public/data", { recursive: true });
  writeFileSync("web/public/data/topology.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `Wrote web/public/data/topology.json (nodes=${payload.metadata.deviceCount}, links=${payload.metadata.linkCount})`,
  );
}

main();
