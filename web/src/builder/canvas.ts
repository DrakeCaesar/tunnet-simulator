import {
  BuilderState,
  BuilderEntityRoot,
  BuilderLayer,
  BuilderTemplateType,
  createEntityRoot,
  addLinkRootOneWirePerPort,
  createLinkRoot,
  createEmptyBuilderState,
  compactBuilderIds,
  crossLayerBlockSlotFromSegments,
  defaultSettings,
  isStaticOuterLeafEndpoint,
  isOuterLeafVoidSegment,
  LAYER_COUNTS,
  linkTreatedAsInnerOuterVoidBand,
  linkTreatedAsSlottedInnerMiddle,
  OUTER_CANVAS_VOID_MERGE_KEY,
  rebuildStateWithOuterLeafEndpoints,
  removeEntityGroup,
  removeLinkGroup,
  removeLinksTouchingInstancePort,
  sanitizeDuplicateTypePlacements,
  updateEntitySettings,
} from "./state";
import {
  formatPacketLabelSubject,
  packetIpLabelBgDimensions,
  PACKET_DOT_RADIUS_PX,
  PACKET_IP_LABEL_HEIGHT_PX,
  PACKET_IP_LABEL_OFFSET_X_PX,
  PACKET_IP_LABEL_OFFSET_Y_PX,
  PACKET_IP_LABEL_WIDTH_PX,
  PACKET_LABEL_ANCHOR_X_PX,
} from "./builder-packet-overlay-metrics";
import {
  BUILDER_CANVAS_SCALE_KEY,
  clampCanvasScaleX,
  clampCanvasScaleY,
  canvasScaleXIndexFromValue,
  canvasScaleXValueFromIndex,
  DEFAULT_LAYER_SCALE_Y,
  formatScaleLabel,
  type CanvasScale,
} from "./canvas-scale";
import { builderViewShellHtml } from "./builder-view-shell";
import { createBuilderWireOverlay } from "./builder-wire-overlay";
import { mountBuilderWireColorWheel } from "./wire-color-wheel";
import {
  buildFilterDescription,
  buildTemplateDragImage,
  isBuilderTemplateType,
  templateLabel,
  templateList,
  textTileSizeFromEntity,
  textTileSizeFromSettings,
} from "./template-sidebar";
import { layoutPacketLabelBackgroundRect } from "../packet-label-layout";
import {
  nextPacketLabelMode,
  packetLabelToggleButtonText,
  parsePacketLabelModeFromPageState,
  type PacketLabelMode,
} from "../packet-label-mode";
import {
  expandBuilderState,
  filterSettingsAtSegment,
  layerColumns,
  layerTitle,
  mapMaskForSegment,
  parseBuilderInstanceId,
  outerLayerBuilderColumnSlots,
  orderedLayersTopDown,
  segmentLabel,
  unmapMaskForSegment,
  mapMaskForSegmentIndex,
  unmapMaskForSegmentIndex,
  type ExpandedBuilderState,
} from "./clone-engine";
import {
  clearBuilderLayoutSlot,
  clearBuilderUrlLayoutSlot,
  exportBuilderStateUrlToken,
  importBuilderStateUrlToken,
  listBuilderLayoutSlots,
  loadBuilderState,
  loadBuilderLayoutSlot,
  loadBuilderUrlLayoutSlot,
  saveBuilderLayoutSlot,
  saveBuilderState,
  saveBuilderUrlLayoutSlot,
} from "./persistence";
import { buildBuilderEntityInstanceHtml, buildSortedEntitiesByCanvasBucket } from "./canvas-entity-html";
import { compileBuilderPayload } from "./compile";
import type { Device, Packet, PortRef, SimulationStats, SimulatorRuntimeState, Topology } from "../simulation";
import { buildPortAdjacency, getHubEgressPort, portKey, TunnetSimulator } from "../simulation";
import {
  formatSpeedLabel,
  speedMultiplierFromExponent,
  SPEED_EXP_DEFAULT,
  SPEED_EXP_MAX,
  SPEED_EXP_MIN,
} from "../sim-controls";
import { capturePrimaryDragOnWindow } from "../ui/input/pointer-drag";
import {
  mountSimulatorPanel,
  renderSimulatorMetaGridHtml,
  SimulatorDropBoardController,
  setSimulatorPanelLayoutVariant,
} from "../ui/components/simulator-panel-ui";
import {
  HUB_LAYOUT,
  HUB_VIEW,
  HUB_REVERSE_BUTTON_SIZE,
  HUB_REVERSE_ICON_SIZE,
  hubDistToSeg,
  hubLocalToModel,
  hubPointInOrOnTri,
  hubPointerMode,
  hubPortPinUprightStyle,
  hubTriangleSvg,
  relayPointerMode,
  startRelayRotateDrag,
  startSnappedRotateDragAroundPivot,
  tryStartTextEntityResizeDrag,
  type RotateDragChrome,
} from "../ui/canvas-entities";

const BUILDER_PAGE_STATE_KEY = "tunnet.builder.pageState";
const BUILDER_SIDEBAR_WIDTH_KEY = "tunnet.builder.sidebarWidth";
const BUILDER_LAYER_GAP_PX = 4;
const BUILDER_GRID_TILE_SIZE_X_PX = 20;
const BUILDER_GRID_TILE_SIZE_Y_PX = 20;
const BUILDER_SIDEBAR_DEFAULT_WIDTH_PX = 480;
const BUILDER_SIDEBAR_MIN_WIDTH_PX = 240;
const BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX = 16;
const BUILDER_SIDEBAR_COLLAPSE_THRESHOLD_PX = 160;
const BUILDER_MAIN_MIN_WIDTH_PX = 240;
const BUILDER_LAYOUT_SLOT_COUNT = 5;
const BUILDER_PANEL_SECTION_IDS = ["performance"] as const;

/** One mask nibble cycles * → 0 → 1 → 2 → 3 → * (matches game semantics). */
const MASK_VALUE_CYCLE = ["*", "0", "1", "2", "3"] as const;

type BuilderPanelSectionId = (typeof BUILDER_PANEL_SECTION_IDS)[number];

type BuilderPageState = {
  collapsedSections: Partial<Record<BuilderPanelSectionId, boolean>>;
  packetLabelMode: PacketLabelMode;
  simSpeedExponent: number;
  activeLayoutSlotIndex: number;
  activeLayoutKind: "slot" | "url";
};

interface BuilderMountOptions {
  root: HTMLDivElement;
}

type EntitySelection = { kind: "entity"; rootId: string };
type LinkSelection = { kind: "link"; rootId: string };
type PacketSelection = { kind: "packet"; packetId: number };
type Selection = EntitySelection | LinkSelection | PacketSelection | null;
type SetSelectionOpts = { dropTraceFromView?: boolean; dropTraceDeviceId?: string | null };
type BoxSelectionState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  mode: "replace" | "add" | "remove";
} | null;

type BuilderPerfKey =
  | "canvas.total"
  | "canvas.expand"
  | "canvas.bucketSort"
  | "canvas.htmlBuild"
  | "canvas.domCommit"
  | "canvas.portCache"
  | "wire.total"
  | "wire.packetHook"
  | "wire.expandLinks"
  | "wire.overlayWrapRect"
  | "wire.overlayScrollExtents"
  | "wire.portResolve"
  | "wire.lineBuild"
  | "wire.dragMarkup"
  | "wire.domCommit"
  | "packet.total"
  | "packet.overlayResize"
  | "packet.compute"
  | "packet.polyline"
  | "packet.interpolate"
  | "packet.domCommit"
  | "sim.meta"
  | "sim.finishTotal"
  | "sim.finishRenderPackets"
  | "sim.finishMeta"
  | "sim.finishRefresh"
  | "sim.finishDispatch";

type BuilderPerfStat = { lastMs: number; emaMs: number; maxMs: number; samples: number };

