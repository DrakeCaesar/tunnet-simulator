import "../style.css";
import {
  TunnetSimulator,
  buildPortAdjacency,
  portKey,
  type Topology,
  type SimulationStats,
  type PortRef,
  type Packet,
} from "../simulation";
import { endpointData, type EndpointDatasetRow } from "../builder/endpoint-data";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type SaveAddressElement =
  | "Zero"
  | "One"
  | "Two"
  | "Three"
  | "Wildcard";

interface SaveAddress {
  elements: SaveAddressElement[];
  address_type: string;
}

interface SaveNode {
  pos: [number, number, number];
  up?: [number, number, number];
  angle?: number;
}

interface SaveEndpoint {
  node: number;
  address: SaveAddress;
}

interface SaveRelay {
  node: number;
}

interface SaveFilter {
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

interface SaveHub {
  node: number;
  dir?: boolean;
}

interface SaveBridge {
  node: number;
}

interface SaveAntenna {
  node: number;
}

interface SaveData {
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

interface VisualNode {
  id: string;
  type: "endpoint" | "relay" | "filter" | "hub" | "bridge" | "antenna";
  x: number;
  y: number;
  portCount: number;
  label: string;
}

interface GraphModel {
  nodes: VisualNode[];
  links: Array<{ from: PortRef; to: PortRef }>;
  topology: Topology;
}

interface ViewportBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface WorldSummary {
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

const PACKET_IP_LABEL_CHAR_COUNT = 7;
const PACKET_IP_LABEL_MONO_CHAR_ADVANCE_PX = 6.1;
const PACKET_IP_LABEL_WIDTH_PX = Math.ceil(PACKET_IP_LABEL_CHAR_COUNT * PACKET_IP_LABEL_MONO_CHAR_ADVANCE_PX + 8);
const PACKET_IP_LABEL_HEIGHT_PX = 24;
const PACKET_DOT_RADIUS_PX = 8;
const PACKET_LABEL_ANCHOR_X_PX = PACKET_DOT_RADIUS_PX + 5;
const PACKET_IP_LABEL_OFFSET_X_PX = -3;
const PACKET_IP_LABEL_OFFSET_Y_PX = -13;
const WORLD_CHUNK_SIZE = 16;
const WORLD_CHUNK_RES = 32;
const WORLD_VOXEL_SIZE = WORLD_CHUNK_SIZE / WORLD_CHUNK_RES;
const WORLD_CHUNK_Y_SIGN = 1;
const WORLD_CHUNK_Y_OFFSET = 4;
const WORLD_LOCAL_Y_INVERT = true;

function fitBoxToViewportAspect(box: ViewportBox, viewportWidthPx: number, viewportHeightPx: number): ViewportBox {
  const vw = Math.max(1, viewportWidthPx);
  const vh = Math.max(1, viewportHeightPx);
  const target = vw / vh;
  const w = Math.max(1e-9, box.maxX - box.minX);
  const h = Math.max(1e-9, box.maxY - box.minY);
  const current = w / h;
  const cx = (box.minX + box.maxX) * 0.5;
  const cy = (box.minY + box.maxY) * 0.5;
  if (Math.abs(current - target) < 1e-9) {
    return box;
  }
  if (current < target) {
    const nextW = h * target;
    return {
      minX: cx - nextW * 0.5,
      maxX: cx + nextW * 0.5,
      minY: box.minY,
      maxY: box.maxY,
    };
  }
  const nextH = w / target;
  return {
    minX: box.minX,
    maxX: box.maxX,
    minY: cy - nextH * 0.5,
    maxY: cy + nextH * 0.5,
  };
}

function mountLayout(): HTMLDivElement {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("Missing #app root");
  app.innerHTML = `
    <div class="sv-root">
      <div class="sv-sidebar">
        <div class="card">
          <div class="section-title">Load save file</div>
          <div class="hint">Choose a Tunnet save JSON (contains nodes + edges + entities).</div>
          <input id="sv-file-input" type="file" accept=".json,application/json" />
          <div class="sv-button-row">
            <button id="sv-load-sample" type="button">Load bundled slot_0.json</button>
          </div>
        </div>
        <div class="card">
          <div class="section-title">Simulation</div>
          <div class="sim-buttons">
            <button id="sv-step" type="button">Step</button>
            <button id="sv-run" type="button">Run</button>
            <button id="sv-stop" type="button">Stop</button>
            <button id="sv-reset" type="button">Reset</button>
          </div>
          <label class="sim-send-rate-label" for="sv-tick-rate">Tick interval</label>
          <div class="sim-send-rate-row">
            <input id="sv-tick-rate" type="range" min="20" max="1000" step="10" value="200" />
            <span id="sv-tick-rate-value" class="meta">200 ms</span>
          </div>
          <div class="sim-buttons">
            <button id="sv-toggle-packet-ips" type="button">Hide IPs</button>
          </div>
          <div id="sv-stats" class="meta"></div>
        </div>
        <div class="card">
          <div class="section-title">View</div>
          <div class="sim-buttons">
            <button id="sv-zoom-in" type="button">Zoom in</button>
            <button id="sv-zoom-out" type="button">Zoom out</button>
            <button id="sv-zoom-fit" type="button">Fit</button>
            <button id="sv-view-toggle" type="button">Switch to 3D</button>
          </div>
          <label class="sim-send-rate-label" for="sv-block-orientation">Block orientation</label>
          <div class="sim-send-rate-row">
            <input id="sv-block-orientation" type="range" min="0" max="5" step="1" value="4" />
            <span id="sv-block-orientation-value" class="meta">4 (+Z)</span>
          </div>
          <label class="sim-send-rate-label" for="sv-cull-height">3D cull plane (top cut)</label>
          <div class="sim-send-rate-row">
            <input id="sv-cull-height" type="range" min="0" max="1000" step="1" value="1000" />
            <span id="sv-cull-height-value" class="meta">max</span>
          </div>
          <div id="sv-load-progress-wrap" class="hidden">
            <label class="sim-send-rate-label" for="sv-load-progress">3D load progress</label>
            <div class="sim-send-rate-row">
              <progress id="sv-load-progress" max="1000" value="0"></progress>
              <span id="sv-load-progress-value" class="meta">0%</span>
            </div>
            <div id="sv-load-progress-text" class="hint">idle</div>
          </div>
          <div class="hint">Mouse wheel to zoom. Drag on graph to pan (hand).</div>
        </div>
        <div class="card">
          <div class="section-title">Legend</div>
          <div class="sv-legend"></div>
          <div class="hint">Bridge and antenna are placeholders and currently behave like relay in simulation.</div>
        </div>
        <div class="card">
          <div class="section-title">World data</div>
          <div id="sv-world-summary" class="meta">Load a save file to inspect world sections.</div>
        </div>
      </div>
      <div class="sv-canvas-wrap">
        <svg id="sv-wires" class="sv-wires"></svg>
        <svg id="sv-packet-overlay" class="builder-packet-overlay" aria-hidden="true"></svg>
        <div id="sv-3d-view" class="sv-3d-view hidden" aria-hidden="true"></div>
      </div>
    </div>
  `;
  return app;
}

function decodeAddress(addr: SaveAddress | undefined): string {
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

function normalizeSave(raw: unknown): SaveData {
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

function buildWorldSummary(save: SaveData): WorldSummary {
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

function renderWorldSummary(summary: WorldSummary): void {
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

function buildGraphModel(save: SaveData): GraphModel {
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

function viewBoxFor(nodes: VisualNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
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

function nodeClass(type: VisualNode["type"]): string {
  return `sv-node sv-node-${type}`;
}

function clampZoom(z: number): number {
  return Math.max(0.2, Math.min(8, z));
}

function gridStepPowerOfTwo(unitsPerPixel: number): number {
  if (!Number.isFinite(unitsPerPixel) || unitsPerPixel <= 0) return 1;
  const targetPx = 96;
  const targetWorld = targetPx * unitsPerPixel;
  const exp = Math.round(Math.log2(Math.max(targetWorld, 1e-9)));
  return 2 ** exp;
}

function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step)));
}

function formatGridCoord(value: number, step: number): string {
  const d = decimalsForStep(step);
  const n = Number(value.toFixed(d));
  return String(n);
}

function renderGraph(model: GraphModel, camera: ViewportBox): ViewportBox | null {
  const wiresEl = document.querySelector<SVGSVGElement>("#sv-wires");
  const legendEl = document.querySelector<HTMLDivElement>(".sv-legend");
  if (!wiresEl || !legendEl) return null;

  wiresEl.innerHTML = "";
  const drawBox = fitBoxToViewportAspect(camera, wiresEl.clientWidth, wiresEl.clientHeight);
  const width = Math.max(1, drawBox.maxX - drawBox.minX);
  const height = Math.max(1, drawBox.maxY - drawBox.minY);
  wiresEl.setAttribute("viewBox", `${drawBox.minX} ${drawBox.minY} ${width} ${height}`);
  wiresEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const unitsPerPixelX = width / Math.max(1, wiresEl.clientWidth || 1);
  const unitsPerPixelY = height / Math.max(1, wiresEl.clientHeight || 1);
  const unitsPerPixel = Math.max(unitsPerPixelX, unitsPerPixelY);
  const textFontSize = 10 * unitsPerPixel;
  const textDx = 8 * unitsPerPixel;
  const textDy = -8 * unitsPerPixel;

  const gridGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gridGroup.setAttribute("class", "sv-grid");
  const majorStep = gridStepPowerOfTwo(unitsPerPixel);
  const minorStep = majorStep / 2;
  const x0Minor = Math.floor(drawBox.minX / minorStep) * minorStep;
  const y0Minor = Math.floor(drawBox.minY / minorStep) * minorStep;
  const labelMarginX = unitsPerPixelX * 6;
  const labelMarginY = unitsPerPixelY * 6;
  const labelSize = 10 * unitsPerPixel;

  for (let x = x0Minor; x <= drawBox.maxX; x += minorStep) {
    const isMajor = Math.abs(Math.round(x / majorStep) * majorStep - x) < minorStep * 0.05;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x));
    line.setAttribute("y1", String(drawBox.minY));
    line.setAttribute("x2", String(x));
    line.setAttribute("y2", String(drawBox.maxY));
    line.setAttribute("class", x === 0 ? "sv-grid-axis" : isMajor ? "sv-grid-line" : "sv-grid-line-minor");
    gridGroup.appendChild(line);

    if (isMajor) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "sv-grid-label");
      label.setAttribute("x", String(x + labelMarginX));
      label.setAttribute("y", String(drawBox.minY + labelMarginY));
      label.setAttribute("font-size", String(labelSize));
      label.textContent = formatGridCoord(x, majorStep);
      gridGroup.appendChild(label);
    }
  }
  for (let y = y0Minor; y <= drawBox.maxY; y += minorStep) {
    const isMajor = Math.abs(Math.round(y / majorStep) * majorStep - y) < minorStep * 0.05;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(drawBox.minX));
    line.setAttribute("y1", String(y));
    line.setAttribute("x2", String(drawBox.maxX));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", y === 0 ? "sv-grid-axis" : isMajor ? "sv-grid-line" : "sv-grid-line-minor");
    gridGroup.appendChild(line);

