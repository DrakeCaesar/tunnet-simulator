import { defaultSettings, type BuilderTemplateType } from "./state";
import {
  HUB_LAYOUT,
  HUB_REVERSE_BUTTON_SIZE,
  HUB_REVERSE_ICON_SIZE,
  HUB_VIEW,
  hubPortPinUprightStyle,
  hubTriangleSvg,
} from "../ui/canvas-entities/hub-geometry";

export function buildTemplateDragImage(templateType: BuilderTemplateType): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "builder-drag-image";
  const portBtn = (port: number): string =>
    `<button class="builder-port" type="button" disabled>${port}</button>`;
  if (templateType === "text") {
    wrap.innerHTML = `
      <div class="builder-entity builder-entity--text" style="--builder-text-w:41px;--builder-text-h:41px;">
        <div class="builder-entity-title">Note</div>
        <div class="builder-text-box"></div>
      </div>
    `;
    return wrap;
  }
  if (templateType === "hub") {
    const faceDeg = 0;
    const hubOriginX = (HUB_LAYOUT.G.x / HUB_VIEW.w) * 100;
    const hubOriginY = (HUB_LAYOUT.G.y / HUB_VIEW.h) * 100;
    wrap.innerHTML = `
      <div class="builder-entity builder-entity--hub">
        <div class="builder-hub" data-face-angle="${faceDeg}" style="--hub-w:${HUB_VIEW.w}px;--hub-h:${HUB_VIEW.h}px;--hub-reverse-size:${HUB_REVERSE_BUTTON_SIZE}px;--hub-reverse-icon-size:${HUB_REVERSE_ICON_SIZE}px;">
          <div class="builder-hub-rot" style="transform:rotate(${faceDeg}deg);transform-origin:${hubOriginX}% ${hubOriginY}%;">
            ${hubTriangleSvg("drag-preview", "clockwise")}
            <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.T, faceDeg)}" disabled>0</button>
            <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.R, faceDeg)}" disabled>1</button>
            <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.L, faceDeg)}" disabled>2</button>
          </div>
          <button type="button" class="builder-hub-reverse" style="left:${hubOriginX}%;top:${hubOriginY}%;transform:translate(-50%,-50%)" disabled><span class="builder-hub-reverse-icon" aria-hidden="true">↻</span></button>
        </div>
      </div>
    `;
    return wrap;
  }
  if (templateType === "filter") {
    const settings = defaultSettings("filter");
    const maskParts = (settings.mask ?? "*.*.*.*").split(".");
    while (maskParts.length < 4) maskParts.push("*");
    const displayAddressField =
      (settings.addressField ?? "destination") === "source"
        ? "Source"
        : "Destination";
    const displayOperation =
      (settings.operation ?? "differ") === "match" ? "Match" : "Differ";
    const displayAction =
      (settings.action ?? "send_back") === "drop" ? "Drop" : "Send back";
    const displayCollision =
      (() => {
        const value = settings.collisionHandling ?? "drop_inbound";
        if (value === "drop_inbound") return "Drop<br/>Inbound";
        if (value === "drop_outbound") return "Drop<br/>Outbound";
        return "Send back<br/>Outbound";
      })();
    wrap.innerHTML = `
      <div class="builder-entity builder-entity--filter">
        <div class="builder-ports builder-ports--filter-top">${portBtn(0)}</div>
        <div class="builder-entity-title">filter</div>
        <div class="builder-filter-ui" data-root-id="drag-preview">
          <div class="builder-filter-left">
            <div class="builder-row">
              <span class="builder-row-label">Port:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${settings.operatingPort ?? "0"}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row">
              <span class="builder-row-label">Address:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayAddressField}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row">
              <span class="builder-row-label">Operation:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayOperation}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row builder-row-mask">
              <span class="builder-row-label">Mask:</span>
              <div class="builder-mask-row">
                ${[0, 1, 2, 3]
                  .map(
                    (idx) => `
                      <div class="builder-mask-cell">
                        <button class="builder-mask-arrow" type="button" disabled>+</button>
                        <span class="${(maskParts[idx] ?? "*") === "*" ? "builder-mask-value-wildcard" : ""}">${maskParts[idx] ?? "*"}</span>
                        <button class="builder-mask-arrow" type="button" disabled>-</button>
                      </div>
                    `,
                  )
                  .join(`<span class="builder-mask-dot" aria-hidden="true">.</span>`)}
              </div>
            </div>
            <div class="builder-row">
              <span class="builder-row-label">Action:</span>
              <div class="builder-cycle">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayAction}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
            <div class="builder-row builder-row-collision">
              <span class="builder-row-label">Collision<br/>handling:</span>
              <div class="builder-cycle builder-cycle--tall">
                <button class="builder-cycle-btn" type="button" disabled>&lt;</button>
                <span class="builder-cycle-value">${displayCollision}</span>
                <button class="builder-cycle-btn" type="button" disabled>&gt;</button>
              </div>
            </div>
          </div>
        </div>
        <div class="builder-ports builder-ports--filter-bottom">${portBtn(1)}</div>
      </div>
    `;
    return wrap;
  }
  wrap.innerHTML = `
    <div class="builder-entity builder-entity--relay">
      <div class="builder-relay-core">
        <div class="builder-relay-port-dock builder-relay-port-a">${portBtn(0)}</div>
        <div class="builder-relay-port-dock builder-relay-port-b">${portBtn(1)}</div>
      </div>
    </div>
  `;
  return wrap;
}

