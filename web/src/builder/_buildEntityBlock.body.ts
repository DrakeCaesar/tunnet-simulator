    const selected =
      selection?.kind === "entity" && selection.rootId === entity.rootId ? "selected" : "";
    const shadow = entity.isShadow ? "shadow" : "";
    const settingsText = Object.entries(entity.settings)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join("<br/>");
    const maskParts = (entity.settings.mask ?? "*.*.*.*").split(".");
    while (maskParts.length < 4) maskParts.push("*");
    const displayAddressField =
      (entity.settings.addressField ?? "destination") === "source"
        ? "Source"
        : "Destination";
    const displayOperation =
      (entity.settings.operation ?? "differ") === "match" ? "Match" : "Differ";
    const displayAction =
      (entity.settings.action ?? "send_back") === "drop" ? "Drop" : "Send back";
    const displayCollision =
      (() => {
        const value = entity.settings.collisionHandling ?? "send_back_outbound";
        if (value === "drop_inbound") return "Drop<br/>Inbound";
        if (value === "drop_outbound") return "Drop<br/>Outbound";
        return "Send back<br/>Outbound";
      })();
    const filterControls =
      entity.templateType === "filter"
        ? `
          <div class="builder-filter-ui" data-root-id="${entity.rootId}">
            <div class="builder-filter-left">
              <div class="builder-row">
                <span class="builder-row-label">Port:</span>
                <div class="builder-cycle">
                  <button class="builder-cycle-btn" data-setting-cycle="operatingPort" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                  <span class="builder-cycle-value">${entity.settings.operatingPort ?? "0"}</span>
                  <button class="builder-cycle-btn" data-setting-cycle="operatingPort" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                </div>
              </div>
              <div class="builder-row">
                <span class="builder-row-label">Address:</span>
                <div class="builder-cycle">
                  <button class="builder-cycle-btn" data-setting-cycle="addressField" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                  <span class="builder-cycle-value">${displayAddressField}</span>
                  <button class="builder-cycle-btn" data-setting-cycle="addressField" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                </div>
              </div>
              <div class="builder-row">
                <span class="builder-row-label">Operation:</span>
                <div class="builder-cycle">
                  <button class="builder-cycle-btn" data-setting-cycle="operation" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                  <span class="builder-cycle-value">${displayOperation}</span>
                  <button class="builder-cycle-btn" data-setting-cycle="operation" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                </div>
              </div>
              <div class="builder-row builder-row-mask">
                <span class="builder-row-label">Mask:</span>
                <div class="builder-mask-row">
                  ${[0, 1, 2, 3]
                    .map(
                      (idx) => `
                        <div class="builder-mask-cell">
                          <button class="builder-mask-arrow" data-mask-dir="up" data-mask-idx="${idx}" data-root-id="${entity.rootId}" type="button">+</button>
                          <span>${maskParts[idx] ?? "*"}</span>
                          <button class="builder-mask-arrow" data-mask-dir="down" data-mask-idx="${idx}" data-root-id="${entity.rootId}" type="button">-</button>
                        </div>
                      `,
                    )
                    .join(`<span class="builder-mask-dot" aria-hidden="true">.</span>`)}
                </div>
              </div>
              <div class="builder-row">
                <span class="builder-row-label">Action:</span>
                <div class="builder-cycle">
                  <button class="builder-cycle-btn" data-setting-cycle="action" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                  <span class="builder-cycle-value">${displayAction}</span>
                  <button class="builder-cycle-btn" data-setting-cycle="action" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                </div>
              </div>
              ${
                (entity.settings.action ?? "send_back") === "send_back"
                  ? `
                <div class="builder-row builder-row-collision">
                  <span class="builder-row-label">Collision<br/>handling:</span>
                  <div class="builder-cycle builder-cycle--tall">
                    <button class="builder-cycle-btn" data-setting-cycle="collisionHandling" data-dir="prev" data-root-id="${entity.rootId}" type="button">&lt;</button>
                    <span class="builder-cycle-value">${displayCollision}</span>
                    <button class="builder-cycle-btn" data-setting-cycle="collisionHandling" data-dir="next" data-root-id="${entity.rootId}" type="button">&gt;</button>
                  </div>
                </div>
              `
                  : ""
              }
            </div>
          </div>
        `
        : "";
    const hubCw = (entity.settings.rotation ?? "clockwise") !== "counterclockwise";
    const hubFaceDeg =
      ((Number.parseFloat(entity.settings.faceAngle ?? "0") % 360) + 360) % 360;
    const hubOriginX = (HUB_LAYOUT.G.x / HUB_VIEW.w) * 100;
    const hubOriginY = (HUB_LAYOUT.G.y / HUB_VIEW.h) * 100;
    const hubBlock =
      entity.templateType === "hub"
        ? `<div class="builder-hub" data-face-angle="${hubFaceDeg}">
        <div class="builder-hub-rot" style="transform:rotate(${hubFaceDeg}deg);transform-origin:${hubOriginX}% ${hubOriginY}%;">
          ${hubTriangleSvg(entity.instanceId, entity.settings.rotation)}
          <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.T, hubFaceDeg)}" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="0">0</button>
          <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.R, hubFaceDeg)}" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="1">1</button>
          <button type="button" class="builder-port builder-hub-port" style="${hubPortPinUprightStyle(HUB_LAYOUT.L, hubFaceDeg)}" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="2">2</button>
        </div>
        <button type="button" class="builder-hub-reverse" style="left:${hubOriginX}%;top:${hubOriginY}%;transform:translate(-50%,-50%)" data-hub-toggle-rotation data-root-id="${entity.rootId}" title="Reverse forwarding direction"><span class="builder-hub-reverse-icon" aria-hidden="true">${hubCw ? "↻" : "↺"}</span></button>
      </div>`
        : "";
    const entityShapeClass =
      entity.templateType === "filter"
        ? " builder-entity--filter"
        : entity.templateType === "hub"
          ? " builder-entity--hub"
          : "";
    const settingsBlock =
      entity.templateType === "filter" || entity.templateType === "hub"
        ? ""
        : `<div class="builder-entity-settings">${settingsText}</div>`;
    const portBtn = (port: number): string =>
      `<button class="builder-port" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="${port}" type="button">${port}</button>`;
    const portsRow =
      entity.templateType === "filter"
        ? `<div class="builder-ports builder-ports--filter-bottom">${portBtn(1)}</div>`
        : entity.templateType === "hub"
          ? ""
          : `<div class="builder-ports">${entity.ports.map((p) => portBtn(p)).join("")}</div>`;
    return `
      <div
        class="builder-entity ${selected} ${shadow} ${entityShapeClass}"
        data-instance-id="${entity.instanceId}"
        data-root-id="${entity.rootId}"
        style="left:${entity.x * 100}%;top:${entity.y * 100}%"
      >
        ${
          entity.templateType === "filter"
            ? `<div class="builder-ports builder-ports--filter-top">${portBtn(0)}</div>`
            : ""
        }
        ${entity.templateType === "hub" ? "" : `<div class="builder-entity-title">${entity.templateType}</div>`}
        ${settingsBlock}
        ${filterControls}
        ${hubBlock}
        ${portsRow}
      </div>
    `;