    if (isMajor) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "sv-grid-label");
      label.setAttribute("x", String(drawBox.minX + labelMarginX));
      label.setAttribute("y", String(y - labelMarginY));
      label.setAttribute("font-size", String(labelSize));
      label.textContent = formatGridCoord(y, majorStep);
      gridGroup.appendChild(label);
    }
  }
  wiresEl.appendChild(gridGroup);

  for (const link of model.links) {
    const fromNode = nodeById.get(link.from.deviceId);
    const toNode = nodeById.get(link.to.deviceId);
    if (!fromNode || !toNode) continue;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(fromNode.x));
    line.setAttribute("y1", String(fromNode.y));
    line.setAttribute("x2", String(toNode.x));
    line.setAttribute("y2", String(toNode.y));
    line.setAttribute("class", "sv-wire");
    wiresEl.appendChild(line);
  }

  for (const node of model.nodes) {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", nodeClass(node.type));
    group.setAttribute("data-device-id", node.id);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(node.x));
    circle.setAttribute("cy", String(node.y));
    circle.setAttribute("r", "0.6");
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(node.x + textDx));
    text.setAttribute("y", String(node.y + textDy));
    text.setAttribute("font-size", String(textFontSize));
    text.textContent = node.label;
    group.appendChild(circle);
    group.appendChild(text);
    wiresEl.appendChild(group);
  }

  const counts = model.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    return acc;
  }, {});
  legendEl.innerHTML = [
    "endpoint",
    "relay",
    "filter",
    "hub",
    "bridge",
    "antenna",
  ]
    .map((t) => `<div class="sv-legend-row"><span class="sv-chip sv-node-${t}"></span><span>${t}: ${counts[t] ?? 0}</span></div>`)
    .join("");
  return drawBox;
}