export function mountBuilderView(options: BuilderMountOptions): void {
  const { root } = options;
  let raw = loadBuilderState();
  if (!raw || raw.version !== 1) {
    raw = createEmptyBuilderState();
  }
  const rebuiltInitialState = rebuildStateWithOuterLeafEndpoints(raw);
  const sanitizedInitial = sanitizeDuplicateTypePlacements(rebuiltInitialState);
  const compactedInitial = compactBuilderIds(sanitizedInitial.state);
  let state = compactedInitial.state;
  if (sanitizedInitial.changed || compactedInitial.changed) {
    saveBuilderState(state);
  }

  let selection: Selection = null;
  let dragEntityPatchRaf: number | null = null;
  const pendingDragEntityPatchRootIds = new Set<string>();
  let selectedEntityRootIds = new Set<string>();
  let boxSelection: BoxSelectionState = null;
  let suppressNextEntityClickToggle = false;
  let suppressNextControlClick = false;
  let suppressNextPacketClick = false;
  let suppressBoxSelectionUntilMouseUp = false;
  const loadCanvasScale = (): CanvasScale => {
    try {
      const rawScale = window.localStorage.getItem(BUILDER_CANVAS_SCALE_KEY);
      if (!rawScale) return { x: 1, yByLayer: { ...DEFAULT_LAYER_SCALE_Y } };
      const parsed = JSON.parse(rawScale) as Partial<CanvasScale> & {
        y?: number;
        yByLayer?: Partial<Record<BuilderLayer, number>>;
      };
      const x = clampCanvasScaleX(Number(parsed.x));
      const legacyY = clampCanvasScaleY(Number(parsed.y));
      const yOuter = clampCanvasScaleY(Number(parsed.yByLayer?.outer64));
      const yMiddle = clampCanvasScaleY(Number(parsed.yByLayer?.middle16));
      const yInner = clampCanvasScaleY(Number(parsed.yByLayer?.inner4));
      const yCore = clampCanvasScaleY(Number(parsed.yByLayer?.core1));
      return {
        x: Number.isFinite(x) ? x : 1,
        yByLayer: {
          outer64: Number.isFinite(yOuter) ? yOuter : Number.isFinite(legacyY) ? legacyY : DEFAULT_LAYER_SCALE_Y.outer64,
          middle16: Number.isFinite(yMiddle) ? yMiddle : Number.isFinite(legacyY) ? legacyY : DEFAULT_LAYER_SCALE_Y.middle16,
          inner4: Number.isFinite(yInner) ? yInner : Number.isFinite(legacyY) ? legacyY : DEFAULT_LAYER_SCALE_Y.inner4,
          core1: Number.isFinite(yCore) ? yCore : Number.isFinite(legacyY) ? legacyY : DEFAULT_LAYER_SCALE_Y.core1,
        },
      };
    } catch {
      return { x: 1, yByLayer: { ...DEFAULT_LAYER_SCALE_Y } };
    }
  };
  let canvasScale = loadCanvasScale();
  const loadBuilderPageState = (): BuilderPageState => {
    const clampLayoutSlotIndex = (value: unknown): number => {
      const n = Number(value);
      if (!Number.isFinite(n)) return 1;
      return Math.max(1, Math.min(BUILDER_LAYOUT_SLOT_COUNT, Math.round(n)));
    };
    const clampSimSpeedExponent = (value: unknown): number => {
      const n = Number(value);
      if (!Number.isFinite(n)) return SPEED_EXP_DEFAULT;
      return Math.max(SPEED_EXP_MIN, Math.min(SPEED_EXP_MAX, Math.round(n)));
    };
    try {
      const raw = window.localStorage.getItem(BUILDER_PAGE_STATE_KEY);
      if (!raw) {
        return {
          collapsedSections: {},
          packetLabelMode: "ipsSubject",
          simSpeedExponent: SPEED_EXP_DEFAULT,
          activeLayoutSlotIndex: 1,
          activeLayoutKind: "slot",
        };
      }
      const parsed = JSON.parse(raw) as Partial<BuilderPageState> & { showPacketIps?: unknown };
      const collapsedSections: BuilderPageState["collapsedSections"] = {};
      const parsedSections = parsed.collapsedSections ?? {};
      BUILDER_PANEL_SECTION_IDS.forEach((id) => {
        collapsedSections[id] = parsedSections[id] === true;
      });
      return {
        collapsedSections,
        packetLabelMode: parsePacketLabelModeFromPageState(parsed),
        simSpeedExponent: clampSimSpeedExponent(parsed.simSpeedExponent),
        activeLayoutSlotIndex: clampLayoutSlotIndex(parsed.activeLayoutSlotIndex),
        activeLayoutKind: parsed.activeLayoutKind === "url" ? "url" : "slot",
      };
    } catch {
      return {
        collapsedSections: {},
        packetLabelMode: "ipsSubject",
        simSpeedExponent: SPEED_EXP_DEFAULT,
        activeLayoutSlotIndex: 1,
        activeLayoutKind: "slot",
      };
    }
  };
  const clampBuilderSidebarWidth = (width: number, layoutWidth = window.innerWidth): number => {
    if (!Number.isFinite(width)) return BUILDER_SIDEBAR_DEFAULT_WIDTH_PX;
    const maxWidth = Math.max(
      BUILDER_SIDEBAR_MIN_WIDTH_PX,
      layoutWidth - BUILDER_MAIN_MIN_WIDTH_PX,
    );
    if (width <= BUILDER_SIDEBAR_COLLAPSE_THRESHOLD_PX) {
      return BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX;
    }
    const expandedWidth = Math.max(
      BUILDER_SIDEBAR_MIN_WIDTH_PX,
      Math.min(maxWidth, BUILDER_SIDEBAR_DEFAULT_WIDTH_PX),
    );
    return expandedWidth;
  };
  const loadBuilderSidebarWidth = (): number => {
    try {
      const raw = window.localStorage.getItem(BUILDER_SIDEBAR_WIDTH_KEY);
      if (raw === null) return BUILDER_SIDEBAR_DEFAULT_WIDTH_PX;
      return clampBuilderSidebarWidth(Number(raw));
    } catch {
      return BUILDER_SIDEBAR_DEFAULT_WIDTH_PX;
    }
  };
  let builderPageState = loadBuilderPageState();
  const persistedUrlLayout = loadBuilderUrlLayoutSlot();
  const startupUrlToken = new URLSearchParams(window.location.search).get("layout");
  builderPageState.activeLayoutSlotIndex = Math.max(
    1,
    Math.min(BUILDER_LAYOUT_SLOT_COUNT, Math.round(builderPageState.activeLayoutSlotIndex || 1)),
  );
  {
    const usePersistedUrlLayout =
      builderPageState.activeLayoutKind === "url" &&
      persistedUrlLayout &&
      !startupUrlToken;
    const initialState = usePersistedUrlLayout
      ? persistedUrlLayout.state
      : (loadBuilderLayoutSlot(builderPageState.activeLayoutSlotIndex)?.state ?? null);
    if (initialState) {
      const rebuilt = rebuildStateWithOuterLeafEndpoints(initialState);
      const sanitized = sanitizeDuplicateTypePlacements(rebuilt);
      const compacted = compactBuilderIds(sanitized.state);
      state = compacted.state;
      if (sanitized.changed || compacted.changed) {
        if (usePersistedUrlLayout && persistedUrlLayout) {
          saveBuilderUrlLayoutSlot(persistedUrlLayout.token, state);
        } else {
          saveBuilderLayoutSlot(builderPageState.activeLayoutSlotIndex, state);
        }
      }
    } else {
      // If the selected loadout slot is empty, start from an empty layout for that slot.
      state = createEmptyBuilderState();
    }
  }
  let builderSidebarWidth = loadBuilderSidebarWidth();
  const builderDevPerfVisible = (() => {
    const host = window.location.hostname;
    const localHost =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".local");
    const forced = new URLSearchParams(window.location.search).get("builderPerf");
    if (forced === "1") return true;
    if (forced === "0") return false;
    return localHost;
  })();
  const panelSectionAttrs = (id: BuilderPanelSectionId): string => {
    const collapsed = builderPageState.collapsedSections[id] === true;
    return `class="builder-panel-section${collapsed ? " collapsed" : ""}" data-builder-panel-section="${id}"`;
  };
  const panelToggle = (id: BuilderPanelSectionId, title: string): string => {
    const collapsed = builderPageState.collapsedSections[id] === true;
    return `<button class="section-title builder-panel-section-toggle" type="button" data-builder-panel-toggle="${id}" aria-expanded="${collapsed ? "false" : "true"}" aria-controls="builder-panel-${id}-body"><span>${title}</span><span class="builder-panel-section-caret" aria-hidden="true">›</span></button>`;
  };

  root.innerHTML = builderViewShellHtml(canvasScale);

  const builderLayoutEl = root.querySelector<HTMLDivElement>(".builder-layout")!;
  const builderSidebarEl = root.querySelector<HTMLElement>(".builder-sidebar")!;
  const builderSidebarResizerEl = root.querySelector<HTMLDivElement>(".builder-sidebar-resizer")!;
  const controlsSidebarHostEl = root.querySelector<HTMLDivElement>("#builder-controls-sidebar-host")!;
  const controlsFloatingHostEl = root.querySelector<HTMLDivElement>("#builder-controls-floating-host")!;
  const panelLayoutsEl = root.querySelector<HTMLDivElement>("#builder-panel-layouts")!;
  const panelScaleEl = root.querySelector<HTMLDivElement>("#builder-panel-scale")!;
  const simPanelMountHost = root.querySelector<HTMLDivElement>("#builder-sim-panel-host")!;
  const simPanel = mountSimulatorPanel(simPanelMountHost, "builder", {
    layoutVariant: "hud",
    stepBack: true,
    speedExponent: builderPageState.simSpeedExponent,
    packetIpsButtonText: packetLabelToggleButtonText(builderPageState.packetLabelMode),
    dropBoardEmptyText:
      "Run or step the simulation to accumulate per-entity drop counts. Stop clears the list.",
    initialMetaHtml: "Initializing…",
  });
  const panelSimulationEl = simPanel.root;
  const panelTemplatesEl = root.querySelector<HTMLDivElement>("#builder-panel-templates")!;
  const panelPerformanceEl = root.querySelector<HTMLDivElement>("#builder-panel-performance")!;
  const templatesEl = root.querySelector<HTMLDivElement>("#builder-templates")!;
  const deleteDropZoneEl = root.querySelector<HTMLDivElement>("#builder-delete-drop-zone")!;
  const wireColorWheelHostEl = root.querySelector<HTMLDivElement>("#builder-wire-color-wheel-host")!;
  const wireColorChoiceRef: { index: number } = { index: 0 };
  mountBuilderWireColorWheel(wireColorWheelHostEl, wireColorChoiceRef);
  const canvasEl = root.querySelector<HTMLDivElement>("#builder-canvas")!;
  const wireOverlayEl = root.querySelector<SVGSVGElement>("#builder-wire-overlay")!;
  const packetOverlayEl = root.querySelector<SVGSVGElement>("#builder-packet-overlay")!;
  const perfEl = root.querySelector<HTMLPreElement>("#builder-perf")!;
  const scaleXEl = root.querySelector<HTMLInputElement>("#builder-scale-x")!;
  const scaleYOuterEl = root.querySelector<HTMLInputElement>("#builder-scale-y-outer64")!;
  const scaleYMiddleEl = root.querySelector<HTMLInputElement>("#builder-scale-y-middle16")!;
  const scaleYInnerEl = root.querySelector<HTMLInputElement>("#builder-scale-y-inner4")!;
  const scaleYCoreEl = root.querySelector<HTMLInputElement>("#builder-scale-y-core1")!;
  const scaleXValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-x-value")!;
  const scaleYOuterValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-outer64-value")!;
  const scaleYMiddleValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-middle16-value")!;
  const scaleYInnerValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-inner4-value")!;
  const scaleYCoreValueEl = root.querySelector<HTMLSpanElement>("#builder-scale-y-core1-value")!;
  const layoutSlotsEl = root.querySelector<HTMLDivElement>("#builder-layout-slots")!;
  const simPlayPauseBtn = simPanel.playPauseBtn;
  const simBackBtn = simPanel.backBtn;
  const simStepBtn = simPanel.stepBtn;
  const simResetBtn = simPanel.resetBtn;
  const simTogglePacketIpsBtn = simPanel.togglePacketIpsBtn;
  const simSpeedEl = simPanel.speedRange;
  const simSpeedValueEl = simPanel.speedValueSpan;
  const simMetaEl = simPanel.metaEl;
  const canvasWrapEl = wireOverlayEl.parentElement as HTMLDivElement | null;
  const wireBag: { w: ReturnType<typeof createBuilderWireOverlay> | null } = { w: null };
  const boxEl = document.createElement("div");
  boxEl.className = "builder-box-selection";
  const dragBoundsEl = document.createElement("div");
  dragBoundsEl.className = "builder-drag-bounds";
  if (canvasWrapEl) {
    canvasWrapEl.appendChild(boxEl);
    canvasWrapEl.appendChild(dragBoundsEl);
  }
  const perfStats = new Map<BuilderPerfKey, BuilderPerfStat>();
  const PERF_EMA_ALPHA = 0.18;
  let perfCounts = { expandedEntities: 0, stateLinks: 0, expandedLinks: 0, packetsInFlight: 0 };
  let nextPerfPanelAtMs = 0;
  const hideEntityPropertyLabels = true;
  let urlEmbeddedLayoutState: BuilderState | null = persistedUrlLayout?.state ?? null;
  let urlEmbeddedLayoutToken: string | null = persistedUrlLayout?.token ?? null;
  let pendingClearLayoutSlotIndex: number | null = null;
  let pendingSaveCopyLayoutSlotIndex: number | null = null;
  let layoutImportText = "";
  let activeLayoutTarget: { kind: "slot"; index: number } | { kind: "url" } = {
    ...(builderPageState.activeLayoutKind === "url" && persistedUrlLayout && !startupUrlToken
      ? { kind: "url" as const }
      : { kind: "slot" as const, index: builderPageState.activeLayoutSlotIndex }),
  };
  let filterTooltipTimer: number | null = null;
  let filterTooltipRootId: string | null = null;
  let filterTooltipInstanceId: string | null = null;
  let filterTooltipEl: HTMLDivElement | null = null;

  function formatSlotTimestamp(ts: number): string {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return "Unknown time";
    }
  }

  function slotUrlFromToken(token: string): string {
    const url = new URL(window.location.href);
    url.searchParams.set("layout", token);
    return url.toString();
  }

  function layoutTokenFromInput(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      return parsed.searchParams.get("layout");
    } catch {
      return trimmed;
    }
  }

  async function copyLayoutUrlForState(layoutState: BuilderState): Promise<void> {
    const token = await exportBuilderStateUrlToken(layoutState);
    await navigator.clipboard.writeText(slotUrlFromToken(token));
  }

  function applyLoadedBuilderState(nextRawState: BuilderState, persistState: boolean): void {
    const rebuilt = rebuildStateWithOuterLeafEndpoints(nextRawState);
    const sanitized = sanitizeDuplicateTypePlacements(rebuilt);
    state = compactBuilderIds(sanitized.state).state;
    if (persistState) {
      persist();
    } else {
      requestBuilderSimulatorRefresh();
    }
    setSelection(null);
    renderLayoutSlots();
    renderCanvas();
    resetBuilderSimulation();
  }

  function renderLayoutSlots(): void {
    const byIndex = new Map(listBuilderLayoutSlots().map((slot) => [slot.index, slot]));
    const escapedImportText = layoutImportText
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    let html = "";
    for (let i = 1; i <= BUILDER_LAYOUT_SLOT_COUNT; i += 1) {
      const slot = byIndex.get(i);
      const subtitle = slot ? formatSlotTimestamp(slot.updatedAtMs) : "Empty";
      const active = activeLayoutTarget.kind === "slot" && activeLayoutTarget.index === i;
      const clearArmed = pendingClearLayoutSlotIndex === i;
      const saveCopyArmed = pendingSaveCopyLayoutSlotIndex === i;
      html += `
        <div class="builder-layout-slot ${active ? "builder-layout-slot--active" : ""}">
          <div class="builder-layout-slot-meta">
            <strong>Layout ${i}</strong>
            <span>${subtitle}</span>
          </div>
          <div class="builder-layout-slot-actions">
            <button type="button" data-layout-slot-action="select" data-layout-slot="${i}" ${active ? "disabled" : ""}>${active ? "Active" : "Load"}</button>
            <button type="button" data-layout-slot-action="save-copy" data-layout-slot="${i}" ${active ? "disabled" : ""}>${saveCopyArmed ? "Confirm" : "Save copy"}</button>
            <button type="button" data-layout-slot-action="clear" data-layout-slot="${i}" ${slot ? "" : "disabled"}>${clearArmed ? "Confirm" : "Clear"}</button>
            <button type="button" data-layout-slot-action="url" data-layout-slot="${i}" ${slot ? "" : "disabled"}>Copy URL</button>
          </div>
        </div>
      `;
    }
    if (urlEmbeddedLayoutState && urlEmbeddedLayoutToken) {
      html += `
        <div class="builder-layout-slot builder-layout-slot--url ${activeLayoutTarget.kind === "url" ? "builder-layout-slot--active" : ""}">
          <div class="builder-layout-slot-meta">
            <strong>URL layout</strong>
          </div>
          <div class="builder-layout-slot-actions">
            <button type="button" data-layout-slot-action="load-url" ${activeLayoutTarget.kind === "url" ? "disabled" : ""}>${activeLayoutTarget.kind === "url" ? "Active" : "Select"}</button>
            <button type="button" data-layout-slot-action="clear-url">Clear</button>
            <button type="button" data-layout-slot-action="url-url">Copy URL</button>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="builder-layout-slot builder-layout-slot--import">
          <div class="builder-layout-slot-meta">
            <strong>Import URL/token</strong>
          </div>
          <div class="builder-layout-slot-import">
            <button
              type="button"
              data-layout-slot-action="import-load"
              ${layoutImportText.trim().length ? "" : "disabled"}
            >
              Load
            </button>
            <input
              type="text"
              value="${escapedImportText}"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              autocomplete="off"
              data-layout-slot-import-input
              placeholder="Paste URL or token"
            />
          </div>
        </div>
      `;
    }
    layoutSlotsEl.innerHTML = html;
  }

  function persistCanvasScale(): void {
    window.localStorage.setItem(BUILDER_CANVAS_SCALE_KEY, JSON.stringify(canvasScale));
  }

  function persistBuilderPageState(): void {
    window.localStorage.setItem(BUILDER_PAGE_STATE_KEY, JSON.stringify(builderPageState));
  }

  function persistBuilderSidebarWidth(): void {
    window.localStorage.setItem(BUILDER_SIDEBAR_WIDTH_KEY, String(Math.round(builderSidebarWidth)));
  }

  function applyBuilderSidebarWidth(width: number, persistWidth = false): void {
    const layoutWidth = builderLayoutEl.getBoundingClientRect().width || window.innerWidth;
    builderSidebarWidth = clampBuilderSidebarWidth(width, layoutWidth);
    builderLayoutEl.style.setProperty("--builder-sidebar-width", `${builderSidebarWidth}px`);
    builderLayoutEl.classList.toggle(
      "builder-sidebar-collapsed",
      builderSidebarWidth === BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX,
    );
    const collapsed = builderSidebarWidth === BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX;
    const actionLabel = collapsed ? "Open side panel" : "Close side panel";
    builderSidebarResizerEl.setAttribute("aria-label", actionLabel);
    builderSidebarResizerEl.setAttribute("title", actionLabel);
    if (persistWidth) {
      persistBuilderSidebarWidth();
    }
    syncBuilderControlPanelPlacement();
    wireBag.w!.scheduleWireOverlayRender();
    renderBuilderPacketCircles(simPacketProgress);
  }

  function syncBuilderControlPanelPlacement(): void {
    const sidebarCollapsed = builderSidebarWidth === BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX;
    builderLayoutEl.classList.toggle("builder-controls-in-sidebar", !sidebarCollapsed);
    if (!builderDevPerfVisible) {
      panelPerformanceEl.remove();
    }
    if (sidebarCollapsed) {
      controlsFloatingHostEl.append(panelTemplatesEl, wireColorWheelHostEl, panelScaleEl, panelSimulationEl, panelLayoutsEl);
      if (builderDevPerfVisible) {
        controlsFloatingHostEl.append(panelPerformanceEl);
      }
      setSimulatorPanelLayoutVariant(panelSimulationEl, "hud");
      return;
    }
    controlsSidebarHostEl.append(panelLayoutsEl, panelSimulationEl, panelScaleEl, wireColorWheelHostEl, panelTemplatesEl);
    if (builderDevPerfVisible) {
      controlsSidebarHostEl.append(panelPerformanceEl);
    }
    setSimulatorPanelLayoutVariant(panelSimulationEl, "sidebar");
  }

  function setPanelSectionCollapsed(sectionId: BuilderPanelSectionId, collapsed: boolean): void {
    builderPageState = {
      ...builderPageState,
      collapsedSections: {
        ...builderPageState.collapsedSections,
        [sectionId]: collapsed,
      },
    };
    const sectionEl = root.querySelector<HTMLElement>(`[data-builder-panel-section="${sectionId}"]`);
    const toggleEl = root.querySelector<HTMLButtonElement>(`[data-builder-panel-toggle="${sectionId}"]`);
    sectionEl?.classList.toggle("collapsed", collapsed);
    toggleEl?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    persistBuilderPageState();
  }

  function cyclePacketLabelMode(): void {
    const next = nextPacketLabelMode(builderPageState.packetLabelMode);
    builderPageState = {
      ...builderPageState,
      packetLabelMode: next,
    };
    simTogglePacketIpsBtn.textContent = packetLabelToggleButtonText(next);
    if (next === "hide") {
      packetLabelPool.forEach((label) => {
        if (label.visible) {
          label.bg.setAttribute("display", "none");
          label.text.setAttribute("display", "none");
          label.visible = false;
        }
        label.text.removeAttribute("data-packet-id");
        label.lastLabelSig = "";
      });
    }
    persistBuilderPageState();
    renderBuilderPacketCircles(simPacketProgress);
  }

  function setBuilderDragCursor(cursor: "grabbing" | "crosshair"): void {
    document.body.style.cursor = cursor;
    root.classList.toggle("builder-dragging-grab", cursor === "grabbing");
  }

  function clearBuilderDragCursor(): void {
    document.body.style.removeProperty("cursor");
    root.classList.remove("builder-dragging-grab");
  }

  window.addEventListener("blur", clearBuilderDragCursor);
  window.addEventListener("contextmenu", clearBuilderDragCursor);

  builderSidebarResizerEl.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    if (builderSidebarWidth === BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX) {
      applyBuilderSidebarWidth(BUILDER_SIDEBAR_DEFAULT_WIDTH_PX, true);
      return;
    }
    applyBuilderSidebarWidth(BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX, true);
  });

  builderSidebarResizerEl.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (builderSidebarWidth === BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX) {
      applyBuilderSidebarWidth(BUILDER_SIDEBAR_DEFAULT_WIDTH_PX, true);
      return;
    }
    applyBuilderSidebarWidth(BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX, true);
  });

  builderSidebarEl.addEventListener("click", () => {
    if (builderSidebarWidth !== BUILDER_SIDEBAR_COLLAPSED_WIDTH_PX) return;
    applyBuilderSidebarWidth(BUILDER_SIDEBAR_DEFAULT_WIDTH_PX, true);
  });

  function applyCanvasScale(): void {
    const wrap = wireOverlayEl.parentElement;
    if (wrap) {
      const middleBasePx = Math.max(320, wrap.clientWidth);
      const layerCount = orderedLayersTopDown().length;
      const totalGapPx = Math.max(0, layerCount - 1) * BUILDER_LAYER_GAP_PX;
      const usableHeight = Math.max(120, wrap.clientHeight - totalGapPx);
      const rawLayerBasePx = Math.max(120, usableHeight / Math.max(1, layerCount));
      // Floor (not nearest) and quantize to 4px steps so 0.5x/1.5x vertical
      // scale multipliers resolve to clean integer heights.
      const layerBasePx = Math.max(4, Math.floor(rawLayerBasePx / 4) * 4);
      let rawMiddleColWidthPx: number;
      if (canvasScale.x <= 0.5) {
        // For sub-1x zoom, make the horizontal scale represent how many outer (64-layer)
        // segments fit in the viewport:
        // 0.5 -> 8, 0.25 -> 16, 1/8 -> 32, 1/16 -> 64.
        const outerSegmentsToFit = Math.max(1, Math.round(4 / canvasScale.x));
        const outerTrackSpacePx = Math.max(
          1,
          middleBasePx - (outerSegmentsToFit - 1) * BUILDER_LAYER_GAP_PX,
        );
        // Distribute remainder across visible Octet-4 columns so widths stay integer
        // without coarse 64/32/16px jumps.
        const outerBasePx = Math.max(1, Math.floor(outerTrackSpacePx / outerSegmentsToFit));
        const outerRemainder = Math.max(0, outerTrackSpacePx - outerBasePx * outerSegmentsToFit);
        const outerVisibleWidths = Array.from({ length: outerSegmentsToFit }, (_, idx) =>
          outerBasePx + (idx < outerRemainder ? 1 : 0),
        );
        const repeats = Math.max(1, Math.floor(64 / outerSegmentsToFit));
        const outerWidths = Array.from({ length: repeats }, () => outerVisibleWidths).flat();
        const middleWidths = Array.from({ length: 16 }, (_, idx) => {
          const base = idx * 4;
          return (
            outerWidths[base] +
            outerWidths[base + 1] +
            outerWidths[base + 2] +
            outerWidths[base + 3] +
            3 * BUILDER_LAYER_GAP_PX
          );
        });
        const innerWidths = Array.from({ length: 4 }, (_, idx) => {
          const base = idx * 4;
          return (
            middleWidths[base] +
            middleWidths[base + 1] +
            middleWidths[base + 2] +
            middleWidths[base + 3] +
            3 * BUILDER_LAYER_GAP_PX
          );
        });
        const coreWidth =
          innerWidths[0] +
          innerWidths[1] +
          innerWidths[2] +
          innerWidths[3] +
          3 * BUILDER_LAYER_GAP_PX;
        root.style.setProperty("--builder-cols-outer64", outerWidths.map((w) => `${w}px`).join(" "));
        root.style.setProperty("--builder-cols-middle16", middleWidths.map((w) => `${w}px`).join(" "));
        root.style.setProperty("--builder-cols-inner4", innerWidths.map((w) => `${w}px`).join(" "));
        root.style.setProperty("--builder-cols-core1", `${coreWidth}px`);

        rawMiddleColWidthPx =
          middleWidths.reduce((sum, w) => sum + w, 0) / Math.max(1, middleWidths.length);
      } else {
        root.style.removeProperty("--builder-cols-outer64");
        root.style.removeProperty("--builder-cols-middle16");
        root.style.removeProperty("--builder-cols-inner4");
        root.style.removeProperty("--builder-cols-core1");
        rawMiddleColWidthPx = (middleBasePx + BUILDER_LAYER_GAP_PX) * canvasScale.x - BUILDER_LAYER_GAP_PX;
      }
      // Match vertical strategy: always floor to 4px multiples.
      // This avoids subpixel widths while keeping low-zoom fit behavior.
      const middleColWidthPx = Math.max(4, Math.floor(rawMiddleColWidthPx / 4) * 4);
      root.style.setProperty("--builder-middle-col-base-px", `${middleBasePx.toFixed(2)}px`);
      root.style.setProperty("--builder-middle-col-width-px", `${middleColWidthPx.toFixed(2)}px`);
      root.style.setProperty("--builder-layer-base-height-px", `${layerBasePx.toFixed(2)}px`);
    }
    root.style.setProperty("--builder-scale-x", canvasScale.x.toFixed(3));
    root.style.setProperty("--builder-scale-y-outer64", canvasScale.yByLayer.outer64.toFixed(3));
    root.style.setProperty("--builder-scale-y-middle16", canvasScale.yByLayer.middle16.toFixed(3));
    root.style.setProperty("--builder-scale-y-inner4", canvasScale.yByLayer.inner4.toFixed(3));
    root.style.setProperty("--builder-scale-y-core1", canvasScale.yByLayer.core1.toFixed(3));
    root.style.setProperty("--builder-grid-step-x", `${BUILDER_GRID_TILE_SIZE_X_PX}px`);
    root.style.setProperty("--builder-grid-step-y", `${BUILDER_GRID_TILE_SIZE_Y_PX}px`);
    if (wrap) {
      const isOneSixteenth = Math.abs(canvasScale.x - 1 / 16) < 1e-9;
      wrap.style.overflowX = isOneSixteenth ? "hidden" : "scroll";
      const totalYScale =
        canvasScale.yByLayer.outer64 +
        canvasScale.yByLayer.middle16 +
        canvasScale.yByLayer.inner4 +
        canvasScale.yByLayer.core1;
      wrap.style.overflowY = totalYScale > 4 ? "scroll" : "hidden";
    }
    scaleXEl.value = String(canvasScaleXIndexFromValue(canvasScale.x));
    scaleXValueEl.textContent = formatScaleLabel(canvasScale.x);
    scaleYOuterValueEl.textContent = formatScaleLabel(canvasScale.yByLayer.outer64);
    scaleYMiddleValueEl.textContent = formatScaleLabel(canvasScale.yByLayer.middle16);
    scaleYInnerValueEl.textContent = formatScaleLabel(canvasScale.yByLayer.inner4);
    scaleYCoreValueEl.textContent = formatScaleLabel(canvasScale.yByLayer.core1);
    wireBag.w!.scheduleWireOverlayRender();
  }

  function layerViewportSizes(): Record<BuilderLayer, { width: number; height: number } | null> {
    const readLayer = (layer: BuilderLayer): { width: number; height: number } | null => {
      const host = canvasEl.querySelector<HTMLElement>(
        `.builder-segment[data-layer="${layer}"] .builder-segment-entities`,
      );
      if (!host) return null;
      return {
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
      };
    };
    return {
      outer64: readLayer("outer64"),
      middle16: readLayer("middle16"),
      inner4: readLayer("inner4"),
      core1: readLayer("core1"),
    };
  }

  function looksLikeLegacyNormalizedEntityPosition(x: number, y: number): boolean {
    const inUnitRange = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (!inUnitRange) return false;
    // New grid coordinates are integral tile indices; legacy values are mostly fractional.
    return !Number.isInteger(x) || !Number.isInteger(y);
  }

  function migrateLegacyNormalizedEntityPositionsToGrid(): void {
    const sizes = layerViewportSizes();
    let changed = false;
    state = {
      ...state,
      entities: state.entities.map((entity) => {
        if (!looksLikeLegacyNormalizedEntityPosition(entity.x, entity.y)) {
          return entity;
        }
        const layerSize = sizes[entity.layer];
        if (!layerSize) return entity;
        changed = true;
        return {
          ...entity,
          x: Math.round((entity.x * layerSize.width) / BUILDER_GRID_TILE_SIZE_X_PX),
          y: Math.round((entity.y * layerSize.height) / BUILDER_GRID_TILE_SIZE_Y_PX),
        };
      }),
    };
    if (changed) {
      persist();
    }
  }

  function recordPerf(key: BuilderPerfKey, ms: number): void {
    const prev = perfStats.get(key);
    if (!prev) {
      perfStats.set(key, { lastMs: ms, emaMs: ms, maxMs: ms, samples: 1 });
      return;
    }
    prev.lastMs = ms;
    prev.emaMs = PERF_EMA_ALPHA * ms + (1 - PERF_EMA_ALPHA) * prev.emaMs;
    prev.maxMs = Math.max(prev.maxMs, ms);
    prev.samples += 1;
  }

  function fmtPerf(ms: number): string {
    return `${ms.toFixed(2).padStart(6)}ms`;
  }

  function renderPerfPanel(): void {
    const get = (key: BuilderPerfKey): BuilderPerfStat =>
      perfStats.get(key) ?? { lastMs: 0, emaMs: 0, maxMs: 0, samples: 0 };
    const ordered: BuilderPerfKey[] = [
      "canvas.total",
      "canvas.expand",
      "canvas.bucketSort",
      "canvas.htmlBuild",
      "canvas.domCommit",
      "canvas.portCache",
      "wire.total",
      "wire.packetHook",
      "wire.expandLinks",
      "wire.overlayWrapRect",
      "wire.overlayScrollExtents",
      "wire.portResolve",
      "wire.lineBuild",
      "wire.dragMarkup",
      "wire.domCommit",
      "packet.total",
      "packet.overlayResize",
      "packet.compute",
      "packet.polyline",
      "packet.interpolate",
      "packet.domCommit",
      "sim.meta",
      "sim.finishTotal",
      "sim.finishRenderPackets",
      "sim.finishMeta",
      "sim.finishRefresh",
      "sim.finishDispatch",
    ];
    const totalCanvas = Math.max(0.0001, get("canvas.total").lastMs);
    const totalWire = Math.max(0.0001, get("wire.total").lastMs);
    const totalPacket = Math.max(0.0001, get("packet.total").lastMs);
    const totalSim = Math.max(0.0001, get("sim.finishTotal").lastMs);
    const topCanvas = ([
      "canvas.expand",
      "canvas.bucketSort",
      "canvas.htmlBuild",
      "canvas.domCommit",
      "canvas.portCache",
    ] as BuilderPerfKey[])
      .map((k) => ({ k, v: get(k).lastMs }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    const topWire = ([
      "wire.packetHook",
      "wire.domCommit",
      "wire.overlayScrollExtents",
      "wire.overlayWrapRect",
      "wire.dragMarkup",
      "wire.lineBuild",
      "wire.portResolve",
      "wire.expandLinks",
    ] as BuilderPerfKey[])
      .map((k) => ({ k, v: get(k).lastMs }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);
    const topPacket = ([
      "packet.overlayResize",
      "packet.compute",
      "packet.polyline",
      "packet.interpolate",
      "packet.domCommit",
    ] as BuilderPerfKey[])
      .map((k) => ({ k, v: get(k).lastMs }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    const topSim = ([
      "sim.finishRenderPackets",
      "sim.finishMeta",
      "sim.finishRefresh",
      "sim.finishDispatch",
    ] as BuilderPerfKey[])
      .map((k) => ({ k, v: get(k).lastMs }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 4);
    const lines = [
      `entities=${perfCounts.expandedEntities}  stateLinks=${perfCounts.stateLinks}  expandedLinks=${perfCounts.expandedLinks}  packets=${perfCounts.packetsInFlight}`,
      `sim mode=main  step compute=${(simLastStepComputeMs ?? 0).toFixed(2)}ms  ema=${(simEmaStepComputeMs ?? 0).toFixed(2)}ms`,
      "",
      "Metric                      last      ema      max   n",
      ...ordered.map((k) => {
        const s = get(k);
        const label = k.padEnd(24, " ");
        return `${label}${fmtPerf(s.lastMs)} ${fmtPerf(s.emaMs)} ${fmtPerf(s.maxMs)} ${String(s.samples).padStart(4)}`;
      }),
      "",
      `Top canvas contributors (last=${totalCanvas.toFixed(2)}ms):`,
      ...topCanvas.map((x) => `  ${x.k.padEnd(22, " ")} ${(x.v / totalCanvas * 100).toFixed(1).padStart(5)}% (${x.v.toFixed(2)}ms)`),
      "",
      `Top wire contributors (last=${totalWire.toFixed(2)}ms):`,
      ...topWire.map((x) => `  ${x.k.padEnd(22, " ")} ${(x.v / totalWire * 100).toFixed(1).padStart(5)}% (${x.v.toFixed(2)}ms)`),
      "",
      `Top packet contributors (last=${totalPacket.toFixed(2)}ms):`,
      ...topPacket.map((x) => `  ${x.k.padEnd(22, " ")} ${(x.v / totalPacket * 100).toFixed(1).padStart(5)}% (${x.v.toFixed(2)}ms)`),
      "",
      `Top sim contributors (last=${totalSim.toFixed(2)}ms):`,
      ...topSim.map((x) => `  ${x.k.padEnd(22, " ")} ${(x.v / totalSim * 100).toFixed(1).padStart(5)}% (${x.v.toFixed(2)}ms)`),
    ];
    perfEl.textContent = lines.join("\n");
  }

  function maybeRenderPerfPanel(nowMs = performance.now()): void {
    if (nowMs < nextPerfPanelAtMs) return;
    nextPerfPanelAtMs = nowMs + 200;
    renderPerfPanel();
  }

  function persist(): void {
    if (activeLayoutTarget.kind === "slot") {
      saveBuilderLayoutSlot(activeLayoutTarget.index, state);
    } else {
      const token = urlEmbeddedLayoutToken?.trim() ?? "";
      if (token) {
        saveBuilderUrlLayoutSlot(token, state);
        urlEmbeddedLayoutState = state;
      } else {
        saveBuilderState(state);
      }
    }    
    renderLayoutSlots();
    requestBuilderSimulatorRefresh();
  }

  let deferredPersistHandle: number | null = null;
  let pendingBuilderSimulatorRefresh = false;
  function schedulePersist(): void {
    if (deferredPersistHandle !== null) {
      window.clearTimeout(deferredPersistHandle);
    }
    deferredPersistHandle = window.setTimeout(() => {
      deferredPersistHandle = null;
      persist();
    }, 120);
  }

  function requestBuilderSimulatorRefresh(): void {
    if (simAnimating) {
      pendingBuilderSimulatorRefresh = true;
      return;
    }
    initOrRefreshBuilderSimulatorIfTopologyChanged();
  }

  function flushPendingBuilderSimulatorRefresh(): void {
    if (!pendingBuilderSimulatorRefresh || simAnimating) return;
    pendingBuilderSimulatorRefresh = false;
    initOrRefreshBuilderSimulatorIfTopologyChanged();
  }

  let builderTopologySig = "";
  type SimFrame = {
    prevOccupancy: Array<{ port: PortRef; packet: Packet }>;
    currentOccupancy: Array<{ port: PortRef; packet: Packet }>;
    stats: SimulationStats;
    droppedDeviceIds: string[];
    dropEventDeviceIds: string[];
    stepComputeMs: number;
  };
  let builderSimulator: TunnetSimulator | null = null;
  let builderSimulatorOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let simPlaying = false;
  let simAnimating = false;
  let simAnimHandle: number | null = null;
  let simTickTimeoutHandle: number | null = null;
  let simNextTickDeadlineMs: number | null = null;
  let simTickAnimStartMs: number | null = null;
  let simTickAnimDurationMs: number | null = null;
  let simAnimFinishFn: (() => void) | null = null;
  let simSpeedExponent = Number(simSpeedEl.value);
  if (!Number.isFinite(simSpeedExponent)) {
    simSpeedExponent = SPEED_EXP_DEFAULT;
  }
  let simSpeed = speedMultiplierFromExponent(simSpeedExponent);
  let simStats: SimulationStats = {
    tick: 0,
    emitted: 0,
    delivered: 0,
    dropped: 0,
    bounced: 0,
    ttlExpired: 0,
    collisions: 0,
  };
  let simPreviousStatsTotals: SimulationStats = { ...simStats };
  let simDeliveredPerTick: number | null = null;
  let simDeliveredPerTickAvg100: number | null = null;
  const simDeliveredHistory: number[] = [];
  const SIM_DELIVERED_AVG_WINDOW = 100;
  let simDropPctTick: number | null = null;
  let simDropPctCumulative: number | null = null;
  let simEmaAchievedSpeed: number | null = null;
  let simLastStepComputeMs: number | null = null;
  let simEmaStepComputeMs: number | null = null;
  const SIM_STEP_COMPUTE_EMA_ALPHA = 0.2;
  let simAchievedStartMs: number | null = null;
  let simAchievedStartTick = 0;
  let simPreviousOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let simCurrentOccupancy: Array<{ port: PortRef; packet: Packet }> = [];
  let simPreviousOccupancyByPacketId = new Map<number, { port: PortRef; packet: Packet }>();
  let simPacketProgress = 1;
  let simReverseAnimationMode = false;
  let simEndpointGhostPackets: Array<{ packet: Packet; endpointRef: PortRef }> = [];
  const SIM_HISTORY_LIMIT = 100;
  type SimHistoryEntry = { runtime: SimulatorRuntimeState };
  const simHistory: SimHistoryEntry[] = [];
  const builderEndpointIdByAddress = new Map<string, string>();
  let builderSimDevices: Record<string, Device> = {};
  let builderSimAdj: Map<string, PortRef> = new Map();
  const packetRouteTemplateByKey = new Map<string, PortRef[] | null>();
  let simPreparedPacketRenders: SimPreparedPacketRender[] = [];
  let simPreparedPacketRenderDirty = true;
  let packetCircleGroupEl: SVGGElement | null = null;
  let packetSelectedGuideEl: SVGLineElement | null = null;
  type SimPortPoint = SimXY & { clipped: boolean };
  const packetPortCenterCache = new Map<string, SimPortPoint | null>();
  const packetPreparedRouteByKey = new Map<string, SimPreparedPolyline | null>();
  const packetCirclePool: Array<{
    group: SVGGElement;
    el: SVGCircleElement;
    visible: boolean;
    lastPacketId: number | null;
    lastSelected: boolean | null;
    lastStroke: string;
    lastStrokeWidth: number;
  }> = [];
  const packetLabelPool: Array<{
    bg: SVGRectElement;
    text: SVGTextElement;
    src: SVGTSpanElement;
    dest: SVGTSpanElement;
    subject: SVGTSpanElement;
    bgOffsetX: number;
    bgOffsetY: number;
    bgWidth: number;
    bgHeight: number;
    /** Signature of last painted label text (empty when cleared). */
    lastLabelSig: string;
    visible: boolean;
  }> = [];
  const packetSlotByPacketId = new Map<number, number>();
  const packetFreeSlots: number[] = [];
  const packetSlotLastSeenFrame: number[] = [];
  let packetRenderFrameId = 0;
  let packetOverlayWidthPx = -1;
  let packetOverlayHeightPx = -1;
  let simTickDeliveredEntityRootIds = new Set<string>();
  let simTickCollisionDropEntityInstanceIds = new Set<string>();
  let simTickCollisionDropEntityRootIds = new Set<string>();
  let simUiExpandedCacheState: BuilderState | null = null;
  let simUiExpandedCache: ExpandedBuilderState | null = null;
  const expandedBuilderStateForSimUi = (): ExpandedBuilderState => {
    if (simUiExpandedCacheState === state && simUiExpandedCache) {
      return simUiExpandedCache;
    }
    const expanded = expandBuilderState(state, { builderView: true });
    simUiExpandedCacheState = state;
    simUiExpandedCache = expanded;
    return expanded;
  };
  const simDropBoardRef: { board: SimulatorDropBoardController | null } = { board: null };
  const simDropBoard = new SimulatorDropBoardController(
    simPanel.dropListEl,
    simPanel.dropEmptyEl,
    () => compileBuilderPayload(state).topology as unknown as Topology,
    {
      rowMeta(deviceId) {
        const expanded = expandedBuilderStateForSimUi();
        const inst = expanded.entities.find((e) => e.instanceId === deviceId);
        const rootId = inst?.rootId ?? simRootIdFromDeviceId(deviceId);
        if (!rootId) return null;
        return { label: formatSimDropRowLabelForExpanded(expanded, deviceId), rootId };
      },
      rowSelected(deviceId) {
        const b = simDropBoardRef.board;
        if (!b || b.traceDeviceId !== deviceId) return false;
        if (selection?.kind !== "entity") return false;
        const expanded = expandedBuilderStateForSimUi();
        const inst = expanded.entities.find((e) => e.instanceId === deviceId);
        const rootId = inst?.rootId ?? simRootIdFromDeviceId(deviceId);
        return rootId !== null && selection.rootId === rootId;
      },
    },
  );
  simDropBoardRef.board = simDropBoard;
  simDropBoard.onPick = (deviceId) => {
    const expanded = expandedBuilderStateForSimUi();
    const inst = expanded.entities.find((e) => e.instanceId === deviceId);
    const rootId = inst?.rootId ?? simRootIdFromDeviceId(deviceId);
    if (!rootId) return;
    setSelection({ kind: "entity", rootId }, { dropTraceFromView: true, dropTraceDeviceId: deviceId });
    renderBuilderPacketCircles(simPacketProgress);
  };
  wireBag.w = createBuilderWireOverlay({
    root,
    wireOverlayEl,
    canvasEl,
    getState: () => state,
    recordPerf: (key, ms) => recordPerf(key as BuilderPerfKey, ms),
    perfCounts,
    afterWireOverlayPaint: (overlayPassStartMs, paintOpts) => {
      let packetHookMs = 0;
      if (!paintOpts?.skipPacketRefresh) {
        const tp0 = performance.now();
        invalidateBuilderPacketGeometryCache();
        invalidateBuilderPacketRenderCache();
        renderBuilderPacketCircles(simPacketProgress);
        packetHookMs = performance.now() - tp0;
      }
      recordPerf("wire.packetHook", packetHookMs);
      recordPerf("wire.total", performance.now() - overlayPassStartMs);
      renderPerfPanel();
    },
    setBuilderDragCursor,
    clearBuilderDragCursor,
    getActiveWireColorIndex: () => wireColorChoiceRef.index,
    commitLinkDragResult: ({ from, toPort, startedFromPacket }) => {
      if (startedFromPacket) suppressNextPacketClick = true;
      if (!toPort) {
        const fromInst = parseBuilderInstanceId(from.instanceId);
        if (!fromInst || fromInst.rootId !== from.rootId) return;
        const next = removeLinksTouchingInstancePort(state, fromInst.rootId, fromInst.segmentIndex, from.port);
        if (next !== state) {
          state = next;
          schedulePersist();
          {
            const sel = selection;
            if (sel && sel.kind === "link" && !state.links.some((l) => l.id === sel.rootId)) {
              setSelection(null);
            }
          }
        }
        return;
      }
      const toRootId = toPort.dataset.rootId;
      const toP = Number(toPort.dataset.port);
      const toInstanceRaw = toPort.dataset.instanceId ?? "";
      if (!toRootId) return;
      if (toInstanceRaw && toInstanceRaw === from.instanceId) return;
      const fromInst = parseBuilderInstanceId(from.instanceId);
      const toInstParsed = parseBuilderInstanceId(toInstanceRaw);
      if (!fromInst || !toInstParsed) return;
      if (fromInst.rootId !== from.rootId || toInstParsed.rootId !== toRootId) return;
      const fromRoot = state.entities.find((ent) => ent.id === fromInst.rootId);
      const toRoot = state.entities.find((ent) => ent.id === toInstParsed.rootId);
      if (!fromRoot || !toRoot) return;
      const linkOpts =
        fromRoot.id === toRoot.id
          ? {
              sameEntityPin: {
                fromSegmentIndex: fromInst.segmentIndex,
                toSegmentIndex: toInstParsed.segmentIndex,
              },
            }
          : fromRoot.layer === toRoot.layer
            ? {
                sameLayerSegmentDelta: toInstParsed.segmentIndex - fromInst.segmentIndex,
              }
            : (() => {
                const slot = crossLayerBlockSlotFromSegments(
                  fromRoot.layer,
                  fromInst.segmentIndex,
                  toRoot.layer,
                  toInstParsed.segmentIndex,
                );
                if (slot === undefined) {
                  return undefined;
                }
                return { crossLayerBlockSlot: slot };
              })();
      if (fromRoot.id !== toRoot.id && fromRoot.layer !== toRoot.layer && linkOpts === undefined) {
        return;
      }
      const added = addLinkRootOneWirePerPort(state, fromRoot.id, from.port, toRoot.id, toP, {
        ...linkOpts,
        wireColorIndex: wireColorChoiceRef.index,
      });
      if (!added.link) return;
      state = added.state;
      schedulePersist();
      setSelection({ kind: "link", rootId: added.link.id });
    },
  });
  applyBuilderSidebarWidth(builderSidebarWidth);

  function updateSimBackButtonState(): void {
    simBackBtn.disabled = simHistory.length === 0;
    // Stop is only meaningful once we've advanced at least one tick or while running/animating.
    const canStop = (simStats.tick ?? 0) > 0 || simPlaying || simAnimating;
    simResetBtn.disabled = !canStop;
  }

  function clearSimHistory(): void {
    simHistory.length = 0;
    simEndpointGhostPackets = [];
    updateSimBackButtonState();
  }

  function pushSimHistorySnapshot(): void {
    if (!builderSimulator) return;
    const runtime = builderSimulator.exportRuntimeState();
    const snapshot: SimHistoryEntry = {
      runtime: {
        ...runtime,
        occupancy: cloneSimOccupancyWithPackets(runtime.occupancy),
        stats: { ...runtime.stats },
        endpointNextSendTickById: { ...runtime.endpointNextSendTickById },
      },
    };
    simHistory.push(snapshot);
    if (simHistory.length > SIM_HISTORY_LIMIT) {
      simHistory.splice(0, simHistory.length - SIM_HISTORY_LIMIT);
    }
    updateSimBackButtonState();
  }

  function stepBackBuilderSimulation(): void {
    if (simAnimating) return;
    if (simPlaying) {
      setBuilderSimPlaying(false);
    }
    const snapshot = simHistory.pop();
    if (!snapshot || !builderSimulator) {
      updateSimBackButtonState();
      return;
    }
    const currentRuntime = builderSimulator.exportRuntimeState();
    const fromOccupancy = cloneSimOccupancyWithPackets(currentRuntime.occupancy);
    const toOccupancy = cloneSimOccupancyWithPackets(snapshot.runtime.occupancy);
    const toIds = new Set(toOccupancy.map((e) => e.packet.id));
    const boundaryGhosts = fromOccupancy
      .filter(({ packet }) => !toIds.has(packet.id))
      .map(({ packet }) => {
        const endpointId = builderEndpointIdByAddress.get(packet.src);
        if (!endpointId) return null;
        return { packet: { ...packet }, endpointRef: { deviceId: endpointId, port: 0 } };
      })
      .filter((x): x is { packet: Packet; endpointRef: PortRef } => !!x);
    simPreviousOccupancy = fromOccupancy;
    simPreviousOccupancyByPacketId = simOccupancyByPacketId(simPreviousOccupancy);
    simCurrentOccupancy = toOccupancy;
    simReverseAnimationMode = true;
    simTickDeliveredEntityRootIds = new Set();
    simTickCollisionDropEntityInstanceIds = new Set();
    simTickCollisionDropEntityRootIds = new Set();
    applySimTickHighlightsToCanvas();
    invalidateBuilderPacketRenderCache();
    const animStart = performance.now();
    const durationMs = Math.max(60, 1000 / Math.max(simSpeed, 0.1));
    simTickAnimStartMs = animStart;
    simTickAnimDurationMs = durationMs;
    let finished = false;
    simAnimating = true;
    updateSimBackButtonState();
    const finishBackStep = (): void => {
      if (finished) return;
      finished = true;
      cancelBuilderSimTickTimers();
      simAnimating = false;
      simReverseAnimationMode = false;
      simTickAnimStartMs = null;
      simTickAnimDurationMs = null;
      simAnimFinishFn = null;
      builderSimulator!.importRuntimeState(snapshot.runtime);
      builderSimulatorOccupancy = cloneSimOccupancyWithPackets(builderSimulator!.getPortOccupancy());
      applyBuilderSimulatorSnapshot(builderSimulatorOccupancy, { ...snapshot.runtime.stats });
      simEndpointGhostPackets = boundaryGhosts;
      invalidateBuilderPacketRenderCache();
      renderBuilderPacketCircles(1);
      simDeliveredPerTick = null;
      simDropPctTick = null;
      simEmaAchievedSpeed = null;
      simAchievedStartMs = null;
      simAchievedStartTick = simStats.tick;
      updateSimBackButtonState();
    };
    simAnimFinishFn = finishBackStep;
    const animateBack = (now: number): void => {
      if (finished) return;
      const start = simTickAnimStartMs ?? animStart;
      const dur = simTickAnimDurationMs ?? durationMs;
      const t = dur <= 0 ? 1 : clamp01((now - start) / dur);
      simPacketProgress = t;
      renderBuilderPacketCircles(t);
      if (t < 1) {
        simAnimHandle = requestAnimationFrame(animateBack);
        return;
      }
      finishBackStep();
    };
    simPacketProgress = 0;
    renderBuilderPacketCircles(0);
    simTickTimeoutHandle = window.setTimeout(finishBackStep, durationMs);
    simAnimHandle = requestAnimationFrame(animateBack);
  }

  function cloneSimOccupancy(occ: Array<{ port: PortRef; packet: Packet }>): Array<{ port: PortRef; packet: Packet }> {
    return occ.map((e) => ({ port: { ...e.port }, packet: e.packet }));
  }

  function cloneSimOccupancyWithPackets(occ: Array<{ port: PortRef; packet: Packet }>): Array<{ port: PortRef; packet: Packet }> {
    return occ.map((e) => ({ port: { ...e.port }, packet: { ...e.packet } }));
  }

  function simRootIdFromDeviceId(deviceId: string): string | null {
    if (state.entities.some((e) => e.id === deviceId)) return deviceId;
    const m = deviceId.match(/^(.+)@\d+$/);
    if (!m) return null;
    const rootId = m[1] ?? "";
    return state.entities.some((e) => e.id === rootId) ? rootId : null;
  }

  function computeSimTickHighlights(
    prev: Array<{ port: PortRef; packet: Packet }>,
    current: Array<{ port: PortRef; packet: Packet }>,
  ): { delivered: Set<string> } {
    const currentPacketIds = new Set(current.map((e) => e.packet.id));
    const delivered = new Set<string>();
    for (const e of prev) {
      if (currentPacketIds.has(e.packet.id)) continue;
      const device = builderSimDevices[e.port.deviceId];
      if (device?.type === "endpoint" && e.port.port === 0 && e.packet.dest === device.address) {
        const rootId = simRootIdFromDeviceId(e.port.deviceId);
        if (rootId) delivered.add(rootId);
      }
    }
    return { delivered };
  }

  function simPortCountForDevice(device: Device): number {
    if (device.type === "endpoint") return 1;
    if (device.type === "relay") return 2;
    if (device.type === "filter") return 2;
    return 3;
  }

  function projectRuntimeStateToTopology(
    runtime: SimulatorRuntimeState,
    topology: Topology,
  ): SimulatorRuntimeState {
    const occupancy = runtime.occupancy.filter(({ port }) => {
      const device = topology.devices[port.deviceId];
      if (!device) return false;
      return Number.isInteger(port.port) && port.port >= 0 && port.port < simPortCountForDevice(device);
    });
    const endpointNextSendTickById: Record<string, number> = {};
    for (const dev of Object.values(topology.devices)) {
      if (dev.type !== "endpoint") continue;
      const existing = runtime.endpointNextSendTickById[dev.id];
      if (Number.isFinite(existing)) {
        endpointNextSendTickById[dev.id] = existing;
      }
    }
    return {
      ...runtime,
      occupancy,
      endpointNextSendTickById,
    };
  }

  function applyBuilderSimulatorSnapshot(
    occupancy: Array<{ port: PortRef; packet: Packet }>,
    stats: SimulationStats,
  ): void {
    simPreviousOccupancy = [];
    simPreviousOccupancyByPacketId = new Map();
    simCurrentOccupancy = cloneSimOccupancy(occupancy);
    simStats = { ...stats };
    simPreviousStatsTotals = { ...stats };
    simTickDeliveredEntityRootIds = new Set();
    simTickCollisionDropEntityInstanceIds = new Set();
    simTickCollisionDropEntityRootIds = new Set();
    applySimTickHighlightsToCanvas();
    simPacketProgress = 1;
    invalidateBuilderPacketRenderCache();
    if (selection?.kind === "packet") {
      const packetSel = selection;
      const stillThere = simCurrentOccupancy.some((e) => e.packet.id === packetSel.packetId);
      if (!stillThere) {
        setSelection(null);
      }
    }
    updateBuilderSimMeta();
    renderBuilderPacketCircles(1);
  }

  function initBuilderSimulator(topology: Topology): void {
    builderSimulator = new TunnetSimulator(topology, 1337);
    clearSimHistory();
    builderSimulatorOccupancy = cloneSimOccupancyWithPackets(builderSimulator.getPortOccupancy());
    applyBuilderSimulatorSnapshot(builderSimulatorOccupancy, {
      tick: 0,
      emitted: 0,
      delivered: 0,
      dropped: 0,
      bounced: 0,
      ttlExpired: 0,
      collisions: 0,
    });
  }

  function updateBuilderSimulatorTopology(topology: Topology): void {
    if (!builderSimulator) {
      initBuilderSimulator(topology);
      return;
    }
    clearSimHistory();
    const runtime = builderSimulator.exportRuntimeState();
    const projected = projectRuntimeStateToTopology(runtime, topology);
    const next = new TunnetSimulator(topology, projected.rndState);
    next.importRuntimeState(projected);
    builderSimulator = next;
    builderSimulatorOccupancy = cloneSimOccupancyWithPackets(builderSimulator.getPortOccupancy());
    applyBuilderSimulatorSnapshot(builderSimulatorOccupancy, { ...projected.stats });
  }

  function computeNextBuilderSimFrame(): SimFrame | null {
    if (!builderSimulator) return null;
    const prev = cloneSimOccupancyWithPackets(builderSimulatorOccupancy);
    const t0 = performance.now();
    const snap = builderSimulator.step();
    const stepComputeMs = performance.now() - t0;
    builderSimulatorOccupancy = cloneSimOccupancyWithPackets(builderSimulator.getPortOccupancy());
    return {
      prevOccupancy: prev,
      currentOccupancy: cloneSimOccupancyWithPackets(builderSimulatorOccupancy),
      stats: { ...snap.stats },
      droppedDeviceIds: [...snap.droppedDeviceIds],
      dropEventDeviceIds: [...snap.dropEventDeviceIds],
      stepComputeMs,
    };
  }

  function rebuildBuilderSimEndpointIndex(topology: Topology): void {
    builderEndpointIdByAddress.clear();
    for (const dev of Object.values(topology.devices)) {
      if (dev.type === "endpoint") {
        builderEndpointIdByAddress.set(dev.address, dev.id);
      }
    }
  }

  function rebuildBuilderSimTopologyCache(top: Topology): void {
    builderSimDevices = top.devices;
    builderSimAdj = buildPortAdjacency(top);
    packetRouteTemplateByKey.clear();
  }

  function syncBuilderSimSliderLabels(): void {
    const target = formatSpeedLabel(simSpeedExponent);
    const measured =
      simEmaAchievedSpeed !== null && Number.isFinite(simEmaAchievedSpeed)
        ? `${Math.max(0, simEmaAchievedSpeed).toFixed(0)}`
        : null;
    simSpeedValueEl.textContent = measured ? `${target} (${measured})` : target;
  }

  function formatSimDropRowLabelForExpanded(expanded: ExpandedBuilderState, deviceId: string): string {
    const inst = expanded.entities.find((e) => e.instanceId === deviceId);
    if (!inst) return deviceId;
    const sec = segmentLabel(inst.layer, inst.segmentIndex);
    return `${sec} ${inst.templateType}`;
  }

  function updateBuilderSimMeta(): void {
    const tMeta0 = performance.now();
    syncBuilderSimSliderLabels();
    simMetaEl.innerHTML = renderSimulatorMetaGridHtml({
      stats: simStats,
      inFlight: simCurrentOccupancy.length,
      deliveredPerTickAvg100: simDeliveredPerTickAvg100,
      dropPctCumulative: simDropPctCumulative,
    });
    simDropBoard.refresh();
    recordPerf("sim.meta", performance.now() - tMeta0);
  }

  function cancelBuilderSimTickTimers(): void {
    if (simAnimHandle !== null) {
      cancelAnimationFrame(simAnimHandle);
      simAnimHandle = null;
    }
    if (simTickTimeoutHandle !== null) {
      window.clearTimeout(simTickTimeoutHandle);
      simTickTimeoutHandle = null;
    }
  }

  function resetBuilderSimulation(resumeIfWasPlaying = false): void {
    const shouldResume = resumeIfWasPlaying && simPlaying;
    cancelBuilderSimTickTimers();
    simNextTickDeadlineMs = null;
    simPlaying = false;
    simPlayPauseBtn.textContent = "▶";
    simAnimating = false;
    const payload = compileBuilderPayload(state);
    const topo = payload.topology as unknown as Topology;
    builderTopologySig = JSON.stringify(payload.topology);
    rebuildBuilderSimTopologyCache(topo);
    simStats = {
      tick: 0,
      emitted: 0,
      delivered: 0,
      dropped: 0,
      bounced: 0,
      ttlExpired: 0,
      collisions: 0,
    };
    updateSimBackButtonState();
    simPreviousStatsTotals = { ...simStats };
    simDeliveredPerTick = null;
    simDeliveredPerTickAvg100 = null;
    simDeliveredHistory.length = 0;
    simDropPctTick = null;
    simDropPctCumulative = null;
    simEmaAchievedSpeed = null;
    simAchievedStartMs = null;
    simAchievedStartTick = 0;
    simLastStepComputeMs = null;
    simEmaStepComputeMs = null;
    simTickDeliveredEntityRootIds = new Set();
    simTickCollisionDropEntityInstanceIds = new Set();
    simTickCollisionDropEntityRootIds = new Set();
    simDropBoard.reset();
    clearSimHistory();
    rebuildBuilderSimEndpointIndex(topo);
    simPreviousOccupancy = [];
    simPreviousOccupancyByPacketId = new Map();
    simCurrentOccupancy = [];
    simPacketProgress = 1;
    invalidateBuilderPacketRenderCache();
    if (selection?.kind === "packet") {
      setSelection(null);
    }
    clearBuilderPacketCirclePool();
    updateBuilderSimMeta();
    wireBag.w!.scheduleWireOverlayRender();
    initBuilderSimulator(topo);
    if (shouldResume) {
      simPlaying = true;
      runOneBuilderSimTick();
    }
  }

  function initOrRefreshBuilderSimulatorIfTopologyChanged(): void {
    if (simAnimating) {
      pendingBuilderSimulatorRefresh = true;
      return;
    }
    const payload = compileBuilderPayload(state);
    const sig = JSON.stringify(payload.topology);
    if (sig === builderTopologySig) return;
    builderTopologySig = sig;
    const topo = payload.topology as unknown as Topology;
    rebuildBuilderSimTopologyCache(topo);
    rebuildBuilderSimEndpointIndex(topo);
    clearSimHistory();

    const shouldResume = simPlaying;
    cancelBuilderSimTickTimers();
    simNextTickDeadlineMs = null;
    simAnimating = false;
    simPlaying = false;
    updateBuilderSimulatorTopology(topo);
    if (shouldResume) {
      simPlaying = true;
      runOneBuilderSimTick();
    }
  }

  function runOneBuilderSimTick(): void {
    if (simAnimating) return;
    if (simEndpointGhostPackets.length > 0) {
      simEndpointGhostPackets = [];
      invalidateBuilderPacketRenderCache();
    }
    pushSimHistorySnapshot();
    const tickWallStartMs = performance.now();
    if (simAchievedStartMs === null) {
      simAchievedStartMs = tickWallStartMs;
      simAchievedStartTick = simStats.tick;
    }
    const frame = computeNextBuilderSimFrame();
    if (!frame) return;
    simAnimating = true;
    updateSimBackButtonState();
    simPreviousOccupancy = frame.prevOccupancy;
    simPreviousOccupancyByPacketId = simOccupancyByPacketId(simPreviousOccupancy);
    const statsBeforeTick = simPreviousStatsTotals;
    const emittedTick = frame.stats.emitted - simPreviousStatsTotals.emitted;
    const deliveredTickCount = frame.stats.delivered - simPreviousStatsTotals.delivered;
    const droppedTickCount = frame.stats.dropped - simPreviousStatsTotals.dropped;
    simDeliveredPerTick = deliveredTickCount;
    simDeliveredHistory.push(deliveredTickCount);
    if (simDeliveredHistory.length > SIM_DELIVERED_AVG_WINDOW) {
      simDeliveredHistory.shift();
    }
    simDeliveredPerTickAvg100 =
      simDeliveredHistory.length > 0
        ? simDeliveredHistory.reduce((sum, v) => sum + v, 0) / simDeliveredHistory.length
        : null;
    simDropPctTick = emittedTick > 0 ? (droppedTickCount / emittedTick) * 100 : null;
    simDropPctCumulative =
      frame.stats.emitted > 0 ? (frame.stats.dropped / frame.stats.emitted) * 100 : null;
    const tickHighlights = computeSimTickHighlights(
      frame.prevOccupancy,
      frame.currentOccupancy,
    );
    simTickDeliveredEntityRootIds = tickHighlights.delivered;
    simTickCollisionDropEntityInstanceIds = new Set();
    simTickCollisionDropEntityRootIds = new Set();
    frame.droppedDeviceIds.forEach((deviceId) => {
      if (/@\d+$/.test(deviceId)) {
        simTickCollisionDropEntityInstanceIds.add(deviceId);
        return;
      }
      const rootId = simRootIdFromDeviceId(deviceId);
      if (rootId) simTickCollisionDropEntityRootIds.add(rootId);
    });
    simDropBoard.ingestDropEvents(frame.dropEventDeviceIds);
    applySimTickHighlightsToCanvas();
    simPreviousStatsTotals = { ...frame.stats };
    const stepMs = frame.stepComputeMs;
    simLastStepComputeMs = stepMs;
    simEmaStepComputeMs =
      simEmaStepComputeMs === null
        ? stepMs
        : SIM_STEP_COMPUTE_EMA_ALPHA * stepMs + (1 - SIM_STEP_COMPUTE_EMA_ALPHA) * simEmaStepComputeMs;
    simStats = frame.stats;
    simCurrentOccupancy = frame.currentOccupancy;
    invalidateBuilderPacketRenderCache();
    if (selection && selection.kind === "packet") {
      const packetSel = selection;
      const stillThere = simCurrentOccupancy.some((e) => e.packet.id === packetSel.packetId);
      if (!stillThere) {
        setSelection(null);
      }
    }
    const targetTickIntervalMs = 1000 / Math.max(simSpeed, 0.1);
    if (
      simNextTickDeadlineMs === null ||
      simNextTickDeadlineMs < tickWallStartMs - targetTickIntervalMs
    ) {
      simNextTickDeadlineMs = tickWallStartMs + targetTickIntervalMs;
    }
    const tickDeadlineMs = simNextTickDeadlineMs;
    simNextTickDeadlineMs = tickDeadlineMs + targetTickIntervalMs;
    let animStart = performance.now();
    let durationMs = Math.max(0, tickDeadlineMs - animStart);
    simTickAnimStartMs = animStart;
    simTickAnimDurationMs = durationMs;
    let finished = false;
    const finishTick = (): void => {
      if (finished) return;
      const tFinish0 = performance.now();
      const now = performance.now();
      finished = true;
      cancelBuilderSimTickTimers();
      simTickAnimStartMs = null;
      simTickAnimDurationMs = null;
      simAnimFinishFn = null;
      if (simAchievedStartMs !== null) {
        const elapsedMs = now - simAchievedStartMs;
        const completedTicks = simStats.tick - simAchievedStartTick;
        if (elapsedMs > 1 && completedTicks > 0) {
          simEmaAchievedSpeed = (completedTicks * 1000) / elapsedMs;
        }
      }
      simAnimating = false;
      updateSimBackButtonState();
      simPacketProgress = 1;
      const tRender0 = performance.now();
      renderBuilderPacketCircles(1);
      const tRender1 = performance.now();
      const tMeta0 = performance.now();
      updateBuilderSimMeta();
      const tMeta1 = performance.now();
      const tRefresh0 = performance.now();
      flushPendingBuilderSimulatorRefresh();
      const tRefresh1 = performance.now();
      let dispatchMs = 0;
      if (simPlaying) {
        const tDispatch0 = performance.now();
        runOneBuilderSimTick();
        dispatchMs = performance.now() - tDispatch0;
      } else {
        simNextTickDeadlineMs = null;
      }
      const tFinish1 = performance.now();
      recordPerf("sim.finishRenderPackets", tRender1 - tRender0);
      recordPerf("sim.finishMeta", tMeta1 - tMeta0);
      recordPerf("sim.finishRefresh", tRefresh1 - tRefresh0);
      recordPerf("sim.finishDispatch", dispatchMs);
      recordPerf("sim.finishTotal", tFinish1 - tFinish0);
    };
    simAnimFinishFn = finishTick;
    simPacketProgress = 0;
    simTickTimeoutHandle = window.setTimeout(finishTick, durationMs);
    const shouldAnimatePackets = simSpeed <= 8;
    if (shouldAnimatePackets) {
      const animate = (now: number): void => {
        if (finished) return;
        const start = simTickAnimStartMs ?? animStart;
        const dur = simTickAnimDurationMs ?? durationMs;
        const t = dur <= 0 ? 1 : clamp01((now - start) / dur);
        simPacketProgress = t;
        renderBuilderPacketCircles(t);
        if (t < 1) {
          simAnimHandle = requestAnimationFrame(animate);
          return;
        }
        finishTick();
      };
      simAnimHandle = requestAnimationFrame(animate);
    }
  }

  function setBuilderSimPlaying(enabled: boolean): void {
    const wasPlaying = simPlaying;
    simPlaying = enabled;
    simPlayPauseBtn.textContent = simPlaying ? "❚❚" : "▶";
    if (simPlaying && !wasPlaying) {
      simEmaAchievedSpeed = null;
      simAchievedStartMs = null;
      simAchievedStartTick = simStats.tick;
    }
    if (!simPlaying && !simAnimating && (simAnimHandle !== null || simTickTimeoutHandle !== null)) {
      cancelBuilderSimTickTimers();
      simNextTickDeadlineMs = null;
      simAnimating = false;
      simPacketProgress = 1;
      renderBuilderPacketCircles(1);
    }
    if (simPlaying && !simAnimating) {
      simNextTickDeadlineMs = null;
      runOneBuilderSimTick();
    }
    updateBuilderSimMeta();
  }

  function applyPropertyLabelVisibility(): void {
    root.classList.toggle("builder-hide-property-labels", hideEntityPropertyLabels);
    wireBag.w!.scheduleWireOverlayRender();
  }

  function applySelectionToCanvas(): void {
    canvasEl.querySelectorAll<HTMLElement>(".builder-entity.selected").forEach((el) => {
      el.classList.remove("selected");
    });
    if (
      selectedEntityRootIds.size === 0 &&
      selection?.kind === "entity" &&
      simDropBoard.traceDeviceId &&
      simRootIdFromDeviceId(simDropBoard.traceDeviceId) === selection.rootId
    ) {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-instance-id="${simDropBoard.traceDeviceId}"]`)
        .forEach((el) => {
          el.classList.add("selected");
        });
      return;
    }
    const ids = selectedEntityRootIds.size
      ? Array.from(selectedEntityRootIds)
      : selection?.kind === "entity"
        ? [selection.rootId]
        : [];
    ids.forEach((id) => {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${id}"]`)
        .forEach((el) => {
          el.classList.add("selected");
        });
    });
  }

  function setDeleteDropZoneActive(active: boolean): void {
    deleteDropZoneEl.classList.toggle("active", active);
  }

  function isPointInDeleteDropZone(clientX: number, clientY: number): boolean {
    const r = deleteDropZoneEl.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  function ensureFilterTooltipEl(): HTMLDivElement {
    if (filterTooltipEl) return filterTooltipEl;
    const el = document.createElement("div");
    el.className = "builder-filter-tooltip";
    el.style.display = "none";
    document.body.appendChild(el);
    filterTooltipEl = el;
    return el;
  }

  function hideFilterTooltip(): void {
    if (filterTooltipTimer !== null) {
      window.clearTimeout(filterTooltipTimer);
      filterTooltipTimer = null;
    }
    filterTooltipRootId = null;
    filterTooltipInstanceId = null;
    if (filterTooltipEl) {
      filterTooltipEl.style.display = "none";
    }
  }

  function showFilterTooltip(rootId: string, instanceId?: string | null): void {
    const entity = state.entities.find((e) => e.id === rootId && e.templateType === "filter");
    if (!entity) return;
    const host =
      (instanceId
        ? canvasEl.querySelector<HTMLElement>(
            `.builder-entity[data-root-id="${rootId}"][data-instance-id="${instanceId}"]`,
          )
        : null) ?? canvasEl.querySelector<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`);
    if (!host) return;
    const tooltip = ensureFilterTooltipEl();
    const parsed = instanceId ? parseBuilderInstanceId(instanceId) : null;
    const segmentIndex =
      parsed !== null && Number.isInteger(parsed.segmentIndex) ? parsed.segmentIndex : entity.segmentIndex;
    tooltip.textContent = buildFilterDescription(filterSettingsAtSegment(entity, segmentIndex));
    const r = host.getBoundingClientRect();
    tooltip.style.left = `${Math.round(r.left + r.width / 2)}px`;
    tooltip.style.top = `${Math.round(r.top - 10)}px`;
    tooltip.style.display = "block";
  }

  function refreshFilterTooltipIfVisible(rootId: string): void {
    if (filterTooltipRootId !== rootId) return;
    if (!filterTooltipEl || filterTooltipEl.style.display !== "block") return;
    showFilterTooltip(rootId, filterTooltipInstanceId);
  }

  function applySimTickHighlightsToCanvas(): void {
    canvasEl
      .querySelectorAll<HTMLElement>(".builder-entity--tick-delivered, .builder-entity--tick-collision-drop")
      .forEach((el) => {
        el.classList.remove("builder-entity--tick-delivered", "builder-entity--tick-collision-drop");
      });
    simTickDeliveredEntityRootIds.forEach((rootId) => {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`)
        .forEach((el) => el.classList.add("builder-entity--tick-delivered"));
    });
    simTickCollisionDropEntityInstanceIds.forEach((instanceId) => {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-instance-id="${instanceId}"]`)
        .forEach((el) => {
          el.classList.remove("builder-entity--tick-delivered");
          el.classList.add("builder-entity--tick-collision-drop");
        });
    });
    simTickCollisionDropEntityRootIds.forEach((rootId) => {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`)
        .forEach((el) => {
          // Instance-level highlights win if present.
          if (simTickCollisionDropEntityInstanceIds.has(el.dataset.instanceId ?? "")) return;
          el.classList.remove("builder-entity--tick-delivered");
          el.classList.add("builder-entity--tick-collision-drop");
        });
    });
  }

  function showDragGroupBounds(ids: string[]): void {
    if (!canvasWrapEl) return;
    if (!ids.length) {
      dragBoundsEl.style.display = "none";
      return;
    }
    const wrapRect = canvasWrapEl.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ids.forEach((id) => {
      const ent = state.entities.find((e) => e.id === id);
      if (!ent) return;
      const host = segmentEntitiesHost(ent.layer, ent.segmentIndex);
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const hostLeft = hostRect.left - wrapRect.left + canvasWrapEl.scrollLeft;
      const hostTop = hostRect.top - wrapRect.top + canvasWrapEl.scrollTop;
      const fp = entityFootprintOffsets(ent);
      const gx1 = ent.x + fp.left;
      const gy1 = ent.y + fp.top;
      const gx2 = ent.x + fp.right + 1;
      const gy2 = ent.y + fp.bottom + 1;
      const x1 = hostLeft + gx1 * BUILDER_GRID_TILE_SIZE_X_PX;
      const y1 = hostTop + gy1 * BUILDER_GRID_TILE_SIZE_Y_PX;
      const x2 = hostLeft + gx2 * BUILDER_GRID_TILE_SIZE_X_PX;
      const y2 = hostTop + gy2 * BUILDER_GRID_TILE_SIZE_Y_PX;
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      dragBoundsEl.style.display = "none";
      return;
    }
    dragBoundsEl.style.display = "block";
    dragBoundsEl.style.left = `${minX}px`;
    dragBoundsEl.style.top = `${minY}px`;
    dragBoundsEl.style.width = `${Math.max(0, maxX - minX)}px`;
    dragBoundsEl.style.height = `${Math.max(0, maxY - minY)}px`;
  }

  function hideDragGroupBounds(): void {
    dragBoundsEl.style.display = "none";
    dragBoundsEl.style.width = "0px";
    dragBoundsEl.style.height = "0px";
  }

  function entityFootprintOffsets(entity: BuilderEntityRoot): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    if (entity.templateType === "hub") {
      // Hub anchor is the center cross of its 4x4 footprint.
      return { left: -2, right: 1, top: -2, bottom: 1 };
    }
    if (entity.templateType === "relay") {
      // Relay anchor is top-left of a 2x2 footprint.
      return { left: 0, right: 1, top: 0, bottom: 1 };
    }
    if (entity.templateType === "filter") {
      // Filter anchor is top-left.
      const width = hideEntityPropertyLabels ? 6 : 9;
      const height = 11;
      return { left: 0, right: width - 1, top: 0, bottom: height - 1 };
    }
    if (entity.templateType === "endpoint") {
      // Endpoint anchor is top-left.
      const width = hideEntityPropertyLabels ? 6 : 9;
      const height = 3;
      return { left: 0, right: width - 1, top: 0, bottom: height - 1 };
    }
    if (entity.templateType === "text") {
      const { wTiles, hTiles } = textTileSizeFromEntity(entity);
      return { left: 0, right: wTiles - 1, top: 0, bottom: hTiles - 1 };
    }
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }

  function setSelection(next: Selection, opts?: SetSelectionOpts): void {
    if (!(opts?.dropTraceFromView && next?.kind === "entity")) {
      simDropBoard.traceDeviceId = null;
    }
    const hadLinkDrag = wireBag.w!.isLinkDragActive();
    selection = next;
    selectedEntityRootIds.clear();
    wireBag.w!.clearLinkDrag();
    if (opts?.dropTraceFromView && next?.kind === "entity") {
      simDropBoard.traceDeviceId = opts.dropTraceDeviceId ?? null;
    }
    renderInspector();
    applySelectionToCanvas();
    // Wires use port DOM geometry; selection only adds `.selected` on entities. Skip full wire
    // rebuild unless we cleared an in-flight link drag (rubber band must disappear).
    if (hadLinkDrag) {
      wireBag.w!.renderWireOverlay();
    } else {
      renderBuilderPacketCircles(simPacketProgress);
    }
    simDropBoard.refresh();
  }

  function setEntitySelectionSet(ids: Set<string>): void {
    simDropBoard.traceDeviceId = null;
    const hadLinkDrag = wireBag.w!.isLinkDragActive();
    selectedEntityRootIds = new Set(ids);
    const firstId = selectedEntityRootIds.values().next().value as string | undefined;
    selection = firstId ? { kind: "entity", rootId: firstId } : null;
    wireBag.w!.clearLinkDrag();
    renderInspector();
    applySelectionToCanvas();
    if (hadLinkDrag) {
      wireBag.w!.renderWireOverlay();
    } else {
      renderBuilderPacketCircles(simPacketProgress);
    }
    simDropBoard.refresh();
  }

  function entityPositionCss(templateType: BuilderTemplateType, x: number, y: number): { left: string; top: string } {
    const isHub = templateType === "hub";
    const left = isHub
      ? `calc(${x} * var(--builder-grid-step-x) - ${HUB_LAYOUT.G.x.toFixed(3)}px)`
      : `calc(${x} * var(--builder-grid-step-x))`;
    const top = isHub
      ? `calc(${y} * var(--builder-grid-step-y) - ${HUB_LAYOUT.G.y.toFixed(3)}px)`
      : `calc(${y} * var(--builder-grid-step-y))`;
    return { left, top };
  }

  function previewPositionCss(rootId: string, x: number, y: number): { left: string; top: string } {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    return entityPositionCss(rootEnt?.templateType ?? "relay", x, y);
  }

  type DragPlacement = { layer: BuilderLayer; segment: number; x: number; y: number };

  function hasSameTypePlacementConflict(
    templateType: BuilderTemplateType,
    layer: BuilderLayer,
    segment: number,
    x: number,
    y: number,
    ignoreIds?: Set<string>,
  ): boolean {
  const expanded = expandBuilderState(state, { builderView: true });
  return expanded.entities.some((e) => {
    if (ignoreIds?.has(e.rootId)) return false;
    return e.templateType === templateType && e.layer === layer && e.segmentIndex === segment && e.x === x && e.y === y;
  });
  }

  function hasPlacementMapConflicts(placements: Map<string, DragPlacement>): boolean {
  if (placements.size === 0) return false;
  const moved = new Map<string, DragPlacement>(placements);
  const nextState: BuilderState = {
    ...state,
    entities: state.entities.map((e) => {
      const p = moved.get(e.id);
      if (!p) return e;
      return {
        ...e,
        layer: p.layer,
        segmentIndex: p.segment,
        x: p.x,
        y: p.y,
      };
    }),
  };
  const expanded = expandBuilderState(nextState, { builderView: true });
    const seen = new Set<string>();
  for (const ent of expanded.entities) {
    const key = `${ent.templateType}:${ent.layer}:${ent.segmentIndex}:${ent.x}:${ent.y}`;
      if (seen.has(key)) {
      return true;
      }
      seen.add(key);
  }
  return false;
  }

  function segmentEntitiesHost(layer: BuilderLayer, segment: number): HTMLElement | null {
    if (layer === "outer64" && isOuterLeafVoidSegment(segment)) {
      const outerVoidCell = canvasEl.querySelector<HTMLElement>('.builder-segment[data-layer="outer64"][data-void-outer="1"]');
      return outerVoidCell?.querySelector<HTMLElement>(".builder-segment-entities") ?? outerVoidCell ?? null;
    }
    const cell = canvasEl.querySelector<HTMLElement>(
      `.builder-segment[data-layer="${layer}"][data-segment="${segment}"]`,
    );
    return cell?.querySelector<HTMLElement>(".builder-segment-entities") ?? cell ?? null;
  }

  function segmentFromClientPoint(clientX: number, clientY: number): {
    layer: BuilderLayer;
    segment: number;
    host: HTMLElement;
    rect: DOMRect;
    widthPx: number;
    heightPx: number;
  } | null {
    const cell =
      document
        .elementsFromPoint(clientX, clientY)
        .map((node) => node.closest<HTMLElement>(".builder-segment"))
        .find((seg): seg is HTMLElement => seg !== null) ?? null;
    if (!cell) return null;
    const layer = cell.dataset.layer as BuilderLayer;
    const host = cell.querySelector<HTMLElement>(".builder-segment-entities") ?? cell;
    const rect = host.getBoundingClientRect();
    const widthPx = Math.max(1, host.clientWidth);
    const heightPx = Math.max(1, host.clientHeight);
    if (cell.dataset.voidOuter === "1") {
      const relX = (clientX - rect.left) / Math.max(1, host.clientWidth);
      const slot = Math.max(0, Math.min(3, Math.floor(relX * 4)));
      return { layer: "outer64", segment: 12 + slot, host, rect, widthPx, heightPx };
    }
    const segment = Number(cell.dataset.segment);
    if (Number.isNaN(segment)) return null;
    return { layer, segment, host, rect, widthPx, heightPx };
  }

  function applyCopyGhostPositions(posById: Map<string, DragPlacement>): void {
    canvasEl.querySelectorAll<HTMLElement>(".builder-entity.copy-ghost-preview").forEach((el) => {
      el.remove();
    });
    posById.forEach((pos, id) => {
      const { left, top } = previewPositionCss(id, pos.x, pos.y);
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${id}"]`)
        .forEach((srcEl) => {
          const ghostEl = srcEl.cloneNode(true) as HTMLElement;
          ghostEl.classList.remove("selected");
          ghostEl.classList.add("copy-ghost", "copy-ghost-preview");
          ghostEl.removeAttribute("data-root-id");
          ghostEl.style.left = left;
          ghostEl.style.top = top;
          (segmentEntitiesHost(pos.layer, pos.segment) ?? srcEl.parentElement)?.appendChild(ghostEl);
        });
    });
  }

  function commitCopiedGroup(
    sourceRootIds: string[],
    targetPosBySourceId: Map<string, DragPlacement>,
  ): void {
    const sourceSet = new Set(sourceRootIds);
    let nextState = state;
    const idMap = new Map<string, string>();
    sourceRootIds.forEach((srcId) => {
      const src = state.entities.find((e) => e.id === srcId);
      const targetPos = targetPosBySourceId.get(srcId);
      if (!src || !targetPos || isStaticOuterLeafEndpoint(src)) return;
      if (
        hasSameTypePlacementConflict(
          src.templateType,
          targetPos.layer,
          targetPos.segment,
          targetPos.x,
          targetPos.y,
        )
      ) {
        return;
      }
      const created = createEntityRoot(
        nextState,
        src.templateType,
        targetPos.layer,
        targetPos.segment,
        targetPos.x,
        targetPos.y,
      );
      nextState = { ...nextState, entities: [...nextState.entities, created] };
      nextState = updateEntitySettings(nextState, created.id, { ...src.settings });
      idMap.set(srcId, created.id);
    });
    state.links.forEach((link) => {
      if (!sourceSet.has(link.fromEntityId) || !sourceSet.has(link.toEntityId)) return;
      const fromId = idMap.get(link.fromEntityId);
      const toId = idMap.get(link.toEntityId);
      if (!fromId || !toId) return;
      const createdLink = createLinkRoot(
        nextState,
        fromId,
        link.fromPort,
        toId,
        link.toPort,
        {
          fromSegmentIndex: link.fromSegmentIndex,
          toSegmentIndex: link.toSegmentIndex,
          sameLayerSegmentDelta: link.sameLayerSegmentDelta,
          crossLayerBlockSlot: link.crossLayerBlockSlot,
          voidBandInnerOuterCrossLayer: link.voidBandInnerOuterCrossLayer,
          ...(link.wireColorIndex !== undefined ? { wireColorIndex: link.wireColorIndex } : {}),
        },
      );
      nextState = { ...nextState, links: [...nextState.links, createdLink] };
    });
    state = nextState;
    setEntitySelectionSet(new Set(Array.from(idMap.values())));
    persist();
    syncEntityDomForRoots(new Set(idMap.values()));
    renderInspector();
  }

  function createCopiedGroupInPlace(sourceRootIds: string[]): Map<string, string> {
    const sourceSet = new Set(sourceRootIds);
    let nextState = state;
    const idMap = new Map<string, string>();
    sourceRootIds.forEach((srcId) => {
      const src = state.entities.find((e) => e.id === srcId);
      if (!src || isStaticOuterLeafEndpoint(src)) return;
      if (
        hasSameTypePlacementConflict(
          src.templateType,
          src.layer,
          src.segmentIndex,
          src.x,
          src.y,
          sourceSet,
        )
      ) {
        return;
      }
      const created = createEntityRoot(
        nextState,
        src.templateType,
        src.layer,
        src.segmentIndex,
        src.x,
        src.y,
      );
      nextState = { ...nextState, entities: [...nextState.entities, created] };
      nextState = updateEntitySettings(nextState, created.id, { ...src.settings });
      idMap.set(srcId, created.id);
    });
    state.links.forEach((link) => {
      if (!sourceSet.has(link.fromEntityId) || !sourceSet.has(link.toEntityId)) return;
      const fromId = idMap.get(link.fromEntityId);
      const toId = idMap.get(link.toEntityId);
      if (!fromId || !toId) return;
      const createdLink = createLinkRoot(
        nextState,
        fromId,
        link.fromPort,
        toId,
        link.toPort,
        {
          fromSegmentIndex: link.fromSegmentIndex,
          toSegmentIndex: link.toSegmentIndex,
          sameLayerSegmentDelta: link.sameLayerSegmentDelta,
          crossLayerBlockSlot: link.crossLayerBlockSlot,
          voidBandInnerOuterCrossLayer: link.voidBandInnerOuterCrossLayer,
          ...(link.wireColorIndex !== undefined ? { wireColorIndex: link.wireColorIndex } : {}),
        },
      );
      nextState = { ...nextState, links: [...nextState.links, createdLink] };
    });
    state = nextState;
    return idMap;
  }

  function currentEntitySelectionSet(): Set<string> {
    if (selectedEntityRootIds.size) return new Set(selectedEntityRootIds);
    if (selection?.kind === "entity") return new Set([selection.rootId]);
    return new Set<string>();
  }

  function applyEntitySelectionWithMode(
    ids: Set<string>,
    mode: "replace" | "add" | "remove",
  ): void {
    if (mode === "replace") {
      setEntitySelectionSet(ids);
      return;
    }
    const base = currentEntitySelectionSet();
    if (mode === "add") {
      ids.forEach((id) => base.add(id));
    } else {
      ids.forEach((id) => base.delete(id));
    }
    setEntitySelectionSet(base);
  }

  function selectedEntityIdsForAction(primaryRootId: string): string[] {
    if (selectedEntityRootIds.has(primaryRootId)) {
      return Array.from(selectedEntityRootIds);
    }
    return [primaryRootId];
  }

  function entityIdsHaveLinks(ids: Iterable<string>): boolean {
    const idSet = new Set(ids);
    if (idSet.size === 0) return false;
    return state.links.some((link) => idSet.has(link.fromEntityId) || idSet.has(link.toEntityId));
  }

  function templatePlacementInSection(
    templateType: BuilderTemplateType,
    section: { layer: BuilderLayer; segment: number; rect: DOMRect; widthPx: number; heightPx: number },
    clientX: number,
    clientY: number,
  ): DragPlacement {
    const rawX = (clientX - section.rect.left) / BUILDER_GRID_TILE_SIZE_X_PX;
    const rawY = (clientY - section.rect.top) / BUILDER_GRID_TILE_SIZE_Y_PX;
    const footprint = entityFootprintOffsets({
      id: "template-preview",
      groupId: "template-preview",
      templateType,
      layer: section.layer,
      segmentIndex: section.segment,
      x: 0,
      y: 0,
      settings: defaultSettings(templateType),
    });
    const maxX = Math.max(0, Math.floor(Math.max(1, section.widthPx) / BUILDER_GRID_TILE_SIZE_X_PX) - 1);
    const maxY = Math.max(0, Math.floor(Math.max(1, section.heightPx) / BUILDER_GRID_TILE_SIZE_Y_PX) - 1);
    const minAnchorX = -footprint.left;
    const minAnchorY = -footprint.top;
    const maxAnchorX = maxX - footprint.left;
    const maxAnchorY = maxY - footprint.top;
    return {
      layer: section.layer,
      segment: section.segment,
      x: Math.max(minAnchorX, Math.min(maxAnchorX, Math.floor(rawX))),
      y: Math.max(minAnchorY, Math.min(maxAnchorY, Math.floor(rawY))),
    };
  }

  function startTemplateDragFromSidebar(templateType: BuilderTemplateType, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    hideFilterTooltip();
    let createdRootId: string | null = null;
    let lastPlacementKey = "";
    const floatingGhostEl = buildTemplateDragImage(templateType);
    floatingGhostEl.classList.toggle("builder-hide-property-labels", hideEntityPropertyLabels);
    document.body.appendChild(floatingGhostEl);

    const moveFloatingGhost = (clientX: number, clientY: number): void => {
      if (createdRootId) return;
      floatingGhostEl.style.left = `${clientX + 12}px`;
      floatingGhostEl.style.top = `${clientY + 12}px`;
    };

    const updateDraggedEntity = (clientX: number, clientY: number): void => {
      moveFloatingGhost(clientX, clientY);
      const overDeleteZone = isPointInDeleteDropZone(clientX, clientY);
      setDeleteDropZoneActive(overDeleteZone);
      if (createdRootId && overDeleteZone) {
        return;
      }
      const section = segmentFromClientPoint(clientX, clientY);
      if (!section) return;
      const placement = templatePlacementInSection(templateType, section, clientX, clientY);
      const key = `${placement.layer}:${placement.segment}:${placement.x}:${placement.y}`;
      if (key === lastPlacementKey) return;
      if (hasSameTypePlacementConflict(
        templateType,
        placement.layer,
        placement.segment,
        placement.x,
        placement.y,
        createdRootId ? new Set([createdRootId]) : undefined,
      )) {
        return;
      }

      if (!createdRootId) {
        floatingGhostEl.remove();
        const rootEntity = createEntityRoot(
          state,
          templateType,
          placement.layer,
          placement.segment,
          placement.x,
          placement.y,
        );
        createdRootId = rootEntity.id;
        state = { ...state, entities: [...state.entities, rootEntity] };
        setSelection({ kind: "entity", rootId: rootEntity.id });
        lastPlacementKey = key;
        syncEntityDomForRoots(new Set([rootEntity.id]));
        return;
      }

      const current = state.entities.find((e) => e.id === createdRootId);
      if (!current) return;
      lastPlacementKey = key;
      if (current.layer !== placement.layer) {
        setEntityPlacementDuringDrag(createdRootId, placement.layer, placement.segment, placement.x, placement.y);
        scheduleDragEntityPatch(new Set([createdRootId]));
      } else if (current.segmentIndex !== placement.segment) {
        setEntityPlacementDuringDrag(createdRootId, placement.layer, placement.segment, placement.x, placement.y);
        setEntityDomPosition(createdRootId, placement.x, placement.y);
      } else {
        setEntityPositionDuringDrag(createdRootId, placement.x, placement.y);
        setEntityDomPosition(createdRootId, placement.x, placement.y);
      }
    };

    setBuilderDragCursor("grabbing");
    updateDraggedEntity(ev.clientX, ev.clientY);
    capturePrimaryDragOnWindow(ev, {
      onMove: (mv) => updateDraggedEntity(mv.clientX, mv.clientY),
      onEnd: (up) => {
        const droppedInDeleteZone = isPointInDeleteDropZone(up.clientX, up.clientY);
        setDeleteDropZoneActive(false);
        let templatePatchFlush: Set<string> | null = null;
        if (dragEntityPatchRaf !== null) {
          window.cancelAnimationFrame(dragEntityPatchRaf);
          dragEntityPatchRaf = null;
          templatePatchFlush = new Set(pendingDragEntityPatchRootIds);
        }
        pendingDragEntityPatchRootIds.clear();
        clearBuilderDragCursor();
        floatingGhostEl.remove();
        if (!createdRootId) return;
        if (droppedInDeleteZone) {
          deleteEntityRootIds([createdRootId]);
          return;
        }
        if (templatePatchFlush && templatePatchFlush.size > 0) {
          syncEntityDomForRoots(templatePatchFlush);
        }
        schedulePersist();
        renderInspector();
        up.preventDefault();
      },
    });
  }

  function renderTemplates(): void {
    templatesEl.innerHTML = templateList()
      .map(
        (type) =>
          `<div class="builder-template" data-template="${type}">${templateLabel(type)}</div>`,
      )
      .join("");
    templatesEl.querySelectorAll<HTMLElement>(".builder-template").forEach((el) => {
      el.addEventListener("pointerdown", (ev) => {
        const templateType = el.dataset.template;
        if (!isBuilderTemplateType(templateType)) return;
        startTemplateDragFromSidebar(templateType, ev);
      });
    });
  }

  function simOccupancyByPacketId(
    occ: Array<{ port: PortRef; packet: Packet }>,
  ): Map<number, { port: PortRef; packet: Packet }> {
    const m = new Map<number, { port: PortRef; packet: Packet }>();
    for (const e of occ) {
      m.set(e.packet.id, e);
    }
    return m;
  }

  function builderPortCenterInOverlayCoords(
    ref: PortRef,
    cache?: Map<string, SimPortPoint | null>,
  ): SimPortPoint | null {
    const key = portKey(ref);
    if (cache?.has(key)) {
      return cache.get(key) ?? null;
    }
    const wrap = packetOverlayEl.parentElement;
    if (!wrap) {
      cache?.set(key, null);
      return null;
    }
    const el = wireBag.w!.resolveBuilderPortForWireOverlay(ref.deviceId, ref.port);
    if (!el) {
      cache?.set(key, null);
      return null;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let clientX = r.left + r.width / 2;
    let clientY = r.top + r.height / 2;
    let clipped = false;
    const viewport = el.closest<HTMLElement>(".builder-segment-entities");
    if (viewport) {
      const viewportRect = viewport.getBoundingClientRect();
      if (viewportRect.width <= 0 || viewportRect.height <= 0) {
        cache?.set(key, null);
        return null;
      }
      const clampedX = Math.max(viewportRect.left, Math.min(viewportRect.right, clientX));
      const clampedY = Math.max(viewportRect.top, Math.min(viewportRect.bottom, clientY));
      clipped = clampedX !== clientX || clampedY !== clientY;
      clientX = clampedX;
      clientY = clampedY;
    }
    const center = {
      x: clientX - wrapRect.left + wrap.scrollLeft,
      y: clientY - wrapRect.top + wrap.scrollTop,
      clipped,
    };
    cache?.set(key, center);
    return center;
  }

  function builderPacketOverlayViewportCenter(): { x: number; y: number } | null {
    const wrap = packetOverlayEl.parentElement;
    if (!wrap) return null;
    return {
      x: wrap.scrollLeft + wrap.clientWidth * 0.5,
      y: wrap.scrollTop + wrap.clientHeight * 0.5,
    };
  }

  type SimXY = { x: number; y: number };
  type SimPreparedPolyline = {
    points: SimXY[];
    segLens: number[];
    totalLen: number;
  };
  type SimPreparedPacketRender = {
    packetId: number;
    src: string;
    dest: string;
    subject?: string;
    line: SimPreparedPolyline | null;
    fallback: SimXY;
    fill: string;
    stroke: string;
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    selected: boolean;
    pathStartT: number;
    pathEndT: number;
  };

  function preparePolyline(points: SimXY[]): SimPreparedPolyline | null {
    if (points.length === 0) return null;
    if (points.length === 1) {
      return { points, segLens: [], totalLen: 0 };
    }
    const segLens: number[] = new Array(Math.max(0, points.length - 1));
    let totalLen = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const p = points[i]!;
      const q = points[i + 1]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      segLens[i] = len;
      totalLen += len;
    }
    return { points, segLens, totalLen };
  }

  function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  function simPointOnPreparedPolylineAt(line: SimPreparedPolyline, t: number): SimXY | null {
    const pts = line.points;
    if (pts.length === 0) return null;
    if (pts.length === 1) {
      return pts[0] ?? null;
    }
    if (line.totalLen < 1e-6) {
      return pts[0] ?? null;
    }
    let d = clamp01(t) * line.totalLen;
    for (let i = 0; i < line.segLens.length; i += 1) {
      const L = line.segLens[i] ?? 0;
      if (d <= L) {
        const u = d / (L < 1e-9 ? 1 : L);
        const p0 = pts[i]!;
        const p1 = pts[i + 1]!;
        return { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u };
      }
      d -= L;
    }
    return pts[pts.length - 1] ?? null;
  }

  function packetRouteKey(from: PortRef, to: PortRef): string {
    return `${from.deviceId}:${from.port}>${to.deviceId}:${to.port}`;
  }

  function buildPacketRouteTemplate(from: PortRef, to: PortRef): PortRef[] | null {
    if (from.deviceId === to.deviceId && from.port === to.port) {
      return [{ ...from }];
    }
    if (Object.keys(builderSimDevices).length === 0) {
      return [{ ...from }, { ...to }];
    }
    const dFrom = builderSimDevices[from.deviceId];
    if (dFrom && dFrom.id !== to.deviceId) {
      if (dFrom.type === "hub") {
        const egress = getHubEgressPort(dFrom.rotation, from.port);
        const nbr = builderSimAdj.get(portKey({ deviceId: from.deviceId, port: egress }));
        if (nbr && nbr.deviceId === to.deviceId && nbr.port === to.port) {
          return [{ ...from }, { deviceId: from.deviceId, port: egress }, { ...to }];
        }
      } else if (dFrom.type === "relay") {
        const outPort: 0 | 1 = from.port === 0 ? 1 : 0;
        const nbr = builderSimAdj.get(portKey({ deviceId: from.deviceId, port: outPort }));
        if (nbr && nbr.deviceId === to.deviceId && nbr.port === to.port) {
          return [{ ...from }, { deviceId: from.deviceId, port: outPort }, { ...to }];
        }
      } else if (dFrom.type === "filter") {
        for (const outPort of [0, 1] as const) {
          const nbr = builderSimAdj.get(portKey({ deviceId: from.deviceId, port: outPort }));
          if (!nbr || nbr.deviceId !== to.deviceId || nbr.port !== to.port) continue;
          if (outPort === from.port) {
            return [{ ...from }, { ...to }];
          }
          return [{ ...from }, { deviceId: from.deviceId, port: outPort }, { ...to }];
        }
      }
    }
    return [{ ...from }, { ...to }];
  }

  function buildPacketAnimationPolylinePrepared(
    from: PortRef,
    to: PortRef,
    centerCache: Map<string, SimPortPoint | null>,
  ): SimPreparedPolyline | null {
    const key = packetRouteKey(from, to);
    const reverseKey = packetRouteKey(to, from);
    let template = packetRouteTemplateByKey.get(key);
    if (template === undefined) {
      template = buildPacketRouteTemplate(from, to);
      packetRouteTemplateByKey.set(key, template);
      // Keep forward/backward animation paths symmetric: once we decide on a template for
      // one direction, reuse its reverse for the opposite direction.
      if (template) {
        if (packetRouteTemplateByKey.get(reverseKey) === undefined) {
          packetRouteTemplateByKey.set(reverseKey, [...template].reverse());
        }
      }
    }
    if (!template || template.length === 0) return null;
    const points: SimXY[] = [];
    for (const ref of template) {
      const c = builderPortCenterInOverlayCoords(ref, centerCache);
      if (!c) {
        return null;
      }
      points.push({ x: c.x, y: c.y });
    }
    return preparePolyline(points);
  }

  function syncBuilderPacketOverlayDimensions(overlayWidth: number, overlayHeight: number): void {
    const w = Math.ceil(overlayWidth);
    const h = Math.ceil(overlayHeight);
    if (packetOverlayWidthPx === w && packetOverlayHeightPx === h) {
      return;
    }
    packetOverlayWidthPx = w;
    packetOverlayHeightPx = h;
    packetOverlayEl.setAttribute("width", String(w));
    packetOverlayEl.setAttribute("height", String(h));
    packetOverlayEl.style.width = `${w}px`;
    packetOverlayEl.style.height = `${h}px`;
  }

  function invalidateBuilderPacketRenderCache(): void {
    simPreparedPacketRenderDirty = true;
  }

  function invalidateBuilderPacketGeometryCache(): void {
    packetPortCenterCache.clear();
    packetPreparedRouteByKey.clear();
  }

  function clearBuilderPacketCirclePool(): void {
    packetOverlayEl.innerHTML = "";
    packetCircleGroupEl = null;
    packetSelectedGuideEl = null;
    invalidateBuilderPacketGeometryCache();
    packetCirclePool.length = 0;
    packetLabelPool.length = 0;
    packetSlotByPacketId.clear();
    packetFreeSlots.length = 0;
    packetSlotLastSeenFrame.length = 0;
    packetRenderFrameId = 0;
    packetOverlayWidthPx = -1;
    packetOverlayHeightPx = -1;
  }

  function ensureBuilderPacketCircleGroup(): SVGGElement {
    if (packetCircleGroupEl?.parentNode === packetOverlayEl) {
      return packetCircleGroupEl;
    }
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    packetOverlayEl.appendChild(group);
    packetCircleGroupEl = group;
    return group;
  }

  function ensureSelectedPacketGuide(): SVGLineElement {
    if (packetSelectedGuideEl?.parentNode === packetOverlayEl) {
      return packetSelectedGuideEl;
    }
    const guide = document.createElementNS("http://www.w3.org/2000/svg", "line");
    guide.setAttribute("class", "builder-packet-selected-guide");
    guide.setAttribute("display", "none");
    packetOverlayEl.appendChild(guide);
    packetSelectedGuideEl = guide;
    return guide;
  }

  function ensureBuilderPacketCircle(index: number): {
    group: SVGGElement;
    el: SVGCircleElement;
    visible: boolean;
    lastPacketId: number | null;
    lastSelected: boolean | null;
    lastStroke: string;
    lastStrokeWidth: number;
  } {
    const existing = packetCirclePool[index];
    if (existing) {
      return existing;
    }
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "builder-packet-dot");
    circle.setAttribute("r", String(PACKET_DOT_RADIUS_PX));
    circle.setAttribute("cx", "0");
    circle.setAttribute("cy", "0");
    group.appendChild(circle);
    ensureBuilderPacketCircleGroup().appendChild(group);
    const slot = {
      group,
      el: circle,
      visible: true,
      lastPacketId: null,
      lastSelected: null,
      lastStroke: "",
      lastStrokeWidth: Number.NaN,
    };
    packetCirclePool[index] = slot;
    return slot;
  }

  function ensureBuilderPacketLabel(index: number): {
    bg: SVGRectElement;
    text: SVGTextElement;
    src: SVGTSpanElement;
    dest: SVGTSpanElement;
    subject: SVGTSpanElement;
    bgOffsetX: number;
    bgOffsetY: number;
    bgWidth: number;
    bgHeight: number;
    lastLabelSig: string;
    visible: boolean;
  } {
    const existing = packetLabelPool[index];
    if (existing) {
      return existing;
    }
    const circle = ensureBuilderPacketCircle(index);
    const group = circle.group;
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("class", "builder-packet-label-bg");
    bg.setAttribute("rx", "4");
    bg.setAttribute("ry", "4");
    bg.setAttribute("display", "none");

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "builder-packet-label");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("x", "0");
    text.setAttribute("y", "0");
    text.setAttribute("display", "none");

    const src = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    src.setAttribute("class", "builder-packet-label-src");
    src.setAttribute("dy", "-0.58em");
    src.setAttribute("x", String(PACKET_LABEL_ANCHOR_X_PX));

    const dest = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    dest.setAttribute("class", "builder-packet-label-dest");
    dest.setAttribute("dy", "1.16em");
    dest.setAttribute("x", String(PACKET_LABEL_ANCHOR_X_PX));

    const subject = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    subject.setAttribute("class", "builder-packet-label-subject");
    subject.setAttribute("dy", "1.16em");
    subject.setAttribute("x", String(PACKET_LABEL_ANCHOR_X_PX));
    subject.setAttribute("display", "none");

    text.append(src, dest, subject);
    bg.setAttribute("x", (PACKET_LABEL_ANCHOR_X_PX + PACKET_IP_LABEL_OFFSET_X_PX).toFixed(2));
    bg.setAttribute("y", PACKET_IP_LABEL_OFFSET_Y_PX.toFixed(2));
    text.setAttribute("x", String(PACKET_LABEL_ANCHOR_X_PX));
    text.setAttribute("y", "0");
    group.append(bg, text);
    const label = {
      bg,
      text,
      src,
      dest,
      subject,
      bgOffsetX: PACKET_IP_LABEL_OFFSET_X_PX,
      bgOffsetY: PACKET_IP_LABEL_OFFSET_Y_PX,
      bgWidth: PACKET_IP_LABEL_WIDTH_PX,
      bgHeight: PACKET_IP_LABEL_HEIGHT_PX,
      lastLabelSig: "",
      visible: false,
    };
    packetLabelPool[index] = label;
    return label;
  }

  function hideBuilderPacketSlot(slotIndex: number): void {
    const circle = packetCirclePool[slotIndex];
    if (circle) {
      if (circle.visible) {
        circle.group.setAttribute("display", "none");
        circle.visible = false;
      }
      if (circle.lastPacketId !== null) {
        circle.el.removeAttribute("data-packet-id");
        circle.lastPacketId = null;
      }
    }
    const label = packetLabelPool[slotIndex];
    if (label) {
      if (label.visible) {
        label.bg.setAttribute("display", "none");
        label.text.setAttribute("display", "none");
        label.visible = false;
      }
      if (label.lastLabelSig !== "") {
        label.text.removeAttribute("data-packet-id");
        label.lastLabelSig = "";
      }
    }
  }

  function prepareBuilderPacketRenders(): number {
    const centerCache = packetPortCenterCache;
    const preparedRouteByKey = packetPreparedRouteByKey;
    const prepared: SimPreparedPacketRender[] = [];
    const tPoly0 = performance.now();

    for (const { port, packet } of simCurrentOccupancy) {
      const fromEntry = simPreviousOccupancyByPacketId.get(packet.id);
      const spawnId = builderEndpointIdByAddress.get(packet.src);
      // Forward animation: if we didn't see the packet last tick, assume it was emitted from its source endpoint.
      // Reverse animation: if we didn't see the packet in the newer tick, it was likely consumed/dropped; don't
      // animate it "from the source" — keep it at its current (older) port.
      const fromDeviceId =
        fromEntry?.port.deviceId ??
        (simReverseAnimationMode ? port.deviceId : (spawnId ?? port.deviceId));
      const fromPortNum = fromEntry?.port.port ?? (simReverseAnimationMode ? port.port : 0);
      const fromRef: PortRef = { deviceId: fromDeviceId, port: fromPortNum };
      const toRef: PortRef = { ...port };
      const finalEndpointId = builderEndpointIdByAddress.get(packet.dest);
      const finalDestRef: PortRef | null = finalEndpointId ? { deviceId: finalEndpointId, port: 0 } : null;
      const pa = builderPortCenterInOverlayCoords(fromRef, centerCache) ?? builderPortCenterInOverlayCoords(toRef, centerCache);
      const pb = builderPortCenterInOverlayCoords(toRef, centerCache);
      if (!pa || !pb) continue;
      if (pa.clipped && pb.clipped) continue;
      const pFinal = finalDestRef ? builderPortCenterInOverlayCoords(finalDestRef, centerCache) : null;

      const fallback = { x: pa.x, y: pa.y };
      let line: SimPreparedPolyline | null = null;
      if (fromDeviceId !== port.deviceId || fromPortNum !== port.port) {
        const routeKey = packetRouteKey(fromRef, toRef);
        line = preparedRouteByKey.get(routeKey);
        if (line === undefined) {
          line = buildPacketAnimationPolylinePrepared(fromRef, toRef, centerCache);
          preparedRouteByKey.set(routeKey, line);
        }
        if (!line || line.points.length < 2 || line.totalLen < 1) {
          line = null;
        }
      }

      const hue = (packet.id * 47) % 360;
      prepared.push({
        packetId: packet.id,
        src: packet.src,
        dest: packet.dest,
        subject: packet.subject,
        line,
        fallback,
        fill: `hsl(${hue} 82% 58%)`,
        stroke: `hsl(${hue} 82% 38%)`,
        x: fallback.x,
        y: fallback.y,
        targetX: (pFinal ?? pb).x,
        targetY: (pFinal ?? pb).y,
        selected: false,
        pathStartT: 0,
        pathEndT: 1,
      });
    }

    // Reverse-step animation: also render packets that exist in "from" (newer tick)
    // but not in "to" (older tick) so they can visually travel back to source endpoint.
    if (simReverseAnimationMode) {
      const currentIds = new Set(simCurrentOccupancy.map((e) => e.packet.id));
      for (const { port, packet } of simPreviousOccupancy) {
        if (currentIds.has(packet.id)) continue;
        const sourceEndpointId = builderEndpointIdByAddress.get(packet.src);
        if (!sourceEndpointId) continue;
        const fromRef: PortRef = { ...port };
        const toRef: PortRef = { deviceId: sourceEndpointId, port: 0 };
        const pa = builderPortCenterInOverlayCoords(fromRef, centerCache);
        const pb = builderPortCenterInOverlayCoords(toRef, centerCache);
        if (!pa || !pb) continue;
        if (pa.clipped && pb.clipped) continue;
        const routeKey = packetRouteKey(fromRef, toRef);
        let line = preparedRouteByKey.get(routeKey);
        if (line === undefined) {
          line = buildPacketAnimationPolylinePrepared(fromRef, toRef, centerCache);
          preparedRouteByKey.set(routeKey, line);
        }
        if (!line || line.points.length < 2 || line.totalLen < 1) {
          line = null;
        }
        const fallback = { x: pa.x, y: pa.y };
        const hue = (packet.id * 47) % 360;
        prepared.push({
          packetId: packet.id,
          src: packet.src,
          dest: packet.dest,
          subject: packet.subject,
          line,
          fallback,
          fill: `hsl(${hue} 82% 58%)`,
          stroke: `hsl(${hue} 82% 38%)`,
          x: fallback.x,
          y: fallback.y,
          targetX: pb.x,
          targetY: pb.y,
          selected: false,
          // Reach endpoint before the end, then stay visible there.
          pathStartT: 0,
          pathEndT: 0.82,
        });
      }
    }

    if (!simReverseAnimationMode && simEndpointGhostPackets.length > 0) {
      const currentIds = new Set(simCurrentOccupancy.map((e) => e.packet.id));
      for (const ghost of simEndpointGhostPackets) {
        if (currentIds.has(ghost.packet.id)) continue;
        const p = builderPortCenterInOverlayCoords(ghost.endpointRef, centerCache);
        if (!p || p.clipped) continue;
        const fallback = { x: p.x, y: p.y };
        const hue = (ghost.packet.id * 47) % 360;
        prepared.push({
          packetId: ghost.packet.id,
          src: ghost.packet.src,
          dest: ghost.packet.dest,
          subject: ghost.packet.subject,
          line: null,
          fallback,
          fill: `hsl(${hue} 82% 58%)`,
          stroke: `hsl(${hue} 82% 38%)`,
          x: fallback.x,
          y: fallback.y,
          targetX: fallback.x,
          targetY: fallback.y,
          selected: false,
          pathStartT: 0,
          pathEndT: 1,
        });
      }
    }

    simPreparedPacketRenders = prepared;
    simPreparedPacketRenderDirty = false;
    return performance.now() - tPoly0;
  }

  function renderBuilderPacketCircles(t: number): void {
    const t0 = performance.now();
    const wrap = packetOverlayEl.parentElement;
    if (!wrap) return;
    const progress = clamp01(t);
    const tResize0 = performance.now();
    const contentWidth = Math.max(canvasEl.scrollWidth, canvasEl.clientWidth);
    const contentHeight = Math.max(canvasEl.scrollHeight, canvasEl.clientHeight);
    const overlayWidth = Math.max(wrap.clientWidth, contentWidth);
    const overlayHeight = Math.max(wrap.clientHeight, contentHeight);
    syncBuilderPacketOverlayDimensions(overlayWidth, overlayHeight);
    const tResize1 = performance.now();

    let polylineMs = 0;
    let interpolateMs = 0;
    const tCompute0 = performance.now();
    if (simPreparedPacketRenderDirty) {
      polylineMs = prepareBuilderPacketRenders();
    }
    let selectedRender: SimPreparedPacketRender | null = null;
    for (const render of simPreparedPacketRenders) {
      let x = render.fallback.x;
      let y = render.fallback.y;
      if (render.line) {
        const denom = Math.max(1e-6, render.pathEndT - render.pathStartT);
        const pathProgress = clamp01((progress - render.pathStartT) / denom);
        const tInterp0 = performance.now();
        const p = simPointOnPreparedPolylineAt(render.line, pathProgress);
        interpolateMs += performance.now() - tInterp0;
        if (p) {
          x = p.x;
          y = p.y;
        }
      }
      render.x = x;
      render.y = y;
      render.selected = selection?.kind === "packet" && selection.packetId === render.packetId;
      if (render.selected) selectedRender = render;
    }
    const tCompute1 = performance.now();
    const tCommit0 = performance.now();
    if (simPreparedPacketRenders.length > 0) {
      ensureBuilderPacketCircleGroup();
    }
    const selectedGuide = ensureSelectedPacketGuide();
    packetRenderFrameId += 1;
    const frameId = packetRenderFrameId;
    for (let i = 0; i < simPreparedPacketRenders.length; i += 1) {
      const render = simPreparedPacketRenders[i]!;
      let slotIndex = packetSlotByPacketId.get(render.packetId);
      if (slotIndex === undefined) {
        slotIndex =
          packetFreeSlots.length > 0 ? (packetFreeSlots.pop() as number) : packetCirclePool.length;
        packetSlotByPacketId.set(render.packetId, slotIndex);
      }
      packetSlotLastSeenFrame[slotIndex] = frameId;
      const circle = ensureBuilderPacketCircle(slotIndex);
      const selected = render.selected;
      const circleEl = circle.el;
      if (!circle.visible) {
        circle.group.removeAttribute("display");
        circle.visible = true;
      }
      circle.group.setAttribute("transform", `translate(${render.x.toFixed(2)} ${render.y.toFixed(2)})`);
      if (circle.lastPacketId !== render.packetId) {
        circle.lastPacketId = render.packetId;
        circleEl.setAttribute("data-packet-id", String(render.packetId));
        circleEl.setAttribute("fill", render.fill);
      }
      const stroke = selected ? "#f9e2af" : render.stroke;
      const strokeWidth = selected ? 2.2 : 1.2;
      if (circle.lastSelected !== selected) {
        circle.lastSelected = selected;
        circleEl.setAttribute("class", selected ? "builder-packet-dot builder-packet-dot--selected" : "builder-packet-dot");
      }
      if (circle.lastStroke !== stroke) {
        circle.lastStroke = stroke;
        circleEl.setAttribute("stroke", stroke);
      }
      if (circle.lastStrokeWidth !== strokeWidth) {
        circle.lastStrokeWidth = strokeWidth;
        circleEl.setAttribute("stroke-width", String(strokeWidth));
      }
      const labelMode = builderPageState.packetLabelMode;
      const showPacketLabels = labelMode !== "hide";
      const showSubjectLine = labelMode === "ipsSubject";
      const label = showPacketLabels ? ensureBuilderPacketLabel(slotIndex) : packetLabelPool[slotIndex];
      if (showPacketLabels) {
        const shownLabel = label!;
        if (!shownLabel.visible) {
          shownLabel.bg.removeAttribute("display");
          shownLabel.text.removeAttribute("display");
          shownLabel.visible = true;
        }
        const subjRaw = formatPacketLabelSubject(render.subject);
        const subj = showSubjectLine ? subjRaw : "";
        const labelSig = `${labelMode}\0${render.packetId}\0${render.src}\0${render.dest}\0${subj}`;
        if (shownLabel.lastLabelSig !== labelSig) {
          shownLabel.lastLabelSig = labelSig;
          shownLabel.src.textContent = render.src;
          shownLabel.dest.textContent = render.dest;
          shownLabel.text.setAttribute("data-packet-id", String(render.packetId));
          const dims = packetIpLabelBgDimensions(render.src, render.dest, subj);
          const fallbackOrigin = {
            x: PACKET_LABEL_ANCHOR_X_PX + PACKET_IP_LABEL_OFFSET_X_PX,
            y: PACKET_IP_LABEL_OFFSET_Y_PX,
          };
          if (subj) {
            shownLabel.subject.textContent = subj;
            shownLabel.subject.removeAttribute("display");
            shownLabel.src.setAttribute("dy", "-1.16em");
            shownLabel.dest.setAttribute("dy", "1.16em");
            shownLabel.subject.setAttribute("dy", "1.16em");
          } else {
            shownLabel.subject.textContent = "";
            shownLabel.subject.setAttribute("display", "none");
            shownLabel.src.setAttribute("dy", "-0.58em");
            shownLabel.dest.setAttribute("dy", "1.16em");
          }
          layoutPacketLabelBackgroundRect(shownLabel.text, shownLabel.bg, dims, fallbackOrigin);
          shownLabel.bgWidth = parseFloat(shownLabel.bg.getAttribute("width")!) || dims.width;
          shownLabel.bgHeight = parseFloat(shownLabel.bg.getAttribute("height")!) || dims.height;
        }
      } else if (label) {
        if (label.visible) {
          label.bg.setAttribute("display", "none");
          label.text.setAttribute("display", "none");
          label.visible = false;
        }
        if (label.lastLabelSig !== "") {
          label.text.removeAttribute("data-packet-id");
          label.lastLabelSig = "";
        }
      }
    }
    const stalePacketIds: number[] = [];
    packetSlotByPacketId.forEach((slotIndex, packetId) => {
      if (packetSlotLastSeenFrame[slotIndex] === frameId) return;
      hideBuilderPacketSlot(slotIndex);
      packetFreeSlots.push(slotIndex);
      stalePacketIds.push(packetId);
    });
    stalePacketIds.forEach((packetId) => {
      packetSlotByPacketId.delete(packetId);
    });
    if (selectedRender) {
      selectedGuide.removeAttribute("display");
      selectedGuide.setAttribute("x1", selectedRender.x.toFixed(2));
      selectedGuide.setAttribute("y1", selectedRender.y.toFixed(2));
      selectedGuide.setAttribute("x2", selectedRender.targetX.toFixed(2));
      selectedGuide.setAttribute("y2", selectedRender.targetY.toFixed(2));
    } else if (
      selection?.kind === "entity" &&
      simDropBoard.traceDeviceId &&
      simRootIdFromDeviceId(simDropBoard.traceDeviceId) === selection.rootId
    ) {
      const vc = builderPacketOverlayViewportCenter();
      const anchor = builderPortCenterInOverlayCoords({ deviceId: simDropBoard.traceDeviceId, port: 0 });
      if (vc && anchor) {
        selectedGuide.removeAttribute("display");
        selectedGuide.setAttribute("x1", vc.x.toFixed(2));
        selectedGuide.setAttribute("y1", vc.y.toFixed(2));
        selectedGuide.setAttribute("x2", anchor.x.toFixed(2));
        selectedGuide.setAttribute("y2", anchor.y.toFixed(2));
      } else {
        selectedGuide.setAttribute("display", "none");
      }
    } else {
      selectedGuide.setAttribute("display", "none");
    }
    const tCommit1 = performance.now();
    perfCounts.packetsInFlight = simCurrentOccupancy.length;
    recordPerf("packet.overlayResize", tResize1 - tResize0);
    recordPerf("packet.compute", tCompute1 - tCompute0);
    recordPerf("packet.polyline", polylineMs);
    recordPerf("packet.interpolate", interpolateMs);
    recordPerf("packet.domCommit", tCommit1 - tCommit0);
    recordPerf("packet.total", tCommit1 - t0);
    maybeRenderPerfPanel(tCommit1);
  }

  function setEntityDomPosition(rootId: string, x: number, y: number): void {
    const { left, top } = previewPositionCss(rootId, x, y);
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`)
      .forEach((entityEl) => {
        entityEl.style.left = left;
        entityEl.style.top = top;
      });
  }

  function setEntityPositionDuringDrag(rootId: string, x: number, y: number): void {
    const ent = state.entities.find((e) => e.id === rootId);
    if (!ent || ent.isStatic || isStaticOuterLeafEndpoint(ent)) return;
    ent.x = x;
    ent.y = y;
  }

  function setEntityPlacementDuringDrag(
    rootId: string,
    layer: BuilderLayer,
    segment: number,
    x: number,
    y: number,
  ): void {
    const ent = state.entities.find((e) => e.id === rootId);
    if (!ent || ent.isStatic || isStaticOuterLeafEndpoint(ent)) return;
    ent.layer = layer;
    ent.segmentIndex = segment;
    ent.x = x;
    ent.y = y;
  }

  function segmentTransitionChangesMirrorMembership(
    layer: BuilderLayer,
    fromSegment: number,
    toSegment: number,
  ): boolean {
    if (fromSegment === toSegment) return false;
    // outer64 12-15 (0.0.3.*) is non-mirroring
    if (layer === "outer64") {
      return isOuterLeafVoidSegment(fromSegment) !== isOuterLeafVoidSegment(toSegment);
    }
    // middle16 segment 3 (0.0.3.* lane) is non-mirroring
    if (layer === "middle16") {
      const fromIsVoid = fromSegment === 3;
      const toIsVoid = toSegment === 3;
      return fromIsVoid !== toIsVoid;
    }
    return false;
  }

  function setHubFaceAngleDom(rootId: string, faceDeg: number): void {
    const normalizedFace = ((faceDeg % 360) + 360) % 360;
    const portStyleFor = (port: string): string => {
      if (port === "0") return hubPortPinUprightStyle(HUB_LAYOUT.T, normalizedFace);
      if (port === "1") return hubPortPinUprightStyle(HUB_LAYOUT.R, normalizedFace);
      return hubPortPinUprightStyle(HUB_LAYOUT.L, normalizedFace);
    };
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`)
      .forEach((entityEl) => {
        const hub = entityEl.querySelector<HTMLElement>(".builder-hub");
        if (!hub) return;
        hub.dataset.faceAngle = String(normalizedFace);
        const rot = hub.querySelector<HTMLElement>(".builder-hub-rot");
        if (rot) {
          rot.style.transform = `rotate(${normalizedFace}deg)`;
        }
        hub.querySelectorAll<HTMLButtonElement>(".builder-hub-port[data-port]").forEach((portEl) => {
          portEl.style.cssText = portStyleFor(portEl.dataset.port ?? "2");
        });
      });
  }

  function setRelayAngleDom(rootId: string, angleDeg: number): void {
    const normalized = ((angleDeg % 360) + 360) % 360;
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity.builder-entity--relay[data-root-id="${rootId}"]`)
      .forEach((entityEl) => {
        entityEl.dataset.relayAngle = String(normalized);
      });
  }

  function setTextEntitySizeDom(rootId: string, widthTiles: number, heightTiles: number): void {
    const wPx = widthTiles * BUILDER_GRID_TILE_SIZE_X_PX + 1;
    const hPx = heightTiles * BUILDER_GRID_TILE_SIZE_Y_PX + 1;
    canvasEl
      .querySelectorAll<HTMLElement>(`.builder-entity.builder-entity--text[data-root-id="${rootId}"]`)
      .forEach((entityEl) => {
        entityEl.style.setProperty("--builder-text-w", `${wPx}px`);
        entityEl.style.setProperty("--builder-text-h", `${hPx}px`);
      });
  }

  function snapPixelToGridX(pixelX: number): number {
    return Math.round(pixelX / BUILDER_GRID_TILE_SIZE_X_PX);
  }

  function snapPixelToGridY(pixelY: number): number {
    return Math.round(pixelY / BUILDER_GRID_TILE_SIZE_Y_PX);
  }

  function clampGridToSectionBounds(
    x: number,
    y: number,
    sectionWidthPx: number,
    sectionHeightPx: number,
  ): { x: number; y: number } {
    const maxX = Math.max(0, Math.floor(Math.max(1, sectionWidthPx) / BUILDER_GRID_TILE_SIZE_X_PX) - 1);
    const maxY = Math.max(0, Math.floor(Math.max(1, sectionHeightPx) / BUILDER_GRID_TILE_SIZE_Y_PX) - 1);
    return {
      x: Math.max(0, Math.min(maxX, x)),
      y: Math.max(0, Math.min(maxY, y)),
    };
  }

  function boxIntersectsHubTriangle(
    boxL: number,
    boxT: number,
    boxR: number,
    boxB: number,
    hubEl: HTMLElement,
    faceDeg: number,
    wrapRect: DOMRect,
    wrapScrollLeft: number,
    wrapScrollTop: number,
  ): boolean {
    const hubRect = hubEl.getBoundingClientRect();
    const hx1 = hubRect.left - wrapRect.left + wrapScrollLeft;
    const hy1 = hubRect.top - wrapRect.top + wrapScrollTop;
    const hx2 = hx1 + hubRect.width;
    const hy2 = hy1 + hubRect.height;
    const ix1 = Math.max(boxL, hx1);
    const iy1 = Math.max(boxT, hy1);
    const ix2 = Math.min(boxR, hx2);
    const iy2 = Math.min(boxB, hy2);
    if (ix2 < ix1 || iy2 < iy1) return false;
    const sampleXs = [ix1, (ix1 + ix2) / 2, ix2];
    const sampleYs = [iy1, (iy1 + iy2) / 2, iy2];
    for (const sx of sampleXs) {
      for (const sy of sampleYs) {
        const localX = sx - hx1;
        const localY = sy - hy1;
        const p = hubLocalToModel(localX, localY, faceDeg);
        if (hubPointInOrOnTri(p, HUB_LAYOUT.T, HUB_LAYOUT.L, HUB_LAYOUT.R)) {
          return true;
        }
        const d = Math.min(
          hubDistToSeg(p, HUB_LAYOUT.T, HUB_LAYOUT.L),
          hubDistToSeg(p, HUB_LAYOUT.L, HUB_LAYOUT.R),
          hubDistToSeg(p, HUB_LAYOUT.R, HUB_LAYOUT.T),
        );
        if (d <= HUB_LAYOUT.r) {
          return true;
        }
      }
    }
    return false;
  }

  /** Pass `true` for pointer-up wired flush (paint + bake). Use `{ syncPartial: true, bake: false }` mid-drag DOM rebuild (layer/segment hop). */
  function syncEntityDomForRoots(
    rootIds: ReadonlySet<string>,
    entityWireOverlay?: boolean | { syncPartial: true; bake?: boolean },
  ): boolean {
    if (rootIds.size === 0) return false;
    const expanded = expandBuilderState(state, { builderView: true });
    const staticRootIds = new Set(
      state.entities.filter((e) => isStaticOuterLeafEndpoint(e)).map((e) => e.id),
    );
    const bucketMap = buildSortedEntitiesByCanvasBucket(expanded, staticRootIds);
    rootIds.forEach((id) => {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${CSS.escape(id)}"]`)
        .forEach((el) => el.remove());
    });
    const htmlCtx = {
      gridTileXPx: BUILDER_GRID_TILE_SIZE_X_PX,
      gridTileYPx: BUILDER_GRID_TILE_SIZE_Y_PX,
      staticRootIds,
      selectedEntityRootId: selection?.kind === "entity" ? selection.rootId : null,
      simTickCollisionDropEntityInstanceIds,
      simTickCollisionDropEntityRootIds,
      simTickDeliveredEntityRootIds,
    };
    for (const entities of Array.from(bucketMap.values())) {
      if (!entities.some((e) => rootIds.has(e.rootId))) continue;
      const host = segmentEntitiesHost(entities[0].layer, entities[0].segmentIndex);
      if (!host) continue;
      for (const entity of entities) {
        let el: HTMLElement | null = null;
        if (rootIds.has(entity.rootId)) {
          const html = buildBuilderEntityInstanceHtml(entity, htmlCtx);
          const tpl = document.createElement("template");
          tpl.innerHTML = html.trim();
          el = tpl.content.firstElementChild as HTMLElement | null;
        } else {
          el = host.querySelector<HTMLElement>(
            `.builder-entity[data-root-id="${CSS.escape(entity.rootId)}"][data-instance-id="${CSS.escape(entity.instanceId)}"]`,
          );
        }
        if (!el) continue;
        host.appendChild(el);
      }
    }
    canvasEl.querySelectorAll<HTMLTextAreaElement>(".builder-note-editor[data-note-root-id]").forEach((editor) => {
      const noteRootId = editor.dataset.noteRootId;
      if (!noteRootId || !rootIds.has(noteRootId)) return;
      editor.addEventListener("input", () => {
        const rid = editor.dataset.noteRootId;
        if (!rid) return;
        const ent = state.entities.find((e) => e.id === rid);
        if (!ent || ent.templateType !== "text") return;
        const nextLabel = editor.value;
        if ((ent.settings.label ?? "") === nextLabel) return;
        state = updateEntitySettings(state, ent.id, { ...ent.settings, label: nextLabel });
        schedulePersist();
      });
    });
    applySelectionToCanvas();
    applySimTickHighlightsToCanvas();
    let syncPartial = false;
    let bakeAfterPartial = true;
    if (entityWireOverlay === true) {
      syncPartial = true;
      bakeAfterPartial = true;
    } else if (
      entityWireOverlay &&
      typeof entityWireOverlay === "object" &&
      entityWireOverlay.syncPartial === true
    ) {
      syncPartial = true;
      bakeAfterPartial = entityWireOverlay.bake !== false;
    }
    return wireBag.w!.refreshWireOverlayAfterEntityPatch(rootIds, {
      syncEntityWirePartial: syncPartial,
      entityWireBakeAfterPartial: bakeAfterPartial,
    });
  }

  function removeEntityDomForIds(removedRootIds: ReadonlySet<string>, wireGeometryChanged = true): void {
    if (removedRootIds.size === 0) return;
    removedRootIds.forEach((id) => {
      canvasEl
        .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${CSS.escape(id)}"]`)
        .forEach((el) => el.remove());
    });
    applySelectionToCanvas();
    applySimTickHighlightsToCanvas();
    wireBag.w!.refreshWireOverlayAfterEntityRemoval(wireGeometryChanged);
  }

  function scheduleDragEntityPatch(rootIds: ReadonlySet<string>): void {
    rootIds.forEach((id) => pendingDragEntityPatchRootIds.add(id));
    if (dragEntityPatchRaf !== null) return;
    dragEntityPatchRaf = window.requestAnimationFrame(() => {
      dragEntityPatchRaf = null;
      const ids = new Set(pendingDragEntityPatchRootIds);
      pendingDragEntityPatchRootIds.clear();
      if (ids.size > 0) {
        syncEntityDomForRoots(
          ids,
          wireBag.w!.isEntityWireDragActive() ? { syncPartial: true, bake: false } : undefined,
        );
      }
    });
  }

  const cycleValue = (value: string, options: string[], direction: "next" | "prev"): string => {
    const idx = options.indexOf(value);
    const safeIdx = idx >= 0 ? idx : 0;
    const delta = direction === "next" ? 1 : -1;
    return options[(safeIdx + delta + options.length) % options.length];
  };

  function filterDisplayValue(key: string, settings: Record<string, string>): string {
    if (key === "operatingPort") return settings.operatingPort ?? "0";
    if (key === "addressField") return (settings.addressField ?? "destination") === "source" ? "Source" : "Destination";
    if (key === "operation") return (settings.operation ?? "differ") === "match" ? "Match" : "Differ";
    if (key === "action") return (settings.action ?? "send_back") === "drop" ? "Drop" : "Send back";
    if (key === "collisionHandling") {
      const value = settings.collisionHandling ?? "drop_inbound";
      if (value === "drop_inbound") return "Drop<br/>Inbound";
      if (value === "drop_outbound") return "Drop<br/>Outbound";
      return "Send back<br/>Outbound";
    }
    return settings[key] ?? "";
  }

  function refreshFilterSettingControls(rootId: string): void {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    if (!rootEnt || rootEnt.templateType !== "filter") return;
    canvasEl.querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`).forEach((entityEl) => {
      entityEl.querySelectorAll<HTMLElement>("[data-setting-value]").forEach((valueEl) => {
        const key = valueEl.dataset.settingValue;
        if (!key) return;
        valueEl.innerHTML = filterDisplayValue(key, rootEnt.settings);
      });
      entityEl.querySelectorAll<HTMLElement>("[data-filter-collision-row]").forEach((rowEl) => {
        rowEl.classList.toggle(
          "builder-row-collision--hidden",
          (rootEnt.settings.action ?? "send_back") !== "send_back",
        );
      });
    });
  }

  const setFilterSetting = (rootId: string, key: string, direction: "next" | "prev"): void => {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    if (!rootEnt) return;
    const current = rootEnt.settings[key] ?? "";
    let next = current;
    if (key === "operatingPort") next = cycleValue(current || "0", ["0", "1"], direction);
    if (key === "addressField") next = cycleValue(current || "destination", ["destination", "source"], direction);
    if (key === "operation") next = cycleValue(current || "differ", ["differ", "match"], direction);
    if (key === "action") next = cycleValue(current || "send_back", ["send_back", "drop"], direction);
    if (key === "collisionHandling") {
      next = cycleValue(
        current || "drop_inbound",
        ["drop_inbound", "drop_outbound", "send_back_outbound"],
        direction,
      );
    }
    state = updateEntitySettings(state, rootEnt.id, { ...rootEnt.settings, [key]: next });
    refreshFilterSettingControls(rootEnt.id);
    refreshFilterTooltipIfVisible(rootEnt.id);
    schedulePersist();
    renderInspector();
  };

  const updateMaskAt = (rootId: string, maskIdx: number, dir: "up" | "down", instanceSegmentIndex?: number): void => {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    if (!rootEnt) return;
    const segmentIndex = Number.isInteger(instanceSegmentIndex) ? instanceSegmentIndex : rootEnt.segmentIndex;
    const visibleMask =
      rootEnt.templateType === "filter"
        ? mapMaskForSegmentIndex(rootEnt.settings.mask ?? "*.*.*.*", rootEnt.layer, rootEnt.segmentIndex, segmentIndex)
        : (rootEnt.settings.mask ?? "*.*.*.*");
    const parts = visibleMask.split(".");
    while (parts.length < 4) parts.push("*");
    for (let i = 0; i < 4; i += 1) parts[i] = parts[i] ?? "*";

    const raw = parts[maskIdx] ?? "*";
    let poolIdx = MASK_VALUE_CYCLE.indexOf(raw as (typeof MASK_VALUE_CYCLE)[number]);
    if (poolIdx < 0) poolIdx = 0;
    const n = MASK_VALUE_CYCLE.length;
    poolIdx = dir === "up" ? (poolIdx + 1) % n : (poolIdx + n - 1) % n;

    const nextParts = parts.slice(0, 4);
    nextParts[maskIdx] = MASK_VALUE_CYCLE[poolIdx];
    const rootMask =
      rootEnt.templateType === "filter"
        ? unmapMaskForSegmentIndex(nextParts.join("."), rootEnt.layer, rootEnt.segmentIndex, segmentIndex)
        : nextParts.join(".");
    state = updateEntitySettings(state, rootEnt.id, { ...rootEnt.settings, mask: rootMask });
    refreshFilterMaskControls(rootEnt.id);
    refreshFilterTooltipIfVisible(rootEnt.id);
    schedulePersist();
    renderInspector();
  };

  function refreshFilterMaskControls(rootId: string): void {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    if (!rootEnt || rootEnt.templateType !== "filter") return;
    canvasEl.querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`).forEach((entityEl) => {
      const instance = parseBuilderInstanceId(entityEl.dataset.instanceId ?? "");
      const segmentIndex = instance?.segmentIndex ?? rootEnt.segmentIndex;
      const maskParts = mapMaskForSegmentIndex(
        rootEnt.settings.mask ?? "*.*.*.*",
        rootEnt.layer,
        rootEnt.segmentIndex,
        segmentIndex,
      ).split(".");
      while (maskParts.length < 4) maskParts.push("*");
      entityEl.querySelectorAll<HTMLElement>("[data-mask-value-idx]").forEach((valueEl) => {
        const idx = Number(valueEl.dataset.maskValueIdx);
        if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
        const value = maskParts[idx] ?? "*";
        valueEl.textContent = value;
        valueEl.classList.toggle("builder-mask-value-wildcard", value === "*");
      });
    });
  }

  function refreshHubControls(rootId: string): void {
    const rootEnt = state.entities.find((e) => e.id === rootId);
    if (!rootEnt || rootEnt.templateType !== "hub") return;
    const cw = (rootEnt.settings.rotation ?? "clockwise") !== "counterclockwise";
    canvasEl.querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${rootId}"]`).forEach((entityEl) => {
      const instanceId = entityEl.dataset.instanceId ?? rootId;
      const svg = entityEl.querySelector<SVGSVGElement>(".builder-hub-svg");
      if (svg) {
        const nextSvgWrap = document.createElement("div");
        nextSvgWrap.innerHTML = hubTriangleSvg(instanceId, rootEnt.settings.rotation);
        const nextSvg = nextSvgWrap.firstElementChild;
        if (nextSvg) {
          svg.replaceWith(nextSvg);
        }
      }
      const icon = entityEl.querySelector<HTMLElement>(".builder-hub-reverse-icon");
      if (icon) icon.textContent = cw ? "↻" : "↺";
    });
  }

  function refreshHubControlsForRoots(rootIds: string[]): void {
    rootIds.forEach((id) => {
      refreshHubControls(id);
    });
  }
  let hoveredHubEl: HTMLElement | null = null;
  let hoveredRelayEl: HTMLElement | null = null;

  const clearHubHover = (hub: HTMLElement | null): void => {
    if (!hub) return;
    hub.classList.remove("builder-hub--hover-move", "builder-hub--hover-rotate");
    hub.closest<HTMLElement>(".builder-entity--hub")?.classList.remove(
      "builder-hub--hover-move",
      "builder-hub--hover-rotate",
    );
  };

  const updateHubHoverFromPointer = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const hub =
      target.closest<HTMLElement>(".builder-hub") ??
      target.closest<HTMLElement>(".builder-entity--hub")?.querySelector<HTMLElement>(".builder-hub") ??
      null;
    if (!hub || target.closest("button")) {
      clearHubHover(hoveredHubEl);
      hoveredHubEl = null;
      return;
    }
    if (hoveredHubEl && hoveredHubEl !== hub) {
      clearHubHover(hoveredHubEl);
    }
    hoveredHubEl = hub;
    const r = hub.getBoundingClientRect();
    const localX = ev.clientX - r.left;
    const localY = ev.clientY - r.top;
    const faceRaw = Number.parseFloat(hub.dataset.faceAngle ?? "0");
    const face = (((Number.isFinite(faceRaw) ? faceRaw : 0) % 360) + 360) % 360;
    const mode = hubPointerMode(localX, localY, face);
    hub.classList.toggle("builder-hub--hover-move", mode === "move");
    hub.classList.toggle("builder-hub--hover-rotate", mode === "rotate");
    const hubEntity = hub.closest<HTMLElement>(".builder-entity--hub");
    if (hubEntity) {
      hubEntity.classList.toggle("builder-hub--hover-move", mode === "move");
      hubEntity.classList.toggle("builder-hub--hover-rotate", mode === "rotate");
    }
  };

  const clearRelayHover = (relay: HTMLElement | null): void => {
    if (!relay) return;
    relay.classList.remove("builder-relay--hover-rotate");
  };

  const updateRelayHoverFromPointer = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target || target.closest("button")) {
      clearRelayHover(hoveredRelayEl);
      hoveredRelayEl = null;
      return;
    }
    const relay = target.closest<HTMLElement>(".builder-entity--relay");
    if (!relay) {
      clearRelayHover(hoveredRelayEl);
      hoveredRelayEl = null;
      return;
    }
    if (hoveredRelayEl && hoveredRelayEl !== relay) {
      clearRelayHover(hoveredRelayEl);
    }
    hoveredRelayEl = relay;
    const outerRect = relay.getBoundingClientRect();
    const coreEl = relay.querySelector<HTMLElement>(".builder-relay-core");
    if (!coreEl) {
      clearRelayHover(hoveredRelayEl);
      hoveredRelayEl = null;
      return;
    }
    const coreRect = coreEl.getBoundingClientRect();
    const localX = ev.clientX - outerRect.left;
    const localY = ev.clientY - outerRect.top;
    const mode = relayPointerMode(
      localX,
      localY,
      outerRect.width,
      outerRect.height,
      coreRect.left - outerRect.left,
      coreRect.top - outerRect.top,
      coreRect.width,
      coreRect.height,
    );
    relay.classList.toggle("builder-relay--hover-rotate", mode === "rotate");
  };

  const builderRotateDragChrome = (shouldUpdateWiresDuringDrag: boolean): RotateDragChrome => ({
    shouldUpdateWiresDuringDrag,
    scheduleWireOverlayIfDragging: () => {
      if (shouldUpdateWiresDuringDrag) {
        wireBag.w!.scheduleWireOverlayRender();
      }
    },
    scheduleWireOverlayIfIdle: () => {
      if (shouldUpdateWiresDuringDrag) {
        wireBag.w!.scheduleWireOverlayRender();
      }
    },
    clearBuilderDragCursor,
    schedulePersist,
    renderInspector,
    setBuilderDragCursor,
    clearDragRenderRaf: () => {
      if (dragEntityPatchRaf !== null) {
        window.cancelAnimationFrame(dragEntityPatchRaf);
        dragEntityPatchRaf = null;
      }
      pendingDragEntityPatchRootIds.clear();
    },
  });

  const finalizeEntityGroupMovePointerUp = (
    up: MouseEvent,
    ctx: {
      movingRootIds: string[];
      primaryRootId: string;
      didModifierCopy: boolean;
      didMove: boolean;
      preCopyState: BuilderState;
      preCopySelection: Set<string>;
      shouldUpdateWiresDuringDrag: boolean;
    },
  ): void => {
    const droppedInDeleteZone = isPointInDeleteDropZone(up.clientX, up.clientY);
    setDeleteDropZoneActive(false);
    let entityPatchFlushIds: Set<string> | null = null;
    if (dragEntityPatchRaf !== null) {
      window.cancelAnimationFrame(dragEntityPatchRaf);
      dragEntityPatchRaf = null;
      entityPatchFlushIds = new Set(pendingDragEntityPatchRootIds);
    }
    pendingDragEntityPatchRootIds.clear();
    clearBuilderDragCursor();
    if (droppedInDeleteZone) {
      hideDragGroupBounds();
      wireBag.w!.endEntityWireDrag();
      deleteEntityRootIds(ctx.movingRootIds);
      return;
    }
    if (ctx.didModifierCopy && !ctx.didMove) {
      wireBag.w!.endEntityWireDrag();
      state = ctx.preCopyState;
      const next = new Set(ctx.preCopySelection);
      if (next.has(ctx.primaryRootId)) next.delete(ctx.primaryRootId);
      else next.add(ctx.primaryRootId);
      setEntitySelectionSet(next);
      return;
    }
    hideDragGroupBounds();
    let overlayRedrawn = false;
    if (entityPatchFlushIds && entityPatchFlushIds.size > 0) {
      overlayRedrawn = syncEntityDomForRoots(entityPatchFlushIds, true);
    }
    if (ctx.shouldUpdateWiresDuringDrag) {
      if (!overlayRedrawn) {
        overlayRedrawn = wireBag.w!.refreshWireOverlayAfterEntityPatch(new Set(), {
          syncEntityWirePartial: true,
        });
      }
    }
    wireBag.w!.endEntityWireDrag();
    schedulePersist();
    renderInspector();
  };

  const startEntityDragFromElement = (entityEl: HTMLElement, ev: MouseEvent): void => {
    const target = ev.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>("button");
    if (btn) {
      const isControl = btn.matches(".builder-hub-reverse,.builder-cycle-btn[data-setting-cycle],.builder-mask-arrow");
      // Never start entity drag from ports; ports are reserved for link dragging.
      if (!isControl || btn.classList.contains("builder-port")) return;
    }
    if (wireBag.w!.builderPortFromClientPoint(ev.clientX, ev.clientY)) return;
    const rootId = entityEl.dataset.rootId!;
    const rootEnt = state.entities.find((e) => e.id === rootId);
    const seg = entityEl.closest<HTMLElement>(".builder-segment");
    if (!rootEnt || !seg) return;
    hideFilterTooltip();
    if (isStaticOuterLeafEndpoint(rootEnt)) return;
    if (
      tryStartTextEntityResizeDrag({
        ev,
        entityEl,
        rootEnt,
        seg,
        gridTileXPx: BUILDER_GRID_TILE_SIZE_X_PX,
        gridTileYPx: BUILDER_GRID_TILE_SIZE_Y_PX,
        segmentEntitiesHost,
        textTileSizeFromEntity,
        setEntityDomPosition,
        setTextEntitySizeDom,
        scheduleWireOverlayRender: () => wireBag.w!.scheduleWireOverlayRender(),
        clearBuilderDragCursor,
        schedulePersist,
        renderInspector,
        setBuilderDragCursor,
        mutateTextEntityIfChanged: (rootId, p) => {
          const ent = state.entities.find((e) => e.id === rootId);
          if (!ent || ent.templateType !== "text") return false;
          if (
            ent.x === p.x &&
            ent.y === p.y &&
            textTileSizeFromEntity(ent).wTiles === p.widthTiles &&
            textTileSizeFromEntity(ent).hTiles === p.heightTiles
          ) {
            return false;
          }
          ent.x = p.x;
          ent.y = p.y;
          ent.settings = {
            ...ent.settings,
            widthTiles: String(p.widthTiles),
            heightTiles: String(p.heightTiles),
          };
          return true;
        },
      })
    ) {
      return;
    }
    let movingRootIds = selectedEntityIdsForAction(rootEnt.id)
      .filter((id) => {
        const e = state.entities.find((x) => x.id === id);
        return !!e && !isStaticOuterLeafEndpoint(e);
      });
    let rootDragId = rootEnt.id;
    if (rootEnt.templateType === "relay") {
      const relayRect = entityEl.getBoundingClientRect();
      const coreEl = entityEl.querySelector<HTMLElement>(".builder-relay-core");
      if (!coreEl) return;
      const coreRect = coreEl.getBoundingClientRect();
      const localX = ev.clientX - relayRect.left;
      const localY = ev.clientY - relayRect.top;
      const mode = relayPointerMode(
        localX,
        localY,
        relayRect.width,
        relayRect.height,
        coreRect.left - relayRect.left,
        coreRect.top - relayRect.top,
        coreRect.width,
        coreRect.height,
      );
      if (mode === "none") return;
      if (mode === "rotate") {
        const rotatingRootIds = selectedEntityIdsForAction(rootEnt.id).filter((id) => {
          const e = state.entities.find((x) => x.id === id);
          return e?.templateType === "relay";
        });
        const shouldUpdateWiresDuringDrag = entityIdsHaveLinks(rotatingRootIds);
        startRelayRotateDrag({
          ev,
          entityEl,
          rotatingRootIds,
          readBaseAngleDeg: (rootId) => {
            const ent = state.entities.find((x) => x.id === rootId);
            const raw = Number.parseFloat(ent?.settings.angle ?? "0");
            return ((Number.isFinite(raw) ? raw : 0) % 360 + 360) % 360;
          },
          writeAngleDeg: (rootId, newDeg) => {
            const cur = state.entities.find((e) => e.id === rootId);
            if (!cur) return;
            state = updateEntitySettings(state, cur.id, { ...cur.settings, angle: String(newDeg) });
            setRelayAngleDom(cur.id, newDeg);
          },
          chrome: builderRotateDragChrome(shouldUpdateWiresDuringDrag),
        });
        return;
      }
    }
    if (rootEnt.templateType === "hub") {
      const hubEl = entityEl.querySelector<HTMLElement>(".builder-hub");
      if (!hubEl) return;
      const r0 = hubEl.getBoundingClientRect();
      const localX = ev.clientX - r0.left;
      const localY = ev.clientY - r0.top;
      const faceDeg = ((Number.parseFloat(rootEnt.settings.faceAngle ?? "0") % 360) + 360) % 360;
      const hubMode = hubPointerMode(localX, localY, faceDeg);
      if (hubMode === "none") return;
      if (!selectedEntityRootIds.has(rootEnt.id) && !ev.shiftKey && !ev.ctrlKey) {
        setSelection({ kind: "entity", rootId: rootEnt.id });
      }
      ev.preventDefault();
      if (hubMode === "move") {
        let shouldUpdateWiresDuringDrag = entityIdsHaveLinks(movingRootIds);
        const preCopyState = state;
        const preCopySelection = new Set(selectedEntityRootIds);
        let didMove = false;
        let didModifierCopy = false;
        if (ev.ctrlKey || ev.shiftKey) {
          const idMap = createCopiedGroupInPlace(movingRootIds);
          const copiedIds = Array.from(idMap.values());
          if (!copiedIds.length) return;
          movingRootIds = copiedIds;
          rootDragId = idMap.get(rootEnt.id) ?? rootEnt.id;
          setEntitySelectionSet(new Set(movingRootIds));
          shouldUpdateWiresDuringDrag = entityIdsHaveLinks(movingRootIds);
          didModifierCopy = true;
        }
        const rootDragEnt = state.entities.find((e) => e.id === rootDragId);
        if (!rootDragEnt) return;
        const initialPlacementById = new Map<string, { layer: BuilderLayer; segment: number; x: number; y: number }>();
        movingRootIds.forEach((id) => {
          const e = state.entities.find((x) => x.id === id);
          if (!e) return;
          initialPlacementById.set(id, { layer: e.layer, segment: e.segmentIndex, x: e.x, y: e.y });
        });
        const layerOrder = orderedLayersTopDown();
        const rootInitialLayerIdx = Math.max(0, layerOrder.indexOf(rootDragEnt.layer));
        const rootInitialSegment = rootDragEnt.segmentIndex;
        const boundsCache = new Map<string, { maxX: number; maxY: number }>();
        const boundsFor = (layer: BuilderLayer, segment: number): { maxX: number; maxY: number } => {
          const key = `${layer}:${segment}`;
          const cached = boundsCache.get(key);
          if (cached) return cached;
          const host = segmentEntitiesHost(layer, segment);
          const w = Math.max(1, host?.clientWidth ?? 1);
          const h = Math.max(1, host?.clientHeight ?? 1);
          const next = {
            maxX: Math.max(0, Math.floor(w / BUILDER_GRID_TILE_SIZE_X_PX) - 1),
            maxY: Math.max(0, Math.floor(h / BUILDER_GRID_TILE_SIZE_Y_PX) - 1),
          };
          boundsCache.set(key, next);
          return next;
        };
        const clampToRange = (value: number, min: number, max: number): number =>
          Math.max(min, Math.min(max, value));
        const buildGroupPlacements = (
          section: { layer: BuilderLayer; segment: number },
          primaryX: number,
          primaryY: number,
        ): Map<string, DragPlacement> => {
          const placements = new Map<string, DragPlacement>();
          const primaryInitial = initialPlacementById.get(rootDragEnt.id) ?? {
            layer: rootDragEnt.layer,
            segment: rootDragEnt.segmentIndex,
            x: rootDragEnt.x,
            y: rootDragEnt.y,
          };
          const rawLayerDelta = layerOrder.indexOf(section.layer) - rootInitialLayerIdx;
          let minLayerDelta = -Infinity;
          let maxLayerDelta = Infinity;
          movingRootIds.forEach((id) => {
            const p0 = initialPlacementById.get(id);
            if (!p0) return;
            const idx = layerOrder.indexOf(p0.layer);
            minLayerDelta = Math.max(minLayerDelta, -idx);
            maxLayerDelta = Math.min(maxLayerDelta, layerOrder.length - 1 - idx);
          });
          if (minLayerDelta > maxLayerDelta) {
            return placements;
          }
          const layerDelta = clampToRange(rawLayerDelta, minLayerDelta, maxLayerDelta);
          const targetById = new Map<string, { p0: { layer: BuilderLayer; segment: number; x: number; y: number }; layer: BuilderLayer; segment: number }>();
          let minSegmentDelta = -Infinity;
          let maxSegmentDelta = Infinity;
          movingRootIds.forEach((id) => {
            const p0 = initialPlacementById.get(id);
            if (!p0) return;
            const baseLayerIdx = layerOrder.indexOf(p0.layer);
            const targetLayer = layerOrder[baseLayerIdx + layerDelta]!;
            const layerMaxSegment = layerColumns(targetLayer).length - 1;
            minSegmentDelta = Math.max(minSegmentDelta, -p0.segment);
            maxSegmentDelta = Math.min(maxSegmentDelta, layerMaxSegment - p0.segment);
            targetById.set(id, { p0, layer: targetLayer, segment: p0.segment });
          });
          const rawSegmentDelta = section.segment - rootInitialSegment;
          const segmentDelta = clampToRange(rawSegmentDelta, minSegmentDelta, maxSegmentDelta);
          if (minSegmentDelta > maxSegmentDelta) {
            return placements;
          }
          let minFootprintLeftX = Infinity;
          let minFootprintTopY = Infinity;
          targetById.forEach((t, id) => {
            const targetSegment = t.p0.segment + segmentDelta;
            t.segment = targetSegment;
            const ent = state.entities.find((e) => e.id === id);
            if (!ent) {
              minFootprintLeftX = Infinity;
              minFootprintTopY = Infinity;
              return;
            }
            const fp = entityFootprintOffsets(ent);
            minFootprintLeftX = Math.min(minFootprintLeftX, t.p0.x + fp.left);
            minFootprintTopY = Math.min(minFootprintTopY, t.p0.y + fp.top);
          });
          if (!Number.isFinite(minFootprintLeftX) || !Number.isFinite(minFootprintTopY)) {
            return placements;
          }
          const rootTarget = targetById.get(rootDragEnt.id);
          if (!rootTarget) return placements;
          const rootBounds = boundsFor(rootTarget.layer, rootTarget.segment);
          const minDx = -minFootprintLeftX;
          const maxDx = rootBounds.maxX - minFootprintLeftX;
          const minDy = -minFootprintTopY;
          const maxDy = rootBounds.maxY - minFootprintTopY;
          if (minDx > maxDx || minDy > maxDy) return placements;
          const dxGrid = clampToRange(primaryX - primaryInitial.x, minDx, maxDx);
          const dyGrid = clampToRange(primaryY - primaryInitial.y, minDy, maxDy);
          targetById.forEach((t, id) => {
            placements.set(id, {
              layer: t.layer,
              segment: t.segment,
              x: t.p0.x + dxGrid,
              y: t.p0.y + dyGrid,
            });
          });
          return placements;
        };
        const initialSection = segmentFromClientPoint(ev.clientX, ev.clientY);
        const initialHost =
          initialSection?.host ?? segmentEntitiesHost(rootDragEnt.layer, rootDragEnt.segmentIndex) ?? seg;
        const initialRect = initialSection?.rect ?? initialHost.getBoundingClientRect();
        const anchorX = (ev.clientX - initialRect.left) / BUILDER_GRID_TILE_SIZE_X_PX;
        const anchorY = (ev.clientY - initialRect.top) / BUILDER_GRID_TILE_SIZE_Y_PX;
        const rx = rootDragEnt.x;
        const ry = rootDragEnt.y;
        const dx = anchorX - rx;
        const dy = anchorY - ry;
        let lastX = rx;
        let lastY = ry;
        let lastLayer = rootEnt.layer;
        let lastSegment = rootEnt.segmentIndex;
        const onMove = (mv: MouseEvent): void => {
          const overDeleteZone = isPointInDeleteDropZone(mv.clientX, mv.clientY);
          setDeleteDropZoneActive(overDeleteZone);
          if (overDeleteZone) return;
          const hoveredSection = segmentFromClientPoint(mv.clientX, mv.clientY);
          if (!hoveredSection) return;
          const section = hoveredSection;
          const rawX = (mv.clientX - section.rect.left) / BUILDER_GRID_TILE_SIZE_X_PX - dx;
          const rawY = (mv.clientY - section.rect.top) / BUILDER_GRID_TILE_SIZE_Y_PX - dy;
          const clamped = clampGridToSectionBounds(
            Math.round(rawX),
            Math.round(rawY),
            section.widthPx,
            section.heightPx,
          );
          const x = clamped.x;
          const y = clamped.y;
          const placements = buildGroupPlacements(section, x, y);
          const rootPlacement = placements.get(rootDragEnt.id);
          if (!rootPlacement) return;
          if (hasPlacementMapConflicts(placements)) return;
          if (
            rootPlacement.x === lastX &&
            rootPlacement.y === lastY &&
            rootPlacement.layer === lastLayer &&
            rootPlacement.segment === lastSegment
          ) {
            return;
          }
          if (didModifierCopy && !didMove) {
            syncEntityDomForRoots(new Set(movingRootIds));
          }
          lastX = rootPlacement.x;
          lastY = rootPlacement.y;
          lastLayer = rootPlacement.layer;
          lastSegment = rootPlacement.segment;
          const entityDomPatchRootIds = new Set<string>();
          placements.forEach((nextPlacement, id) => {
            const p0 = initialPlacementById.get(id);
            if (!p0) return;
            const nx = nextPlacement.x;
            const ny = nextPlacement.y;
            const targetLayer = nextPlacement.layer;
            const targetSegment = nextPlacement.segment;
            const cur = state.entities.find((e) => e.id === id);
            if (!cur) return;
            if (cur.layer !== targetLayer) {
              setEntityPlacementDuringDrag(id, targetLayer, targetSegment, nx, ny);
              entityDomPatchRootIds.add(id);
            } else if (cur.segmentIndex !== targetSegment) {
              const needsRebuild = segmentTransitionChangesMirrorMembership(
                targetLayer,
                cur.segmentIndex,
                targetSegment,
              );
              setEntityPlacementDuringDrag(id, targetLayer, targetSegment, nx, ny);
              if (needsRebuild) {
                entityDomPatchRootIds.add(id);
              } else {
                setEntityDomPosition(id, nx, ny);
              }
            } else {
              setEntityPositionDuringDrag(id, nx, ny);
              setEntityDomPosition(id, nx, ny);
            }
          });
          if (entityDomPatchRootIds.size > 0) {
            scheduleDragEntityPatch(entityDomPatchRootIds);
          }
          didMove = true;
          showDragGroupBounds(movingRootIds);
          if (shouldUpdateWiresDuringDrag) {
            wireBag.w!.beginEntityWireDrag(movingRootIds, rootDragEnt.id);
            wireBag.w!.scheduleEntityWireDragPartial();
          }
        };
        const onUp = (up: MouseEvent): void => {
          finalizeEntityGroupMovePointerUp(up, {
            movingRootIds,
            primaryRootId: rootEnt.id,
            didModifierCopy,
            didMove,
            preCopyState,
            preCopySelection,
            shouldUpdateWiresDuringDrag,
          });
        };
        setBuilderDragCursor("grabbing");
        capturePrimaryDragOnWindow(ev, { onMove, onEnd: onUp });
        return;
      }
      const px = r0.left + (HUB_LAYOUT.G.x / HUB_VIEW.w) * r0.width;
      const py = r0.top + (HUB_LAYOUT.G.y / HUB_VIEW.h) * r0.height;
      const rotatingHubRootIds = selectedEntityIdsForAction(rootEnt.id).filter((id) => {
        const e = state.entities.find((x) => x.id === id);
        return e?.templateType === "hub";
      });
      const hubRotateWireDrag = entityIdsHaveLinks(rotatingHubRootIds);
      startSnappedRotateDragAroundPivot({
        ev,
        pivotClientX: px,
        pivotClientY: py,
        snapDegrees: 30,
        rotatingRootIds: rotatingHubRootIds,
        readAngleDeg: (rid) => {
          const ent = state.entities.find((x) => x.id === rid);
          const raw = Number.parseFloat(ent?.settings.faceAngle ?? "0");
          return ((Number.isFinite(raw) ? raw : 0) % 360 + 360) % 360;
        },
        writeAngleDeg: (rid, newDeg) => {
          const cur = state.entities.find((e) => e.id === rid);
          if (!cur) return;
          state = updateEntitySettings(state, cur.id, { ...cur.settings, faceAngle: String(newDeg) });
          setHubFaceAngleDom(cur.id, newDeg);
        },
        chrome: builderRotateDragChrome(hubRotateWireDrag),
      });
      return;
    }
    ev.preventDefault();
    const entitiesHost =
      seg.querySelector<HTMLElement>(".builder-segment-entities") ?? seg;
    const segRect = entitiesHost.getBoundingClientRect();
    const anchorX = (ev.clientX - segRect.left) / BUILDER_GRID_TILE_SIZE_X_PX;
    const anchorY = (ev.clientY - segRect.top) / BUILDER_GRID_TILE_SIZE_Y_PX;
    let shouldUpdateWiresDuringDrag = entityIdsHaveLinks(movingRootIds);
    const preCopyState = state;
    const preCopySelection = new Set(selectedEntityRootIds);
    let didMove = false;
    let didModifierCopy = false;
    if (ev.ctrlKey || ev.shiftKey) {
      const idMap = createCopiedGroupInPlace(movingRootIds);
      const copiedIds = Array.from(idMap.values());
      if (!copiedIds.length) return;
      movingRootIds = copiedIds;
      rootDragId = idMap.get(rootEnt.id) ?? rootEnt.id;
      setEntitySelectionSet(new Set(movingRootIds));
      shouldUpdateWiresDuringDrag = entityIdsHaveLinks(movingRootIds);
      didModifierCopy = true;
    }
    const rootDragEnt = state.entities.find((e) => e.id === rootDragId);
    if (!rootDragEnt) return;
    const initialPlacementById = new Map<string, { layer: BuilderLayer; segment: number; x: number; y: number }>();
    movingRootIds.forEach((id) => {
      const e = state.entities.find((x) => x.id === id);
      if (!e) return;
      initialPlacementById.set(id, { layer: e.layer, segment: e.segmentIndex, x: e.x, y: e.y });
    });
    const layerOrder = orderedLayersTopDown();
    const rootInitialLayerIdx = Math.max(0, layerOrder.indexOf(rootDragEnt.layer));
    const rootInitialSegment = rootDragEnt.segmentIndex;
    const boundsCache = new Map<string, { maxX: number; maxY: number }>();
    const boundsFor = (layer: BuilderLayer, segment: number): { maxX: number; maxY: number } => {
      const key = `${layer}:${segment}`;
      const cached = boundsCache.get(key);
      if (cached) return cached;
      const host = segmentEntitiesHost(layer, segment);
      const w = Math.max(1, host?.clientWidth ?? 1);
      const h = Math.max(1, host?.clientHeight ?? 1);
      const next = {
        maxX: Math.max(0, Math.floor(w / BUILDER_GRID_TILE_SIZE_X_PX) - 1),
        maxY: Math.max(0, Math.floor(h / BUILDER_GRID_TILE_SIZE_Y_PX) - 1),
      };
      boundsCache.set(key, next);
      return next;
    };
    const clampToRange = (value: number, min: number, max: number): number =>
      Math.max(min, Math.min(max, value));
    const buildGroupPlacements = (
      section: { layer: BuilderLayer; segment: number },
      primaryX: number,
      primaryY: number,
    ): Map<string, DragPlacement> => {
      const placements = new Map<string, DragPlacement>();
      const primaryInitial = initialPlacementById.get(rootDragEnt.id) ?? {
        layer: rootDragEnt.layer,
        segment: rootDragEnt.segmentIndex,
        x: rootDragEnt.x,
        y: rootDragEnt.y,
      };
      const rawLayerDelta = layerOrder.indexOf(section.layer) - rootInitialLayerIdx;
      let minLayerDelta = -Infinity;
      let maxLayerDelta = Infinity;
      movingRootIds.forEach((id) => {
        const p0 = initialPlacementById.get(id);
        if (!p0) return;
        const idx = layerOrder.indexOf(p0.layer);
        minLayerDelta = Math.max(minLayerDelta, -idx);
        maxLayerDelta = Math.min(maxLayerDelta, layerOrder.length - 1 - idx);
      });
      if (minLayerDelta > maxLayerDelta) {
        return placements;
      }
      const layerDelta = clampToRange(rawLayerDelta, minLayerDelta, maxLayerDelta);
      const targetById = new Map<string, { p0: { layer: BuilderLayer; segment: number; x: number; y: number }; layer: BuilderLayer; segment: number }>();
      let minSegmentDelta = -Infinity;
      let maxSegmentDelta = Infinity;
      movingRootIds.forEach((id) => {
        const p0 = initialPlacementById.get(id);
        if (!p0) return;
        const baseLayerIdx = layerOrder.indexOf(p0.layer);
        const targetLayer = layerOrder[baseLayerIdx + layerDelta]!;
        const layerMaxSegment = layerColumns(targetLayer).length - 1;
        minSegmentDelta = Math.max(minSegmentDelta, -p0.segment);
        maxSegmentDelta = Math.min(maxSegmentDelta, layerMaxSegment - p0.segment);
        targetById.set(id, { p0, layer: targetLayer, segment: p0.segment });
      });
      const rawSegmentDelta = section.segment - rootInitialSegment;
      const segmentDelta = clampToRange(rawSegmentDelta, minSegmentDelta, maxSegmentDelta);
      if (minSegmentDelta > maxSegmentDelta) {
        return placements;
      }
      let minFootprintLeftX = Infinity;
      let minFootprintTopY = Infinity;
      targetById.forEach((t, id) => {
        const targetSegment = t.p0.segment + segmentDelta;
        t.segment = targetSegment;
        const ent = state.entities.find((e) => e.id === id);
        if (!ent) {
          minFootprintLeftX = Infinity;
          minFootprintTopY = Infinity;
          return;
        }
        const fp = entityFootprintOffsets(ent);
        minFootprintLeftX = Math.min(minFootprintLeftX, t.p0.x + fp.left);
        minFootprintTopY = Math.min(minFootprintTopY, t.p0.y + fp.top);
      });
      if (!Number.isFinite(minFootprintLeftX) || !Number.isFinite(minFootprintTopY)) {
        return placements;
      }
      const rootTarget = targetById.get(rootDragEnt.id);
      if (!rootTarget) return placements;
      const rootBounds = boundsFor(rootTarget.layer, rootTarget.segment);
      const minDx = -minFootprintLeftX;
      const maxDx = rootBounds.maxX - minFootprintLeftX;
      const minDy = -minFootprintTopY;
      const maxDy = rootBounds.maxY - minFootprintTopY;
      if (minDx > maxDx || minDy > maxDy) return placements;
      const dxGrid = clampToRange(primaryX - primaryInitial.x, minDx, maxDx);
      const dyGrid = clampToRange(primaryY - primaryInitial.y, minDy, maxDy);
      targetById.forEach((t, id) => {
        placements.set(id, {
          layer: t.layer,
          segment: t.segment,
          x: t.p0.x + dxGrid,
          y: t.p0.y + dyGrid,
        });
      });
      return placements;
    };
    const dx = anchorX - rootDragEnt.x;
    const dy = anchorY - rootDragEnt.y;
    let lastX = rootDragEnt.x;
    let lastY = rootDragEnt.y;
    let lastLayer = rootDragEnt.layer;
    let lastSegment = rootDragEnt.segmentIndex;
    const onMove = (mv: MouseEvent): void => {
      const overDeleteZone = isPointInDeleteDropZone(mv.clientX, mv.clientY);
      setDeleteDropZoneActive(overDeleteZone);
      if (overDeleteZone) return;
      const hoveredSection = segmentFromClientPoint(mv.clientX, mv.clientY);
      if (!hoveredSection) return;
      const section = hoveredSection;
      const rawX = (mv.clientX - section.rect.left) / BUILDER_GRID_TILE_SIZE_X_PX - dx;
      const rawY = (mv.clientY - section.rect.top) / BUILDER_GRID_TILE_SIZE_Y_PX - dy;
      const clamped = clampGridToSectionBounds(
        Math.round(rawX),
        Math.round(rawY),
        section.widthPx,
        section.heightPx,
      );
      const x = clamped.x;
      const y = clamped.y;
      const placements = buildGroupPlacements(section, x, y);
      const rootPlacement = placements.get(rootDragEnt.id);
      if (!rootPlacement) return;
      if (hasPlacementMapConflicts(placements)) return;
      if (
        rootPlacement.x === lastX &&
        rootPlacement.y === lastY &&
        rootPlacement.layer === lastLayer &&
        rootPlacement.segment === lastSegment
      ) {
        return;
      }
      if (didModifierCopy && !didMove) {
        syncEntityDomForRoots(new Set(movingRootIds));
      }
      lastX = rootPlacement.x;
      lastY = rootPlacement.y;
      lastLayer = rootPlacement.layer;
      lastSegment = rootPlacement.segment;
      const entityDomPatchRootIds = new Set<string>();
      placements.forEach((nextPlacement, id) => {
        const p0 = initialPlacementById.get(id);
        if (!p0) return;
        const nx = nextPlacement.x;
        const ny = nextPlacement.y;
        const targetLayer = nextPlacement.layer;
        const targetSegment = nextPlacement.segment;
        const cur = state.entities.find((e) => e.id === id);
        if (!cur) return;
        if (cur.layer !== targetLayer) {
          setEntityPlacementDuringDrag(id, targetLayer, targetSegment, nx, ny);
          entityDomPatchRootIds.add(id);
        } else if (cur.segmentIndex !== targetSegment) {
          const needsRebuild = segmentTransitionChangesMirrorMembership(
            targetLayer,
            cur.segmentIndex,
            targetSegment,
          );
          setEntityPlacementDuringDrag(id, targetLayer, targetSegment, nx, ny);
          if (needsRebuild) {
            entityDomPatchRootIds.add(id);
          } else {
            setEntityDomPosition(id, nx, ny);
          }
        } else {
          setEntityPositionDuringDrag(id, nx, ny);
          setEntityDomPosition(id, nx, ny);
        }
      });
      if (entityDomPatchRootIds.size > 0) {
        scheduleDragEntityPatch(entityDomPatchRootIds);
      }
      didMove = true;
      showDragGroupBounds(movingRootIds);
      if (shouldUpdateWiresDuringDrag) {
        wireBag.w!.beginEntityWireDrag(movingRootIds, rootDragEnt.id);
        wireBag.w!.scheduleEntityWireDragPartial();
      }
    };
    const onUp = (up: MouseEvent): void => {
      finalizeEntityGroupMovePointerUp(up, {
        movingRootIds,
        primaryRootId: rootEnt.id,
        didModifierCopy,
        didMove,
        preCopyState,
        preCopySelection,
        shouldUpdateWiresDuringDrag,
      });
    };
    setBuilderDragCursor("grabbing");
    capturePrimaryDragOnWindow(ev, { onMove, onEnd: onUp });
  };

  function renderCanvas(): void {
    wireBag.w!.notifyCanvasDomRebuilt();
    hideFilterTooltip();
    const t0 = performance.now();
    const tExpand0 = performance.now();
    const expanded = expandBuilderState(state, { builderView: true });
    const tExpand1 = performance.now();
    recordPerf("canvas.expand", tExpand1 - tExpand0);
    perfCounts.expandedEntities = expanded.entities.length;
    const tBucket0 = performance.now();
    const entitiesByLayerSegment = new Map<string, typeof expanded.entities>();
    expanded.entities.forEach((entity) => {
      const key =
        entity.layer === "outer64" && isOuterLeafVoidSegment(entity.segmentIndex)
          ? OUTER_CANVAS_VOID_MERGE_KEY
          : `${entity.layer}:${entity.segmentIndex}`;
      if (!entitiesByLayerSegment.has(key)) entitiesByLayerSegment.set(key, []);
      entitiesByLayerSegment.get(key)!.push(entity);
    });
    const staticRootIds = new Set(
      state.entities.filter((e) => isStaticOuterLeafEndpoint(e)).map((e) => e.id),
    );
    entitiesByLayerSegment.forEach((list) => {
      list.sort((a, b) => {
        const aS = a.templateType === "endpoint" && a.layer === "outer64" && staticRootIds.has(a.rootId) ? 1 : 0;
        const bS = b.templateType === "endpoint" && b.layer === "outer64" && staticRootIds.has(b.rootId) ? 1 : 0;
        return aS - bS;
      });
    });
    recordPerf("canvas.bucketSort", performance.now() - tBucket0);

    const tHtml0 = performance.now();
    canvasEl.innerHTML = orderedLayersTopDown()
      .map((layer) => {
        const columns = layer === "outer64" ? outerLayerBuilderColumnSlots() : layerColumns(layer);
        return `
          <section class="builder-layer builder-layer-section-${layer}">
            <div class="builder-layer-grid builder-layer-${layer}" data-layer="${layer}">
              ${columns
                .map((segment) => {
                  const isOuterVoid = layer === "outer64" && segment === "void-12-15";
                  const key = isOuterVoid
                    ? OUTER_CANVAS_VOID_MERGE_KEY
                    : `${layer}:${segment as number}`;
                  const entities = entitiesByLayerSegment.get(key) ?? [];
                  return `
                    <div class="builder-segment ${
                      isOuterVoid ? "builder-segment--outer-void-merged" : ""
                    }" data-layer="${layer}" data-segment="${isOuterVoid ? "12-15" : String(segment)}"${
                      isOuterVoid ? ` data-void-outer="1"` : ""
                    }>
                      <div class="builder-segment-label">${
                        isOuterVoid
                          ? "0.0.3.*"
                          : segmentLabel(layer, segment as number)
                      }</div>
                      <div class="builder-segment-entities">
                        ${entities
                          .map((entity) =>
                            buildBuilderEntityInstanceHtml(entity, {
                              gridTileXPx: BUILDER_GRID_TILE_SIZE_X_PX,
                              gridTileYPx: BUILDER_GRID_TILE_SIZE_Y_PX,
                              staticRootIds,
                              selectedEntityRootId: selection?.kind === "entity" ? selection.rootId : null,
                              simTickCollisionDropEntityInstanceIds,
                              simTickCollisionDropEntityRootIds,
                              simTickDeliveredEntityRootIds,
                            }),
                          )
                          .join("")}
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </section>
        `;
      })
      .join("");
    const tHtml1 = performance.now();
    recordPerf("canvas.htmlBuild", tHtml1 - tHtml0);
    canvasEl.querySelectorAll<HTMLTextAreaElement>(".builder-note-editor[data-note-root-id]").forEach((editor) => {
      editor.addEventListener("input", () => {
        const rootId = editor.dataset.noteRootId;
        if (!rootId) return;
        const ent = state.entities.find((e) => e.id === rootId);
        if (!ent || ent.templateType !== "text") return;
        const nextLabel = editor.value;
        if ((ent.settings.label ?? "") === nextLabel) return;
        state = updateEntitySettings(state, ent.id, { ...ent.settings, label: nextLabel });
        schedulePersist();
      });
    });
    const tCache0 = performance.now();
    wireBag.w!.rebuildPortElementCache();
    const tCache1 = performance.now();
    recordPerf("canvas.portCache", tCache1 - tCache0);
    recordPerf("canvas.domCommit", tCache1 - tHtml0);
    recordPerf("canvas.total", performance.now() - t0);
    renderPerfPanel();
    applySelectionToCanvas();
    applySimTickHighlightsToCanvas();

    // entity/port selection and link-drag start are delegated once (outside renderCanvas)

    // filter/hub controls are delegated once (outside renderCanvas)

    // entity drag + hub hover are delegated once (outside renderCanvas)

    requestAnimationFrame(() => {
      wireBag.w!.renderWireOverlay();
    });
  }

  function renderInspector(): void {}

  root.querySelectorAll<HTMLButtonElement>("[data-builder-panel-toggle]").forEach((toggleEl) => {
    toggleEl.addEventListener("click", () => {
      const sectionId = toggleEl.dataset.builderPanelToggle as BuilderPanelSectionId | undefined;
      if (!sectionId || !BUILDER_PANEL_SECTION_IDS.includes(sectionId)) return;
      setPanelSectionCollapsed(sectionId, toggleEl.getAttribute("aria-expanded") === "true");
    });
  });

  const deleteSelected = (): void => {
    if (!selection) return;
    if (selection.kind === "packet") {
      setSelection(null);
      return;
    }
    const removingLink = selection.kind === "link" && !selectedEntityRootIds.size;
    const removedEntityDomIds = new Set<string>();
    const groupIdsToRemove = new Set<string>();
    let wireGeometryChangedForRemovedEntities = true;
    if (selection.kind === "entity" || selectedEntityRootIds.size) {
      const ids = selectedEntityRootIds.size
        ? Array.from(selectedEntityRootIds)
        : selection.kind === "entity"
          ? [selection.rootId]
          : [];
      ids.forEach((id) => {
        const ent = state.entities.find((e) => e.id === id);
        if (ent && !isStaticOuterLeafEndpoint(ent)) {
          state.entities.filter((e) => e.groupId === ent.groupId).forEach((e) => removedEntityDomIds.add(e.id));
          groupIdsToRemove.add(ent.groupId);
        }
      });
      wireGeometryChangedForRemovedEntities =
        removedEntityDomIds.size > 0 &&
        state.links.some(
          (l) => removedEntityDomIds.has(l.fromEntityId) || removedEntityDomIds.has(l.toEntityId),
        );
      groupIdsToRemove.forEach((gid) => {
        state = removeEntityGroup(state, gid);
      });
    } else {
      state = removeLinkGroup(state, selection.rootId);
    }
    if (removingLink) {
      schedulePersist();
    } else {
      persist();
    }
    setSelection(null);
    if (removingLink) {
      applySelectionToCanvas();
      wireBag.w!.renderWireOverlay();
    } else {
      removeEntityDomForIds(removedEntityDomIds, wireGeometryChangedForRemovedEntities);
    }
  };

  const deleteEntityRootIds = (ids: string[]): void => {
    if (!ids.length) return;
    const removedEntityDomIds = new Set<string>();
    const groupIdsToRemove = new Set<string>();
    ids.forEach((id) => {
      const ent = state.entities.find((e) => e.id === id);
      if (ent && !isStaticOuterLeafEndpoint(ent)) {
        state.entities.filter((e) => e.groupId === ent.groupId).forEach((e) => removedEntityDomIds.add(e.id));
        groupIdsToRemove.add(ent.groupId);
      }
    });
    const wireGeometryChanged =
      removedEntityDomIds.size > 0 &&
      state.links.some((l) => removedEntityDomIds.has(l.fromEntityId) || removedEntityDomIds.has(l.toEntityId));
    let changed = false;
    groupIdsToRemove.forEach((gid) => {
      state = removeEntityGroup(state, gid);
      changed = true;
    });
    if (!changed) return;
    setSelection(null);
    persist();
    removeEntityDomForIds(removedEntityDomIds, wireGeometryChanged);
  };

  layoutSlotsEl.addEventListener("input", (ev) => {
    const input = (ev.target as HTMLElement | null)?.closest<HTMLInputElement>("[data-layout-slot-import-input]");
    if (!input) return;
    layoutImportText = input.value;
    const btn = layoutSlotsEl.querySelector<HTMLButtonElement>('[data-layout-slot-action="import-load"]');
    if (btn) {
      btn.disabled = layoutImportText.trim().length === 0;
    }
  });

  layoutSlotsEl.addEventListener("click", async (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-layout-slot-action]");
    if (!btn) return;
    const action = btn.dataset.layoutSlotAction ?? "";
    const slotRaw = btn.dataset.layoutSlot;
    const slotIndex = Number(slotRaw);
    if (action === "import-load") {
      const token = layoutTokenFromInput(layoutImportText);
      if (!token) {
        alert("Invalid layout URL/token.");
        return;
      }
      const parsed = await importBuilderStateUrlToken(token);
      if (!parsed) {
        alert("Invalid layout URL/token.");
        return;
      }
      urlEmbeddedLayoutState = parsed;
      urlEmbeddedLayoutToken = token;
      saveBuilderUrlLayoutSlot(token, parsed);
      builderPageState.activeLayoutKind = "url";
      persistBuilderPageState();
      pendingClearLayoutSlotIndex = null;
      pendingSaveCopyLayoutSlotIndex = null;
      activeLayoutTarget = { kind: "url" };
      applyLoadedBuilderState(parsed, false);
      return;
    }
    if (action === "load-url") {
      pendingClearLayoutSlotIndex = null;
      pendingSaveCopyLayoutSlotIndex = null;
      if (!urlEmbeddedLayoutState) return;
      builderPageState.activeLayoutKind = "url";
      persistBuilderPageState();
      activeLayoutTarget = { kind: "url" };
      applyLoadedBuilderState(urlEmbeddedLayoutState, false);
      return;
    }
    if (action === "url-url") {
      pendingClearLayoutSlotIndex = null;
      pendingSaveCopyLayoutSlotIndex = null;
      if (!urlEmbeddedLayoutState) return;
      await copyLayoutUrlForState(urlEmbeddedLayoutState);
      return;
    }
    if (action === "clear-url") {
      pendingClearLayoutSlotIndex = null;
      pendingSaveCopyLayoutSlotIndex = null;
      urlEmbeddedLayoutState = null;
      urlEmbeddedLayoutToken = null;
      clearBuilderUrlLayoutSlot();
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("layout");
      window.history.replaceState(null, "", nextUrl.toString());
      if (activeLayoutTarget.kind === "url") {
        const fallbackSlotIndex = Math.max(1, Math.min(BUILDER_LAYOUT_SLOT_COUNT, builderPageState.activeLayoutSlotIndex));
        builderPageState.activeLayoutKind = "slot";
        persistBuilderPageState();
        activeLayoutTarget = { kind: "slot", index: fallbackSlotIndex };
        const fallbackSlot = loadBuilderLayoutSlot(fallbackSlotIndex);
        if (fallbackSlot) {
          applyLoadedBuilderState(fallbackSlot.state, false);
        } else {
          applyLoadedBuilderState(createEmptyBuilderState(), false);
        }
      } else {
        renderLayoutSlots();
      }
      return;
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > BUILDER_LAYOUT_SLOT_COUNT) return;
    if (action === "save-copy") {
      pendingClearLayoutSlotIndex = null;
      const targetSlot = loadBuilderLayoutSlot(slotIndex);
      if (!targetSlot) {
        pendingSaveCopyLayoutSlotIndex = null;
        saveBuilderLayoutSlot(slotIndex, state);
        renderLayoutSlots();
        return;
      }
      if (pendingSaveCopyLayoutSlotIndex !== slotIndex) {
        pendingSaveCopyLayoutSlotIndex = slotIndex;
        renderLayoutSlots();
        return;
      }
      pendingSaveCopyLayoutSlotIndex = null;
      saveBuilderLayoutSlot(slotIndex, state);
      renderLayoutSlots();
      return;
    }
    if (action === "select") {
      pendingClearLayoutSlotIndex = null;
      pendingSaveCopyLayoutSlotIndex = null;
      activeLayoutTarget = { kind: "slot", index: slotIndex };
      builderPageState.activeLayoutSlotIndex = slotIndex;
      builderPageState.activeLayoutKind = "slot";
      persistBuilderPageState();
      const slot = loadBuilderLayoutSlot(slotIndex);
      if (slot) {
        applyLoadedBuilderState(slot.state, false);
      } else {
        applyLoadedBuilderState(createEmptyBuilderState(), false);
      }
      return;
    }
    if (action === "clear") {
      pendingSaveCopyLayoutSlotIndex = null;
      if (pendingClearLayoutSlotIndex !== slotIndex) {
        pendingClearLayoutSlotIndex = slotIndex;
        renderLayoutSlots();
        return;
      }
      pendingClearLayoutSlotIndex = null;
      clearBuilderLayoutSlot(slotIndex);
      if (activeLayoutTarget.kind === "slot" && activeLayoutTarget.index === slotIndex) {
        applyLoadedBuilderState(createEmptyBuilderState(), false);
        return;
      }
      renderLayoutSlots();
      return;
    }
    if (action === "url") {
      pendingClearLayoutSlotIndex = null;
      pendingSaveCopyLayoutSlotIndex = null;
      const slot = loadBuilderLayoutSlot(slotIndex);
      if (!slot) return;
      await copyLayoutUrlForState(slot.state);
    }
  });

  layoutSlotsEl.addEventListener("mouseout", (ev) => {
    if (pendingClearLayoutSlotIndex === null && pendingSaveCopyLayoutSlotIndex === null) return;
    const target = ev.target as HTMLElement | null;
    const actionBtn = target?.closest<HTMLButtonElement>('[data-layout-slot-action="clear"],[data-layout-slot-action="save-copy"]');
    if (!actionBtn) return;
    const slotIndex = Number(actionBtn.dataset.layoutSlot);
    if (!Number.isInteger(slotIndex)) return;
    const action = actionBtn.dataset.layoutSlotAction ?? "";
    if (action === "clear" && slotIndex !== pendingClearLayoutSlotIndex) return;
    if (action === "save-copy" && slotIndex !== pendingSaveCopyLayoutSlotIndex) return;
    const nextTarget = ev.relatedTarget as Node | null;
    if (nextTarget && actionBtn.contains(nextTarget)) return;
    if (action === "clear") {
      pendingClearLayoutSlotIndex = null;
    } else if (action === "save-copy") {
      pendingSaveCopyLayoutSlotIndex = null;
    }
    renderLayoutSlots();
  });

  packetOverlayEl.addEventListener("click", (ev) => {
    if (suppressNextPacketClick) {
      suppressNextPacketClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const el = t.closest("circle.builder-packet-dot");
    if (!el) return;
    const idRaw = el.getAttribute("data-packet-id");
    if (idRaw === null) return;
    const packetId = Number(idRaw);
    if (!Number.isFinite(packetId)) return;
    ev.stopPropagation();
    setSelection({ kind: "packet", packetId });
  });

  canvasEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".builder-note-editor")) return;
    if (suppressNextControlClick) {
      suppressNextControlClick = false;
      // If a drag started from a control button, swallow the trailing click that would otherwise activate it.
      if (target.closest(".builder-hub-reverse,.builder-cycle-btn[data-setting-cycle],.builder-mask-arrow")) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }

    const portEl = target.closest<HTMLButtonElement>(".builder-port");
    if (portEl) {
      ev.stopPropagation();
      return;
    }

    const cycleBtn = target.closest<HTMLButtonElement>(".builder-cycle-btn[data-setting-cycle]");
    if (cycleBtn) {
      ev.stopPropagation();
      const rootId = cycleBtn.dataset.rootId;
      const key = cycleBtn.dataset.settingCycle;
      const direction = cycleBtn.dataset.dir === "prev" ? "prev" : "next";
      if (!rootId || !key) return;
      setFilterSetting(rootId, key, direction);
      return;
    }

    const maskBtn = target.closest<HTMLButtonElement>(".builder-mask-arrow");
    if (maskBtn) {
      ev.stopPropagation();
      const rootId = maskBtn.dataset.rootId;
      const rawIdx = maskBtn.dataset.maskIdx;
      const dir = maskBtn.dataset.maskDir === "down" ? "down" : "up";
      if (!rootId || rawIdx === undefined) return;
      const instanceId = maskBtn.closest<HTMLElement>(".builder-entity")?.dataset.instanceId ?? "";
      const instance = parseBuilderInstanceId(instanceId);
      updateMaskAt(rootId, Number(rawIdx), dir, instance?.segmentIndex);
      return;
    }

    const hubToggle = target.closest<HTMLButtonElement>("[data-hub-toggle-rotation]");
    if (hubToggle) {
      ev.stopPropagation();
      const rootId = hubToggle.dataset.rootId;
      if (!rootId) return;
      const rootEnt = state.entities.find((e) => e.id === rootId);
      if (!rootEnt || rootEnt.templateType !== "hub") return;
      const targetIds = selectedEntityRootIds.has(rootId)
        ? Array.from(selectedEntityRootIds).filter((id) => state.entities.find((e) => e.id === id)?.templateType === "hub")
        : [rootId];
      targetIds.forEach((id) => {
        const ent = state.entities.find((e) => e.id === id);
        if (!ent || ent.templateType !== "hub") return;
        const next =
          (ent.settings.rotation ?? "clockwise") === "counterclockwise" ? "clockwise" : "counterclockwise";
        state = updateEntitySettings(state, ent.id, { ...ent.settings, rotation: next });
      });
      refreshHubControlsForRoots(targetIds);
      schedulePersist();
      applySelectionToCanvas();
      renderInspector();
      return;
    }

    const entityEl = target.closest<HTMLElement>(".builder-entity");
    if (entityEl) {
      const rootId = entityEl.dataset.rootId!;
      if (suppressNextEntityClickToggle) {
        suppressNextEntityClickToggle = false;
        return;
      }
      const rootEnt = state.entities.find((e) => e.id === rootId);
      if (ev.shiftKey || ev.ctrlKey) {
        if (rootEnt?.templateType === "hub") {
          // For modifier-toggle, accept clicks only on actual hub geometry, not transparent bbox area.
          const hubEl = entityEl.querySelector<HTMLElement>(".builder-hub");
          if (!hubEl) return;
          const hubRect = hubEl.getBoundingClientRect();
          const localX = ev.clientX - hubRect.left;
          const localY = ev.clientY - hubRect.top;
          const faceRaw = Number.parseFloat(hubEl.dataset.faceAngle ?? rootEnt.settings.faceAngle ?? "0");
          const faceDeg = ((Number.isFinite(faceRaw) ? faceRaw : 0) % 360 + 360) % 360;
          if (hubPointerMode(localX, localY, faceDeg) === "none") {
            return;
          }
        }
        const next = currentEntitySelectionSet();
        if (next.has(rootId)) next.delete(rootId);
        else next.add(rootId);
        setEntitySelectionSet(next);
        return;
      }
      if (rootEnt?.templateType === "hub") {
        return;
      }
      setSelection({ kind: "entity", rootId });
    }
  });

  canvasEl.addEventListener("mousemove", (ev) => {
    if (root.classList.contains("builder-dragging-grab")) {
      hideFilterTooltip();
      return;
    }
    const entityEl = (ev.target as Element | null)?.closest<HTMLElement>(".builder-entity[data-template-type]");
    const nextRootId = entityEl?.dataset.templateType === "filter" ? (entityEl.dataset.rootId ?? null) : null;
    const nextInstanceId =
      entityEl?.dataset.templateType === "filter" ? (entityEl.dataset.instanceId ?? null) : null;
    if (!nextRootId) {
      hideFilterTooltip();
      return;
    }
    if (filterTooltipRootId === nextRootId && filterTooltipInstanceId === nextInstanceId) {
      return;
    }
    hideFilterTooltip();
    filterTooltipRootId = nextRootId;
    filterTooltipInstanceId = nextInstanceId;
    filterTooltipTimer = window.setTimeout(() => {
      if (filterTooltipRootId !== nextRootId || filterTooltipInstanceId !== nextInstanceId) return;
      showFilterTooltip(nextRootId, nextInstanceId);
      filterTooltipTimer = null;
    }, 1000);
  });
  canvasEl.addEventListener("mouseleave", () => {
    hideFilterTooltip();
  });

  const onWirePortPointerDown = (ev: PointerEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const portEl =
      target.closest<HTMLButtonElement>(".builder-port") ??
      wireBag.w!.builderPortFromClientPoint(ev.clientX, ev.clientY);
    if (!portEl) return;
    suppressBoxSelectionUntilMouseUp = true;
    const clearSuppression = (): void => {
      suppressBoxSelectionUntilMouseUp = false;
      window.removeEventListener("mouseup", clearSuppression, true);
    };
    window.addEventListener("mouseup", clearSuppression, true);
    wireBag.w!.startLinkDragFromPort(portEl, ev);
  };
  canvasWrapEl?.addEventListener("pointerdown", onWirePortPointerDown);

  canvasEl.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (ev.button !== 0) return;
    if (target.closest(".builder-note-editor")) return;
    const downBtn = target.closest<HTMLButtonElement>("button");
    const downBtnIsControl =
      !!downBtn &&
      downBtn.matches(".builder-hub-reverse,.builder-cycle-btn[data-setting-cycle],.builder-mask-arrow");
    if (downBtn && !downBtnIsControl) return;
    // Never start entity drag from ports; ports are reserved for link dragging.
    if (downBtn?.classList.contains("builder-port")) return;
    const entityEl = target.closest<HTMLElement>(".builder-entity");
    if (!entityEl) return;
    // Same as wire overlay proximity zone: reserve link-drag start without also arming move/rotate.
    if (wireBag.w!.builderPortFromClientPoint(ev.clientX, ev.clientY)) return;
    const rootId = entityEl.dataset.rootId;
    const rootEnt = rootId ? state.entities.find((e) => e.id === rootId) : null;
    const preserveMulti = !!rootId && selectedEntityRootIds.has(rootId);
    if (rootId && !preserveMulti && !ev.shiftKey && !ev.ctrlKey) {
      setSelection({ kind: "entity", rootId });
    }
    const downX = ev.clientX;
    const downY = ev.clientY;
    const DRAG_START_THRESHOLD_PX = 3;
    let started = false;
    let cancelArmDrag: (() => void) | undefined;
    cancelArmDrag = capturePrimaryDragOnWindow(ev, {
      onMove: (mv: MouseEvent): void => {
        if (started) return;
        const dx = mv.clientX - downX;
        const dy = mv.clientY - downY;
        if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD_PX) return;
        started = true;
        cancelArmDrag?.();
        cancelArmDrag = undefined;
        suppressNextEntityClickToggle = true;
        suppressNextControlClick = downBtnIsControl;
        ev.stopImmediatePropagation();
        startEntityDragFromElement(entityEl, mv);
      },
      onEnd: () => {},
    });
  });

  canvasEl.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (ev.button !== 0) return;
    if (suppressBoxSelectionUntilMouseUp) return;
    if (target.closest("button")) return;
    const entityUnder = target.closest<HTMLElement>(".builder-entity");
    if (entityUnder) {
      const rootId = entityUnder.dataset.rootId;
      const rootEnt = rootId ? state.entities.find((e) => e.id === rootId) : null;
      if (rootEnt?.templateType !== "hub") return;
      const hubEl = entityUnder.querySelector<HTMLElement>(".builder-hub");
      if (!hubEl) return;
      const hubRect = hubEl.getBoundingClientRect();
      const localX = ev.clientX - hubRect.left;
      const localY = ev.clientY - hubRect.top;
      const faceRaw = Number.parseFloat(hubEl.dataset.faceAngle ?? rootEnt.settings.faceAngle ?? "0");
      const faceDeg = ((Number.isFinite(faceRaw) ? faceRaw : 0) % 360 + 360) % 360;
      const mode = hubPointerMode(localX, localY, faceDeg);
      if (mode !== "none") return;
    }
    if (!canvasWrapEl) return;
    const wrapRect = canvasWrapEl.getBoundingClientRect();
    const startX = ev.clientX - wrapRect.left + canvasWrapEl.scrollLeft;
    const startY = ev.clientY - wrapRect.top + canvasWrapEl.scrollTop;
    const mode: "replace" | "add" | "remove" = ev.ctrlKey ? "remove" : ev.shiftKey ? "add" : "replace";
    boxSelection = { startX, startY, currentX: startX, currentY: startY, mode };
    boxEl.style.display = "block";
    const clearBoxPreview = (): void => {
      canvasEl.querySelectorAll<HTMLElement>(".builder-entity.box-preview").forEach((el) => {
        el.classList.remove("box-preview");
      });
    };
    const collectBoxSelectionIds = (l: number, t: number, r: number, b: number): Set<string> => {
      const ids = new Set<string>();
      canvasEl.querySelectorAll<HTMLElement>(".builder-entity[data-root-id]").forEach((el) => {
        const id = el.dataset.rootId;
        if (!id) return;
        const ent = state.entities.find((e) => e.id === id);
        if (!ent || isStaticOuterLeafEndpoint(ent)) return;
        if (ent.templateType === "hub") {
          const hubEl = el.querySelector<HTMLElement>(".builder-hub");
          if (!hubEl) return;
          const faceRaw = Number.parseFloat(hubEl.dataset.faceAngle ?? ent.settings.faceAngle ?? "0");
          const faceDeg = ((Number.isFinite(faceRaw) ? faceRaw : 0) % 360 + 360) % 360;
          const hubHit = boxIntersectsHubTriangle(
            l,
            t,
            r,
            b,
            hubEl,
            faceDeg,
            wrapRect,
            canvasWrapEl.scrollLeft,
            canvasWrapEl.scrollTop,
          );
          if (hubHit) ids.add(id);
          return;
        }
        const relayCore =
          ent.templateType === "relay"
            ? el.querySelector<HTMLElement>(".builder-relay-core")
            : null;
        const rect = (relayCore ?? el).getBoundingClientRect();
        const ex1 = rect.left - wrapRect.left + canvasWrapEl.scrollLeft;
        const ey1 = rect.top - wrapRect.top + canvasWrapEl.scrollTop;
        const ex2 = ex1 + rect.width;
        const ey2 = ey1 + rect.height;
        const hit = ex1 <= r && ex2 >= l && ey1 <= b && ey2 >= t;
        if (hit) ids.add(id);
      });
      return ids;
    };
    const applyBoxPreview = (ids: Set<string>): void => {
      clearBoxPreview();
      ids.forEach((id) => {
        canvasEl
          .querySelectorAll<HTMLElement>(`.builder-entity[data-root-id="${id}"]`)
          .forEach((el) => el.classList.add("box-preview"));
      });
    };
    const updateBox = (): void => {
      if (!boxSelection) return;
      const left = Math.min(boxSelection.startX, boxSelection.currentX);
      const top = Math.min(boxSelection.startY, boxSelection.currentY);
      const width = Math.abs(boxSelection.currentX - boxSelection.startX);
      const height = Math.abs(boxSelection.currentY - boxSelection.startY);
      boxEl.style.left = `${left}px`;
      boxEl.style.top = `${top}px`;
      boxEl.style.width = `${width}px`;
      boxEl.style.height = `${height}px`;
      applyBoxPreview(collectBoxSelectionIds(left, top, left + width, top + height));
    };
    updateBox();
    const onMove = (mv: MouseEvent): void => {
      if (!boxSelection) return;
      boxSelection.currentX = mv.clientX - wrapRect.left + canvasWrapEl.scrollLeft;
      boxSelection.currentY = mv.clientY - wrapRect.top + canvasWrapEl.scrollTop;
      updateBox();
    };
    const onUp = (): void => {
      if (!boxSelection) return;
      const l = Math.min(boxSelection.startX, boxSelection.currentX);
      const t = Math.min(boxSelection.startY, boxSelection.currentY);
      const r = Math.max(boxSelection.startX, boxSelection.currentX);
      const b = Math.max(boxSelection.startY, boxSelection.currentY);
      const ids = collectBoxSelectionIds(l, t, r, b);
      applyEntitySelectionWithMode(ids, boxSelection.mode);
      clearBoxPreview();
      boxSelection = null;
      boxEl.style.display = "none";
      boxEl.style.width = "0px";
      boxEl.style.height = "0px";
    };
    capturePrimaryDragOnWindow(ev, { onMove, onEnd: onUp });
  });

  canvasEl.addEventListener("mousemove", (ev) => {
    updateHubHoverFromPointer(ev);
    updateRelayHoverFromPointer(ev);
  });
  canvasEl.addEventListener("mouseleave", () => {
    clearHubHover(hoveredHubEl);
    hoveredHubEl = null;
    clearRelayHover(hoveredRelayEl);
    hoveredRelayEl = null;
  });

  const wrap = wireOverlayEl.parentElement;
  if (wrap) {
    wireBag.w!.attachScrollAndResizeListeners(wrap);
    const wrapResizeObserver = new ResizeObserver(() => {
      applyCanvasScale();
    });
    wrapResizeObserver.observe(wrap);
  }
  window.addEventListener("resize", applyCanvasScale);
  window.addEventListener("resize", () => applyBuilderSidebarWidth(builderSidebarWidth));

  scaleXEl.addEventListener("input", () => {
    const parsed = Number(scaleXEl.value);
    canvasScale.x = canvasScaleXValueFromIndex(Number.isFinite(parsed) ? parsed : canvasScaleXIndexFromValue(1));
    applyCanvasScale();
  });
  scaleXEl.addEventListener("change", () => {
    persistCanvasScale();
    persist();
  });
  scaleYOuterEl.addEventListener("input", () => {
    const parsed = Number(scaleYOuterEl.value);
    canvasScale.yByLayer.outer64 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  scaleYMiddleEl.addEventListener("input", () => {
    const parsed = Number(scaleYMiddleEl.value);
    canvasScale.yByLayer.middle16 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  scaleYInnerEl.addEventListener("input", () => {
    const parsed = Number(scaleYInnerEl.value);
    canvasScale.yByLayer.inner4 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  scaleYCoreEl.addEventListener("input", () => {
    const parsed = Number(scaleYCoreEl.value);
    canvasScale.yByLayer.core1 = clampCanvasScaleY(Number.isFinite(parsed) ? parsed : 1);
    applyCanvasScale();
  });
  const onChangeY = (): void => {
    persistCanvasScale();
    persist();
  };
  scaleYOuterEl.addEventListener("change", onChangeY);
  scaleYMiddleEl.addEventListener("change", onChangeY);
  scaleYInnerEl.addEventListener("change", onChangeY);
  scaleYCoreEl.addEventListener("change", onChangeY);

  simPlayPauseBtn.addEventListener("click", () => setBuilderSimPlaying(!simPlaying));
  const finishRunningSimAnimationNow = (): boolean => {
    if (!simAnimating) return false;
    if (simPlaying) {
      setBuilderSimPlaying(false);
    }
    simAnimFinishFn?.();
    return true;
  };
  simStepBtn.addEventListener("click", () => {
    if (finishRunningSimAnimationNow()) return;
    if (simPlaying) {
      simPlaying = false;
      simPlayPauseBtn.textContent = "▶";
      updateBuilderSimMeta();
      return;
    }
    runOneBuilderSimTick();
  });
  simBackBtn.addEventListener("click", () => {
    if (finishRunningSimAnimationNow()) return;
    stepBackBuilderSimulation();
  });
  simResetBtn.addEventListener("click", () => resetBuilderSimulation());
  simTogglePacketIpsBtn.addEventListener("click", () => cyclePacketLabelMode());

  const applyBuilderSimSpeedFromSlider = (): void => {
    simSpeedExponent = Number(simSpeedEl.value);
    if (!Number.isFinite(simSpeedExponent)) {
      simSpeedExponent = SPEED_EXP_DEFAULT;
    }
    builderPageState.simSpeedExponent = simSpeedExponent;
    persistBuilderPageState();
    simSpeed = speedMultiplierFromExponent(simSpeedExponent);
    simEmaAchievedSpeed = null;
    simAchievedStartMs = null;
    simAchievedStartTick = simStats.tick;
    // If we're mid-tick animation, retime smoothly instead of cancelling/restarting.
    if (simAnimating && simTickAnimStartMs !== null && simTickAnimDurationMs !== null) {
      const now = performance.now();
      const progress =
        simTickAnimDurationMs <= 0 ? 1 : clamp01((now - simTickAnimStartMs) / simTickAnimDurationMs);
      const newDurationMs = Math.max(1, 1000 / Math.max(simSpeed, 0.1));
      simTickAnimStartMs = now - progress * newDurationMs;
      simTickAnimDurationMs = newDurationMs;
      // `simNextTickDeadlineMs` tracks the deadline for the *next* tick animation,
      // not the currently running one. Keep it one full interval after current end.
      simNextTickDeadlineMs = simTickAnimStartMs + newDurationMs * 2;
      if (simTickTimeoutHandle !== null) {
        window.clearTimeout(simTickTimeoutHandle);
      }
      const remainingMs = Math.max(0, (1 - progress) * newDurationMs);
      simTickTimeoutHandle = window.setTimeout(() => {
        if (!simAnimating) return;
        simAnimFinishFn?.();
      }, remainingMs);
    } else if (simPlaying && (simAnimHandle !== null || simTickTimeoutHandle !== null)) {
      cancelBuilderSimTickTimers();
      simNextTickDeadlineMs = null;
      simAnimating = false;
      runOneBuilderSimTick();
    }
    syncBuilderSimSliderLabels();
    updateBuilderSimMeta();
  };
  simSpeedEl.addEventListener("input", applyBuilderSimSpeedFromSlider);
  simSpeedEl.addEventListener("change", applyBuilderSimSpeedFromSlider);

  window.addEventListener("keydown", (ev) => {
    const bv = root.closest(".builder-view");
    if (!bv || bv.classList.contains("hidden")) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
    if (ev.code === "Space") {
      ev.preventDefault();
      setBuilderSimPlaying(!simPlaying);
      return;
    }
    if (ev.key === "Delete") {
      ev.preventDefault();
      deleteSelected();
    }
  });

  renderTemplates();
  renderLayoutSlots();
  const urlToken = startupUrlToken;
  if (urlToken) {
    importBuilderStateUrlToken(urlToken).then((parsed) => {
      if (!parsed) return;
      urlEmbeddedLayoutState = parsed;
      urlEmbeddedLayoutToken = urlToken;
      saveBuilderUrlLayoutSlot(urlToken, parsed);
      builderPageState.activeLayoutKind = "url";
      persistBuilderPageState();
      activeLayoutTarget = { kind: "url" };
      applyLoadedBuilderState(parsed, false);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("layout");
      window.history.replaceState(null, "", nextUrl.toString());
    });
  }
  syncBuilderSimSliderLabels();
  renderInspector();
  renderCanvas();
  applyCanvasScale();
  migrateLegacyNormalizedEntityPositionsToGrid();
  renderCanvas();
  applyPropertyLabelVisibility();
  requestAnimationFrame(() => {
    applyCanvasScale();
  });
  resetBuilderSimulation();
}
