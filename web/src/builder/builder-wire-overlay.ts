import {
  expandLinks,
  parseBuilderInstanceId,
  type BuilderLinkInstance,
} from "./clone-engine";
import type { BuilderState } from "./state";
import { isOuterLeafVoidSegment, isStaticOuterLeafEndpoint } from "./state";

/** Port DOM identity for link dragging (mirrors share rootId). */
export type LinkSourceSelection = {
  rootId: string;
  port: number;
  instanceId: string;
};

export type WirePerfKey =
  | "wire.expandLinks"
  | "wire.overlayWrapRect"
  | "wire.overlayScrollExtents"
  | "wire.portResolve"
  | "wire.lineBuild"
  | "wire.dragMarkup"
  | "wire.domCommit";

export type BuilderWireOverlayOptions = {
  root: HTMLElement;
  wireOverlayEl: SVGSVGElement;
  canvasEl: HTMLElement;
  getState: () => BuilderState;
  recordPerf: (key: WirePerfKey, ms: number) => void;
  perfCounts: { stateLinks: number; expandedLinks: number };
  /**
   * After wire `innerHTML` or partial wire attribute updates.
   * `skipPacketRefresh`: set for scroll-only and entity-drag partial wire passes (skip packet overlay work).
   */
  afterWireOverlayPaint: (overlayPassStartMs: number, opts?: { skipPacketRefresh?: boolean }) => void;
  setBuilderDragCursor: (cursor: "crosshair") => void;
  clearBuilderDragCursor: () => void;
  /** Called after clearing rubber-band state and refreshing wires once. */
  commitLinkDragResult: (input: {
    from: LinkSourceSelection;
    toPort: HTMLButtonElement | null;
    startedFromPacket: boolean;
  }) => void;
};

export type RenderWireOpts = {
  skipPacketRefresh?: boolean;
  mode?: "default" | "entityDragPartitionBuild";
};

const WIRE_PORT_DROP_ZONE_PX = 5;
const WIRE_DRAG_START_THRESHOLD_PX = 3;

function portCacheKey(instanceId: string, port: number): string {
  return `${instanceId}#${port}`;
}

function linkRootIdFromInstanceId(instanceId: string): string | null {
  const p = parseBuilderInstanceId(instanceId);
  return p?.rootId ?? null;
}

function linkEntityDragWireCategory(
  link: BuilderLinkInstance,
  moving: Set<string>,
): "static" | "internal" | "external" {
  const fr = linkRootIdFromInstanceId(String(link.fromInstanceId));
  const tr = linkRootIdFromInstanceId(String(link.toInstanceId));
  const fm = fr !== null && moving.has(fr);
  const tm = tr !== null && moving.has(tr);
  if (!fm && !tm) return "static";
  if (fm && tm) return "internal";
  return "external";
}

function movingRootSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  let ok = true;
  a.forEach((id) => {
    if (!b.has(id)) ok = false;
  });
  return ok;
}

