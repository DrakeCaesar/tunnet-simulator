import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import type { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { applyWorldVertexAo, type WorldAoColorSet } from "./world-ao-block";
import { createWorldSsao } from "./world-ao-ssao";
import { buildWorldCullCapGeometry, createWorldCullCapMaterial } from "./world-cull-cap";
import { createWorldGridLines, type WorldGridLines } from "./world-grid-lines";
import { decodeAddress, type SaveData, type SaveNode, type VisualNode } from "./model";

{
  const meshProto = THREE.Mesh.prototype as THREE.Mesh & { __svBvhPatched?: boolean };
  if (!meshProto.__svBvhPatched) {
    (THREE.BufferGeometry.prototype as THREE.BufferGeometry & { computeBoundsTree?: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
    (THREE.BufferGeometry.prototype as THREE.BufferGeometry & { disposeBoundsTree?: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
    (THREE.Mesh.prototype as THREE.Mesh).raycast = acceleratedRaycast;
    meshProto.__svBvhPatched = true;
  }
}

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
const SAVE_VIEWER_GRAPH_ENTITY_Y_OFFSET = -1;

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

type ViewLayerId =
  | "groundGrid"
  | "entityGraph"
  | "chunkWorld"
  | "blockGrid"
  | "cullCap"
  | "playerMarker"
  | "perfOverlay";

type ViewEffectId = "minimap" | "ssao" | "blockAo" | "hemisphereAo";
type ViewModePolicy = {
  pilot: boolean;
  orbit: boolean;
};
type ViewModeSettings = {
  layers: Record<ViewLayerId, ViewModePolicy>;
  effects: Record<ViewEffectId, ViewModePolicy>;
};

// Centralized 3D mode settings matrix (layers + effects together).
const VIEW_MODE_SETTINGS: ViewModeSettings = {
  layers: {
    groundGrid: { pilot: false, orbit: true },
    entityGraph: { pilot: true, orbit: true },
    chunkWorld: { pilot: true, orbit: true },
    blockGrid: { pilot: true, orbit: false },
    cullCap: { pilot: false, orbit: true },
    playerMarker: { pilot: true, orbit: true },
    perfOverlay: { pilot: true, orbit: true },
  },
  effects: {
    minimap: { pilot: true, orbit: false },
    ssao: { pilot: true, orbit: true },
    blockAo: { pilot: true, orbit: true },
    hemisphereAo: { pilot: true, orbit: true },
  },
};

export function isViewEffectAllowedInMode(effectId: ViewEffectId, isFirstPerson: boolean): boolean {
  const policy = VIEW_MODE_SETTINGS.effects[effectId];
  return isFirstPerson ? policy.pilot : policy.orbit;
}

function isViewLayerAllowedInMode(layerId: ViewLayerId, isFirstPerson: boolean): boolean {
  const policy = VIEW_MODE_SETTINGS.layers[layerId];
  return isFirstPerson ? policy.pilot : policy.orbit;
}

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

export type Viewer3DState = {
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

export type LoadProgressReporter = (phase: string, current: number, total: number) => Promise<void>;

type ChunkPos = { x: number; y: number; z: number };
export type CameraPersistState = {
  position: [number, number, number];
  target: [number, number, number];
};
export type PilotPositionPersistState = [number, number, number];

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

export async function createOrRefresh3DWorld(
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
    { key: "render_pass", label: "render pass", color: "#a6e3a1" },
    { key: "render_ssao", label: "render ssao", color: "#74c7ec" },
    { key: "render_output", label: "render output", color: "#89dceb" },
    { key: "render_other", label: "render other", color: "#6cb8d1" },
    { key: "render_map_prep", label: "map prep", color: "#b4befe" },
    { key: "render_map_draw", label: "map draw", color: "#cba6f7" },
    { key: "render_map_restore", label: "map restore", color: "#f5c2e7" },
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
    render_pass: 0,
    render_ssao: 0,
    render_output: 0,
    render_other: 0,
    render_map_prep: 0,
    render_map_draw: 0,
    render_map_restore: 0,
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
  type RenderStepKey = "render_pass" | "render_ssao" | "render_output" | "render_other";
  const renderStepFrameMs: Record<RenderStepKey, number> = {
    render_pass: 0,
    render_ssao: 0,
    render_output: 0,
    render_other: 0,
  };
  if (composer) {
    const passList = (composer as unknown as { passes?: Array<{ render?: (...args: unknown[]) => void }> }).passes ?? [];
    for (const pass of passList) {
      const originalRender = pass.render;
      if (!originalRender) continue;
      const passName = pass === ssaoPass ? "render_ssao" : pass === outputPass ? "render_output" : "render_pass";
      pass.render = (...args: unknown[]): void => {
        const t = performance.now();
        originalRender.apply(pass, args);
        renderStepFrameMs[passName] += performance.now() - t;
      };
    }
  }
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
  const halfChunk = WORLD_CHUNK_SIZE * 0.5;
  // GridHelper draws lines around its origin; half-chunk phase shift aligns lines to chunk boundaries.
  grid.position.set(center.x + halfChunk, bounds.min.y, center.z + halfChunk);
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
  for (const mesh of entityInstancedMeshes) entityGraphGroup.add(mesh);
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
        // Block AO samples edge/corner occupancy, so meshing needs the full 26-neighbor
        // chunk neighborhood around each chunk (not only +/- axis neighbors).
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
              requiredKeys.add(`${pos.x + dx},${pos.y + dy},${pos.z + dz}`);
            }
          }
        }
      }
      const requiredChunks: unknown[] = [];
      for (const key of Array.from(requiredKeys)) {
        const raw = chunkEntryByKey.get(key);
        if (raw) requiredChunks.push(raw);
      }
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
            if (msg.phase.startsWith("Decoding")) decodeProgress[workerIndex] = msg.current;
            else buildProgress[workerIndex] = msg.current;
            reportCombinedProgress();
            return;
          }
          if (msg.type === "chunkMesh") {
            if (msg.positions.length === 0) return;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.BufferAttribute(msg.positions, 3));
            geom.setAttribute("normal", new THREE.BufferAttribute(msg.normals, 3));
            geom.setAttribute("color", new THREE.BufferAttribute(msg.flatColors, 3));
            const colorSet: WorldAoColorSet = { geometry: geom, blockAoColors: msg.colors, flatColors: msg.flatColors };
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
    cullCapMesh.visible =
      layerEnabledInCurrentMode("cullCap") &&
      cullCapMesh.geometry.getAttribute("position")?.count > 0;
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
  const layerEnabledInCurrentMode = (layerId: ViewLayerId): boolean => {
    return isViewLayerAllowedInMode(layerId, firstPersonActive);
  };
  const effectEnabledInCurrentMode = (effectId: ViewEffectId): boolean =>
    isViewEffectAllowedInMode(effectId, firstPersonActive);
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
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
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
    if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
  };
  window.addEventListener("mousemove", onMouseMove);
  renderer.domElement.addEventListener("click", onPointerLockClick);
  let lastFrameMs = performance.now();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const moveForward = new THREE.Vector3();
  const moveRight = new THREE.Vector3();
  const playerFeet = new THREE.Vector3(initialPilotFeetPos[0], initialPilotFeetPos[1], initialPilotFeetPos[2]);
  let verticalVelocity = 0;
  let grounded = false;
  let lastPersistMs = 0;
  const physics = { eyeHeight: 1, moveSpeed: 11, jumpSpeed: 8.5, gravity: 24, radius: 0.34 };
  const minimapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  minimapCamera.up.set(0, 0, -1);
  const renderMinimap = (): { prepMs: number; drawMs: number; restoreMs: number } => {
    const prepStart = performance.now();
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
      const inMap = Math.abs(entry.center.x - playerFeet.x) <= halfMap && Math.abs(entry.center.z - playerFeet.z) <= halfMap;
      entry.mesh.visible = inMap;
      if (entry.lines) entry.lines.visible = false;
    }
    const prepMs = performance.now() - prepStart;
    const drawStart = performance.now();
    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, size, size);
    renderer.setScissor(x, y, size, size);
    renderer.setClearColor(0x111827, 0.96);
    renderer.clear(true, true, true);
    renderer.render(scene, minimapCamera);
    const drawMs = performance.now() - drawStart;
    const restoreStart = performance.now();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewW, viewH);
    renderer.setClearColor(oldClearColor, oldClearAlpha);
    for (let i = 0; i < worldMeshes.length; i += 1) worldMeshes[i]!.visible = oldWorldMeshVisibility[i] ?? true;
    for (let i = 0; i < worldBoundaryLines.length; i += 1) worldBoundaryLines[i]!.visible = oldLineVisibility[i] ?? true;
    cullCapMesh.visible = oldCapVisible;
    clipPlane.constant = oldClipConstant;
    const restoreMs = performance.now() - restoreStart;
    return { prepMs, drawMs, restoreMs };
  };

  const applyVertexAoEnabled = (enabled: { blockAo: boolean; hemisphereAo: boolean }): void => {
    applyWorldVertexAo(worldMeshColorSets, { blockAoEnabled: enabled.blockAo, hemisphereAoEnabled: enabled.hemisphereAo });
    for (const material of entityAoMaterials) {
      material.aoMapIntensity = enabled.blockAo ? 1 : 0;
      material.needsUpdate = true;
    }
  };
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  let collisionMeshes: THREE.Mesh[] = worldMeshes;
  const applyLayerVisibilityForMode = (): void => {
    grid.visible = layerEnabledInCurrentMode("groundGrid");
    entityGraphGroup.visible = layerEnabledInCurrentMode("entityGraph");
    cullCapMesh.visible = cullCapMesh.visible && layerEnabledInCurrentMode("cullCap");
    playerMarker.visible = layerEnabledInCurrentMode("playerMarker");
    perfOverlay.style.display = layerEnabledInCurrentMode("perfOverlay") ? "block" : "none";
    for (const entry of chunkVisibilityEntries) {
      if (!layerEnabledInCurrentMode("chunkWorld")) {
        entry.mesh.visible = false;
      }
      if (entry.lines && !layerEnabledInCurrentMode("blockGrid")) {
        entry.lines.visible = false;
      }
    }
  };
  const updateChunkVisibility = (nowMs: number): void => {
    if (chunkVisibilityEntries.length === 0) return;
    if (nowMs - lastChunkVisibilityUpdateMs < CHUNK_VISIBILITY_UPDATE_MS) return;
    lastChunkVisibilityUpdateMs = nowMs;
    const chunkWorldAllowed = layerEnabledInCurrentMode("chunkWorld");
    const chunkBoundaryAllowed = layerEnabledInCurrentMode("blockGrid");
    if (!chunkWorldAllowed) {
      for (const entry of chunkVisibilityEntries) {
        entry.mesh.visible = false;
        if (entry.lines) entry.lines.visible = false;
      }
      return;
    }
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
      if (entry.lines) entry.lines.visible = chunkBoundaryAllowed;
      visibleCollisionMeshes.push(entry.mesh);
    }
    if (visibleCollisionMeshes.length > 0) collisionMeshes = visibleCollisionMeshes;
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
    for (const y of capsuleSampleHeights()) {
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
      const lookDir = new THREE.Vector3(Math.sin(lookState.yaw) * cosPitch, Math.sin(lookState.pitch), -Math.cos(lookState.yaw) * cosPitch).normalize();
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
          if (!testWallBlocked(stepDx, 0)) playerFeet.x += stepDx;
          if (!testWallBlocked(0, stepDz)) playerFeet.z += stepDz;
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
            } else grounded = false;
          } else grounded = false;
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
        if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
        else forward.normalize();
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
      if (firstPersonActive) onPilotPositionChange([playerFeet.x, playerFeet.y, playerFeet.z]);
      onCameraStateChange(
        { position: [camera.position.x, camera.position.y, camera.position.z], target: [controls.target.x, controls.target.y, controls.target.z] },
        firstPersonActive,
      );
      lastPersistMs = nowMs;
    }
    const updateMs = performance.now() - tUpdate;
    renderStepFrameMs.render_pass = 0;
    renderStepFrameMs.render_ssao = 0;
    renderStepFrameMs.render_output = 0;
    renderStepFrameMs.render_other = 0;
    const tRenderMain = performance.now();
    composer!.render();
    const renderMainMs = performance.now() - tRenderMain;
    const minimapTiming = effectEnabledInCurrentMode("minimap")
      ? renderMinimap()
      : { prepMs: 0, drawMs: 0, restoreMs: 0 };
    const { prepMs: renderMapPrepMs, drawMs: renderMapDrawMs, restoreMs: renderMapRestoreMs } = minimapTiming;
    const renderMinimapMs = renderMapPrepMs + renderMapDrawMs + renderMapRestoreMs;
    const renderPassTotalMs = renderStepFrameMs.render_pass + renderStepFrameMs.render_ssao + renderStepFrameMs.render_output;
    const renderOtherMs = Math.max(0, renderMainMs - renderPassTotalMs);
    const frameMs = performance.now() - frameStartMs;
    const renderMs = renderMainMs + renderMinimapMs;
    const otherMs = Math.max(0, frameMs - visibilityMs - simulationMs - updateMs - renderMs);
    perfEma.visibility = perfEma.visibility * (1 - PERF_EMA_ALPHA) + visibilityMs * PERF_EMA_ALPHA;
    perfEma.sim_input = perfEma.sim_input * (1 - PERF_EMA_ALPHA) + simInputMs * PERF_EMA_ALPHA;
    perfEma.sim_collision = perfEma.sim_collision * (1 - PERF_EMA_ALPHA) + simCollisionMs * PERF_EMA_ALPHA;
    perfEma.sim_vertical = perfEma.sim_vertical * (1 - PERF_EMA_ALPHA) + simVerticalMs * PERF_EMA_ALPHA;
    perfEma.sim_sync = perfEma.sim_sync * (1 - PERF_EMA_ALPHA) + simSyncMs * PERF_EMA_ALPHA;
    perfEma.update = perfEma.update * (1 - PERF_EMA_ALPHA) + updateMs * PERF_EMA_ALPHA;
    perfEma.render_pass = perfEma.render_pass * (1 - PERF_EMA_ALPHA) + renderStepFrameMs.render_pass * PERF_EMA_ALPHA;
    perfEma.render_ssao = perfEma.render_ssao * (1 - PERF_EMA_ALPHA) + renderStepFrameMs.render_ssao * PERF_EMA_ALPHA;
    perfEma.render_output = perfEma.render_output * (1 - PERF_EMA_ALPHA) + renderStepFrameMs.render_output * PERF_EMA_ALPHA;
    perfEma.render_other = perfEma.render_other * (1 - PERF_EMA_ALPHA) + renderOtherMs * PERF_EMA_ALPHA;
    perfEma.render_map_prep = perfEma.render_map_prep * (1 - PERF_EMA_ALPHA) + renderMapPrepMs * PERF_EMA_ALPHA;
    perfEma.render_map_draw = perfEma.render_map_draw * (1 - PERF_EMA_ALPHA) + renderMapDrawMs * PERF_EMA_ALPHA;
    perfEma.render_map_restore = perfEma.render_map_restore * (1 - PERF_EMA_ALPHA) + renderMapRestoreMs * PERF_EMA_ALPHA;
    perfEma.other = perfEma.other * (1 - PERF_EMA_ALPHA) + otherMs * PERF_EMA_ALPHA;
    perfFrameEma = perfFrameEma * (1 - PERF_EMA_ALPHA) + frameMs * PERF_EMA_ALPHA;
    if (nowMs - lastPerfUiMs >= PERF_UI_INTERVAL_MS) {
      drawPerfPie(perfFrameEma > 0 ? perfFrameEma : frameMs);
      lastPerfUiMs = nowMs;
    }
    state.animationFrame = window.requestAnimationFrame(animate);
  };

  const state: Viewer3DState = {
    renderer, composer, ssaoPass, outputPass, scene, camera, controls, animationFrame: 0, clipPlane,
    cullMinY: worldMinY,
    cullMaxY: worldMaxY + WORLD_CHUNK_SIZE * 0.5,
    worldMeshes, cullCapMesh, worldBoundaryLines, worldMaterials, worldMeshWorkers,
    isFirstPerson: firstPersonActive,
    gravityEnabled,
    setCullY,
    setFirstPersonMode: (enabled: boolean) => {
      if (!canFirstPerson) {
        firstPersonActive = false;
        state.isFirstPerson = false;
        applyLayerVisibilityForMode();
        return;
      }
      firstPersonActive = enabled;
      state.isFirstPerson = firstPersonActive;
      if (!firstPersonActive && document.pointerLockElement === renderer.domElement) document.exitPointerLock();
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
      applyLayerVisibilityForMode();
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
      if (!cameraState || !Array.isArray(cameraState.position) || cameraState.position.length < 3 || !Array.isArray(cameraState.target) || cameraState.target.length < 3) return;
      camera.position.set(Number(cameraState.position[0] ?? 0), Number(cameraState.position[1] ?? 0), Number(cameraState.position[2] ?? 0));
      controls.target.set(Number(cameraState.target[0] ?? 0), Number(cameraState.target[1] ?? 0), Number(cameraState.target[2] ?? 0));
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
      const feet: [number, number, number] = [Number(position[0] ?? 0), Number(position[1] ?? 0), Number(position[2] ?? 0)];
      playerFeet.set(feet[0], feet[1], feet[2]);
      verticalVelocity = 0;
      grounded = false;
      playerMarker.position.set(feet[0], feet[1], feet[2]);
      if (firstPersonActive && !scene.children.includes(playerMarker)) scene.add(playerMarker);
      camera.position.set(feet[0], feet[1] + physics.eyeHeight, feet[2]);
      controls.target.set(feet[0] + 1, feet[1] + physics.eyeHeight, feet[2]);
      controls.update();
      onPilotPositionChange(feet);
      onCameraStateChange({ position: [camera.position.x, camera.position.y, camera.position.z], target: [controls.target.x, controls.target.y, controls.target.z] }, firstPersonActive);
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
      onCameraStateChange({ position: [camera.position.x, camera.position.y, camera.position.z], target: [controls.target.x, controls.target.y, controls.target.z] }, firstPersonActive);
      if (firstPersonActive) onPilotPositionChange([playerFeet.x, playerFeet.y, playerFeet.z]);
    },
    onKeyDown,
    onKeyUp,
    dispose: () => {
      stopped = true;
      for (const worker of state.worldMeshWorkers) {
        worker.postMessage({ type: "cancel" });
        worker.terminate();
      }
      if (state.animationFrame) window.cancelAnimationFrame(state.animationFrame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("click", onPointerLockClick);
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
      controls.dispose();
      for (const mesh of entityInstancedMeshes) mesh.dispose();
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
      for (const material of state.worldMaterials) material.dispose();
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
  applyLayerVisibilityForMode();
  animate();
  await reportProgress("Finalizing", 1, 1);
  return state;
}
