import { endpointData, type EndpointDatasetRow } from "../builder/endpoint-data";
import type { Topology, SimulationStats, PortRef } from "../simulation";

export type SaveAddressElement = "Zero" | "One" | "Two" | "Three" | "Wildcard";

export interface SaveAddress {
  elements: SaveAddressElement[];
  address_type: string;
}

export interface SaveNode {
  pos: [number, number, number];
  up?: [number, number, number];
  angle?: number;
}

export interface SaveEndpoint {
  node: number;
  address: SaveAddress;
}

export interface SaveRelay {
  node: number;
}

export interface SaveFilter {
  node: number;
  config?: {
    port?: number;
    mask?: SaveAddress;
    addr?: "Src" | "Dst";
    action?: "DropPacket" | "SendBack";
    op?: "Match" | "Differ";
    collision?: "DropInbound" | "DropOutbound" | "SendBackOutbound";
  };
}

export interface SaveHub {
  node: number;
  dir?: boolean;
}

export interface SaveBridge {
  node: number;
}

export interface SaveAntenna {
  node: number;
}

export interface SaveData {
  nodes: SaveNode[];
  edges: Array<[[number, number], [number, number], number?]>;
  endpoints: SaveEndpoint[];
  relays: SaveRelay[];
  filters: SaveFilter[];
  hubs: SaveHub[];
  bridges: SaveBridge[];
  antennas: SaveAntenna[];
  player?: {
    pos?: [number, number, number];
    credits?: number;
  };
  story?: {
    state?: string;
    page_no?: number;
    visited_chunks?: unknown[];
    inventory?: unknown[];
    [key: string]: unknown;
  };
  pages?: unknown[];
  chunk_types?: unknown[];
  chunks?: unknown[];
  toolboxes?: unknown[];
}

export interface VisualNode {
  id: string;
  type: "endpoint" | "relay" | "filter" | "hub" | "bridge" | "antenna";
  x: number;
  y: number;
  portCount: number;
  label: string;
}

export interface GraphModel {
  nodes: VisualNode[];
  links: Array<{ from: PortRef; to: PortRef }>;
  topology: Topology;
}

export interface ViewportBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface WorldSummary {
  credits: number | null;
  playerPos: [number, number, number] | null;
  storyState: string | null;
  pageNo: number | null;
  pagesCount: number;
  chunkTypesCount: number;
  chunksCount: number;
  toolboxesCount: number;
  visitedChunksCount: number;
  inventoryCount: number;
}

export function decodeAddress(addr: SaveAddress | undefined): string {
  if (!addr?.elements || addr.elements.length !== 4) return "0.0.0.0";
  const map: Record<SaveAddressElement, string> = {
    Zero: "0",
    One: "1",
    Two: "2",
    Three: "3",
    Wildcard: "*",
  };
  return addr.elements.map((el) => map[el] ?? "0").join(".");
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function matchAddressPattern(pattern: string, address: string): boolean {
  const p = pattern.split(".");
  const a = address.split(".");
  if (p.length !== 4 || a.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === "*") continue;
    if (p[i] !== a[i]) return false;
  }
  return true;
}

function expandAddressTargets(targets: string[], knownAddresses: string[]): string[] {
  const expanded: string[] = [];
  for (const target of targets) {
    if (target.includes("*")) {
      for (const candidate of knownAddresses) {
        if (matchAddressPattern(target, candidate)) expanded.push(candidate);
      }
      continue;
    }
    expanded.push(target);
  }
  return uniqueList(expanded);
}