export function templateList(): BuilderTemplateType[] {
  return ["relay", "hub", "filter", "text"];
}

export function isBuilderTemplateType(value: string): value is BuilderTemplateType {
  return value === "relay" || value === "hub" || value === "filter" || value === "text";
}

export function templateLabel(type: BuilderTemplateType): string {
  if (type === "relay") return "Relay";
  if (type === "hub") return "Hub";
  if (type === "text") return "Note";
  return "Filter";
}

export function buildFilterDescription(settings: Record<string, string>): string {
  const operatingPort = settings.operatingPort === "1" ? 1 : 0;
  const nonOperatingPort = operatingPort === 0 ? 1 : 0;
  const addressField = settings.addressField === "source" ? "source" : "destination";
  const operation = settings.operation === "match" ? "match" : "differ";
  const action = settings.action === "drop" ? "drop" : "send_back";
  const collisionHandling =
    settings.collisionHandling === "drop_inbound" ||
    settings.collisionHandling === "drop_outbound" ||
    settings.collisionHandling === "send_back_outbound"
      ? settings.collisionHandling
      : "drop_inbound";
  const mask = settings.mask ?? "*.*.*.*";

  const fieldText = addressField === "destination" ? `addressed to ${mask}` : `emitted by ${mask}`;
  const qualifier = operation === "match" ? `which are ${fieldText}` : `which are not ${fieldText}`;
  const actionText = action === "drop" ? "Drops" : "Sends back";
  const firstLine = `${actionText} packets received on port ${operatingPort} ${qualifier}.`;
  if (action === "drop") {
    return firstLine;
  }
  if (collisionHandling === "drop_inbound") {
    return `${firstLine}\nIn case of collision, the packet received on port ${operatingPort} is dropped.`;
  }
  if (collisionHandling === "drop_outbound") {
    return `${firstLine}\nIn case of collision, the packet received on port ${nonOperatingPort} is dropped.`;
  }
  return `${firstLine}\nIn case of collision, the packet received on port ${nonOperatingPort} is sent back.`;
}

export function textTileSizeFromSettings(settings: Record<string, string>): { wTiles: number; hTiles: number } {
  const wRaw = Number.parseInt(settings.widthTiles ?? "2", 10);
  const hRaw = Number.parseInt(settings.heightTiles ?? "2", 10);
  const wTiles = Number.isFinite(wRaw) ? Math.max(2, Math.min(64, wRaw)) : 2;
  const hTiles = Number.isFinite(hRaw) ? Math.max(2, Math.min(64, hRaw)) : 2;
  return { wTiles, hTiles };
}

export function textTileSizeFromEntity(entity: { settings: Record<string, string> }): { wTiles: number; hTiles: number } {
  return textTileSizeFromSettings(entity.settings);
}