function renderPacketOverlay(
  model: GraphModel,
  prevOccupancy: Array<{ port: PortRef; packet: Packet }>,
  occupancy: Array<{ port: PortRef; packet: Packet }>,
  adjacency: Map<string, PortRef> | null,
  progress: number,
  showPacketIps: boolean,
  drawBox: ViewportBox | null,
): void {
  const overlayEl = document.querySelector<SVGSVGElement>("#sv-packet-overlay");
  const wiresEl = document.querySelector<SVGSVGElement>("#sv-wires");
  if (!overlayEl || !wiresEl || !adjacency || !drawBox) return;
  overlayEl.innerHTML = "";
  const overlayWidth = Math.max(1, wiresEl.clientWidth);
  const overlayHeight = Math.max(1, wiresEl.clientHeight);
  overlayEl.setAttribute("width", String(overlayWidth));
  overlayEl.setAttribute("height", String(overlayHeight));
  overlayEl.setAttribute("viewBox", `0 0 ${overlayWidth} ${overlayHeight}`);
  if (occupancy.length === 0) return;
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const prevByPacketId = new Map(prevOccupancy.map((o) => [o.packet.id, o]));
  const packetGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlayEl.appendChild(packetGroup);

  const worldW = Math.max(1e-9, drawBox.maxX - drawBox.minX);
  const worldH = Math.max(1e-9, drawBox.maxY - drawBox.minY);
  const worldToScreen = (x: number, y: number): { x: number; y: number } => ({
    x: ((x - drawBox.minX) / worldW) * overlayWidth,
    y: ((y - drawBox.minY) / worldH) * overlayHeight,
  });

  for (const occ of occupancy) {
    const currentFromNode = nodeById.get(occ.port.deviceId);
    const neighborRef = adjacency.get(portKey(occ.port));
    const currentToNode = neighborRef ? nodeById.get(neighborRef.deviceId) : undefined;
    if (!currentFromNode || !currentToNode) continue;

    const prevOcc = prevByPacketId.get(occ.packet.id);
    const prevFromNode = prevOcc ? nodeById.get(prevOcc.port.deviceId) : undefined;
    const prevNeighborRef = prevOcc ? adjacency.get(portKey(prevOcc.port)) : undefined;
    const prevToNode = prevNeighborRef ? nodeById.get(prevNeighborRef.deviceId) : undefined;

    const currT = 0.35;
    const currentX = currentFromNode.x + (currentToNode.x - currentFromNode.x) * currT;
    const currentY = currentFromNode.y + (currentToNode.y - currentFromNode.y) * currT;
    const previousX =
      prevFromNode && prevToNode ? prevFromNode.x + (prevToNode.x - prevFromNode.x) * currT : currentX;
    const previousY =
      prevFromNode && prevToNode ? prevFromNode.y + (prevToNode.y - prevFromNode.y) * currT : currentY;
    const x = previousX + (currentX - previousX) * progress;
    const y = previousY + (currentY - previousY) * progress;
    const p = worldToScreen(x, y);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "builder-packet-dot");
    circle.setAttribute("r", String(PACKET_DOT_RADIUS_PX));
    const hue = (occ.packet.id * 47) % 360;
    circle.setAttribute("fill", `hsl(${hue} 82% 58%)`);
    circle.setAttribute("stroke", occ.packet.sensitive ? "#ff7f9f" : `hsl(${hue} 82% 38%)`);
    circle.setAttribute("stroke-width", "1.2");
    circle.setAttribute("data-packet-id", String(occ.packet.id));
    group.appendChild(circle);

    if (showPacketIps) {
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("class", "builder-packet-label-bg");
      bg.setAttribute("rx", "4");
      bg.setAttribute("ry", "4");
      bg.setAttribute("x", (PACKET_LABEL_ANCHOR_X_PX + PACKET_IP_LABEL_OFFSET_X_PX).toFixed(2));
      bg.setAttribute("y", PACKET_IP_LABEL_OFFSET_Y_PX.toFixed(2));
      bg.setAttribute("width", String(PACKET_IP_LABEL_WIDTH_PX));
      bg.setAttribute("height", String(PACKET_IP_LABEL_HEIGHT_PX));
      group.appendChild(bg);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("class", "builder-packet-label");
      text.setAttribute("dominant-baseline", "middle");
      text.setAttribute("x", String(PACKET_LABEL_ANCHOR_X_PX));
      text.setAttribute("y", "0");
      text.setAttribute("data-packet-id", String(occ.packet.id));
      const src = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      src.setAttribute("class", "builder-packet-label-src");
      src.setAttribute("dy", "-0.58em");
      src.setAttribute("x", String(PACKET_LABEL_ANCHOR_X_PX));
      src.textContent = occ.packet.src;
      const dest = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      dest.setAttribute("class", "builder-packet-label-dest");
      dest.setAttribute("dy", "1.16em");
      dest.setAttribute("x", String(PACKET_LABEL_ANCHOR_X_PX));
      dest.textContent = occ.packet.dest;
      text.append(src, dest);
      group.appendChild(text);
    }
    packetGroup.appendChild(group);
  }
}

function formatStats(stats: SimulationStats, inFlightPackets: number): string {
  return `tick ${stats.tick} | in-flight ${inFlightPackets} | emitted ${stats.emitted} | delivered ${stats.delivered} | dropped ${stats.dropped} | collisions ${stats.collisions}`;
}

