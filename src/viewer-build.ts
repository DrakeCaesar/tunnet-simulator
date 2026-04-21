import { mkdirSync, writeFileSync } from "node:fs";
import { parseFlowFile, mergeFlowGraphs } from "./flow-parser.js";
import { synthesizePhase5HierarchicalRings } from "./topology.js";
import { Device } from "./types.js";

interface ViewerNode {
  id: string;
  label: string;
  type: string;
  color: string;
  settings: string;
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
  };
  nodes: ViewerNode[];
  edges: ViewerEdge[];
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

function deviceSettings(device: Device): string {
  if (device.type === "endpoint") {
    return [
      `address=${device.address}`,
      device.generator ? `destinations=${device.generator.destinations.join(",")}` : "destinations=",
      device.generator
        ? `interval=${device.generator.minIntervalTicks}-${device.generator.maxIntervalTicks}`
        : "interval=n/a",
      device.generator ? `sensitiveChance=${device.generator.sensitiveChance}` : "sensitiveChance=n/a",
    ].join("\n");
  }
  if (device.type === "relay") {
    return "mode=pass-through";
  }
  if (device.type === "hub") {
    return `rotation=${device.rotation}`;
  }
  return [
    `operatingPort=${device.operatingPort}`,
    `addressField=${device.addressField}`,
    `operation=${device.operation}`,
    `mask=${device.mask}`,
    `action=${device.action}`,
    `collisionHandling=${device.collisionHandling}`,
  ].join("\n");
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

function buildViewerPayload(): ViewerPayload {
  const dot = parseFlowFile("dot-product.txt");
  const extra = parseFlowFile("two-dot-two-product.txt");
  const merged = mergeFlowGraphs(dot, extra);
  const phase5 = synthesizePhase5HierarchicalRings(merged);

  const nodes = Object.values(phase5.topology.devices).map((device) => ({
    id: device.id,
    label: nodeLabel(device),
    type: device.type,
    color: nodeColor(device, merged.nodeColors),
    settings: deviceSettings(device),
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
      flowCount: merged.edges.length,
    },
    nodes,
    edges,
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