export function createBuilderWireOverlay(opts: BuilderWireOverlayOptions): {
  rebuildPortElementCache: () => void;
  resolveBuilderPortForWireOverlay: (instanceId: string, port: number) => HTMLButtonElement | null;
  builderPortFromClientPoint: (clientX: number, clientY: number) => HTMLButtonElement | null;
  renderWireOverlay: (opts?: RenderWireOpts) => void;
  scheduleWireOverlayRender: (schedOpts?: { scrollOnly?: boolean }) => void;
  scheduleWireDragPaint: () => void;
  startLinkDragFromPort: (portEl: HTMLButtonElement, ev: PointerEvent) => void;
  isLinkDragActive: () => boolean;
  clearLinkDrag: () => void;
  attachScrollAndResizeListeners: (wrap: HTMLElement) => void;
  beginEntityWireDrag: (movingRootIds: readonly string[], anchorRootId?: string) => void;
  scheduleEntityWireDragPartial: () => void;
  endEntityWireDrag: () => void;
  notifyCanvasDomRebuilt: () => void;
  isEntityWireDragActive: () => boolean;
  /** After incremental entity DOM replace: refresh ports; partial wire drag or skip or full overlay. */
  refreshWireOverlayAfterEntityPatch: (
    patchedRootIds: ReadonlySet<string>,
    opts?: { syncEntityWirePartial?: boolean; entityWireBakeAfterPartial?: boolean },
  ) => boolean;
  /** Rebuild port cache; redraw all wire segments only if link geometry changed (e.g. a link was removed). */
  refreshWireOverlayAfterEntityRemoval: (wireGeometryChanged?: boolean) => void;
} {
  const {
    root,
    wireOverlayEl,
    canvasEl,
    getState,
    recordPerf,
    perfCounts,
    afterWireOverlayPaint,
    setBuilderDragCursor,
    clearBuilderDragCursor,
    commitLinkDragResult,
  } = opts;

  let portElByInstancePort = new Map<string, HTMLButtonElement>();
  let linkDrag: { from: LinkSourceSelection; endClient: { x: number; y: number } } | null = null;
  let wireOverlayRaf: number | null = null;
  let wireDragRaf: number | null = null;
  /** Coalesced wire RAF: skip packet refresh only if every schedule in the frame was scroll-only. */
  let pendingWireSkipPackets: boolean | null = null;
  let entityDragWireRaf: number | null = null;
  let entityWireDrag: {
    movingRootIds: Set<string>;
    internalIndices: number[];
    externalIndices: number[];
    viewLinks: BuilderLinkInstance[];
    anchorRootId: string;
    anchorStartX: number;
    anchorStartY: number;
  } | null = null;

  function rebuildPortElementCache(): void {
    const next = new Map<string, HTMLButtonElement>();
    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-port[data-instance-id][data-port]").forEach((portEl) => {
      const instanceId = portEl.dataset.instanceId ?? "";
      const p = Number(portEl.dataset.port);
      if (!instanceId || Number.isNaN(p)) return;
      next.set(portCacheKey(instanceId, p), portEl);
    });
    portElByInstancePort = next;
  }

  function resolveBuilderPortForWireOverlay(instanceId: string, port: number): HTMLButtonElement | null {
    const byInstance = portElByInstancePort.get(portCacheKey(instanceId, port)) ?? null;
    if (byInstance) return byInstance;
    const m = instanceId.match(/^(.+)@(\d+)$/);
    if (!m) return null;
    const rootId = m[1] ?? "";
    const seg = Number(m[2]);
    if (!Number.isInteger(seg) || seg < 0 || seg > 63) return null;
    const state = getState();
    const ent = state.entities.find((e) => e.id === rootId);
    if (!ent || !isStaticOuterLeafEndpoint(ent) || ent.layer !== "outer64") {
      return null;
    }
    if (isOuterLeafVoidSegment(seg)) {
      return canvasEl.querySelector<HTMLButtonElement>(
        `.builder-segment[data-void-outer="1"] .builder-port[data-instance-id="${instanceId}"][data-port="${port}"]`,
      );
    }
    return canvasEl.querySelector<HTMLButtonElement>(
      `.builder-segment[data-layer="outer64"][data-segment="${seg}"] [data-static-endpoint="1"] .builder-port[data-port="${port}"]`,
    );
  }

  function builderPortFromClientPoint(clientX: number, clientY: number): HTMLButtonElement | null {
    const stackedPort =
      document
        .elementsFromPoint(clientX, clientY)
        .map((node) => node.closest<HTMLButtonElement>(".builder-port"))
        .find((port): port is HTMLButtonElement => port !== null) ?? null;
    if (stackedPort) return stackedPort;

    let closestPort: HTMLButtonElement | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-port[data-instance-id][data-port]").forEach((portEl) => {
      const rect = portEl.getBoundingClientRect();
      const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      const distance = Math.hypot(dx, dy);
      if (distance > WIRE_PORT_DROP_ZONE_PX || distance >= closestDistance) return;
      closestDistance = distance;
      closestPort = portEl;
    });
    return closestPort;
  }

  function endEntityWireDrag(): void {
    entityWireDrag = null;
    if (entityDragWireRaf !== null) {
      window.cancelAnimationFrame(entityDragWireRaf);
      entityDragWireRaf = null;
    }
  }

  function isEntityWireDragActive(): boolean {
    return entityWireDrag !== null;
  }

  function notifyCanvasDomRebuilt(): void {
    endEntityWireDrag();
  }

  function readAnchorEntityCenterOverlay(
    anchorRootId: string,
    wrap: HTMLElement,
    wrapRect?: DOMRectReadOnly,
  ): { x: number; y: number } | null {
    const wr = wrapRect ?? wrap.getBoundingClientRect();
    const ent = canvasEl.querySelector<HTMLElement>(`.builder-entity[data-root-id="${anchorRootId}"]`);
    if (!ent) return null;
    const r = ent.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: r.left + r.width / 2 - wr.left + wrap.scrollLeft,
      y: r.top + r.height / 2 - wr.top + wrap.scrollTop,
    };
  }

  function beginEntityWireDrag(movingRootIds: readonly string[], anchorRootId?: string): void {
    const next = new Set(movingRootIds);
    if (next.size === 0) {
      endEntityWireDrag();
      return;
    }
    if (entityWireDrag && movingRootSetsEqual(entityWireDrag.movingRootIds, next)) {
      if (wireOverlayEl.querySelector("[data-builder-vlink], [data-builder-vlink-internal]")) {
        return;
      }
      endEntityWireDrag();
    }
    endEntityWireDrag();
    const state = getState();
    const viewLinks = expandLinks(state.links, state.entities);
    const internalIndices: number[] = [];
    const externalIndices: number[] = [];
    for (let i = 0; i < viewLinks.length; i += 1) {
      const cat = linkEntityDragWireCategory(viewLinks[i]!, next);
      if (cat === "internal") internalIndices.push(i);
      else if (cat === "external") externalIndices.push(i);
    }
    const anchor =
      anchorRootId && next.has(anchorRootId) ? anchorRootId : (Array.from(next)[0] as string);
    entityWireDrag = {
      movingRootIds: next,
      internalIndices,
      externalIndices,
      viewLinks,
      anchorRootId: anchor,
      anchorStartX: 0,
      anchorStartY: 0,
    };
    renderWireOverlay({ mode: "entityDragPartitionBuild" });
    const wrap = wireOverlayEl.parentElement;
    if (wrap && entityWireDrag) {
      let p = readAnchorEntityCenterOverlay(entityWireDrag.anchorRootId, wrap);
      if (!p && entityWireDrag.internalIndices.length > 0) {
        entityWireDrag.externalIndices.push(...entityWireDrag.internalIndices);
        entityWireDrag.internalIndices = [];
        renderWireOverlay({ mode: "entityDragPartitionBuild" });
        p = readAnchorEntityCenterOverlay(entityWireDrag.anchorRootId, wrap);
      }
      if (p) {
        entityWireDrag.anchorStartX = p.x;
        entityWireDrag.anchorStartY = p.y;
      }
    }
  }

  /** Incremental entity-wire drag paint ok; full_rebuild when innerHTML fallback ran; none when skipped. */
  type EntityWirePartialOutcome = "incremental_ok" | "none";

  function bakeEntityWireDragInternalLines(preMeasuredWrapRect?: DOMRectReadOnly): void {
    const part = entityWireDrag;
    if (!part || part.internalIndices.length === 0) return;
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    const wrapRect = preMeasuredWrapRect ?? wrap.getBoundingClientRect();
    const portWireEndpoint = (
      portEl: HTMLButtonElement,
    ): { x: number; y: number; radius: number; clipped: boolean } | null => {
      const viewport = portEl.closest<HTMLElement>(".builder-segment-entities");
      const rect = portEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      let clientX = rect.left + rect.width / 2;
      let clientY = rect.top + rect.height / 2;
      let clipped = false;
      if (viewport) {
        const viewportRect = viewport.getBoundingClientRect();
        if (viewportRect.width <= 0 || viewportRect.height <= 0) return null;
        const clampedX = Math.max(viewportRect.left, Math.min(viewportRect.right, clientX));
        const clampedY = Math.max(viewportRect.top, Math.min(viewportRect.bottom, clientY));
        clipped = clampedX !== clientX || clampedY !== clientY;
        clientX = clampedX;
        clientY = clampedY;
      }
      return {
        x: clientX - wrapRect.left + wrap.scrollLeft,
        y: clientY - wrapRect.top + wrap.scrollTop,
        radius: clipped ? 0 : rect.width / 2,
        clipped,
      };
    };
    const lineEndpointsAtPortEdges = (
      x1: number,
      y1: number,
      r1: number,
      x2: number,
      y2: number,
      r2: number,
    ): { sx: number; sy: number; ex: number; ey: number } => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        return { sx: x1, sy: y1, ex: x2, ey: y2 };
      }
      const ux = dx / d;
      const uy = dy / d;
      const startInset = Math.min(r1, d * 0.45);
      const endInset = Math.min(r2, d * 0.45);
      return {
        sx: x1 + ux * startInset,
        sy: y1 + uy * startInset,
        ex: x2 - ux * endInset,
        ey: y2 - uy * endInset,
      };
    };
    for (const i of part.internalIndices) {
      const link = part.viewLinks[i];
      if (!link) continue;
      const from = resolveBuilderPortForWireOverlay(String(link.fromInstanceId), link.fromPort);
      const to = resolveBuilderPortForWireOverlay(String(link.toInstanceId), link.toPort);
      const lineEl = wireOverlayEl.querySelector(`[data-builder-vlink-internal="${i}"]`);
      if (!from || !to || !lineEl) continue;
      const fromCenter = portWireEndpoint(from);
      const toCenter = portWireEndpoint(to);
      if (!fromCenter || !toCenter || (fromCenter.clipped && toCenter.clipped)) continue;
      const e = lineEndpointsAtPortEdges(
        fromCenter.x,
        fromCenter.y,
        fromCenter.radius,
        toCenter.x,
        toCenter.y,
        toCenter.radius,
      );
      lineEl.removeAttribute("transform");
      lineEl.setAttribute("x1", String(e.sx));
      lineEl.setAttribute("y1", String(e.sy));
      lineEl.setAttribute("x2", String(e.ex));
      lineEl.setAttribute("y2", String(e.ey));
    }
  }

  /** `preMeasuredWrapRect`: caller already measured (sync DOM flush shares one rect with bake). */
  function paintEntityWireDragPartial(preMeasuredWrapRect?: DOMRectReadOnly): EntityWirePartialOutcome {
    const part = entityWireDrag;
    if (!part) return "none";
    const t0 = performance.now();
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) {
      endEntityWireDrag();
      return "none";
    }
    const tWrap0 = performance.now();
    const wrapRect = preMeasuredWrapRect ?? wrap.getBoundingClientRect();
    recordPerf("wire.overlayWrapRect", preMeasuredWrapRect !== undefined ? 0 : performance.now() - tWrap0);
    recordPerf("wire.overlayScrollExtents", 0);
    let resolveCost = 0;
    const portWireEndpoint = (
      portEl: HTMLButtonElement,
    ): { x: number; y: number; radius: number; clipped: boolean } | null => {
      const viewport = portEl.closest<HTMLElement>(".builder-segment-entities");
      const rect = portEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      let clientX = rect.left + rect.width / 2;
      let clientY = rect.top + rect.height / 2;
      let clipped = false;
      if (viewport) {
        const viewportRect = viewport.getBoundingClientRect();
        if (viewportRect.width <= 0 || viewportRect.height <= 0) return null;
        const clampedX = Math.max(viewportRect.left, Math.min(viewportRect.right, clientX));
        const clampedY = Math.max(viewportRect.top, Math.min(viewportRect.bottom, clientY));
        clipped = clampedX !== clientX || clampedY !== clientY;
        clientX = clampedX;
        clientY = clampedY;
      }
      return {
        x: clientX - wrapRect.left + wrap.scrollLeft,
        y: clientY - wrapRect.top + wrap.scrollTop,
        radius: clipped ? 0 : rect.width / 2,
        clipped,
      };
    };
    const lineEndpointsAtPortEdges = (
      x1: number,
      y1: number,
      r1: number,
      x2: number,
      y2: number,
      r2: number,
    ): { sx: number; sy: number; ex: number; ey: number } => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        return { sx: x1, sy: y1, ex: x2, ey: y2 };
      }
      const ux = dx / d;
      const uy = dy / d;
      const startInset = Math.min(r1, d * 0.45);
      const endInset = Math.min(r2, d * 0.45);
      return {
        sx: x1 + ux * startInset,
        sy: y1 + uy * startInset,
        ex: x2 - ux * endInset,
        ey: y2 - uy * endInset,
      };
    };

    const tLineBuild0 = performance.now();
    let missing = false;
    if (part.internalIndices.length > 0) {
      const curAnchor = readAnchorEntityCenterOverlay(part.anchorRootId, wrap, wrapRect);
      if (!curAnchor) {
        missing = true;
      } else {
        const dx = curAnchor.x - part.anchorStartX;
        const dy = curAnchor.y - part.anchorStartY;
        const tr = `translate(${dx} ${dy})`;
        for (const i of part.internalIndices) {
          const lineEl = wireOverlayEl.querySelector(`[data-builder-vlink-internal="${i}"]`);
          if (!lineEl) {
            missing = true;
            break;
          }
          lineEl.setAttribute("transform", tr);
        }
      }
    }

    if (!missing) {
      for (const i of part.externalIndices) {
        const link = part.viewLinks[i];
        if (!link) {
          missing = true;
          break;
        }
        const tr0 = performance.now();
        const from = resolveBuilderPortForWireOverlay(String(link.fromInstanceId), link.fromPort);
        const to = resolveBuilderPortForWireOverlay(String(link.toInstanceId), link.toPort);
        resolveCost += performance.now() - tr0;
        const lineEl = wireOverlayEl.querySelector(`[data-builder-vlink="${i}"]`);
        if (!from || !to || !lineEl) {
          missing = true;
          break;
        }
        const fromCenter = portWireEndpoint(from);
        const toCenter = portWireEndpoint(to);
        if (!fromCenter || !toCenter || (fromCenter.clipped && toCenter.clipped)) {
          missing = true;
          break;
        }
        const e = lineEndpointsAtPortEdges(
          fromCenter.x,
          fromCenter.y,
          fromCenter.radius,
          toCenter.x,
          toCenter.y,
          toCenter.radius,
        );
        lineEl.setAttribute("x1", String(e.sx));
        lineEl.setAttribute("y1", String(e.sy));
        lineEl.setAttribute("x2", String(e.ex));
        lineEl.setAttribute("y2", String(e.ey));
      }
    }

    if (missing) {
      endEntityWireDrag();
      return "none";
    }

    recordPerf("wire.portResolve", resolveCost);
    const drag = linkDrag;
    if (drag) {
      const fromPort =
        resolveBuilderPortForWireOverlay(String(drag.from.instanceId), drag.from.port) ??
        (drag.from.instanceId
          ? null
          : canvasEl.querySelector<HTMLButtonElement>(
              `.builder-port[data-root-id="${drag.from.rootId}"][data-port="${drag.from.port}"]`,
            ));
      if (fromPort) {
        const fromCenter = portWireEndpoint(fromPort);
        if (fromCenter) {
          const x2 = drag.endClient.x - wrapRect.left + wrap.scrollLeft;
          const y2 = drag.endClient.y - wrapRect.top + wrap.scrollTop;
          const e = lineEndpointsAtPortEdges(fromCenter.x, fromCenter.y, fromCenter.radius, x2, y2, 0);
          let dragLine = wireOverlayEl.querySelector(".builder-wire-drag");
          if (!dragLine) {
            dragLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
            dragLine.setAttribute("class", "builder-wire-drag");
            dragLine.setAttribute("pointer-events", "none");
            dragLine.setAttribute("stroke", "#f9e2af");
            dragLine.setAttribute("stroke-opacity", "0.9");
            dragLine.setAttribute("stroke-width", "1.5");
            wireOverlayEl.appendChild(dragLine);
          }
          dragLine.setAttribute("x1", String(e.sx));
          dragLine.setAttribute("y1", String(e.sy));
          dragLine.setAttribute("x2", String(e.ex));
          dragLine.setAttribute("y2", String(e.ey));
        }
      }
    } else {
      wireOverlayEl.querySelector(".builder-wire-drag")?.remove();
    }

    recordPerf("wire.lineBuild", performance.now() - tLineBuild0);
    recordPerf("wire.dragMarkup", 0);
    recordPerf("wire.domCommit", 0);
    afterWireOverlayPaint(t0, { skipPacketRefresh: true });
    return "incremental_ok";
  }

  function scheduleEntityWireDragPartial(): void {
    if (entityDragWireRaf !== null) return;
    entityDragWireRaf = window.requestAnimationFrame(() => {
      entityDragWireRaf = null;
      paintEntityWireDragPartial();
    });
  }

  /**
   * Updates `--builder-floating-scrollbar-*` so `.builder-controls-floating-host` clears scrollbar gutters.
   * Kept off the hot wire overlay sizing path — uses layout reads (`offset*` vs `client*`) best deferred/coalesced.
   */
  function applyWireOverlayScrollChromeOnly(): void {
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    const scrollbarRightPx = Math.max(0, wrap.offsetWidth - wrap.clientWidth);
    const scrollbarBottomPx = Math.max(0, wrap.offsetHeight - wrap.clientHeight);
    root.style.setProperty("--builder-floating-scrollbar-right", `${scrollbarRightPx}px`);
    root.style.setProperty("--builder-floating-scrollbar-bottom", `${scrollbarBottomPx}px`);
  }

  let scrollChromeRaf: number | null = null;
  /** Last SVG width/height committed on `wireOverlayEl` (avoid redundant writes when extent unchanged). */
  let lastCommittedOverlayW = -1;
  let lastCommittedOverlayH = -1;

  function scheduleWireOverlayScrollChromeApply(): void {
    if (scrollChromeRaf !== null) return;
    scrollChromeRaf = window.requestAnimationFrame(() => {
      scrollChromeRaf = null;
      applyWireOverlayScrollChromeOnly();
    });
  }

  function renderWireOverlay(opts?: RenderWireOpts): void {
    if (opts?.mode !== "entityDragPartitionBuild") {
      endEntityWireDrag();
    }
    const t0 = performance.now();
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    const state = getState();
    const tExpand0 = performance.now();
    const viewLinks = expandLinks(state.links, state.entities);
    const tExpand1 = performance.now();
    recordPerf("wire.expandLinks", tExpand1 - tExpand0);
    perfCounts.stateLinks = state.links.length;
    perfCounts.expandedLinks = viewLinks.length;
    // Wrap rect maps viewport/client coords → overlay coordinates on every rebuild (always needed).
    const tWrap0 = performance.now();
    const wrapRect = wrap.getBoundingClientRect();
    recordPerf("wire.overlayWrapRect", performance.now() - tWrap0);
    // Scroll extents size the SVG user space to cover scrollable canvas (often unchanged when only ports move).
    const tScroll0 = performance.now();
    const contentWidth = Math.max(canvasEl.scrollWidth, canvasEl.clientWidth);
    const contentHeight = Math.max(canvasEl.scrollHeight, canvasEl.clientHeight);
    const overlayWidth = Math.max(wrap.clientWidth, contentWidth);
    const overlayHeight = Math.max(wrap.clientHeight, contentHeight);
    const ow = Math.ceil(overlayWidth);
    const oh = Math.ceil(overlayHeight);
    if (ow !== lastCommittedOverlayW || oh !== lastCommittedOverlayH) {
      wireOverlayEl.setAttribute("width", String(ow));
      wireOverlayEl.setAttribute("height", String(oh));
      wireOverlayEl.style.width = `${ow}px`;
      wireOverlayEl.style.height = `${oh}px`;
      lastCommittedOverlayW = ow;
      lastCommittedOverlayH = oh;
    }
    recordPerf("wire.overlayScrollExtents", performance.now() - tScroll0);
    let lineMarkup = "";
    let resolveCost = 0;
    const tLine0 = performance.now();
    const tagLines = opts?.mode === "entityDragPartitionBuild";
    const internalIndexSet =
      tagLines && entityWireDrag ? new Set(entityWireDrag.internalIndices) : null;
    const externalIndexSet =
      tagLines && entityWireDrag ? new Set(entityWireDrag.externalIndices) : null;
    const portWireEndpoint = (
      portEl: HTMLButtonElement,
    ): { x: number; y: number; radius: number; clipped: boolean } | null => {
      const viewport = portEl.closest<HTMLElement>(".builder-segment-entities");
      const rect = portEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      let clientX = rect.left + rect.width / 2;
      let clientY = rect.top + rect.height / 2;
      let clipped = false;
      if (viewport) {
        const viewportRect = viewport.getBoundingClientRect();
        if (viewportRect.width <= 0 || viewportRect.height <= 0) return null;
        const clampedX = Math.max(viewportRect.left, Math.min(viewportRect.right, clientX));
        const clampedY = Math.max(viewportRect.top, Math.min(viewportRect.bottom, clientY));
        clipped = clampedX !== clientX || clampedY !== clientY;
        clientX = clampedX;
        clientY = clampedY;
      }
      return {
        x: clientX - wrapRect.left + wrap.scrollLeft,
        y: clientY - wrapRect.top + wrap.scrollTop,
        radius: clipped ? 0 : rect.width / 2,
        clipped,
      };
    };
    const lineEndpointsAtPortEdges = (
      x1: number,
      y1: number,
      r1: number,
      x2: number,
      y2: number,
      r2: number,
    ): { sx: number; sy: number; ex: number; ey: number } => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        return { sx: x1, sy: y1, ex: x2, ey: y2 };
      }
      const ux = dx / d;
      const uy = dy / d;
      const startInset = Math.min(r1, d * 0.45);
      const endInset = Math.min(r2, d * 0.45);
      return {
        sx: x1 + ux * startInset,
        sy: y1 + uy * startInset,
        ex: x2 - ux * endInset,
        ey: y2 - uy * endInset,
      };
    };
    for (let i = 0; i < viewLinks.length; i += 1) {
      const link = viewLinks[i]!;
      const tr0 = performance.now();
      const from = resolveBuilderPortForWireOverlay(String(link.fromInstanceId), link.fromPort);
      const to = resolveBuilderPortForWireOverlay(String(link.toInstanceId), link.toPort);
      resolveCost += performance.now() - tr0;
      if (!from || !to) continue;
      const fromCenter = portWireEndpoint(from);
      const toCenter = portWireEndpoint(to);
      if (!fromCenter || !toCenter) continue;
      if (fromCenter.clipped && toCenter.clipped) continue;
      const e = lineEndpointsAtPortEdges(
        fromCenter.x,
        fromCenter.y,
        fromCenter.radius,
        toCenter.x,
        toCenter.y,
        toCenter.radius,
      );
      let linkTag = "";
      if (internalIndexSet?.has(i)) {
        linkTag = ` data-builder-vlink-internal="${i}" transform="translate(0 0)"`;
      } else if (externalIndexSet?.has(i)) {
        linkTag = ` data-builder-vlink="${i}"`;
      }
      lineMarkup += `<line${linkTag} x1="${e.sx}" y1="${e.sy}" x2="${e.ex}" y2="${e.ey}" stroke="#f9e2af" stroke-opacity="0.9" stroke-width="1.5"></line>`;
    }
    recordPerf("wire.portResolve", resolveCost);
    recordPerf("wire.lineBuild", performance.now() - tLine0);
    const tDragMk0 = performance.now();
    const drag = linkDrag;
    if (drag) {
      const fromPort =
        resolveBuilderPortForWireOverlay(String(drag.from.instanceId), drag.from.port) ??
        (drag.from.instanceId
          ? null
          : canvasEl.querySelector<HTMLButtonElement>(
              `.builder-port[data-root-id="${drag.from.rootId}"][data-port="${drag.from.port}"]`,
            ));
      if (fromPort) {
        const fromCenter = portWireEndpoint(fromPort);
        if (fromCenter) {
          const x2 = drag.endClient.x - wrapRect.left + wrap.scrollLeft;
          const y2 = drag.endClient.y - wrapRect.top + wrap.scrollTop;
          const e = lineEndpointsAtPortEdges(fromCenter.x, fromCenter.y, fromCenter.radius, x2, y2, 0);
          lineMarkup += `<line x1="${e.sx}" y1="${e.sy}" x2="${e.ex}" y2="${e.ey}" class="builder-wire-drag" pointer-events="none"></line>`;
        }
      }
    }
    recordPerf("wire.dragMarkup", performance.now() - tDragMk0);
    const tDom0 = performance.now();
    wireOverlayEl.innerHTML = lineMarkup;
    recordPerf("wire.domCommit", performance.now() - tDom0);
    if (opts?.mode === "entityDragPartitionBuild" && entityWireDrag) {
      entityWireDrag.viewLinks = viewLinks;
    }
    scheduleWireOverlayScrollChromeApply();
    const skipPackets = opts?.skipPacketRefresh === true;
    afterWireOverlayPaint(t0, skipPackets ? { skipPacketRefresh: true } : undefined);
  }

  function scheduleWireOverlayRender(schedOpts?: { scrollOnly?: boolean }): void {
    const scrollOnly = !!schedOpts?.scrollOnly;
    pendingWireSkipPackets =
      pendingWireSkipPackets === null ? scrollOnly : pendingWireSkipPackets && scrollOnly;
    if (wireOverlayRaf !== null) return;
    wireOverlayRaf = window.requestAnimationFrame(() => {
      wireOverlayRaf = null;
      const skipPackets = pendingWireSkipPackets ?? false;
      pendingWireSkipPackets = null;
      // Idle canvas scroll does not repaint wires (coords already include scrollLeft/Top).
      // Only skip when neither link rubber-band nor incremental entity-wire drag needs a refresh.
      if (skipPackets && linkDrag === null && entityWireDrag === null) {
        return;
      }
      renderWireOverlay({ skipPacketRefresh: skipPackets });
    });
  }

  function scheduleWireDragPaint(): void {
    if (wireDragRaf !== null) return;
    wireDragRaf = window.requestAnimationFrame(() => {
      wireDragRaf = null;
      renderWireOverlay();
    });
  }

  function startLinkDragFromPort(portEl: HTMLButtonElement, ev: PointerEvent): void {
    if (ev.button !== 0 || !ev.isPrimary) return;
    endEntityWireDrag();
    const downClient = { x: ev.clientX, y: ev.clientY };
    const startedFromPacket = ev.target instanceof Element && !!ev.target.closest("circle.builder-packet-dot");
    const rootId = portEl.dataset.rootId!;
    const port = Number(portEl.dataset.port);
    const instanceId = portEl.dataset.instanceId ?? "";
    const from: LinkSourceSelection = { rootId, port, instanceId };
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    let started = false;
    const beginDrag = (clientX: number, clientY: number): void => {
      if (started) return;
      started = true;
      root.classList.add("builder-wire-dragging");
      linkDrag = { from, endClient: { x: clientX, y: clientY } };
      setBuilderDragCursor("crosshair");
      renderWireOverlay();
    };
    const onMove = (e: PointerEvent): void => {
      e.preventDefault();
      if (!started) {
        const dx = e.clientX - downClient.x;
        const dy = e.clientY - downClient.y;
        if (Math.hypot(dx, dy) < WIRE_DRAG_START_THRESHOLD_PX) return;
        beginDrag(e.clientX, e.clientY);
      }
      linkDrag = { from, endClient: { x: e.clientX, y: e.clientY } };
      scheduleWireDragPaint();
    };
    let ended = false;
    const onEnd = (e: PointerEvent): void => {
      if (ended) return;
      ended = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      clearBuilderDragCursor();
      if (wireDragRaf !== null) {
        window.cancelAnimationFrame(wireDragRaf);
        wireDragRaf = null;
      }
      if (!started) {
        root.classList.remove("builder-wire-dragging");
        return;
      }
      e.preventDefault();
      const toPort = builderPortFromClientPoint(e.clientX, e.clientY);
      root.classList.remove("builder-wire-dragging");
      linkDrag = null;
      commitLinkDragResult({ from, toPort, startedFromPacket });
      renderWireOverlay();
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  function attachScrollAndResizeListeners(wrap: HTMLElement): void {
    wrap.addEventListener(
      "scroll",
      () => {
        if (linkDrag !== null || entityWireDrag !== null) {
          scheduleWireOverlayRender({ scrollOnly: true });
        }
      },
      { passive: true },
    );
    window.addEventListener("resize", () => scheduleWireOverlayRender());
    scheduleWireOverlayScrollChromeApply();
    const ro = new ResizeObserver(() => scheduleWireOverlayScrollChromeApply());
    ro.observe(wrap);
  }

  function patchedRootsTouchAnyLink(patchedRootIds: ReadonlySet<string>): boolean {
    if (patchedRootIds.size === 0) return false;
    for (const link of getState().links) {
      if (patchedRootIds.has(link.fromEntityId) || patchedRootIds.has(link.toEntityId)) {
        return true;
      }
    }
    return false;
  }

  function refreshWireOverlayAfterEntityPatch(
    patchedRootIds: ReadonlySet<string>,
    opts?: { syncEntityWirePartial?: boolean; entityWireBakeAfterPartial?: boolean },
  ): boolean {
    rebuildPortElementCache();
    if (entityWireDrag !== null) {
      if (opts?.syncEntityWirePartial) {
        const wrap = wireOverlayEl.parentElement;
        if (!wrap) return false;
        const tWrap0 = performance.now();
        const wrapRect = wrap.getBoundingClientRect();
        recordPerf("wire.overlayWrapRect", performance.now() - tWrap0);
        const outcome = paintEntityWireDragPartial(wrapRect);
        if (outcome === "incremental_ok") {
          if (opts?.entityWireBakeAfterPartial !== false) {
            bakeEntityWireDragInternalLines(wrapRect);
          }
          if (entityDragWireRaf !== null) {
            window.cancelAnimationFrame(entityDragWireRaf);
            entityDragWireRaf = null;
          }
          return true;
        }
        return false;
      }
      scheduleEntityWireDragPartial();
      return false;
    }
    if (!patchedRootsTouchAnyLink(patchedRootIds)) {
      return false;
    }
    renderWireOverlay({ skipPacketRefresh: true });
    return true;
  }

  function refreshWireOverlayAfterEntityRemoval(wireGeometryChanged = true): void {
    rebuildPortElementCache();
    if (!wireGeometryChanged) return;
    renderWireOverlay({ skipPacketRefresh: true });
  }

  return {
    rebuildPortElementCache,
    resolveBuilderPortForWireOverlay,
    builderPortFromClientPoint,
    renderWireOverlay: (opts?: RenderWireOpts) => renderWireOverlay(opts),
    scheduleWireOverlayRender,
    scheduleWireDragPaint,
    startLinkDragFromPort,
    isLinkDragActive: () => linkDrag !== null,
    clearLinkDrag: () => {
      linkDrag = null;
    },
    attachScrollAndResizeListeners,
    beginEntityWireDrag,
    scheduleEntityWireDragPartial,
    endEntityWireDrag,
    notifyCanvasDomRebuilt,
    isEntityWireDragActive,
    refreshWireOverlayAfterEntityPatch,
    refreshWireOverlayAfterEntityRemoval,
  };
}
