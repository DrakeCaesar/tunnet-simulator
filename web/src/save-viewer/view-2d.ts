import { portKey, type PortRef, type Packet } from "../simulation";
import type { GraphModel, ViewportBox, VisualNode } from "./model";

const PACKET_IP_LABEL_CHAR_COUNT = 7;
const PACKET_IP_LABEL_MONO_CHAR_ADVANCE_PX = 6.1;
const PACKET_IP_LABEL_WIDTH_PX = Math.ceil(PACKET_IP_LABEL_CHAR_COUNT * PACKET_IP_LABEL_MONO_CHAR_ADVANCE_PX + 8);
const PACKET_IP_LABEL_HEIGHT_PX = 24;
const PACKET_DOT_RADIUS_PX = 8;
const PACKET_LABEL_ANCHOR_X_PX = PACKET_DOT_RADIUS_PX + 5;
const PACKET_IP_LABEL_OFFSET_X_PX = -3;
const PACKET_IP_LABEL_OFFSET_Y_PX = -13;

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

function nodeClass(node: VisualNode): string {
  return `sv-node sv-node-${node.type}${node.isPreplaced ? " sv-node-preplaced" : ""}`;
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

export function renderGraph(model: GraphModel, camera: ViewportBox): ViewportBox | null {
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
    group.setAttribute("class", nodeClass(node));
    group.setAttribute("data-device-id", node.id);
    group.setAttribute("data-device-type", node.type);
    group.setAttribute("data-device-label", node.label);
    if (node.isPreplaced) group.setAttribute("data-device-preplaced", "true");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "sv-node-dot");
    circle.setAttribute("cx", String(node.x));
    circle.setAttribute("cy", String(node.y));
    circle.setAttribute("r", "0.6");
    group.appendChild(circle);
    if (node.type === "endpoint") {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(node.x + textDx));
      text.setAttribute("y", String(node.y + textDy));
      text.setAttribute("font-size", String(textFontSize));
      text.textContent = node.label;
      group.appendChild(text);
    }
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hit.setAttribute("class", "sv-node-hit");
    hit.setAttribute("cx", String(node.x));
    hit.setAttribute("cy", String(node.y));
    hit.setAttribute("r", "1.35");
    group.appendChild(hit);
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

export function renderPacketOverlay(
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