type Viewer3DState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  animationFrame: number;
  clipPlane: THREE.Plane;
  cullBall: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  cullCenterX: number;
  cullCenterZ: number;
  cullMinY: number;
  cullMaxY: number;
  worldMeshes: THREE.Mesh[];
  worldMaterials: THREE.Material[];
  worldMeshWorker: Worker | null;
  setCullY: (y: number) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onKeyUp: (event: KeyboardEvent) => void;
  dispose: () => void;
};

type LoadProgressReporter = (phase: string, current: number, total: number) => Promise<void>;

type ChunkPos = { x: number; y: number; z: number };

type WorldMeshWorkerProgressMessage = {
  type: "progress";
  phase: string;
  current: number;
  total: number;
};

type WorldMeshWorkerChunkMessage = {
  type: "chunkMesh";
  key: string;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
};

type WorldMeshWorkerDoneMessage = {
  type: "done";
};

type WorldMeshWorkerOutMessage =
  | WorldMeshWorkerProgressMessage
  | WorldMeshWorkerChunkMessage
  | WorldMeshWorkerDoneMessage;

function parseChunkPosition(value: unknown): ChunkPos | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const x = Number(v.x);
  const y = Number(v.y);
  const z = Number(v.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function blockOrientationLabel(mode: number): string {
  const m = Math.max(0, Math.min(5, Math.floor(mode)));
  if (m === 0) return "0 (+Y)";
  if (m === 1) return "1 (-Y)";
  if (m === 2) return "2 (+X)";
  if (m === 3) return "3 (-X)";
  if (m === 4) return "4 (+Z)";
  return "5 (-Z)";
}

async function createOrRefresh3DWorld(
  container: HTMLDivElement,
  save: SaveData,
  blockOrientation: number,
  previous: Viewer3DState | null,
  reportProgress: LoadProgressReporter,
): Promise<Viewer3DState | null> {
  if (previous) {
    previous.dispose();
  }
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  if (!save.nodes.length || width <= 0 || height <= 0) {
    return null;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x0d1018, 1);
  renderer.localClippingEnabled = true;
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 0.35);
  directional.position.set(20, 35, 20);
  scene.add(directional);

  const worldPoints = save.nodes.map((n) => new THREE.Vector3(n.pos[0] ?? 0, n.pos[1] ?? 0, n.pos[2] ?? 0));
  const bounds = new THREE.Box3();
  worldPoints.forEach((p) => bounds.expandByPoint(p));
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 20);
  let worldMinY = bounds.min.y;
  let worldMaxY = bounds.max.y;
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), worldMaxY + 1);

  const gridSize = Math.max(WORLD_CHUNK_SIZE, Math.ceil((radius * 2) / WORLD_CHUNK_SIZE) * WORLD_CHUNK_SIZE);
  const gridDivisions = Math.max(1, Math.round(gridSize / WORLD_CHUNK_SIZE));
  const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x395175, 0x202838);
  grid.position.set(center.x, bounds.min.y, center.z);
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const m of gridMaterials) {
    (m as THREE.Material).clippingPlanes = [clipPlane];
    (m as THREE.Material).clipIntersection = false;
  }
  scene.add(grid);

  const pointGeom = new THREE.BufferGeometry().setFromPoints(worldPoints);
  const pointMat = new THREE.PointsMaterial({ color: 0x89b4fa, size: 0.9, sizeAttenuation: true });
  pointMat.clippingPlanes = [clipPlane];
  pointMat.clipIntersection = false;
  const points = new THREE.Points(pointGeom, pointMat);
  scene.add(points);

  const edgeVerts: number[] = [];
  for (const edge of save.edges) {
    const a = edge[0]?.[0] ?? -1;
    const b = edge[1]?.[0] ?? -1;
    const pa = save.nodes[a]?.pos;
    const pb = save.nodes[b]?.pos;
    if (!pa || !pb) continue;
    edgeVerts.push(pa[0] ?? 0, pa[1] ?? 0, pa[2] ?? 0, pb[0] ?? 0, pb[1] ?? 0, pb[2] ?? 0);
  }
  const edgeGeom = new THREE.BufferGeometry();
  edgeGeom.setAttribute("position", new THREE.Float32BufferAttribute(edgeVerts, 3));
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x3f4d68, transparent: true, opacity: 0.9 });
  edgeMat.clippingPlanes = [clipPlane];
  edgeMat.clipIntersection = false;
  const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat);
  scene.add(edgeLines);

  const chunkEntries = Array.isArray(save.chunks) ? save.chunks : [];
  const worldMeshes: THREE.Mesh[] = [];
  const worldMaterials: THREE.Material[] = [];
  let worldMeshWorker: Worker | null = null;
  if (chunkEntries.length > 0) {
    await reportProgress("Preparing chunks", 0, Math.max(1, chunkEntries.length));
    // @ts-expect-error Bundled by Vite worker URL transform.
    worldMeshWorker = new Worker(new URL("./world-mesh.worker.ts", import.meta.url), { type: "module" });
    await new Promise<void>((resolve, reject) => {
      if (!worldMeshWorker) {
        resolve();
        return;
      }
      const worker = worldMeshWorker;
      let done = false;
      const cleanup = (): void => {
        worker.removeEventListener("message", onMessage as EventListener);
        worker.removeEventListener("error", onError as EventListener);
      };
      const onError = (event: ErrorEvent): void => {
        if (done) return;
        done = true;
        cleanup();
        worker.terminate();
        if (worldMeshWorker === worker) {
          worldMeshWorker = null;
        }
        reject(event.error ?? new Error(event.message || "Chunk meshing worker failed"));
      };
      const onMessage = (event: MessageEvent<WorldMeshWorkerOutMessage>): void => {
        if (done) return;
        const msg = event.data;
        if (msg.type === "progress") {
          void reportProgress(msg.phase, msg.current, msg.total);
          return;
        }
        if (msg.type === "chunkMesh") {
          if (msg.positions.length === 0) return;
          const geom = new THREE.BufferGeometry();
          geom.setAttribute("position", new THREE.BufferAttribute(msg.positions, 3));
          geom.setAttribute("normal", new THREE.BufferAttribute(msg.normals, 3));
          geom.setAttribute("color", new THREE.BufferAttribute(msg.colors, 3));
          const mat = new THREE.MeshPhongMaterial({
            vertexColors: true,
            transparent: false,
            opacity: 1,
            side: THREE.DoubleSide,
          });
          mat.clippingPlanes = [clipPlane];
          mat.clipIntersection = false;
          worldMaterials.push(mat);
          const mesh = new THREE.Mesh(geom, mat);
          mesh.name = `chunk:${msg.key}`;
          worldMeshes.push(mesh);
          scene.add(mesh);
          const posAttr = geom.getAttribute("position");
          if (posAttr) {
            for (let i = 1; i < posAttr.array.length; i += 3) {
              const y = Number(posAttr.array[i] ?? 0);
              if (y < worldMinY) worldMinY = y;
              if (y > worldMaxY) worldMaxY = y;
            }
          }
          return;
        }
        if (msg.type === "done") {
          done = true;
          cleanup();
          worker.terminate();
          if (worldMeshWorker === worker) {
            worldMeshWorker = null;
          }
          resolve();
        }
      };
      worker.addEventListener("message", onMessage as EventListener);
      worker.addEventListener("error", onError as EventListener);
      worker.postMessage({
        type: "init",
        chunks: chunkEntries,
        orientation: blockOrientation,
        chunkSize: WORLD_CHUNK_SIZE,
        chunkRes: WORLD_CHUNK_RES,
        voxelSize: WORLD_VOXEL_SIZE,
        chunkYSign: WORLD_CHUNK_Y_SIGN,
        chunkYOffset: WORLD_CHUNK_Y_OFFSET,
        localYInvert: WORLD_LOCAL_Y_INVERT,
      });
    });
  }

  const chunkTypeEntries = Array.isArray(save.chunk_types) ? save.chunk_types : [];
  const chunkTypePoints: THREE.Vector3[] = [];
  for (const raw of chunkTypeEntries) {
    if (!Array.isArray(raw) || raw.length < 1) continue;
    const pos = parseChunkPosition(raw[0]);
    if (!pos) continue;
    chunkTypePoints.push(
      new THREE.Vector3(
        pos.x * WORLD_CHUNK_SIZE + WORLD_CHUNK_SIZE * 0.5,
        pos.y * WORLD_CHUNK_SIZE * WORLD_CHUNK_Y_SIGN + WORLD_CHUNK_Y_OFFSET + WORLD_CHUNK_SIZE * 0.5,
        pos.z * WORLD_CHUNK_SIZE + WORLD_CHUNK_SIZE * 0.5,
      ),
    );
  }
  if (chunkTypePoints.length > 0) {
    const ctGeom = new THREE.BufferGeometry().setFromPoints(chunkTypePoints);
    const ctMat = new THREE.PointsMaterial({ color: 0xf9e2af, size: 1.3, sizeAttenuation: true });
    ctMat.clippingPlanes = [clipPlane];
    ctMat.clipIntersection = false;
    const ctPoints = new THREE.Points(ctGeom, ctMat);
    scene.add(ctPoints);
  }
  const cullCenterX = center.x;
  const cullCenterZ = center.z;
  const cullBall = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(0.8, WORLD_CHUNK_SIZE * 0.08), 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xf9e2af }),
  );
  scene.add(cullBall);
  const setCullY = (y: number): void => {
    const yy = Math.max(worldMinY, Math.min(worldMaxY + WORLD_CHUNK_SIZE * 0.5, y));
    clipPlane.constant = yy;
    cullBall.position.set(cullCenterX, yy, cullCenterZ);
  };
  setCullY(worldMaxY + WORLD_CHUNK_SIZE * 0.5);

  const playerPos = save.player?.pos;
  if (Array.isArray(playerPos) && playerPos.length >= 3) {
    camera.position.set(playerPos[0] + radius * 0.3, playerPos[1] + radius * 0.2, playerPos[2] + radius * 0.3);
    controls.target.set(playerPos[0], playerPos[1], playerPos[2]);
  } else {
    camera.position.set(center.x + radius * 0.8, center.y + radius * 0.6, center.z + radius * 0.8);
    controls.target.copy(center);
  }
  controls.update();
  const keyState = { w: false, a: false, s: false, d: false };
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (event.code === "KeyW") keyState.w = true;
    else if (event.code === "KeyA") keyState.a = true;
    else if (event.code === "KeyS") keyState.s = true;
    else if (event.code === "KeyD") keyState.d = true;
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "KeyW") keyState.w = false;
    else if (event.code === "KeyA") keyState.a = false;
    else if (event.code === "KeyS") keyState.s = false;
    else if (event.code === "KeyD") keyState.d = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  let lastFrameMs = performance.now();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();

  let stopped = false;
  const animate = (): void => {
    if (stopped) return;
    const now = performance.now();
    const dt = Math.max(0.001, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    move.set(0, 0, 0);
    if (keyState.w || keyState.a || keyState.s || keyState.d) {
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-8) {
        forward.set(0, 0, -1);
      } else {
        forward.normalize();
      }
      right.crossVectors(forward, camera.up).normalize();
      if (keyState.w) move.add(forward);
      if (keyState.s) move.sub(forward);
      if (keyState.d) move.add(right);
      if (keyState.a) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize();
        const speed = Math.max(8, radius * 0.35);
        const dx = move.x * speed * dt;
        const dy = move.y * speed * dt;
        const dz = move.z * speed * dt;
        camera.position.add(new THREE.Vector3(dx, dy, dz));
        controls.target.add(new THREE.Vector3(dx, dy, dz));
      }
    }
    controls.update();
    renderer.render(scene, camera);
    state.animationFrame = window.requestAnimationFrame(animate);
  };
  const state: Viewer3DState = {
    renderer,
    scene,
    camera,
    controls,
    animationFrame: 0,
    clipPlane,
    cullBall,
    cullCenterX,
    cullCenterZ,
    cullMinY: worldMinY,
    cullMaxY: worldMaxY + WORLD_CHUNK_SIZE * 0.5,
    worldMeshes,
    worldMaterials,
    worldMeshWorker,
    setCullY,
    onKeyDown,
    onKeyUp,
    dispose: () => {
      stopped = true;
      if (state.worldMeshWorker) {
        state.worldMeshWorker.postMessage({ type: "cancel" });
        state.worldMeshWorker.terminate();
        state.worldMeshWorker = null;
      }
      if (state.animationFrame) {
        window.cancelAnimationFrame(state.animationFrame);
      }
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      controls.dispose();
      for (const mesh of state.worldMeshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      for (const material of state.worldMaterials) {
        material.dispose();
      }
      pointGeom.dispose();
      pointMat.dispose();
      edgeGeom.dispose();
      edgeMat.dispose();
      renderer.dispose();
      container.innerHTML = "";
    },
  };
  animate();
  await reportProgress("Finalizing", 1, 1);
  return state;
}

