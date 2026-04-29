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
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import type { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { applyWorldVertexAo, type WorldAoColorSet } from "./world-ao-block";
import { createWorldSsao, setWorldSsaoEnabled } from "./world-ao-ssao";
import { buildWorldCullCapGeometry, createWorldCullCapMaterial } from "./world-cull-cap";
import { createWorldGridLines, setWorldGridLineResolution, type WorldGridLines } from "./world-grid-lines";

{
  const meshProto = THREE.Mesh.prototype as THREE.Mesh & { __svBvhPatched?: boolean };
  if (!meshProto.__svBvhPatched) {
    (THREE.BufferGeometry.prototype as THREE.BufferGeometry & { computeBoundsTree?: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
    (THREE.BufferGeometry.prototype as THREE.BufferGeometry & { disposeBoundsTree?: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
    (THREE.Mesh.prototype as THREE.Mesh).raycast = acceleratedRaycast;
    meshProto.__svBvhPatched = true;
  }
}

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
const WORLD_CHUNK_Y_OFFSET = -1;
const SAVE_VIEWER_MINIMAP_MARGIN_PX = 16;
const SAVE_VIEWER_MINIMAP_CHUNKS_ACROSS = 7;
const SAVE_VIEWER_MINIMAP_PIXELS_PER_BLOCK = 2;
const SAVE_VIEWER_MINIMAP_VIEWPORT_SIZE_PX =
  SAVE_VIEWER_MINIMAP_CHUNKS_ACROSS * WORLD_CHUNK_RES * SAVE_VIEWER_MINIMAP_PIXELS_PER_BLOCK;
/** World-space Y offset for the 3D graph (node points + edge lines) as a group. */
const SAVE_VIEWER_GRAPH_ENTITY_Y_OFFSET = -1;

/**
 * 3D entity boxes: width (X), height (Y), depth (Z) in meters. Bottom sits on the node `pos` plane;
 * `nodes[].angle` (radians) rotates about Y.
 */
const SAVE_VIEWER_ENTITY_BOX_SIZE: Record<VisualNode["type"], [number, number, number]> = {
  endpoint: [1, 1.5, 0.5],
  relay: [0.25, 0.1, 0.25],
  filter: [0.25, 0.5, 0.25],
  hub: [0.5, 0.5, 0.25],
  bridge: [0.5, 0.1, 0.5],
  antenna: [0.5, 0.1, 0.5],
};

const SAVE_VIEWER_ENTITY_BOX_COLOR: Record<VisualNode["type"], number> = {
  endpoint: 0x89b4fa,
  relay: 0xcba6f7,
  filter: 0xf38ba8,
  hub: 0xf9e2af,
  bridge: 0x94e2d5,
  antenna: 0xa6e3a1,
};
const SAVE_VIEWER_ENTITY_NON_WORLD_UP_COLOR = 0xff7a18;
const SAVE_VIEWER_ENTITY_LOCAL_UP = new THREE.Vector3(0, 1, 0);

function nodeUpVector(node: SaveNode | undefined): THREE.Vector3 {
  const up = node?.up;
  if (!Array.isArray(up) || up.length < 3) return SAVE_VIEWER_ENTITY_LOCAL_UP.clone();
  const v = new THREE.Vector3(Number(up[0] ?? 0), Number(up[1] ?? 0), Number(up[2] ?? 0));
  if (v.lengthSq() < 1e-10) return SAVE_VIEWER_ENTITY_LOCAL_UP.clone();
  return v.normalize();
}

function nodeHasNonWorldUp(node: SaveNode | undefined): boolean {
  const up = nodeUpVector(node);
  const epsilon = 1e-4;
  return (
    Math.abs(up.x) > epsilon ||
    Math.abs(up.y - 1) > epsilon ||
    Math.abs(up.z) > epsilon
  );
}

function ensureUv2Attribute(geometry: THREE.BufferGeometry): void {
  const uv = geometry.getAttribute("uv");
  if (!uv || geometry.getAttribute("uv2")) return;
  const uv2Array = new Float32Array(uv.array as ArrayLike<number>);
  geometry.setAttribute("uv2", new THREE.BufferAttribute(uv2Array, 2));
}

function createEntityBoxAoTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }
  const grad = ctx.createRadialGradient(size * 0.5, size * 0.5, size * 0.1, size * 0.5, size * 0.5, size * 0.7);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.75, "#d0d0d0");
  grad.addColorStop(1, "#8a8a8a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

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
          <input id="sv-file-input" class="sv-file-input" type="file" accept=".json,application/json" />
          <label class="sim-send-rate-label" for="sv-slot-index">Bundled slot</label>
          <div class="sim-send-rate-row">
            <input id="sv-slot-index" type="range" min="0" max="3" step="1" value="3" />
            <span id="sv-slot-index-value" class="meta">slot_3.json</span>
          </div>
          <div class="sv-button-row sim-buttons">
            <button id="sv-load-sample" type="button">Load bundled slot_3.json</button>
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
            <button id="sv-fps-toggle" type="button">Pilot mode: off</button>
            <button id="sv-gravity-toggle" type="button">Gravity: on</button>
            <button id="sv-ssao-toggle" type="button">SSAO: on</button>
            <button id="sv-block-ao-toggle" type="button">Block AO: on</button>
            <button id="sv-hemi-ao-toggle" type="button">Hemi AO: off</button>
            <button id="sv-reset-camera" type="button">Reset camera</button>
          </div>
          <label class="sim-send-rate-label" for="sv-teleport-endpoint">Teleport to endpoint</label>
          <div class="sim-send-rate-row sv-inline-action-row">
            <input id="sv-teleport-endpoint" type="text" value="0.3.0.0" spellcheck="false" />
            <button id="sv-teleport-button" type="button">Teleport</button>
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
  composer: EffectComposer | null;
  ssaoPass: SSAOPass | null;
  outputPass: OutputPass | null;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  animationFrame: number;
  clipPlane: THREE.Plane;
  cullMinY: number;
  cullMaxY: number;
  worldMeshes: THREE.Mesh[];
  cullCapMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;
  worldBoundaryLines: WorldGridLines[];
  worldMaterials: THREE.Material[];
  worldMeshWorkers: Worker[];
  isFirstPerson: boolean;
  gravityEnabled: boolean;
  setCullY: (y: number) => void;
  setFirstPersonMode: (enabled: boolean) => void;
  setGravityEnabled: (enabled: boolean) => void;
  setVertexAoEnabled: (enabled: { blockAo: boolean; hemisphereAo: boolean }) => void;
  applyCameraState: (state: CameraPersistState) => void;
  teleportPilotTo: (position: [number, number, number]) => void;
  resetCamera: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onKeyUp: (event: KeyboardEvent) => void;
  dispose: () => void;
};

type LoadProgressReporter = (phase: string, current: number, total: number) => Promise<void>;

type ChunkPos = { x: number; y: number; z: number };
type CameraPersistState = {
  position: [number, number, number];
  target: [number, number, number];
};
type PilotPositionPersistState = [number, number, number];

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
  flatColors: Float32Array;
  edges: Float32Array;
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

async function createOrRefresh3DWorld(
  container: HTMLDivElement,
  save: SaveData,
  firstPersonMode: boolean,
  gravityEnabledInitial: boolean,
  blockAoEnabledInitial: boolean,
  hemisphereAoEnabledInitial: boolean,
  initialCameraState: CameraPersistState | null,
  onCameraStateChange: (state: CameraPersistState, isFirstPerson: boolean) => void,
  initialPilotPosition: PilotPositionPersistState | null,
  onPilotPositionChange: (position: PilotPositionPersistState) => void,
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
  const perfOverlay = document.createElement("div");
  perfOverlay.style.position = "absolute";
  perfOverlay.style.top = "10px";
  perfOverlay.style.right = "10px";
  perfOverlay.style.width = "280px";
  perfOverlay.style.padding = "12px";
  perfOverlay.style.borderRadius = "8px";
  perfOverlay.style.background = "rgba(10, 14, 24, 0.78)";
  perfOverlay.style.color = "#cdd6f4";
  perfOverlay.style.font = "14px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  perfOverlay.style.pointerEvents = "none";
  perfOverlay.style.zIndex = "5";
  perfOverlay.style.border = "1px solid rgba(137, 180, 250, 0.25)";
  const perfSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  perfSvg.setAttribute("viewBox", "0 0 120 120");
  perfSvg.style.width = "138px";
  perfSvg.style.height = "138px";
  perfSvg.style.display = "block";
  perfSvg.style.margin = "0 auto 8px auto";
  const perfLegend = document.createElement("div");
  perfLegend.style.display = "grid";
  perfLegend.style.gridTemplateColumns = "1fr";
  perfLegend.style.gap = "2px";
  const perfFrameLabel = document.createElement("div");
  perfFrameLabel.style.opacity = "0.9";
  perfFrameLabel.style.marginBottom = "6px";
  perfFrameLabel.style.fontSize = "13px";
  perfOverlay.append(perfSvg, perfFrameLabel, perfLegend);
  container.appendChild(perfOverlay);

  const perfSlices = [
    { key: "visibility", label: "visibility", color: "#89b4fa" },
    { key: "sim_input", label: "sim input", color: "#f38ba8" },
    { key: "sim_collision", label: "sim collide", color: "#eba0ac" },
    { key: "sim_vertical", label: "sim vertical", color: "#fab387" },
    { key: "sim_sync", label: "sim sync", color: "#f9e2af" },
    { key: "update", label: "update", color: "#94e2d5" },
    { key: "render_main", label: "render main", color: "#a6e3a1" },
    { key: "render_minimap", label: "render map", color: "#74c7ec" },
    { key: "other", label: "other", color: "#7f849c" },
  ] as const;
  type PerfSliceKey = (typeof perfSlices)[number]["key"];
  const perfEma: Record<PerfSliceKey, number> = {
    visibility: 0,
    sim_input: 0,
    sim_collision: 0,
    sim_vertical: 0,
    sim_sync: 0,
    update: 0,
    render_main: 0,
    render_minimap: 0,
    other: 0,
  };
  let perfFrameEma = 0;
  let lastPerfUiMs = 0;
  const PERF_UI_INTERVAL_MS = 250;
  const PERF_EMA_ALPHA = 0.22;
  const mkWedgePath = (cx: number, cy: number, r: number, start: number, end: number): string => {
    const x0 = cx + r * Math.cos(start);
    const y0 = cy + r * Math.sin(start);
    const x1 = cx + r * Math.cos(end);
    const y1 = cy + r * Math.sin(end);
    const largeArc = end - start > Math.PI ? 1 : 0;
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1} Z`;
  };
  const drawPerfPie = (frameMs: number): void => {
    const total = Math.max(0.0001, perfSlices.reduce((s, p) => s + perfEma[p.key], 0));
    perfSvg.innerHTML = "";
    let angle = -Math.PI * 0.5;
    for (const slice of perfSlices) {
      const value = perfEma[slice.key];
      const span = (value / total) * Math.PI * 2;
      if (span <= 1e-5) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", mkWedgePath(60, 60, 54, angle, angle + span));
      path.setAttribute("fill", slice.color);
      path.setAttribute("opacity", "0.92");
      perfSvg.appendChild(path);
      angle += span;
    }
    const inner = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    inner.setAttribute("cx", "60");
    inner.setAttribute("cy", "60");
    inner.setAttribute("r", "30");
    inner.setAttribute("fill", "rgba(9, 12, 19, 0.95)");
    inner.setAttribute("stroke", "rgba(255,255,255,0.18)");
    inner.setAttribute("stroke-width", "1");
    perfSvg.appendChild(inner);
    const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
    txt.setAttribute("x", "60");
    txt.setAttribute("y", "57");
    txt.setAttribute("fill", "#cdd6f4");
    txt.setAttribute("font-size", "15");
    txt.setAttribute("text-anchor", "middle");
    txt.textContent = `${frameMs.toFixed(1)}ms`;
    perfSvg.appendChild(txt);
    const txt2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
    txt2.setAttribute("x", "60");
    txt2.setAttribute("y", "70");
    txt2.setAttribute("fill", "#a6adc8");
    txt2.setAttribute("font-size", "12");
    txt2.setAttribute("text-anchor", "middle");
    txt2.textContent = `${(1000 / Math.max(0.001, frameMs)).toFixed(0)} fps`;
    perfSvg.appendChild(txt2);
    perfFrameLabel.textContent = "Frame cost breakdown";
    perfLegend.innerHTML = perfSlices.map((slice) => {
      const v = perfEma[slice.key];
      const pct = (v / total) * 100;
      return `<div><span style="display:inline-block;width:8px;height:8px;background:${slice.color};margin-right:6px;border-radius:2px;"></span>${slice.label.padEnd(10, " ")} ${v.toFixed(2)}ms (${pct.toFixed(0)}%)</div>`;
    }).join("");
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 5000);
  let composer: EffectComposer | null = null;
  let ssaoPass: SSAOPass | null = null;
  let outputPass: OutputPass | null = null;
  const ssao = createWorldSsao(renderer, scene, camera, width, height);
  composer = ssao.composer;
  ssaoPass = ssao.ssaoPass;
  outputPass = ssao.outputPass;
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
  scene.add(grid);

  const deviceNodeIndexSet = new Set<number>();
  for (const e of save.endpoints) deviceNodeIndexSet.add(e.node);
  for (const r of save.relays) deviceNodeIndexSet.add(r.node);
  for (const f of save.filters) deviceNodeIndexSet.add(f.node);
  for (const h of save.hubs) deviceNodeIndexSet.add(h.node);
  for (const b of save.bridges) deviceNodeIndexSet.add(b.node);
  for (const a of save.antennas) deviceNodeIndexSet.add(a.node);

  const graphPointVectors: THREE.Vector3[] = [];
  for (let i = 0; i < save.nodes.length; i += 1) {
    if (deviceNodeIndexSet.has(i)) continue;
    const n = save.nodes[i];
    if (!n) continue;
    graphPointVectors.push(new THREE.Vector3(n.pos[0] ?? 0, n.pos[1] ?? 0, n.pos[2] ?? 0));
  }

  let pointGeom: THREE.BufferGeometry | null = null;
  let pointMat: THREE.PointsMaterial | null = null;
  let points: THREE.Points | null = null;
  if (graphPointVectors.length > 0) {
    pointGeom = new THREE.BufferGeometry().setFromPoints(graphPointVectors);
    pointMat = new THREE.PointsMaterial({ color: 0x7f849c, size: 0.65, sizeAttenuation: true });
    points = new THREE.Points(pointGeom, pointMat);
  }

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
  const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat);

  const placementsByKind: Record<VisualNode["type"], number[]> = {
    endpoint: save.endpoints.map((e) => e.node),
    relay: save.relays.map((r) => r.node),
    filter: save.filters.map((f) => f.node),
    hub: save.hubs.map((h) => h.node),
    bridge: save.bridges.map((b) => b.node),
    antenna: save.antennas.map((a) => a.node),
  };

  const entityBoxKinds: VisualNode["type"][] = ["endpoint", "relay", "filter", "hub", "bridge", "antenna"];
  const entityInstancedMeshes: THREE.InstancedMesh[] = [];
  const entityAoMaterials: THREE.MeshStandardMaterial[] = [];
  const entityAoTexture = createEntityBoxAoTexture();
  const instanceDummy = new THREE.Object3D();
  for (const kind of entityBoxKinds) {
    const nodeIndices = placementsByKind[kind];
    if (nodeIndices.length === 0) continue;
    const [bx, by, bz] = SAVE_VIEWER_ENTITY_BOX_SIZE[kind];
    const boxGeom = new THREE.BoxGeometry(bx, by, bz);
    ensureUv2Attribute(boxGeom);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      aoMap: entityAoTexture,
      aoMapIntensity: blockAoEnabledInitial ? 1 : 0,
      roughness: 0.88,
      metalness: 0.02,
      clippingPlanes: [clipPlane],
      clipIntersection: false,
    });
    entityAoMaterials.push(boxMat);
    const inst = new THREE.InstancedMesh(boxGeom, boxMat, nodeIndices.length);
    inst.name = `sv-entity-boxes-${kind}`;
    let instance = 0;
    const baseColor = new THREE.Color(SAVE_VIEWER_ENTITY_BOX_COLOR[kind]);
    const nonWorldUpColor = new THREE.Color(SAVE_VIEWER_ENTITY_NON_WORLD_UP_COLOR);
    const alignQuat = new THREE.Quaternion();
    const yawQuat = new THREE.Quaternion();
    const surfaceOffset = new THREE.Vector3();
    for (const nodeIndex of nodeIndices) {
      const node = save.nodes[nodeIndex];
      if (!node?.pos) continue;
      const px = node.pos[0] ?? 0;
      const py = node.pos[1] ?? 0;
      const pz = node.pos[2] ?? 0;
      const ang = node.angle;
      const yaw = typeof ang === "number" && Number.isFinite(ang) ? ang : 0;
      const up = nodeUpVector(node);
      surfaceOffset.copy(up).multiplyScalar(by * 0.5);
      instanceDummy.position.set(px + surfaceOffset.x, py + surfaceOffset.y, pz + surfaceOffset.z);
      alignQuat.setFromUnitVectors(SAVE_VIEWER_ENTITY_LOCAL_UP, up);
      yawQuat.setFromAxisAngle(up, yaw);
      instanceDummy.quaternion.copy(yawQuat).multiply(alignQuat);
      instanceDummy.updateMatrix();
      inst.setMatrixAt(instance, instanceDummy.matrix);
      inst.setColorAt(instance, nodeHasNonWorldUp(node) ? nonWorldUpColor : baseColor);
      instance += 1;
    }
    inst.count = instance;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    entityInstancedMeshes.push(inst);
  }

  const entityGraphGroup = new THREE.Group();
  entityGraphGroup.name = "sv-entity-graph";
  entityGraphGroup.position.y = SAVE_VIEWER_GRAPH_ENTITY_Y_OFFSET;
  if (points) entityGraphGroup.add(points);
  entityGraphGroup.add(edgeLines);
  for (const mesh of entityInstancedMeshes) {
    entityGraphGroup.add(mesh);
  }
  scene.add(entityGraphGroup);

  const chunkEntries = Array.isArray(save.chunks) ? save.chunks : [];
  const worldMeshes: THREE.Mesh[] = [];
  const worldBoundaryLines: WorldGridLines[] = [];
  const worldMaterials: THREE.Material[] = [];
  const worldMeshColorSets: WorldAoColorSet[] = [];
  const chunkVisibilityEntries: Array<{ mesh: THREE.Mesh; lines: WorldGridLines | null; center: THREE.Vector3; radius: number }> = [];
  const CHUNK_VIEW_DISTANCE = 8;
  const CHUNK_VISIBILITY_UPDATE_MS = 80;
  const visibilityFrustum = new THREE.Frustum();
  const visibilityProjMatrix = new THREE.Matrix4();
  let lastChunkVisibilityUpdateMs = -Infinity;
  const worldMeshWorkers: Worker[] = [];
  if (chunkEntries.length > 0) {
    await reportProgress("Preparing chunks", 0, Math.max(1, chunkEntries.length));
    const meshWorkerCount = Math.max(1, Math.min(12, chunkEntries.length));
    const shardSize = Math.ceil(chunkEntries.length / meshWorkerCount);
    const decodeProgress = new Array<number>(meshWorkerCount).fill(0);
    const decodeTotals = new Array<number>(meshWorkerCount).fill(0);
    const buildProgress = new Array<number>(meshWorkerCount).fill(0);
    const buildTotals = new Array<number>(meshWorkerCount).fill(0);
    const chunkEntryByKey = new Map<string, unknown[]>();
    for (const raw of chunkEntries) {
      if (!Array.isArray(raw) || raw.length < 2) continue;
      const pos = parseChunkPosition(raw[0]);
      if (!pos) continue;
      const key = `${pos.x},${pos.y},${pos.z}`;
      chunkEntryByKey.set(key, raw);
    }
    const reportCombinedProgress = (): void => {
      const buildCurrent = buildProgress.reduce((sum, value) => sum + value, 0);
      const buildTotal = buildTotals.reduce((sum, value) => sum + value, 0);
      void reportProgress("Processing chunks", buildCurrent, Math.max(1, buildTotal));
    };
    const workerTasks: Array<Promise<void>> = [];
    for (let workerIndex = 0; workerIndex < meshWorkerCount; workerIndex += 1) {
      const start = workerIndex * shardSize;
      const end = Math.min(chunkEntries.length, start + shardSize);
      if (start >= end) continue;
      const meshShard = chunkEntries.slice(start, end);
      const requiredKeys = new Set<string>();
      for (const raw of meshShard) {
        if (!Array.isArray(raw) || raw.length < 1) continue;
        const pos = parseChunkPosition(raw[0]);
        if (!pos) continue;
        requiredKeys.add(`${pos.x},${pos.y},${pos.z}`);
        requiredKeys.add(`${pos.x + 1},${pos.y},${pos.z}`);
        requiredKeys.add(`${pos.x - 1},${pos.y},${pos.z}`);
        requiredKeys.add(`${pos.x},${pos.y + 1},${pos.z}`);
        requiredKeys.add(`${pos.x},${pos.y - 1},${pos.z}`);
        requiredKeys.add(`${pos.x},${pos.y},${pos.z + 1}`);
        requiredKeys.add(`${pos.x},${pos.y},${pos.z - 1}`);
      }
      const requiredChunks: unknown[] = [];
      const requiredKeyList = Array.from(requiredKeys);
      for (const key of requiredKeyList) {
        const raw = chunkEntryByKey.get(key);
        if (raw) requiredChunks.push(raw);
      }
      decodeTotals[workerIndex] = requiredChunks.length;
      buildTotals[workerIndex] = meshShard.length;
      // @ts-expect-error Bundled by Vite worker URL transform.
      const worker = new Worker(new URL("./world-mesh.worker.ts", import.meta.url), { type: "module" });
      worldMeshWorkers.push(worker);
      workerTasks.push(new Promise<void>((resolve, reject) => {
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
          reject(event.error ?? new Error(event.message || "Chunk meshing worker failed"));
        };
        const onMessage = (event: MessageEvent<WorldMeshWorkerOutMessage>): void => {
          if (done) return;
          const msg = event.data;
          if (msg.type === "progress") {
            if (msg.phase.startsWith("Decoding")) {
              decodeProgress[workerIndex] = msg.current;
            } else {
              buildProgress[workerIndex] = msg.current;
            }
            reportCombinedProgress();
            return;
          }
          if (msg.type === "chunkMesh") {
            if (msg.positions.length === 0) return;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.BufferAttribute(msg.positions, 3));
            geom.setAttribute("normal", new THREE.BufferAttribute(msg.normals, 3));
            geom.setAttribute("color", new THREE.BufferAttribute(msg.flatColors, 3));
            const colorSet: WorldAoColorSet = {
              geometry: geom,
              blockAoColors: msg.colors,
              flatColors: msg.flatColors,
            };
            worldMeshColorSets.push(colorSet);
            applyWorldVertexAo([colorSet], {
              blockAoEnabled: blockAoEnabledInitial,
              hemisphereAoEnabled: hemisphereAoEnabledInitial,
            });
            (geom as THREE.BufferGeometry & { computeBoundsTree?: () => void }).computeBoundsTree?.();
            const mat = new THREE.MeshPhongMaterial({
              vertexColors: true,
              transparent: false,
              opacity: 1,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            });
            mat.clippingPlanes = [clipPlane];
            mat.clipIntersection = false;
            worldMaterials.push(mat);
            const mesh = new THREE.Mesh(geom, mat);
            mesh.name = `chunk:${msg.key}`;
            worldMeshes.push(mesh);
            scene.add(mesh);
            let boundaryLines: WorldGridLines | null = null;
            if (msg.edges.length > 0) {
              const { lines, material: lineMat } = createWorldGridLines(msg.edges, width, height, clipPlane);
              worldMaterials.push(lineMat);
              boundaryLines = lines;
              boundaryLines.name = `chunk-grid:${msg.key}`;
              worldBoundaryLines.push(boundaryLines);
              scene.add(boundaryLines);
            }
            const keyParts = msg.key.split(",");
            const cx = Number(keyParts[0] ?? NaN);
            const cy = Number(keyParts[1] ?? NaN);
            const cz = Number(keyParts[2] ?? NaN);
            if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz)) {
              chunkVisibilityEntries.push({
                mesh,
                lines: boundaryLines,
                center: new THREE.Vector3(
                  cx * WORLD_CHUNK_SIZE + WORLD_CHUNK_SIZE * 0.5,
                  cy * WORLD_CHUNK_SIZE * WORLD_CHUNK_Y_SIGN + WORLD_CHUNK_Y_OFFSET + WORLD_CHUNK_SIZE * 0.5,
                  cz * WORLD_CHUNK_SIZE + WORLD_CHUNK_SIZE * 0.5,
                ),
                radius: (Math.sqrt(3) * WORLD_CHUNK_SIZE) * 0.5,
              });
            }
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
            resolve();
          }
        };
        worker.addEventListener("message", onMessage as EventListener);
        worker.addEventListener("error", onError as EventListener);
        worker.postMessage({
          type: "init",
          allChunks: requiredChunks,
          meshChunks: meshShard,
          chunkSize: WORLD_CHUNK_SIZE,
          chunkRes: WORLD_CHUNK_RES,
          voxelSize: WORLD_VOXEL_SIZE,
          chunkYSign: WORLD_CHUNK_Y_SIGN,
          chunkYOffset: WORLD_CHUNK_Y_OFFSET,
        });
      }));
    }
    await Promise.all(workerTasks);
  }

  const cullCapMat = createWorldCullCapMaterial();
  worldMaterials.push(cullCapMat);
  const cullCapMesh = new THREE.Mesh(new THREE.BufferGeometry(), cullCapMat);
  cullCapMesh.name = "sv-cull-cap";
  cullCapMesh.renderOrder = 1;
  scene.add(cullCapMesh);
  const updateCullCap = (y: number): void => {
    cullCapMesh.geometry.dispose();
    if (y >= worldMaxY - 1e-3) {
      cullCapMesh.geometry = new THREE.BufferGeometry();
      cullCapMesh.visible = false;
      return;
    }
    cullCapMesh.geometry = buildWorldCullCapGeometry(worldMeshes, y);
    cullCapMesh.visible = cullCapMesh.geometry.getAttribute("position")?.count > 0;
  };
  const setCullY = (y: number): void => {
    const yy = Math.max(worldMinY, Math.min(worldMaxY + WORLD_CHUNK_SIZE * 0.5, y));
    clipPlane.constant = yy;
    updateCullCap(yy);
  };
  setCullY(worldMaxY + WORLD_CHUNK_SIZE * 0.5);

  const playerPos = save.player?.pos;
  const pilotResetSpawn = (() => {
    for (const ep of save.endpoints) {
      if (decodeAddress(ep.address) !== "0.0.0.0") continue;
      const nodePos = save.nodes[ep.node]?.pos;
      if (Array.isArray(nodePos) && nodePos.length >= 3) {
        return [Number(nodePos[0] ?? 0), Number(nodePos[1] ?? 0), Number(nodePos[2] ?? 0)] as [number, number, number];
      }
    }
    if (Array.isArray(playerPos) && playerPos.length >= 3) {
      return [Number(playerPos[0] ?? 0), Number(playerPos[1] ?? 0), Number(playerPos[2] ?? 0)] as [number, number, number];
    }
    return null;
  })();
  const playerMarkerGeom = new THREE.SphereGeometry(Math.max(0.8, WORLD_CHUNK_SIZE * 0.12), 20, 16);
  const playerMarkerMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6 });
  const playerMarker = new THREE.Mesh(playerMarkerGeom, playerMarkerMat);
  const canFirstPerson = Array.isArray(playerPos) && playerPos.length >= 3;
  const initialPilotFeetPos: [number, number, number] = initialPilotPosition && canFirstPerson
    ? [Number(initialPilotPosition[0] ?? 0), Number(initialPilotPosition[1] ?? 0), Number(initialPilotPosition[2] ?? 0)]
    : [Number(playerPos?.[0] ?? center.x), Number(playerPos?.[1] ?? center.y), Number(playerPos?.[2] ?? center.z)];
  let firstPersonActive = firstPersonMode && canFirstPerson;
  let gravityEnabled = gravityEnabledInitial;
  if (firstPersonActive) {
    playerMarker.position.set(initialPilotFeetPos[0], initialPilotFeetPos[1], initialPilotFeetPos[2]);
    scene.add(playerMarker);
    camera.position.set(initialPilotFeetPos[0], initialPilotFeetPos[1] + 2.5, initialPilotFeetPos[2]);
    controls.target.set(initialPilotFeetPos[0] + 1, initialPilotFeetPos[1] + 2.5, initialPilotFeetPos[2]);
  } else {
    camera.position.set(center.x + radius * 0.8, center.y + radius * 0.6, center.z + radius * 0.8);
    controls.target.copy(center);
  }
  if (
    initialCameraState &&
    Array.isArray(initialCameraState.position) &&
    initialCameraState.position.length >= 3 &&
    Array.isArray(initialCameraState.target) &&
    initialCameraState.target.length >= 3
  ) {
    camera.position.set(
      Number(initialCameraState.position[0] ?? 0),
      Number(initialCameraState.position[1] ?? 0),
      Number(initialCameraState.position[2] ?? 0),
    );
    controls.target.set(
      Number(initialCameraState.target[0] ?? 0),
      Number(initialCameraState.target[1] ?? 0),
      Number(initialCameraState.target[2] ?? 0),
    );
  }
  controls.update();
  const keyState = { w: false, a: false, s: false, d: false, jump: false };
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (event.code === "KeyW") keyState.w = true;
    else if (event.code === "KeyA") keyState.a = true;
    else if (event.code === "KeyS") keyState.s = true;
    else if (event.code === "KeyD") keyState.d = true;
    else if (event.code === "Space") keyState.jump = true;
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "KeyW") keyState.w = false;
    else if (event.code === "KeyA") keyState.a = false;
    else if (event.code === "KeyS") keyState.s = false;
    else if (event.code === "KeyD") keyState.d = false;
    else if (event.code === "Space") keyState.jump = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const lookState = { yaw: 0, pitch: 0 };
  if (firstPersonActive) {
    const lookDirInit = controls.target.clone().sub(camera.position);
    if (lookDirInit.lengthSq() > 1e-9) {
      lookDirInit.normalize();
      lookState.yaw = Math.atan2(lookDirInit.x, -lookDirInit.z);
      lookState.pitch = Math.asin(Math.max(-1, Math.min(1, lookDirInit.y)));
    }
  }
  const onMouseMove = (event: MouseEvent): void => {
    if (!firstPersonActive) return;
    if (document.pointerLockElement !== renderer.domElement) return;
    lookState.yaw += event.movementX * 0.0025;
    lookState.pitch -= event.movementY * 0.0025;
    lookState.pitch = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, lookState.pitch));
  };
  const onPointerLockClick = (): void => {
    if (!firstPersonActive) return;
    if (document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock();
    }
  };
  window.addEventListener("mousemove", onMouseMove);
  renderer.domElement.addEventListener("click", onPointerLockClick);
  let lastFrameMs = performance.now();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const moveForward = new THREE.Vector3();
  const moveRight = new THREE.Vector3();
  const playerFeet = new THREE.Vector3(
    initialPilotFeetPos[0],
    initialPilotFeetPos[1],
    initialPilotFeetPos[2],
  );
  let verticalVelocity = 0;
  let grounded = false;
  let lastPersistMs = 0;
  const physics = {
    eyeHeight: 1,
    moveSpeed: 11,
    jumpSpeed: 8.5,
    gravity: 24,
    radius: 0.34,
  };
  const minimapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  minimapCamera.up.set(0, 0, -1);
  const renderMinimap = (): void => {
    const viewW = Math.max(1, renderer.domElement.clientWidth);
    const viewH = Math.max(1, renderer.domElement.clientHeight);
    const size = Math.max(128, Math.min(SAVE_VIEWER_MINIMAP_VIEWPORT_SIZE_PX, Math.floor(Math.min(viewW, viewH) * 0.42)));
    const minimapWorldSize = SAVE_VIEWER_MINIMAP_CHUNKS_ACROSS * WORLD_CHUNK_SIZE;
    const halfWorld = minimapWorldSize * 0.5;
    const x = Math.max(0, viewW - size - SAVE_VIEWER_MINIMAP_MARGIN_PX);
    const y = SAVE_VIEWER_MINIMAP_MARGIN_PX;
    const playerHeadY = playerFeet.y + physics.eyeHeight;
    const oldClipConstant = clipPlane.constant;
    const oldCapVisible = cullCapMesh.visible;
    const oldClearColor = new THREE.Color();
    renderer.getClearColor(oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldWorldMeshVisibility = worldMeshes.map((mesh) => mesh.visible);
    const oldLineVisibility = worldBoundaryLines.map((lines) => lines.visible);

    minimapCamera.position.set(playerFeet.x, playerHeadY + 500, playerFeet.z);
    minimapCamera.left = -halfWorld;
    minimapCamera.right = halfWorld;
    minimapCamera.top = halfWorld;
    minimapCamera.bottom = -halfWorld;
    minimapCamera.lookAt(playerFeet.x, playerHeadY, playerFeet.z);
    minimapCamera.updateProjectionMatrix();
    minimapCamera.updateMatrixWorld();

    clipPlane.constant = playerHeadY;
    cullCapMesh.visible = false;
    const halfMap = halfWorld + WORLD_CHUNK_SIZE * 0.5;
    for (let i = 0; i < chunkVisibilityEntries.length; i += 1) {
      const entry = chunkVisibilityEntries[i]!;
      const inMap =
        Math.abs(entry.center.x - playerFeet.x) <= halfMap &&
        Math.abs(entry.center.z - playerFeet.z) <= halfMap;
      entry.mesh.visible = inMap;
      if (entry.lines) entry.lines.visible = false;
    }
    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, size, size);
    renderer.setScissor(x, y, size, size);
    renderer.setClearColor(0x111827, 0.96);
    renderer.clear(true, true, true);
    renderer.render(scene, minimapCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewW, viewH);
    renderer.setClearColor(oldClearColor, oldClearAlpha);
    for (let i = 0; i < worldMeshes.length; i += 1) {
      worldMeshes[i]!.visible = oldWorldMeshVisibility[i] ?? true;
    }
    for (let i = 0; i < worldBoundaryLines.length; i += 1) {
      worldBoundaryLines[i]!.visible = oldLineVisibility[i] ?? true;
    }
    cullCapMesh.visible = oldCapVisible;
    clipPlane.constant = oldClipConstant;
  };
  const applyVertexAoEnabled = (enabled: { blockAo: boolean; hemisphereAo: boolean }): void => {
    applyWorldVertexAo(worldMeshColorSets, {
      blockAoEnabled: enabled.blockAo,
      hemisphereAoEnabled: enabled.hemisphereAo,
    });
    for (const material of entityAoMaterials) {
      material.aoMapIntensity = enabled.blockAo ? 1 : 0;
      material.needsUpdate = true;
    }
  };
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  // Ray tests against nearby visible chunks are much cheaper than the full world mesh list.
  let collisionMeshes: THREE.Mesh[] = worldMeshes;
  const updateChunkVisibility = (nowMs: number): void => {
    if (chunkVisibilityEntries.length === 0) return;
    if (nowMs - lastChunkVisibilityUpdateMs < CHUNK_VISIBILITY_UPDATE_MS) return;
    lastChunkVisibilityUpdateMs = nowMs;
    const useDistanceCulling = firstPersonActive;
    const maxWorldDist = CHUNK_VIEW_DISTANCE * WORLD_CHUNK_SIZE;
    visibilityProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    visibilityFrustum.setFromProjectionMatrix(visibilityProjMatrix);
    const visibleCollisionMeshes: THREE.Mesh[] = [];
    for (const entry of chunkVisibilityEntries) {
      if (useDistanceCulling && camera.position.distanceTo(entry.center) > maxWorldDist) {
        entry.mesh.visible = false;
        if (entry.lines) entry.lines.visible = false;
        continue;
      }
      if (!visibilityFrustum.intersectsObject(entry.mesh)) {
        entry.mesh.visible = false;
        if (entry.lines) entry.lines.visible = false;
        continue;
      }
      entry.mesh.visible = true;
      if (entry.lines) entry.lines.visible = true;
      visibleCollisionMeshes.push(entry.mesh);
    }
    if (visibleCollisionMeshes.length > 0) {
      collisionMeshes = visibleCollisionMeshes;
    }
  };
  const capsuleSampleHeights = (): number[] => {
    const bottom = playerFeet.y + physics.radius;
    const mid = playerFeet.y + physics.eyeHeight * 0.5;
    const top = playerFeet.y + Math.max(physics.radius, physics.eyeHeight - physics.radius);
    return [bottom, mid, top];
  };
  const testWallBlocked = (dx: number, dz: number): boolean => {
    const len = Math.hypot(dx, dz);
    if (len < 1e-8) return false;
    const dir = new THREE.Vector3(dx / len, 0, dz / len);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const heights = capsuleSampleHeights();
    for (const y of heights) {
      const probeStarts = [
        new THREE.Vector3(playerFeet.x, y, playerFeet.z),
        new THREE.Vector3(playerFeet.x + side.x * physics.radius, y, playerFeet.z + side.z * physics.radius),
        new THREE.Vector3(playerFeet.x - side.x * physics.radius, y, playerFeet.z - side.z * physics.radius),
      ];
      for (const start of probeStarts) {
        raycaster.set(start, dir);
        raycaster.far = len + physics.radius;
        if (raycaster.intersectObjects(collisionMeshes, false).length > 0) return true;
      }
    }
    return false;
  };

  let stopped = false;
  const animate = (): void => {
    if (stopped) return;
    const frameStartMs = performance.now();
    const dt = Math.max(0.001, (frameStartMs - lastFrameMs) / 1000);
    lastFrameMs = frameStartMs;
    // Large frame gaps (tab switch, GC, heavy load) cause tunneling through thin collision.
    const pilotDt = Math.min(dt, 0.05);
    const PHYS_SUBSTEP = 1 / 120;
    const tVis = performance.now();
    updateChunkVisibility(frameStartMs);
    const visibilityMs = performance.now() - tVis;
    move.set(0, 0, 0);
    let simInputMs = 0;
    let simCollisionMs = 0;
    let simVerticalMs = 0;
    let simSyncMs = 0;
    if (firstPersonActive) {
      const tSimInput = performance.now();
      controls.enabled = false;
      const cosPitch = Math.cos(lookState.pitch);
      const lookDir = new THREE.Vector3(
        Math.sin(lookState.yaw) * cosPitch,
        Math.sin(lookState.pitch),
        -Math.cos(lookState.yaw) * cosPitch,
      ).normalize();
      moveForward.set(Math.sin(lookState.yaw), 0, -Math.cos(lookState.yaw)).normalize();
      moveRight.set(-moveForward.z, 0, moveForward.x).normalize();
      if (keyState.w) move.add(moveForward);
      if (keyState.s) move.sub(moveForward);
      if (keyState.d) move.add(moveRight);
      if (keyState.a) move.sub(moveRight);
      simInputMs += performance.now() - tSimInput;
      const tSimCollision = performance.now();
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(physics.moveSpeed * pilotDt);
        const maxStep = Math.max(0.08, physics.radius * 0.5);
        const stepCount = Math.max(1, Math.ceil(move.length() / maxStep));
        const stepDx = move.x / stepCount;
        const stepDz = move.z / stepCount;
        for (let step = 0; step < stepCount; step += 1) {
          // Engine-like tick collision: separate axis resolution prevents corner tunneling.
          if (!testWallBlocked(stepDx, 0)) {
            playerFeet.x += stepDx;
          }
          if (!testWallBlocked(0, stepDz)) {
            playerFeet.z += stepDz;
          }
        }
      }
      simCollisionMs += performance.now() - tSimCollision;
      const tSimVertical = performance.now();
      if (gravityEnabled) {
        if (grounded && keyState.jump) {
          verticalVelocity = physics.jumpSpeed;
          grounded = false;
        }
        let subTime = 0;
        while (subTime < pilotDt - 1e-9) {
          const h = Math.min(PHYS_SUBSTEP, pilotDt - subTime);
          subTime += h;
          verticalVelocity -= physics.gravity * h;
          const prevFeetY = playerFeet.y;
          playerFeet.y += verticalVelocity * h;
          if (verticalVelocity > 0) {
            const rise = verticalVelocity * h;
            const headY = playerFeet.y + physics.eyeHeight;
            const headProbeStarts = [
              new THREE.Vector3(playerFeet.x, headY, playerFeet.z),
              new THREE.Vector3(playerFeet.x + physics.radius, headY, playerFeet.z),
              new THREE.Vector3(playerFeet.x - physics.radius, headY, playerFeet.z),
              new THREE.Vector3(playerFeet.x, headY, playerFeet.z + physics.radius),
              new THREE.Vector3(playerFeet.x, headY, playerFeet.z - physics.radius),
            ];
            let hitCeiling = false;
            for (const start of headProbeStarts) {
              raycaster.set(start, new THREE.Vector3(0, 1, 0));
              raycaster.far = rise + physics.radius;
              if (raycaster.intersectObjects(collisionMeshes, false).length > 0) {
                hitCeiling = true;
                break;
              }
            }
            if (hitCeiling) {
              verticalVelocity = 0;
              playerFeet.y -= rise;
            }
          }
          const probeY = Math.max(playerFeet.y + 0.6, prevFeetY + 0.6);
          raycaster.set(new THREE.Vector3(playerFeet.x, probeY, playerFeet.z), new THREE.Vector3(0, -1, 0));
          raycaster.far = Math.max(2.5, Math.abs(playerFeet.y - prevFeetY) + Math.abs(verticalVelocity * h) + 1.5);
          const groundHits = raycaster.intersectObjects(collisionMeshes, false);
          if (groundHits.length > 0) {
            const hit = groundHits[0]!;
            const desiredFeetY = hit.point.y;
            if (playerFeet.y <= desiredFeetY + 0.12 && verticalVelocity <= 0) {
              playerFeet.y = desiredFeetY;
              verticalVelocity = 0;
              grounded = true;
            } else {
              grounded = false;
            }
          } else {
            grounded = false;
          }
        }
      } else {
        verticalVelocity = 0;
        grounded = false;
      }
      simVerticalMs += performance.now() - tSimVertical;
      const tSimSync = performance.now();
      camera.position.set(playerFeet.x, playerFeet.y + physics.eyeHeight, playerFeet.z);
      controls.target.copy(camera.position).add(lookDir);
      playerMarker.position.set(playerFeet.x, playerFeet.y, playerFeet.z);
      simSyncMs += performance.now() - tSimSync;
    } else {
      const tSimInput = performance.now();
      controls.enabled = true;
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
      simInputMs += performance.now() - tSimInput;
    }
    const simulationMs = simInputMs + simCollisionMs + simVerticalMs + simSyncMs;
    const tUpdate = performance.now();
    controls.update();
    const nowMs = performance.now();
    if (nowMs - lastPersistMs >= 250) {
      if (firstPersonActive) {
        onPilotPositionChange([playerFeet.x, playerFeet.y, playerFeet.z]);
      }
      onCameraStateChange(
        {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls.target.x, controls.target.y, controls.target.z],
        },
        firstPersonActive,
      );
      lastPersistMs = nowMs;
    }
    const updateMs = performance.now() - tUpdate;
    const tRenderMain = performance.now();
    composer!.render();
    const renderMainMs = performance.now() - tRenderMain;
    const tRenderMinimap = performance.now();
    renderMinimap();
    const renderMinimapMs = performance.now() - tRenderMinimap;
    const frameMs = performance.now() - frameStartMs;
    const renderMs = renderMainMs + renderMinimapMs;
    const otherMs = Math.max(0, frameMs - visibilityMs - simulationMs - updateMs - renderMs);
    perfEma.visibility = perfEma.visibility * (1 - PERF_EMA_ALPHA) + visibilityMs * PERF_EMA_ALPHA;
    perfEma.sim_input = perfEma.sim_input * (1 - PERF_EMA_ALPHA) + simInputMs * PERF_EMA_ALPHA;
    perfEma.sim_collision = perfEma.sim_collision * (1 - PERF_EMA_ALPHA) + simCollisionMs * PERF_EMA_ALPHA;
    perfEma.sim_vertical = perfEma.sim_vertical * (1 - PERF_EMA_ALPHA) + simVerticalMs * PERF_EMA_ALPHA;
    perfEma.sim_sync = perfEma.sim_sync * (1 - PERF_EMA_ALPHA) + simSyncMs * PERF_EMA_ALPHA;
    perfEma.update = perfEma.update * (1 - PERF_EMA_ALPHA) + updateMs * PERF_EMA_ALPHA;
    perfEma.render_main = perfEma.render_main * (1 - PERF_EMA_ALPHA) + renderMainMs * PERF_EMA_ALPHA;
    perfEma.render_minimap = perfEma.render_minimap * (1 - PERF_EMA_ALPHA) + renderMinimapMs * PERF_EMA_ALPHA;
    perfEma.other = perfEma.other * (1 - PERF_EMA_ALPHA) + otherMs * PERF_EMA_ALPHA;
    perfFrameEma = perfFrameEma * (1 - PERF_EMA_ALPHA) + frameMs * PERF_EMA_ALPHA;
    if (nowMs - lastPerfUiMs >= PERF_UI_INTERVAL_MS) {
      drawPerfPie(perfFrameEma > 0 ? perfFrameEma : frameMs);
      lastPerfUiMs = nowMs;
    }
    state.animationFrame = window.requestAnimationFrame(animate);
  };
  const state: Viewer3DState = {
    renderer,
    composer,
    ssaoPass,
    outputPass,
    scene,
    camera,
    controls,
    animationFrame: 0,
    clipPlane,
    cullMinY: worldMinY,
    cullMaxY: worldMaxY + WORLD_CHUNK_SIZE * 0.5,
    worldMeshes,
    cullCapMesh,
    worldBoundaryLines,
    worldMaterials,
    worldMeshWorkers,
    isFirstPerson: firstPersonActive,
    gravityEnabled,
    setCullY,
    setFirstPersonMode: (enabled: boolean) => {
      if (!canFirstPerson) {
        firstPersonActive = false;
        state.isFirstPerson = false;
        return;
      }
      firstPersonActive = enabled;
      state.isFirstPerson = firstPersonActive;
      if (!firstPersonActive && document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
      }
      if (firstPersonActive) {
        playerMarker.position.set(playerFeet.x, playerFeet.y, playerFeet.z);
        if (!scene.children.includes(playerMarker)) scene.add(playerMarker);
        const lookDir = controls.target.clone().sub(camera.position);
        if (lookDir.lengthSq() > 1e-9) {
          lookDir.normalize();
          lookState.yaw = Math.atan2(lookDir.x, -lookDir.z);
          lookState.pitch = Math.asin(Math.max(-1, Math.min(1, lookDir.y)));
        }
        playerFeet.set(camera.position.x, camera.position.y - physics.eyeHeight, camera.position.z);
      }
    },
    setGravityEnabled: (enabled: boolean) => {
      gravityEnabled = enabled;
      state.gravityEnabled = enabled;
      if (!enabled) {
        verticalVelocity = 0;
        grounded = false;
      }
    },
    setVertexAoEnabled: applyVertexAoEnabled,
    applyCameraState: (cameraState: CameraPersistState) => {
      if (
        !cameraState ||
        !Array.isArray(cameraState.position) ||
        cameraState.position.length < 3 ||
        !Array.isArray(cameraState.target) ||
        cameraState.target.length < 3
      ) {
        return;
      }
      camera.position.set(
        Number(cameraState.position[0] ?? 0),
        Number(cameraState.position[1] ?? 0),
        Number(cameraState.position[2] ?? 0),
      );
      controls.target.set(
        Number(cameraState.target[0] ?? 0),
        Number(cameraState.target[1] ?? 0),
        Number(cameraState.target[2] ?? 0),
      );
      if (firstPersonActive) {
        const lookDir = controls.target.clone().sub(camera.position);
        if (lookDir.lengthSq() > 1e-9) {
          lookDir.normalize();
          lookState.yaw = Math.atan2(lookDir.x, -lookDir.z);
          lookState.pitch = Math.asin(Math.max(-1, Math.min(1, lookDir.y)));
        }
        playerFeet.set(camera.position.x, camera.position.y - physics.eyeHeight, camera.position.z);
      }
      controls.update();
    },
    teleportPilotTo: (position: [number, number, number]) => {
      const feet: [number, number, number] = [
        Number(position[0] ?? 0),
        Number(position[1] ?? 0),
        Number(position[2] ?? 0),
      ];
      playerFeet.set(feet[0], feet[1], feet[2]);
      verticalVelocity = 0;
      grounded = false;
      playerMarker.position.set(feet[0], feet[1], feet[2]);
      if (firstPersonActive && !scene.children.includes(playerMarker)) scene.add(playerMarker);
      camera.position.set(feet[0], feet[1] + physics.eyeHeight, feet[2]);
      controls.target.set(feet[0] + 1, feet[1] + physics.eyeHeight, feet[2]);
      controls.update();
      onPilotPositionChange(feet);
      onCameraStateChange(
        {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls.target.x, controls.target.y, controls.target.z],
        },
        firstPersonActive,
      );
    },
    resetCamera: () => {
      if (firstPersonActive && canFirstPerson) {
        const spawn = pilotResetSpawn ?? [playerPos[0], playerPos[1], playerPos[2]];
        playerFeet.set(spawn[0], spawn[1], spawn[2]);
        verticalVelocity = 0;
        grounded = false;
        lookState.yaw = 0;
        lookState.pitch = 0;
        camera.position.set(spawn[0], spawn[1] + physics.eyeHeight, spawn[2]);
        controls.target.set(spawn[0] + 1, spawn[1] + physics.eyeHeight, spawn[2]);
      } else {
        camera.position.set(center.x + radius * 0.8, center.y + radius * 0.6, center.z + radius * 0.8);
        controls.target.copy(center);
      }
      controls.update();
      onCameraStateChange(
        {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls.target.x, controls.target.y, controls.target.z],
        },
        firstPersonActive,
      );
      if (firstPersonActive) {
        onPilotPositionChange([playerFeet.x, playerFeet.y, playerFeet.z]);
      }
    },
    onKeyDown,
    onKeyUp,
    dispose: () => {
      stopped = true;
      for (const worker of state.worldMeshWorkers) {
        worker.postMessage({ type: "cancel" });
        worker.terminate();
      }
      if (state.animationFrame) {
        window.cancelAnimationFrame(state.animationFrame);
      }
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("click", onPointerLockClick);
      if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
      }
      controls.dispose();
      for (const mesh of entityInstancedMeshes) {
        mesh.dispose();
      }
      entityAoTexture.dispose();
      scene.remove(entityGraphGroup);
      for (const mesh of state.worldMeshes) {
        scene.remove(mesh);
        (mesh.geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void }).disposeBoundsTree?.();
        mesh.geometry.dispose();
      }
      scene.remove(state.cullCapMesh);
      state.cullCapMesh.geometry.dispose();
      for (const lines of state.worldBoundaryLines) {
        scene.remove(lines);
        lines.geometry.dispose();
      }
      for (const material of state.worldMaterials) {
        material.dispose();
      }
      playerMarkerGeom.dispose();
      playerMarkerMat.dispose();
      if (pointGeom) pointGeom.dispose();
      if (pointMat) pointMat.dispose();
      edgeGeom.dispose();
      edgeMat.dispose();
      outputPass?.dispose();
      ssaoPass?.dispose();
      composer?.dispose();
      perfOverlay.remove();
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
  const SLOT_INDEX_STORAGE_KEY = "tunnet.saveViewer.slotIndex";
  const FIRST_PERSON_MODE_STORAGE_KEY = "tunnet.saveViewer.firstPersonMode";
  const GRAVITY_ENABLED_STORAGE_KEY = "tunnet.saveViewer.gravityEnabled";
  const SSAO_ENABLED_STORAGE_KEY = "tunnet.saveViewer.aoEnabled";
  const BLOCK_AO_ENABLED_STORAGE_KEY = "tunnet.saveViewer.blockAoEnabled";
  const HEMISPHERE_AO_ENABLED_STORAGE_KEY = "tunnet.saveViewer.hemisphereAoEnabled";
  const CAMERA_STATE_3D_STORAGE_KEY = "tunnet.saveViewer.cameraState3d";
  const CAMERA_STATE_PILOT_STORAGE_KEY = "tunnet.saveViewer.cameraStatePilot";
  const PLAYER_POSITION_PILOT_STORAGE_KEY = "tunnet.saveViewer.playerPositionPilot";
  mountLayout();
  const fileInput = document.querySelector<HTMLInputElement>("#sv-file-input");
  const slotIndexInput = document.querySelector<HTMLInputElement>("#sv-slot-index");
  const slotIndexValue = document.querySelector<HTMLSpanElement>("#sv-slot-index-value");
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
  const fpsToggleButton = document.querySelector<HTMLButtonElement>("#sv-fps-toggle");
  const gravityToggleButton = document.querySelector<HTMLButtonElement>("#sv-gravity-toggle");
  const ssaoToggleButton = document.querySelector<HTMLButtonElement>("#sv-ssao-toggle");
  const blockAoToggleButton = document.querySelector<HTMLButtonElement>("#sv-block-ao-toggle");
  const hemiAoToggleButton = document.querySelector<HTMLButtonElement>("#sv-hemi-ao-toggle");
  const resetCameraButton = document.querySelector<HTMLButtonElement>("#sv-reset-camera");
  const teleportEndpointInput = document.querySelector<HTMLInputElement>("#sv-teleport-endpoint");
  const teleportButton = document.querySelector<HTMLButtonElement>("#sv-teleport-button");
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
    !slotIndexInput ||
    !slotIndexValue ||
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
    !fpsToggleButton ||
    !gravityToggleButton ||
    !ssaoToggleButton ||
    !blockAoToggleButton ||
    !hemiAoToggleButton ||
    !resetCameraButton ||
    !teleportEndpointInput ||
    !teleportButton ||
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
  let slotIndex = 3;
  let firstPersonMode = false;
  let gravityEnabled = true;
  let ssaoEnabled = true;
  let blockAoEnabled = true;
  let hemisphereAoEnabled = false;
  let world3D: Viewer3DState | null = null;
  let world3DResizeHandler: (() => void) | null = null;
  let cullHeightT = 1;
  let worldBuildToken = 0;
  let persisted3DCameraState: CameraPersistState | null = null;
  let persistedPilotCameraState: CameraPersistState | null = null;
  let persistedPilotPosition: PilotPositionPersistState | null = null;
  let pendingTeleportPosition: [number, number, number] | null = null;
  const applyAoForCullState = (): void => {
    setWorldSsaoEnabled(world3D?.ssaoPass ?? null, ssaoEnabled, cullHeightT);
  };
  const applyVertexAoState = (): void => {
    world3D?.setVertexAoEnabled({ blockAo: blockAoEnabled, hemisphereAo: hemisphereAoEnabled });
  };

  const normalizeEndpointAddressInput = (value: string): string | null => {
    const parts = value.trim().split(".");
    if (parts.length !== 4) return null;
    const normalized = parts.map((part) => {
      const n = Number.parseInt(part.trim(), 10);
      return Number.isFinite(n) && n >= 0 && n <= 3 ? String(n) : null;
    });
    if (normalized.some((part) => part === null)) return null;
    return normalized.join(".");
  };

  const findEndpointPosition = (address: string): [number, number, number] | null => {
    for (const endpoint of currentSave.endpoints) {
      if (decodeAddress(endpoint.address) !== address) continue;
      const pos = currentSave.nodes[endpoint.node]?.pos;
      if (!Array.isArray(pos) || pos.length < 3) return null;
      return [Number(pos[0] ?? 0), Number(pos[1] ?? 0), Number(pos[2] ?? 0)];
    }
    return null;
  };

  const applyTeleportPosition = (position: [number, number, number]): void => {
    pendingTeleportPosition = null;
    world3D?.teleportPilotTo(position);
  };

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
    const next = await createOrRefresh3DWorld(
      view3DEl,
      currentSave,
      firstPersonMode,
      gravityEnabled,
      blockAoEnabled,
      hemisphereAoEnabled,
      firstPersonMode ? persistedPilotCameraState : persisted3DCameraState,
      (state, isFirstPerson) => {
        if (isFirstPerson) {
          persistedPilotCameraState = state;
          window.localStorage.setItem(CAMERA_STATE_PILOT_STORAGE_KEY, JSON.stringify(state));
        } else {
          persisted3DCameraState = state;
          window.localStorage.setItem(CAMERA_STATE_3D_STORAGE_KEY, JSON.stringify(state));
        }
      },
      persistedPilotPosition,
      (position) => {
        persistedPilotPosition = position;
        window.localStorage.setItem(PLAYER_POSITION_PILOT_STORAGE_KEY, JSON.stringify(position));
      },
      world3D,
      updateLoadProgress,
    );
    if (token !== worldBuildToken) {
      next?.dispose();
      return;
    }
    world3D = next;
    if (world3D) {
      const y = world3D.cullMinY + (world3D.cullMaxY - world3D.cullMinY) * cullHeightT;
      world3D.setCullY(y);
      cullHeightValue.textContent = y.toFixed(1);
      applyAoForCullState();
      if (pendingTeleportPosition) {
        applyTeleportPosition(pendingTeleportPosition);
      }
    }
    hideLoadProgress();
  };

  const applyViewMode = (): void => {
    const show3D = use3DView;
    wiresEl.classList.toggle("hidden", show3D);
    packetOverlayEl.classList.toggle("hidden", show3D);
    view3DEl.classList.toggle("hidden", !show3D);
    viewToggleButton.textContent = show3D ? "Switch to 2D" : "Switch to 3D";
    fpsToggleButton.textContent = `Pilot mode: ${firstPersonMode ? "on" : "off"}`;
    gravityToggleButton.textContent = `Gravity: ${gravityEnabled ? "on" : "off"}`;
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
          world3D.composer?.setSize(w, h);
          for (const lines of world3D.worldBoundaryLines) {
            setWorldGridLineResolution(lines, w, h);
          }
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

  const updateBundledSlotUi = (): void => {
    slotIndex = Math.max(0, Math.min(3, Math.floor(slotIndex)));
    slotIndexInput.value = String(slotIndex);
    const label = `slot_${slotIndex}.json`;
    slotIndexValue.textContent = label;
    loadSampleButton.textContent = `Load bundled ${label}`;
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
      const parsed = await fetchBundledSlot(slotIndex);
      renderAndReset(parsed);
    } catch (err) {
      statsEl.textContent = `sample load error: ${String(err)}`;
    }
  });
  slotIndexInput.addEventListener("input", () => {
    const n = Number.parseInt(slotIndexInput.value, 10);
    slotIndex = Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 3;
    window.localStorage.setItem(SLOT_INDEX_STORAGE_KEY, String(slotIndex));
    updateBundledSlotUi();
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
  fpsToggleButton.addEventListener("click", () => {
    firstPersonMode = !firstPersonMode;
    window.localStorage.setItem(FIRST_PERSON_MODE_STORAGE_KEY, firstPersonMode ? "1" : "0");
    fpsToggleButton.textContent = `Pilot mode: ${firstPersonMode ? "on" : "off"}`;
    if (use3DView && world3D) {
      world3D.setFirstPersonMode(firstPersonMode);
      const restore = firstPersonMode ? persistedPilotCameraState : persisted3DCameraState;
      if (restore) {
        world3D.applyCameraState(restore);
      }
    }
  });
  gravityToggleButton.addEventListener("click", () => {
    gravityEnabled = !gravityEnabled;
    window.localStorage.setItem(GRAVITY_ENABLED_STORAGE_KEY, gravityEnabled ? "1" : "0");
    gravityToggleButton.textContent = `Gravity: ${gravityEnabled ? "on" : "off"}`;
    if (use3DView && world3D) {
      world3D.setGravityEnabled(gravityEnabled);
    }
  });
  ssaoToggleButton.addEventListener("click", () => {
    ssaoEnabled = !ssaoEnabled;
    window.localStorage.setItem(SSAO_ENABLED_STORAGE_KEY, ssaoEnabled ? "1" : "0");
    ssaoToggleButton.textContent = `SSAO: ${ssaoEnabled ? "on" : "off"}`;
    applyAoForCullState();
  });
  blockAoToggleButton.addEventListener("click", () => {
    blockAoEnabled = !blockAoEnabled;
    window.localStorage.setItem(BLOCK_AO_ENABLED_STORAGE_KEY, blockAoEnabled ? "1" : "0");
    blockAoToggleButton.textContent = `Block AO: ${blockAoEnabled ? "on" : "off"}`;
    applyVertexAoState();
  });
  hemiAoToggleButton.addEventListener("click", () => {
    hemisphereAoEnabled = !hemisphereAoEnabled;
    window.localStorage.setItem(HEMISPHERE_AO_ENABLED_STORAGE_KEY, hemisphereAoEnabled ? "1" : "0");
    hemiAoToggleButton.textContent = `Hemi AO: ${hemisphereAoEnabled ? "on" : "off"}`;
    applyVertexAoState();
  });
  resetCameraButton.addEventListener("click", () => {
    if (!world3D) return;
    if (world3D.isFirstPerson) {
      persistedPilotCameraState = null;
      window.localStorage.removeItem(CAMERA_STATE_PILOT_STORAGE_KEY);
      persistedPilotPosition = null;
      window.localStorage.removeItem(PLAYER_POSITION_PILOT_STORAGE_KEY);
    } else {
      persisted3DCameraState = null;
      window.localStorage.removeItem(CAMERA_STATE_3D_STORAGE_KEY);
    }
    world3D.resetCamera();
  });
  const teleportToEndpoint = (): void => {
    const address = normalizeEndpointAddressInput(teleportEndpointInput.value);
    if (!address) {
      statsEl.textContent = "teleport error: enter an address like 0.3.0.0";
      return;
    }
    teleportEndpointInput.value = address;
    const position = findEndpointPosition(address);
    if (!position) {
      statsEl.textContent = `teleport error: endpoint ${address} not found`;
      return;
    }
    pendingTeleportPosition = position;
    if (world3D) {
      applyTeleportPosition(position);
      statsEl.textContent = `teleported to endpoint ${address}`;
      return;
    }
    statsEl.textContent = `loading 3D view to teleport to endpoint ${address}`;
    if (!use3DView) {
      use3DView = true;
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, "3d");
      applyViewMode();
      return;
    }
    void refresh3DWorld();
  };
  teleportButton.addEventListener("click", teleportToEndpoint);
  teleportEndpointInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    teleportToEndpoint();
  });
  cullHeightInput.addEventListener("input", () => {
    const n = Number.parseInt(cullHeightInput.value, 10);
    const t = Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) / 1000 : 1;
    cullHeightT = t;
    if (world3D) {
      const y = world3D.cullMinY + (world3D.cullMaxY - world3D.cullMinY) * cullHeightT;
      world3D.setCullY(y);
      cullHeightValue.textContent = y.toFixed(1);
      applyAoForCullState();
    } else {
      cullHeightValue.textContent = `${Math.round(t * 100)}%`;
    }
  });
  firstPersonMode = (window.localStorage.getItem(FIRST_PERSON_MODE_STORAGE_KEY) ?? "").trim() === "1";
  fpsToggleButton.textContent = `Pilot mode: ${firstPersonMode ? "on" : "off"}`;
  gravityEnabled = (window.localStorage.getItem(GRAVITY_ENABLED_STORAGE_KEY) ?? "1").trim() !== "0";
  gravityToggleButton.textContent = `Gravity: ${gravityEnabled ? "on" : "off"}`;
  ssaoEnabled = (window.localStorage.getItem(SSAO_ENABLED_STORAGE_KEY) ?? "1").trim() !== "0";
  ssaoToggleButton.textContent = `SSAO: ${ssaoEnabled ? "on" : "off"}`;
  blockAoEnabled = (window.localStorage.getItem(BLOCK_AO_ENABLED_STORAGE_KEY) ?? "1").trim() !== "0";
  blockAoToggleButton.textContent = `Block AO: ${blockAoEnabled ? "on" : "off"}`;
  hemisphereAoEnabled = (window.localStorage.getItem(HEMISPHERE_AO_ENABLED_STORAGE_KEY) ?? "0").trim() === "1";
  hemiAoToggleButton.textContent = `Hemi AO: ${hemisphereAoEnabled ? "on" : "off"}`;
  const parseCameraState = (raw: string | null): CameraPersistState | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CameraPersistState;
      if (
        parsed &&
        Array.isArray(parsed.position) &&
        parsed.position.length >= 3 &&
        Array.isArray(parsed.target) &&
        parsed.target.length >= 3
      ) {
        return {
          position: [Number(parsed.position[0]), Number(parsed.position[1]), Number(parsed.position[2])],
          target: [Number(parsed.target[0]), Number(parsed.target[1]), Number(parsed.target[2])],
        };
      }
    } catch {
      return null;
    }
    return null;
  };
  const parsePilotPosition = (raw: string | null): PilotPositionPersistState | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length >= 3 &&
        Number.isFinite(Number(parsed[0])) &&
        Number.isFinite(Number(parsed[1])) &&
        Number.isFinite(Number(parsed[2]))
      ) {
        return [Number(parsed[0]), Number(parsed[1]), Number(parsed[2])];
      }
    } catch {
      return null;
    }
    return null;
  };
  persisted3DCameraState = parseCameraState(window.localStorage.getItem(CAMERA_STATE_3D_STORAGE_KEY));
  persistedPilotCameraState = parseCameraState(window.localStorage.getItem(CAMERA_STATE_PILOT_STORAGE_KEY));
  persistedPilotPosition = parsePilotPosition(window.localStorage.getItem(PLAYER_POSITION_PILOT_STORAGE_KEY));
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
  const savedSlotIndex = Number.parseInt(window.localStorage.getItem(SLOT_INDEX_STORAGE_KEY) ?? "", 10);
  if (Number.isFinite(savedSlotIndex)) {
    slotIndex = Math.max(0, Math.min(3, savedSlotIndex));
  }
  updateBundledSlotUi();
  statsEl.textContent = "Load a save file to start.";
  applyViewMode();
  void (async () => {
    try {
      const parsed = await fetchBundledSlot(slotIndex);
      renderAndReset(parsed);
      statsEl.textContent = `Loaded /saves/slot_${slotIndex}.json`;
    } catch {
      // Ignore startup auto-load errors; user can still load from picker.
    }
  })();
}

main();