function attachEndpointGenerators(topologyDevices: Topology["devices"]): void {
  const endpointIds = Object.keys(topologyDevices).filter((id) => topologyDevices[id]?.type === "endpoint");
  const knownAddresses = uniqueList(
    endpointIds.map((id) => {
      const dev = topologyDevices[id];
      return dev && dev.type === "endpoint" ? dev.address : "0.0.0.0";
    }),
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const rowByAddress = new Map<string, EndpointDatasetRow>(endpointData.map((row) => [row.address, row]));

  for (const id of endpointIds) {
    const device = topologyDevices[id];
    if (!device || device.type !== "endpoint") continue;
    const address = device.address;
    const row = rowByAddress.get(address);
    const destinations = expandAddressTargets(row?.sends_to ?? [], knownAddresses).filter((d) => d !== address);
    const replyToSources = expandAddressTargets(row?.replies_to ?? [], knownAddresses).filter((d) => d !== address);
    const sendRate = Number.isFinite(row?.send_rate) ? Math.max(0, Math.floor(row!.send_rate)) : 0;
    const hasDatasetPeriodic = sendRate > 0 && destinations.length > 0;
    const hasDatasetReplies = replyToSources.length > 0;

    if (hasDatasetPeriodic || hasDatasetReplies) {
      device.generator = {
        destinations: hasDatasetPeriodic ? [...destinations] : [],
        replyToSources: [...replyToSources],
        minIntervalTicks: hasDatasetPeriodic ? sendRate : 1,
        maxIntervalTicks: hasDatasetPeriodic ? sendRate : 1,
        sensitiveChance: row?.sensitive ? 1 : 0,
        subjectPrefix: "SAVE-",
      };
      continue;
    }

    const fallbackDestinations = knownAddresses.filter((d) => d !== address);
    if (fallbackDestinations.length > 0) {
      device.generator = {
        destinations: fallbackDestinations,
        minIntervalTicks: 4,
        maxIntervalTicks: 10,
        sensitiveChance: 0.15,
        subjectPrefix: "SAVE-",
      };
    }
  }
}

function portCountFor(type: VisualNode["type"]): number {
  if (type === "endpoint") return 1;
  if (type === "hub") return 3;
  return 2;
}

export function normalizeSave(raw: unknown): SaveData {
  const src = (raw ?? {}) as Partial<SaveData>;
  return {
    nodes: Array.isArray(src.nodes) ? src.nodes : [],
    edges: Array.isArray(src.edges) ? src.edges : [],
    endpoints: Array.isArray(src.endpoints) ? src.endpoints : [],
    relays: Array.isArray(src.relays) ? src.relays : [],
    filters: Array.isArray(src.filters) ? src.filters : [],
    hubs: Array.isArray(src.hubs) ? src.hubs : [],
    bridges: Array.isArray(src.bridges) ? src.bridges : [],
    antennas: Array.isArray(src.antennas) ? src.antennas : [],
    player: src.player,
    story: src.story,
    pages: Array.isArray(src.pages) ? src.pages : [],
    chunk_types: Array.isArray(src.chunk_types) ? src.chunk_types : [],
    chunks: Array.isArray(src.chunks) ? src.chunks : [],
    toolboxes: Array.isArray(src.toolboxes) ? src.toolboxes : [],
  };
}

export function buildWorldSummary(save: SaveData): WorldSummary {
  const p = save.player?.pos;
  const playerPos =
    Array.isArray(p) && p.length >= 3
      ? ([Number(p[0] ?? 0), Number(p[1] ?? 0), Number(p[2] ?? 0)] as [number, number, number])
      : null;
  const story = save.story;
  return {
    credits: Number.isFinite(save.player?.credits) ? Number(save.player?.credits) : null,
    playerPos,
    storyState: typeof story?.state === "string" ? story.state : null,
    pageNo: Number.isFinite(story?.page_no) ? Number(story?.page_no) : null,
    pagesCount: save.pages?.length ?? 0,
    chunkTypesCount: save.chunk_types?.length ?? 0,
    chunksCount: save.chunks?.length ?? 0,
    toolboxesCount: save.toolboxes?.length ?? 0,
    visitedChunksCount: Array.isArray(story?.visited_chunks) ? story.visited_chunks.length : 0,
    inventoryCount: Array.isArray(story?.inventory) ? story.inventory.length : 0,
  };
}

export function renderWorldSummary(summary: WorldSummary): void {
  const el = document.querySelector<HTMLDivElement>("#sv-world-summary");
  if (!el) return;
  const pos = summary.playerPos
    ? `[${summary.playerPos[0].toFixed(2)}, ${summary.playerPos[1].toFixed(2)}, ${summary.playerPos[2].toFixed(2)}]`
    : "n/a";
  el.innerHTML = `
    <div class="kv"><span>Story state</span><strong>${summary.storyState ?? "n/a"}</strong></div>
    <div class="kv"><span>Credits</span><strong>${summary.credits ?? "n/a"}</strong></div>
    <div class="kv"><span>Player pos</span><strong>${pos}</strong></div>
    <div class="kv"><span>Page no</span><strong>${summary.pageNo ?? "n/a"}</strong></div>
    <div class="kv"><span>Pages</span><strong>${summary.pagesCount}</strong></div>
    <div class="kv"><span>Chunk types</span><strong>${summary.chunkTypesCount}</strong></div>
    <div class="kv"><span>Chunks</span><strong>${summary.chunksCount}</strong></div>
    <div class="kv"><span>Toolboxes</span><strong>${summary.toolboxesCount}</strong></div>
    <div class="kv"><span>Visited chunks</span><strong>${summary.visitedChunksCount}</strong></div>
    <div class="kv"><span>Inventory entries</span><strong>${summary.inventoryCount}</strong></div>
  `;
}

export function buildGraphModel(save: SaveData): GraphModel {
  const visuals: VisualNode[] = [];
  const nodeToDevice = new Map<number, VisualNode>();
  const topologyDevices: Topology["devices"] = {};

  function pushDevice(type: VisualNode["type"], nodeIndex: number, label: string, extra?: Record<string, unknown>): void {
    const p = save.nodes[nodeIndex]?.pos;
    if (!p) return;
    const id = `${type}-${nodeIndex}`;
    const node: VisualNode = {
      id,
      type,
      x: p[0] ?? 0,
      y: p[2] ?? 0,
      portCount: portCountFor(type),
      label,
    };
    visuals.push(node);
    nodeToDevice.set(nodeIndex, node);
    if (type === "endpoint") {
      const address = typeof extra?.address === "string" ? extra.address : "0.0.0.0";
      topologyDevices[id] = {
        id,
        type: "endpoint",
        address,
        state: { nextSendTick: 0 },
      };
      return;
    }
    if (type === "hub") {
      topologyDevices[id] = {
        id,
        type: "hub",
        rotation: extra?.rotation === "counterclockwise" ? "counterclockwise" : "clockwise",
      };
      return;
    }
    if (type === "filter") {
      topologyDevices[id] = {
        id,
        type: "filter",
        operatingPort: extra?.operatingPort === 1 ? 1 : 0,
        addressField: extra?.addressField === "source" ? "source" : "destination",
        operation: extra?.operation === "match" ? "match" : "differ",
        mask: typeof extra?.mask === "string" ? extra.mask : "*.*.*.*",
        action: extra?.action === "drop" ? "drop" : "send_back",
        collisionHandling:
          extra?.collisionHandling === "drop_outbound" || extra?.collisionHandling === "send_back_outbound"
            ? extra.collisionHandling
            : "drop_inbound",
      };
      return;
    }
    topologyDevices[id] = {
      id,
      type: "relay",
    };
  }

  save.endpoints.forEach((item) => {
    pushDevice("endpoint", item.node, decodeAddress(item.address), { address: decodeAddress(item.address) });
  });
  save.relays.forEach((item) => pushDevice("relay", item.node, "relay"));
  save.filters.forEach((item) =>
    pushDevice("filter", item.node, "filter", {
      operatingPort: item.config?.port ?? 0,
      addressField: item.config?.addr === "Src" ? "source" : "destination",
      operation: item.config?.op === "Match" ? "match" : "differ",
      mask: decodeAddress(item.config?.mask),
      action: item.config?.action === "DropPacket" ? "drop" : "send_back",
      collisionHandling:
        item.config?.collision === "DropOutbound"
          ? "drop_outbound"
          : item.config?.collision === "SendBackOutbound"
            ? "send_back_outbound"
            : "drop_inbound",
    }),
  );
  save.hubs.forEach((item) =>
    pushDevice("hub", item.node, "hub", { rotation: item.dir === false ? "counterclockwise" : "clockwise" }),
  );
  save.bridges.forEach((item) => pushDevice("bridge", item.node, "bridge"));
  save.antennas.forEach((item) => pushDevice("antenna", item.node, "antenna"));

  const links: Array<{ from: PortRef; to: PortRef }> = [];
  for (const edge of save.edges) {
    const left = edge[0];
    const right = edge[1];
    const fromNode = nodeToDevice.get(left?.[0] ?? -1);
    const toNode = nodeToDevice.get(right?.[0] ?? -1);
    if (!fromNode || !toNode) continue;
    const fromPort = Math.max(0, Math.min(fromNode.portCount - 1, left?.[1] ?? 0));
    const toPort = Math.max(0, Math.min(toNode.portCount - 1, right?.[1] ?? 0));
    links.push({
      from: { deviceId: fromNode.id, port: fromPort },
      to: { deviceId: toNode.id, port: toPort },
    });
  }

  attachEndpointGenerators(topologyDevices);

  return {
    nodes: visuals,
    links,
    topology: {
      devices: topologyDevices,
      links: links.map((l) => ({ a: l.from, b: l.to })),
    },
  };
}

export function viewBoxFor(nodes: VisualNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (nodes.length === 0) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  const padX = Math.max(4, (maxX - minX) * 0.1);
  const padY = Math.max(4, (maxY - minY) * 0.1);
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

export function clampZoom(z: number): number {
  return Math.max(0.2, Math.min(8, z));
}

export function formatStats(stats: SimulationStats, inFlightPackets: number): string {
  return `tick ${stats.tick} | in-flight ${inFlightPackets} | emitted ${stats.emitted} | delivered ${stats.delivered} | dropped ${stats.dropped} | collisions ${stats.collisions}`;
}