async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  return JSON.parse(text);
}

async function fetchBundledSave(): Promise<unknown> {
  const res = await fetch("/saves/slot_0.json");
  if (!res.ok) {
    throw new Error("slot_0.json not found. Use file picker.");
  }
  return res.json();
}

async function fetchBundledSlot(index: number): Promise<unknown> {
  const safe = Math.max(0, Math.min(9, Math.floor(index)));
  const res = await fetch(`/saves/slot_${safe}.json`);
  if (!res.ok) {
    throw new Error(`slot_${safe}.json not found`);
  }
  return res.json();
}

function main(): void {
  const VIEW_MODE_STORAGE_KEY = "tunnet.saveViewer.viewMode";
  const BLOCK_ORIENTATION_STORAGE_KEY = "tunnet.saveViewer.blockOrientation";
  mountLayout();
  const fileInput = document.querySelector<HTMLInputElement>("#sv-file-input");
  const loadSampleButton = document.querySelector<HTMLButtonElement>("#sv-load-sample");
  const stepButton = document.querySelector<HTMLButtonElement>("#sv-step");
  const runButton = document.querySelector<HTMLButtonElement>("#sv-run");
  const stopButton = document.querySelector<HTMLButtonElement>("#sv-stop");
  const resetButton = document.querySelector<HTMLButtonElement>("#sv-reset");
  const tickRateInput = document.querySelector<HTMLInputElement>("#sv-tick-rate");
  const tickRateValue = document.querySelector<HTMLSpanElement>("#sv-tick-rate-value");
  const togglePacketIpsButton = document.querySelector<HTMLButtonElement>("#sv-toggle-packet-ips");
  const zoomInButton = document.querySelector<HTMLButtonElement>("#sv-zoom-in");
  const zoomOutButton = document.querySelector<HTMLButtonElement>("#sv-zoom-out");
  const zoomFitButton = document.querySelector<HTMLButtonElement>("#sv-zoom-fit");
  const viewToggleButton = document.querySelector<HTMLButtonElement>("#sv-view-toggle");
  const blockOrientationInput = document.querySelector<HTMLInputElement>("#sv-block-orientation");
  const blockOrientationValue = document.querySelector<HTMLSpanElement>("#sv-block-orientation-value");
  const cullHeightInput = document.querySelector<HTMLInputElement>("#sv-cull-height");
  const cullHeightValue = document.querySelector<HTMLSpanElement>("#sv-cull-height-value");
  const loadProgressWrap = document.querySelector<HTMLDivElement>("#sv-load-progress-wrap");
  const loadProgress = document.querySelector<HTMLProgressElement>("#sv-load-progress");
  const loadProgressValue = document.querySelector<HTMLSpanElement>("#sv-load-progress-value");
  const loadProgressText = document.querySelector<HTMLDivElement>("#sv-load-progress-text");
  const wiresEl = document.querySelector<SVGSVGElement>("#sv-wires");
  const packetOverlayEl = document.querySelector<SVGSVGElement>("#sv-packet-overlay");
  const view3DEl = document.querySelector<HTMLDivElement>("#sv-3d-view");
  const statsEl = document.querySelector<HTMLDivElement>("#sv-stats");
  if (
    !fileInput ||
    !loadSampleButton ||
    !stepButton ||
    !runButton ||
    !stopButton ||
    !resetButton ||
    !tickRateInput ||
    !tickRateValue ||
    !togglePacketIpsButton ||
    !zoomInButton ||
    !zoomOutButton ||
    !zoomFitButton ||
    !viewToggleButton ||
    !blockOrientationInput ||
    !blockOrientationValue ||
    !cullHeightInput ||
    !cullHeightValue ||
    !loadProgressWrap ||
    !loadProgress ||
    !loadProgressValue ||
    !loadProgressText ||
    !wiresEl ||
    !packetOverlayEl ||
    !view3DEl ||
    !statsEl
  ) {
    throw new Error("Missing save viewer controls");
  }

  let currentModel: GraphModel = { nodes: [], links: [], topology: { devices: {}, links: [] } };
  let currentSave: SaveData = normalizeSave({});
  let simulator: TunnetSimulator | null = null;
  let runTimer: number | null = null;
  let baseBox: ViewportBox = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  let cameraBox: ViewportBox = { ...baseBox };
  let simAdj: Map<string, PortRef> | null = null;
  let previousOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let currentOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let showPacketIps = true;
  let tickIntervalMs = 200;
  let isPanning = false;
  let panLastX = 0;
  let panLastY = 0;
  let packetAnimRaf: number | null = null;
  let use3DView = false;
  let blockOrientation = 4;
  let world3D: Viewer3DState | null = null;
  let world3DResizeHandler: (() => void) | null = null;
  let cullHeightT = 1;
  let worldBuildToken = 0;

  const renderGraphAndPackets = (progress = 1): void => {
    if (use3DView) {
      return;
    }
    const drawBox = renderGraph(currentModel, cameraBox);
    renderPacketOverlay(currentModel, previousOccupancy, currentOccupancy, simAdj, progress, showPacketIps, drawBox);
  };

  const updateLoadProgress = (phase: string, current: number, total: number): Promise<void> => {
    loadProgressWrap.classList.remove("hidden");
    const ratio = total <= 0 ? 0 : Math.max(0, Math.min(1, current / total));
    loadProgress.value = Math.round(ratio * 1000);
    loadProgressValue.textContent = `${Math.round(ratio * 100)}%`;
    loadProgressText.textContent = `${phase} (${current}/${Math.max(1, total)})`;
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  };

  const hideLoadProgress = (): void => {
    loadProgressWrap.classList.add("hidden");
  };

  const refresh3DWorld = async (): Promise<void> => {
    if (!use3DView) return;
    const token = ++worldBuildToken;
    await updateLoadProgress("Starting", 0, 1);
    const next = await createOrRefresh3DWorld(view3DEl, currentSave, blockOrientation, world3D, updateLoadProgress);
    if (token !== worldBuildToken) {
      next?.dispose();
      return;
    }
    world3D = next;
    if (world3D) {
      const y = world3D.cullMinY + (world3D.cullMaxY - world3D.cullMinY) * cullHeightT;
      world3D.setCullY(y);
      cullHeightValue.textContent = y.toFixed(1);
    }
    hideLoadProgress();
  };

  const applyViewMode = (): void => {
    const show3D = use3DView;
    wiresEl.classList.toggle("hidden", show3D);
    packetOverlayEl.classList.toggle("hidden", show3D);
    view3DEl.classList.toggle("hidden", !show3D);
    viewToggleButton.textContent = show3D ? "Switch to 2D" : "Switch to 3D";
    if (show3D) {
      refresh3DWorld();
      if (!world3DResizeHandler) {
        world3DResizeHandler = () => {
          if (!world3D || !use3DView) return;
          const w = Math.max(1, view3DEl.clientWidth);
          const h = Math.max(1, view3DEl.clientHeight);
          world3D.camera.aspect = w / h;
          world3D.camera.updateProjectionMatrix();
          world3D.renderer.setSize(w, h);
        };
        window.addEventListener("resize", world3DResizeHandler);
      }
      return;
    }
    if (world3D) {
      world3D.dispose();
      world3D = null;
    }
    if (world3DResizeHandler) {
      window.removeEventListener("resize", world3DResizeHandler);
      world3DResizeHandler = null;
    }
    renderGraphAndPackets();
  };

  const schedulePacketAnimation = (): void => {
    if (packetAnimRaf !== null) {
      window.cancelAnimationFrame(packetAnimRaf);
    }
    const start = performance.now();
    const animate = (): void => {
      const elapsed = performance.now() - start;
      const progress = Math.max(0, Math.min(1, elapsed / Math.max(1, tickIntervalMs)));
      renderGraphAndPackets(progress);
      if (progress < 1) {
        packetAnimRaf = window.requestAnimationFrame(animate);
      } else {
        packetAnimRaf = null;
      }
    };
    packetAnimRaf = window.requestAnimationFrame(animate);
  };

  const applyZoom = (factor: number): void => {
    const centerX = (cameraBox.minX + cameraBox.maxX) / 2;
    const centerY = (cameraBox.minY + cameraBox.maxY) / 2;
    const baseWidth = Math.max(1, baseBox.maxX - baseBox.minX);
    const baseHeight = Math.max(1, baseBox.maxY - baseBox.minY);
    const curWidth = Math.max(1, cameraBox.maxX - cameraBox.minX);
    const curHeight = Math.max(1, cameraBox.maxY - cameraBox.minY);
    const currentZoom = baseWidth / curWidth;
    const targetZoom = clampZoom(currentZoom * factor);
    const nextWidth = baseWidth / targetZoom;
    const nextHeight = baseHeight / targetZoom;
    cameraBox = {
      minX: centerX - nextWidth / 2,
      maxX: centerX + nextWidth / 2,
      minY: centerY - nextHeight / 2,
      maxY: centerY + nextHeight / 2,
    };
    renderGraphAndPackets();
  };

  const panByPixels = (dx: number, dy: number): void => {
    const width = Math.max(1, cameraBox.maxX - cameraBox.minX);
    const height = Math.max(1, cameraBox.maxY - cameraBox.minY);
    const unitsPerPixelX = width / Math.max(1, wiresEl.clientWidth || 1);
    const unitsPerPixelY = height / Math.max(1, wiresEl.clientHeight || 1);
    const worldDx = dx * unitsPerPixelX;
    const worldDy = dy * unitsPerPixelY;
    cameraBox = {
      minX: cameraBox.minX - worldDx,
      maxX: cameraBox.maxX - worldDx,
      minY: cameraBox.minY - worldDy,
      maxY: cameraBox.maxY - worldDy,
    };
    renderGraphAndPackets();
  };

  const stopRunLoop = (): void => {
    if (runTimer !== null) {
      window.clearInterval(runTimer);
      runTimer = null;
    }
  };

  const resetSimulator = (): void => {
    stopRunLoop();
    simulator = new TunnetSimulator(currentModel.topology, 1337);
    simAdj = buildPortAdjacency(currentModel.topology);
    const rt = simulator.exportRuntimeState();
    previousOccupancy = rt.occupancy;
    currentOccupancy = rt.occupancy;
    renderGraphAndPackets();
    statsEl.textContent = formatStats(rt.stats, rt.occupancy.length);
  };

  const renderAndReset = (raw: unknown): void => {
    const save = normalizeSave(raw);
    currentSave = save;
    currentModel = buildGraphModel(save);
    renderWorldSummary(buildWorldSummary(save));
    baseBox = viewBoxFor(currentModel.nodes);
    cameraBox = { ...baseBox };
    previousOccupancy = [];
    currentOccupancy = [];
    simAdj = buildPortAdjacency(currentModel.topology);
    if (use3DView) {
      void refresh3DWorld();
    } else {
      renderGraphAndPackets();
    }
    resetSimulator();
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const parsed = await readJsonFile(file);
      renderAndReset(parsed);
    } catch (err) {
      statsEl.textContent = `load error: ${String(err)}`;
    }
  });

  loadSampleButton.addEventListener("click", async () => {
    try {
      const parsed = await fetchBundledSave();
      renderAndReset(parsed);
    } catch (err) {
      statsEl.textContent = `sample load error: ${String(err)}`;
    }
  });

  stepButton.addEventListener("click", () => {
    if (!simulator) return;
    previousOccupancy = currentOccupancy;
    const next = simulator.step();
    currentOccupancy = simulator.getPortOccupancy().map((e) => ({ port: { ...e.port }, packet: { ...e.packet } }));
    schedulePacketAnimation();
    statsEl.textContent = formatStats(next.stats, next.inFlightPackets);
  });

  const runTick = (): void => {
    if (!simulator) return;
    previousOccupancy = currentOccupancy;
    const next = simulator.step();
    currentOccupancy = simulator.getPortOccupancy().map((e) => ({ port: { ...e.port }, packet: { ...e.packet } }));
    schedulePacketAnimation();
    statsEl.textContent = formatStats(next.stats, next.inFlightPackets);
  };

  runButton.addEventListener("click", () => {
    if (!simulator || runTimer !== null) return;
    runTimer = window.setInterval(runTick, tickIntervalMs);
  });

  stopButton.addEventListener("click", () => {
    stopRunLoop();
  });

  resetButton.addEventListener("click", () => {
    if (Object.keys(currentModel.topology.devices).length === 0) return;
    resetSimulator();
  });
  togglePacketIpsButton.addEventListener("click", () => {
    showPacketIps = !showPacketIps;
    togglePacketIpsButton.textContent = showPacketIps ? "Hide IPs" : "Show IPs";
    renderGraphAndPackets();
  });

  const TICK_RATE_STORAGE_KEY = "tunnet.saveViewer.tickIntervalMs";
  const savedTickInterval = Number(window.localStorage.getItem(TICK_RATE_STORAGE_KEY) ?? "");
  if (Number.isFinite(savedTickInterval) && savedTickInterval >= 20 && savedTickInterval <= 1000) {
    tickIntervalMs = Math.floor(savedTickInterval);
  }
  tickRateInput.value = String(tickIntervalMs);
  tickRateValue.textContent = `${tickIntervalMs} ms`;
  tickRateInput.addEventListener("input", () => {
    const value = Number.parseInt(tickRateInput.value, 10);
    tickIntervalMs = Number.isFinite(value) ? Math.max(20, Math.min(1000, value)) : 200;
    tickRateValue.textContent = `${tickIntervalMs} ms`;
    window.localStorage.setItem(TICK_RATE_STORAGE_KEY, String(tickIntervalMs));
    if (runTimer !== null) {
      window.clearInterval(runTimer);
      runTimer = window.setInterval(runTick, tickIntervalMs);
    }
  });

  zoomInButton.addEventListener("click", () => applyZoom(1.25));
  zoomOutButton.addEventListener("click", () => applyZoom(1 / 1.25));
  zoomFitButton.addEventListener("click", () => {
    cameraBox = { ...baseBox };
    renderGraphAndPackets();
  });
  viewToggleButton.addEventListener("click", () => {
    use3DView = !use3DView;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, use3DView ? "3d" : "2d");
    applyViewMode();
  });
  const savedBlockOrientation = Number.parseInt(window.localStorage.getItem(BLOCK_ORIENTATION_STORAGE_KEY) ?? "", 10);
  if (Number.isFinite(savedBlockOrientation)) {
    blockOrientation = Math.max(0, Math.min(5, savedBlockOrientation));
  }
  blockOrientationInput.value = String(blockOrientation);
  blockOrientationInput.addEventListener("input", () => {
    const n = Number.parseInt(blockOrientationInput.value, 10);
    blockOrientation = Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
    window.localStorage.setItem(BLOCK_ORIENTATION_STORAGE_KEY, String(blockOrientation));
    blockOrientationValue.textContent = blockOrientationLabel(blockOrientation);
    if (use3DView) {
      void refresh3DWorld();
    }
  });
  cullHeightInput.addEventListener("input", () => {
    const n = Number.parseInt(cullHeightInput.value, 10);
    const t = Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) / 1000 : 1;
    cullHeightT = t;
    if (world3D) {
      const y = world3D.cullMinY + (world3D.cullMaxY - world3D.cullMinY) * cullHeightT;
      world3D.setCullY(y);
      cullHeightValue.textContent = y.toFixed(1);
    } else {
      cullHeightValue.textContent = `${Math.round(t * 100)}%`;
    }
  });
  blockOrientationValue.textContent = blockOrientationLabel(blockOrientation);
  cullHeightInput.value = String(Math.round(cullHeightT * 1000));
  cullHeightValue.textContent = "max";

  wiresEl.addEventListener(
    "wheel",
    (evt) => {
      evt.preventDefault();
      applyZoom(evt.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );
  wiresEl.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    isPanning = true;
    panLastX = evt.clientX;
    panLastY = evt.clientY;
    wiresEl.classList.add("is-panning");
    wiresEl.setPointerCapture(evt.pointerId);
  });
  wiresEl.addEventListener("pointermove", (evt) => {
    if (!isPanning) return;
    const dx = evt.clientX - panLastX;
    const dy = evt.clientY - panLastY;
    panLastX = evt.clientX;
    panLastY = evt.clientY;
    panByPixels(dx, dy);
  });
  wiresEl.addEventListener("pointerup", (evt) => {
    if (!isPanning) return;
    isPanning = false;
    wiresEl.classList.remove("is-panning");
    wiresEl.releasePointerCapture(evt.pointerId);
  });
  wiresEl.addEventListener("pointercancel", (evt) => {
    if (!isPanning) return;
    isPanning = false;
    wiresEl.classList.remove("is-panning");
    wiresEl.releasePointerCapture(evt.pointerId);
  });

  const savedViewMode = (window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) ?? "").trim().toLowerCase();
  if (savedViewMode === "3d") {
    use3DView = true;
  }
  statsEl.textContent = "Load a save file to start.";
  applyViewMode();
  void (async () => {
    try {
      const parsed = await fetchBundledSlot(3);
      renderAndReset(parsed);
      statsEl.textContent = "Loaded /saves/slot_3.json";
    } catch {
      // Ignore startup auto-load errors; user can still load from picker.
    }
  })();
}

main();
