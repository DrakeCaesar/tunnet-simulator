import {
  TunnetSimulator,
  buildPortAdjacency,
  type PortRef,
  type Packet,
} from "../simulation";
import { setWorldSsaoEnabled } from "./world-ao-ssao";
import { setWorldGridLineResolution } from "./world-grid-lines";
import {
  decodeAddress,
  normalizeSave,
  buildWorldSummary,
  renderWorldSummary,
  buildGraphModel,
  viewBoxFor,
  clampZoom,
  formatStats,
  type SaveData,
  type GraphModel,
  type ViewportBox,
} from "./model";
import { renderGraph, renderPacketOverlay } from "./view-2d";
import {
  createOrRefresh3DWorld,
  isViewEffectAllowedInMode,
  type Viewer3DState,
  type CameraPersistState,
  type PilotPositionPersistState,
} from "./view-3d";
import { STORAGE_KEYS, parseCameraState, parsePilotPosition } from "./save-viewer-storage";

function fitBoxToViewportAspect(box: ViewportBox, viewportWidthPx: number, viewportHeightPx: number): ViewportBox {
  const vw = Math.max(1, viewportWidthPx);
  const vh = Math.max(1, viewportHeightPx);
  const target = vw / vh;
  const w = Math.max(1e-9, box.maxX - box.minX);
  const h = Math.max(1e-9, box.maxY - box.minY);
  const current = w / h;
  const cx = (box.minX + box.maxX) * 0.5;
  const cy = (box.minY + box.maxY) * 0.5;
  if (Math.abs(current - target) < 1e-9) return box;
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

export function startSaveViewerController(): void {
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
  const selectedDeviceEl = document.querySelector<HTMLDivElement>("#sv-selected-device");
  if (
    !fileInput || !slotIndexInput || !slotIndexValue || !loadSampleButton || !stepButton || !runButton || !stopButton ||
    !resetButton || !tickRateInput || !tickRateValue || !togglePacketIpsButton || !zoomInButton || !zoomOutButton ||
    !zoomFitButton || !viewToggleButton || !fpsToggleButton || !gravityToggleButton || !ssaoToggleButton ||
    !blockAoToggleButton || !hemiAoToggleButton || !resetCameraButton || !teleportEndpointInput || !teleportButton ||
    !cullHeightInput || !cullHeightValue || !loadProgressWrap || !loadProgress || !loadProgressValue || !loadProgressText ||
    !wiresEl || !packetOverlayEl || !view3DEl || !statsEl || !selectedDeviceEl
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
  let panMoved = false;
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
    const modeIsPilot = world3D?.isFirstPerson ?? firstPersonMode;
    const ssaoAllowedByMode = isViewEffectAllowedInMode("ssao", modeIsPilot);
    setWorldSsaoEnabled(world3D?.ssaoPass ?? null, ssaoEnabled && ssaoAllowedByMode, cullHeightT);
  };
  const applyVertexAoState = (): void => {
    const modeIsPilot = world3D?.isFirstPerson ?? firstPersonMode;
    const blockAoAllowedByMode = isViewEffectAllowedInMode("blockAo", modeIsPilot);
    const hemiAoAllowedByMode = isViewEffectAllowedInMode("hemisphereAo", modeIsPilot);
    world3D?.setVertexAoEnabled({
      blockAo: blockAoEnabled && blockAoAllowedByMode,
      hemisphereAo: hemisphereAoEnabled && hemiAoAllowedByMode,
    });
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
    if (use3DView) return;
    const drawBox = renderGraph(currentModel, cameraBox);
    renderPacketOverlay(currentModel, previousOccupancy, currentOccupancy, simAdj, progress, showPacketIps, drawBox);
  };

  const worldFromClientPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = wiresEl.getBoundingClientRect();
    const tX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
    const tY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    const drawBox = fitBoxToViewportAspect(cameraBox, rect.width, rect.height);
    const width = Math.max(1, drawBox.maxX - drawBox.minX);
    const height = Math.max(1, drawBox.maxY - drawBox.minY);
    return {
      x: drawBox.minX + width * Math.max(0, Math.min(1, tX)),
      y: drawBox.minY + height * Math.max(0, Math.min(1, tY)),
    };
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
          window.localStorage.setItem(STORAGE_KEYS.cameraStatePilot, JSON.stringify(state));
        } else {
          persisted3DCameraState = state;
          window.localStorage.setItem(STORAGE_KEYS.cameraState3d, JSON.stringify(state));
        }
      },
      persistedPilotPosition,
      (position) => {
        persistedPilotPosition = position;
        window.localStorage.setItem(STORAGE_KEYS.playerPositionPilot, JSON.stringify(position));
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
      applyVertexAoState();
      if (pendingTeleportPosition) applyTeleportPosition(pendingTeleportPosition);
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
      void refresh3DWorld();
      if (!world3DResizeHandler) {
        world3DResizeHandler = () => {
          if (!world3D || !use3DView) return;
          const w = Math.max(1, view3DEl.clientWidth);
          const h = Math.max(1, view3DEl.clientHeight);
          world3D.camera.aspect = w / h;
          world3D.camera.updateProjectionMatrix();
          world3D.renderer.setSize(w, h);
          world3D.composer?.setSize(w, h);
          for (const lines of world3D.worldBoundaryLines) setWorldGridLineResolution(lines, w, h);
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
    if (packetAnimRaf !== null) window.cancelAnimationFrame(packetAnimRaf);
    const start = performance.now();
    const animate = (): void => {
      const elapsed = performance.now() - start;
      const progress = Math.max(0, Math.min(1, elapsed / Math.max(1, tickIntervalMs)));
      renderGraphAndPackets(progress);
      if (progress < 1) packetAnimRaf = window.requestAnimationFrame(animate);
      else packetAnimRaf = null;
    };
    packetAnimRaf = window.requestAnimationFrame(animate);
  };

  const applyZoom = (factor: number, anchor?: { x: number; y: number }): void => {
    const centerX = (cameraBox.minX + cameraBox.maxX) / 2;
    const centerY = (cameraBox.minY + cameraBox.maxY) / 2;
    const pivot = anchor ?? { x: centerX, y: centerY };
    const baseWidth = Math.max(1, baseBox.maxX - baseBox.minX);
    const baseHeight = Math.max(1, baseBox.maxY - baseBox.minY);
    const curWidth = Math.max(1, cameraBox.maxX - cameraBox.minX);
    const curHeight = Math.max(1, cameraBox.maxY - cameraBox.minY);
    const currentZoom = baseWidth / curWidth;
    const targetZoom = clampZoom(currentZoom * factor);
    const nextWidth = baseWidth / targetZoom;
    const nextHeight = baseHeight / targetZoom;
    const relXRaw = curWidth > 0 ? (pivot.x - cameraBox.minX) / curWidth : 0.5;
    const relYRaw = curHeight > 0 ? (pivot.y - cameraBox.minY) / curHeight : 0.5;
    const relX = Math.max(0, Math.min(1, relXRaw));
    const relY = Math.max(0, Math.min(1, relYRaw));
    const minX = pivot.x - relX * nextWidth;
    const minY = pivot.y - relY * nextHeight;
    cameraBox = fitBoxToViewportAspect(
      { minX, maxX: minX + nextWidth, minY, maxY: minY + nextHeight },
      wiresEl.clientWidth,
      wiresEl.clientHeight,
    );
    renderGraphAndPackets();
  };

  const panByPixels = (dx: number, dy: number): void => {
    const width = Math.max(1, cameraBox.maxX - cameraBox.minX);
    const height = Math.max(1, cameraBox.maxY - cameraBox.minY);
    const unitsPerPixelX = width / Math.max(1, wiresEl.clientWidth || 1);
    const unitsPerPixelY = height / Math.max(1, wiresEl.clientHeight || 1);
    const worldDx = dx * unitsPerPixelX;
    const worldDy = dy * unitsPerPixelY;
    cameraBox = { minX: cameraBox.minX - worldDx, maxX: cameraBox.maxX - worldDx, minY: cameraBox.minY - worldDy, maxY: cameraBox.maxY - worldDy };
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
    baseBox = fitBoxToViewportAspect(viewBoxFor(currentModel.nodes), wiresEl.clientWidth, wiresEl.clientHeight);
    cameraBox = { ...baseBox };
    previousOccupancy = [];
    currentOccupancy = [];
    simAdj = buildPortAdjacency(currentModel.topology);
    if (use3DView) void refresh3DWorld();
    else renderGraphAndPackets();
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
    window.localStorage.setItem(STORAGE_KEYS.slotIndex, String(slotIndex));
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
  stopButton.addEventListener("click", stopRunLoop);
  resetButton.addEventListener("click", () => {
    if (Object.keys(currentModel.topology.devices).length === 0) return;
    resetSimulator();
  });
  togglePacketIpsButton.addEventListener("click", () => {
    showPacketIps = !showPacketIps;
    togglePacketIpsButton.textContent = showPacketIps ? "Hide IPs" : "Show IPs";
    renderGraphAndPackets();
  });

  const savedTickInterval = Number(window.localStorage.getItem(STORAGE_KEYS.tickIntervalMs) ?? "");
  if (Number.isFinite(savedTickInterval) && savedTickInterval >= 20 && savedTickInterval <= 1000) tickIntervalMs = Math.floor(savedTickInterval);
  tickRateInput.value = String(tickIntervalMs);
  tickRateValue.textContent = `${tickIntervalMs} ms`;
  tickRateInput.addEventListener("input", () => {
    const value = Number.parseInt(tickRateInput.value, 10);
    tickIntervalMs = Number.isFinite(value) ? Math.max(20, Math.min(1000, value)) : 200;
    tickRateValue.textContent = `${tickIntervalMs} ms`;
    window.localStorage.setItem(STORAGE_KEYS.tickIntervalMs, String(tickIntervalMs));
    if (runTimer !== null) {
      window.clearInterval(runTimer);
      runTimer = window.setInterval(runTick, tickIntervalMs);
    }
  });

  zoomInButton.addEventListener("click", () => {
    const rect = wiresEl.getBoundingClientRect();
    applyZoom(1.25, worldFromClientPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  });
  zoomOutButton.addEventListener("click", () => {
    const rect = wiresEl.getBoundingClientRect();
    applyZoom(1 / 1.25, worldFromClientPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  });
  zoomFitButton.addEventListener("click", () => {
    cameraBox = fitBoxToViewportAspect(baseBox, wiresEl.clientWidth, wiresEl.clientHeight);
    renderGraphAndPackets();
  });
  viewToggleButton.addEventListener("click", () => {
    use3DView = !use3DView;
    window.localStorage.setItem(STORAGE_KEYS.viewMode, use3DView ? "3d" : "2d");
    applyViewMode();
  });
  fpsToggleButton.addEventListener("click", () => {
    firstPersonMode = !firstPersonMode;
    window.localStorage.setItem(STORAGE_KEYS.firstPersonMode, firstPersonMode ? "1" : "0");
    fpsToggleButton.textContent = `Pilot mode: ${firstPersonMode ? "on" : "off"}`;
    if (use3DView && world3D) {
      world3D.setFirstPersonMode(firstPersonMode);
      applyAoForCullState();
      applyVertexAoState();
      const restore = firstPersonMode ? persistedPilotCameraState : persisted3DCameraState;
      if (restore) world3D.applyCameraState(restore);
    }
  });
  gravityToggleButton.addEventListener("click", () => {
    gravityEnabled = !gravityEnabled;
    window.localStorage.setItem(STORAGE_KEYS.gravityEnabled, gravityEnabled ? "1" : "0");
    gravityToggleButton.textContent = `Gravity: ${gravityEnabled ? "on" : "off"}`;
    if (use3DView && world3D) world3D.setGravityEnabled(gravityEnabled);
  });
  ssaoToggleButton.addEventListener("click", () => {
    ssaoEnabled = !ssaoEnabled;
    window.localStorage.setItem(STORAGE_KEYS.ssaoEnabled, ssaoEnabled ? "1" : "0");
    ssaoToggleButton.textContent = `SSAO: ${ssaoEnabled ? "on" : "off"}`;
    applyAoForCullState();
  });
  blockAoToggleButton.addEventListener("click", () => {
    blockAoEnabled = !blockAoEnabled;
    window.localStorage.setItem(STORAGE_KEYS.blockAoEnabled, blockAoEnabled ? "1" : "0");
    blockAoToggleButton.textContent = `Block AO: ${blockAoEnabled ? "on" : "off"}`;
    applyVertexAoState();
  });
  hemiAoToggleButton.addEventListener("click", () => {
    hemisphereAoEnabled = !hemisphereAoEnabled;
    window.localStorage.setItem(STORAGE_KEYS.hemisphereAoEnabled, hemisphereAoEnabled ? "1" : "0");
    hemiAoToggleButton.textContent = `Hemi AO: ${hemisphereAoEnabled ? "on" : "off"}`;
    applyVertexAoState();
  });
  resetCameraButton.addEventListener("click", () => {
    if (!world3D) return;
    if (world3D.isFirstPerson) {
      persistedPilotCameraState = null;
      window.localStorage.removeItem(STORAGE_KEYS.cameraStatePilot);
      persistedPilotPosition = null;
      window.localStorage.removeItem(STORAGE_KEYS.playerPositionPilot);
    } else {
      persisted3DCameraState = null;
      window.localStorage.removeItem(STORAGE_KEYS.cameraState3d);
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
      window.localStorage.setItem(STORAGE_KEYS.viewMode, "3d");
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
    } else cullHeightValue.textContent = `${Math.round(t * 100)}%`;
  });

  firstPersonMode = (window.localStorage.getItem(STORAGE_KEYS.firstPersonMode) ?? "").trim() === "1";
  fpsToggleButton.textContent = `Pilot mode: ${firstPersonMode ? "on" : "off"}`;
  gravityEnabled = (window.localStorage.getItem(STORAGE_KEYS.gravityEnabled) ?? "1").trim() !== "0";
  gravityToggleButton.textContent = `Gravity: ${gravityEnabled ? "on" : "off"}`;
  ssaoEnabled = (window.localStorage.getItem(STORAGE_KEYS.ssaoEnabled) ?? "1").trim() !== "0";
  ssaoToggleButton.textContent = `SSAO: ${ssaoEnabled ? "on" : "off"}`;
  blockAoEnabled = (window.localStorage.getItem(STORAGE_KEYS.blockAoEnabled) ?? "1").trim() !== "0";
  blockAoToggleButton.textContent = `Block AO: ${blockAoEnabled ? "on" : "off"}`;
  hemisphereAoEnabled = (window.localStorage.getItem(STORAGE_KEYS.hemisphereAoEnabled) ?? "0").trim() === "1";
  hemiAoToggleButton.textContent = `Hemi AO: ${hemisphereAoEnabled ? "on" : "off"}`;
  persisted3DCameraState = parseCameraState(window.localStorage.getItem(STORAGE_KEYS.cameraState3d));
  persistedPilotCameraState = parseCameraState(window.localStorage.getItem(STORAGE_KEYS.cameraStatePilot));
  persistedPilotPosition = parsePilotPosition(window.localStorage.getItem(STORAGE_KEYS.playerPositionPilot));
  cullHeightInput.value = String(Math.round(cullHeightT * 1000));
  cullHeightValue.textContent = "max";

  wiresEl.addEventListener(
    "wheel",
    (evt) => {
      evt.preventDefault();
      applyZoom(evt.deltaY < 0 ? 1.15 : 1 / 1.15, worldFromClientPoint(evt.clientX, evt.clientY));
    },
    { passive: false },
  );
  wiresEl.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    isPanning = true;
    panMoved = false;
    panLastX = evt.clientX;
    panLastY = evt.clientY;
    wiresEl.classList.add("is-panning");
    wiresEl.setPointerCapture(evt.pointerId);
  });
  wiresEl.addEventListener("pointermove", (evt) => {
    if (!isPanning) return;
    const dx = evt.clientX - panLastX;
    const dy = evt.clientY - panLastY;
    if (Math.abs(dx) + Math.abs(dy) > 1) panMoved = true;
    panLastX = evt.clientX;
    panLastY = evt.clientY;
    panByPixels(dx, dy);
  });
  wiresEl.addEventListener("pointerup", (evt) => {
    if (!isPanning) return;
    const target = evt.target instanceof Element ? evt.target.closest<SVGGElement>("g.sv-node") : null;
    if (!panMoved && target) {
      const deviceId = target.dataset.deviceId ?? "";
      const node = currentModel.nodes.find((n) => n.id === deviceId);
      if (node) {
        selectedDeviceEl.innerHTML = `
          <div class="kv"><span>Type</span><strong>${node.type}</strong></div>
          <div class="kv"><span>ID</span><strong>${node.id}</strong></div>
          <div class="kv"><span>Label</span><strong>${node.label}</strong></div>
          <div class="kv"><span>Position</span><strong>[${node.x.toFixed(2)}, ${node.y.toFixed(2)}]</strong></div>
        `;
      }
    }
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

  const savedViewMode = (window.localStorage.getItem(STORAGE_KEYS.viewMode) ?? "").trim().toLowerCase();
  if (savedViewMode === "3d") use3DView = true;
  const savedSlotIndex = Number.parseInt(window.localStorage.getItem(STORAGE_KEYS.slotIndex) ?? "", 10);
  if (Number.isFinite(savedSlotIndex)) slotIndex = Math.max(0, Math.min(3, savedSlotIndex));
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
