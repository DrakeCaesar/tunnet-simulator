import {
  BuilderEntityRoot,
  BuilderLayer,
  BuilderTemplateType,
  createEntityRoot,
  createLinkRoot,
  createEmptyBuilderState,
  defaultSettings,
  removeEntityGroup,
  removeLinkGroup,
  updateEntityPosition,
  updateEntitySettings,
} from "./state";
import { expandBuilderState, layerColumns, layerTitle, orderedLayersTopDown, segmentLabel } from "./clone-engine";
import {
  exportBuilderStateText,
  importBuilderStateText,
  loadBuilderState,
  saveBuilderState,
} from "./persistence";
import { compileBuilderToViewerPayload } from "./compile";

const VIEWER_PREVIEW_KEY = "tunnet.builder.previewPayload";

interface BuilderMountOptions {
  root: HTMLDivElement;
  onPreviewReady?: () => void;
}

type EntitySelection = { kind: "entity"; rootId: string };
type LinkSelection = { kind: "link"; rootId: string };
type Selection = EntitySelection | LinkSelection | null;

interface LinkSourceSelection {
  rootId: string;
  port: number;
}

function templateList(): BuilderTemplateType[] {
  return ["endpoint", "relay", "hub", "filter"];
}

function templateLabel(type: BuilderTemplateType): string {
  if (type === "endpoint") return "Endpoint";
  if (type === "relay") return "Relay";
  if (type === "hub") return "Hub";
  return "Filter";
}

export function mountBuilderView(options: BuilderMountOptions): void {
  const { root, onPreviewReady } = options;
  let state = loadBuilderState();
  if (!state || state.version !== 1) {
    state = createEmptyBuilderState();
  }

  let draggingTemplate: BuilderTemplateType | null = null;
  let dragLayer: BuilderLayer | null = null;
  let dragSegment: number | null = null;
  let selection: Selection = null;
  let linkMode = false;
  let pendingLinkSource: LinkSourceSelection | null = null;

  root.innerHTML = `
    <div class="builder-layout">
      <aside class="builder-sidebar card">
        <div class="section-title">Templates</div>
        <div id="builder-templates"></div>
        <div class="section-title builder-spacer">Actions</div>
        <div class="builder-actions">
          <button id="builder-link-mode" type="button">Link Mode: Off</button>
          <button id="builder-delete" type="button">Delete Selected</button>
          <button id="builder-export" type="button">Export Text</button>
          <button id="builder-import" type="button">Import Text</button>
          <button id="builder-preview" type="button">Preview In Viewer</button>
        </div>
      </aside>
      <main class="builder-main card">
        <div class="section-title">Canvas (64 -> 16 -> 4)</div>
        <div class="builder-canvas-wrap">
          <svg id="builder-wire-overlay" class="builder-wire-overlay"></svg>
          <div id="builder-canvas" class="builder-canvas"></div>
        </div>
      </main>
      <aside class="builder-inspector card">
        <div class="section-title">Inspector</div>
        <div id="builder-inspector">No selection.</div>
      </aside>
    </div>
  `;

  const templatesEl = root.querySelector<HTMLDivElement>("#builder-templates")!;
  const canvasEl = root.querySelector<HTMLDivElement>("#builder-canvas")!;
  const wireOverlayEl = root.querySelector<SVGSVGElement>("#builder-wire-overlay")!;
  const inspectorEl = root.querySelector<HTMLDivElement>("#builder-inspector")!;
  const linkModeBtn = root.querySelector<HTMLButtonElement>("#builder-link-mode")!;
  const deleteBtn = root.querySelector<HTMLButtonElement>("#builder-delete")!;
  const exportBtn = root.querySelector<HTMLButtonElement>("#builder-export")!;
  const importBtn = root.querySelector<HTMLButtonElement>("#builder-import")!;
  const previewBtn = root.querySelector<HTMLButtonElement>("#builder-preview")!;

  function persist(): void {
    saveBuilderState(state);
  }

  function setSelection(next: Selection): void {
    selection = next;
    pendingLinkSource = null;
    renderInspector();
    renderCanvas();
  }

  function renderTemplates(): void {
    templatesEl.innerHTML = templateList()
      .map(
        (type) =>
          `<div class="builder-template" draggable="true" data-template="${type}">${templateLabel(type)}</div>`,
      )
      .join("");
    templatesEl.querySelectorAll<HTMLElement>(".builder-template").forEach((el) => {
      el.addEventListener("dragstart", (ev) => {
        draggingTemplate = el.dataset.template as BuilderTemplateType;
        if (ev.dataTransfer) {
          ev.dataTransfer.setData("text/plain", draggingTemplate);
          ev.dataTransfer.effectAllowed = "copy";
        }
      });
      el.addEventListener("dragend", () => {
        draggingTemplate = null;
        dragLayer = null;
        dragSegment = null;
        renderCanvas();
      });
    });
  }

  function previewInstances(): Set<string> {
    if (!draggingTemplate || dragLayer === null || dragSegment === null) {
      return new Set<string>();
    }
    const previewRoot: BuilderEntityRoot = {
      id: "preview",
      groupId: "preview",
      templateType: draggingTemplate,
      layer: dragLayer,
      segmentIndex: dragSegment,
      x: 0.08,
      y: 0.08,
      settings: defaultSettings(draggingTemplate),
    };
    return new Set(
      expandBuilderState({ version: 1, entities: [previewRoot], links: [], nextId: 0 }).entities.map(
        (entity) => `${entity.layer}:${entity.segmentIndex}`,
      ),
    );
  }

  function renderWireOverlay(links: ReturnType<typeof expandBuilderState>["links"]): void {
    const wrap = wireOverlayEl.parentElement;
    if (!wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const overlayWidth = Math.max(wrap.clientWidth, wrap.scrollWidth);
    wireOverlayEl.setAttribute("width", String(Math.ceil(overlayWidth)));
    wireOverlayEl.setAttribute("height", String(Math.ceil(wrapRect.height)));
    wireOverlayEl.innerHTML = "";
    for (const link of links) {
      const from = canvasEl.querySelector<HTMLButtonElement>(
        `.builder-port[data-instance-id="${link.fromInstanceId}"][data-port="${link.fromPort}"]`,
      );
      const to = canvasEl.querySelector<HTMLButtonElement>(
        `.builder-port[data-instance-id="${link.toInstanceId}"][data-port="${link.toPort}"]`,
      );
      if (!from || !to) continue;
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const x1 = fromRect.left + fromRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y1 = fromRect.top + fromRect.height / 2 - wrapRect.top;
      const x2 = toRect.left + toRect.width / 2 - wrapRect.left + wrap.scrollLeft;
      const y2 = toRect.top + toRect.height / 2 - wrapRect.top;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("stroke", link.isShadow ? "#6c768a" : "#f9e2af");
      line.setAttribute("stroke-opacity", link.isShadow ? "0.35" : "0.9");
      line.setAttribute("stroke-width", link.isShadow ? "1" : "1.5");
      wireOverlayEl.appendChild(line);
    }
  }

  function renderCanvas(): void {
    const expanded = expandBuilderState(state);
    const previewKeys = previewInstances();
    const entitiesByLayerSegment = new Map<string, typeof expanded.entities>();
    expanded.entities.forEach((entity) => {
      const key = `${entity.layer}:${entity.segmentIndex}`;
      if (!entitiesByLayerSegment.has(key)) entitiesByLayerSegment.set(key, []);
      entitiesByLayerSegment.get(key)!.push(entity);
    });

    canvasEl.innerHTML = orderedLayersTopDown()
      .map((layer) => {
        const columns = layerColumns(layer);
        return `
          <section class="builder-layer">
            <div class="builder-layer-title">${layerTitle(layer)}</div>
            <div class="builder-layer-grid builder-layer-${layer}" data-layer="${layer}">
              ${columns
                .map((segment) => {
                  const key = `${layer}:${segment}`;
                  const entities = entitiesByLayerSegment.get(key) ?? [];
                  const isDropTarget = dragLayer === layer && dragSegment === segment;
                  return `
                    <div class="builder-segment ${isDropTarget ? "drop-target" : ""}" data-layer="${layer}" data-segment="${segment}">
                      <div class="builder-segment-label">${segmentLabel(layer, segment)}</div>
                      <div class="builder-segment-entities">
                        ${entities
                          .map((entity) => {
                            const selected =
                              selection?.kind === "entity" && selection.rootId === entity.rootId ? "selected" : "";
                            const shadow = entity.isShadow ? "shadow" : "";
                            const linkSource =
                              pendingLinkSource && pendingLinkSource.rootId === entity.rootId
                                ? "link-source"
                                : "";
                            const settingsText = Object.entries(entity.settings)
                              .slice(0, 3)
                              .map(([k, v]) => `${k}=${v}`)
                              .join("<br/>");
                            const filterControls =
                              entity.templateType === "filter"
                                ? `
                                  <div class="builder-inline-controls" data-root-id="${entity.rootId}">
                                    <button class="builder-inline-btn" data-setting-toggle="operatingPort" data-root-id="${entity.rootId}" type="button">opPort:${entity.settings.operatingPort ?? "0"}</button>
                                    <button class="builder-inline-btn" data-setting-toggle="addressField" data-root-id="${entity.rootId}" type="button">field:${entity.settings.addressField ?? "destination"}</button>
                                    <button class="builder-inline-btn" data-setting-toggle="operation" data-root-id="${entity.rootId}" type="button">op:${entity.settings.operation ?? "differ"}</button>
                                    <button class="builder-inline-btn" data-setting-toggle="action" data-root-id="${entity.rootId}" type="button">action:${entity.settings.action ?? "send_back"}</button>
                                    <button class="builder-inline-btn" data-setting-toggle="collisionHandling" data-root-id="${entity.rootId}" type="button">collision:${entity.settings.collisionHandling ?? "send_back_outbound"}</button>
                                    <div class="builder-mask-row">
                                      ${[0, 1, 2, 3]
                                        .map(
                                          (idx) => `
                                            <div class="builder-mask-cell">
                                              <button class="builder-mask-arrow" data-mask-dir="up" data-mask-idx="${idx}" data-root-id="${entity.rootId}" type="button">▲</button>
                                              <span>${(entity.settings.mask ?? "*.*.*.*").split(".")[idx] ?? "*"}</span>
                                              <button class="builder-mask-arrow" data-mask-dir="down" data-mask-idx="${idx}" data-root-id="${entity.rootId}" type="button">▼</button>
                                            </div>
                                          `,
                                        )
                                        .join("")}
                                    </div>
                                  </div>
                                `
                                : "";
                            return `
                              <div
                                class="builder-entity ${selected} ${shadow} ${linkSource}"
                                data-instance-id="${entity.instanceId}"
                                data-root-id="${entity.rootId}"
                                style="left:${entity.x * 100}%;top:${entity.y * 100}%"
                              >
                                <div class="builder-entity-title">${entity.templateType}</div>
                                <div class="builder-entity-settings">${settingsText}</div>
                                ${filterControls}
                                <div class="builder-ports">
                                  ${entity.ports
                                    .map(
                                      (port) =>
                                        `<button class="builder-port" data-instance-id="${entity.instanceId}" data-root-id="${entity.rootId}" data-port="${port}" type="button">${port}</button>`,
                                    )
                                    .join("")}
                                </div>
                              </div>
                            `;
                          })
                          .join("")}
                        ${previewKeys.has(key) ? `<div class="builder-entity preview">${templateLabel(draggingTemplate!)} preview</div>` : ""}
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

    const setHoverFromEvent = (ev: DragEvent): void => {
      const target = ev.target as HTMLElement | null;
      const cell = target?.closest<HTMLElement>(".builder-segment");
      if (!cell) return;
      const nextLayer = cell.dataset.layer as BuilderLayer;
      const nextSegment = Number(cell.dataset.segment);
      if (dragLayer !== nextLayer || dragSegment !== nextSegment) {
        dragLayer = nextLayer;
        dragSegment = nextSegment;
        renderCanvas();
      }
    };

    const handleDrop = (ev: DragEvent): void => {
      ev.preventDefault();
      const target = ev.target as HTMLElement | null;
      const cell = target?.closest<HTMLElement>(".builder-segment");
      if (!cell) return;
      const droppedTemplate =
        draggingTemplate ??
        ((ev.dataTransfer?.getData("text/plain") as BuilderTemplateType | "") || null);
      if (!droppedTemplate) return;
      const layer = cell.dataset.layer as BuilderLayer;
      const segment = Number(cell.dataset.segment);
      const segmentRect = cell.getBoundingClientRect();
      const px = (ev.clientX - segmentRect.left) / Math.max(1, segmentRect.width);
      const py = (ev.clientY - segmentRect.top) / Math.max(1, segmentRect.height);
      const rootEntity = createEntityRoot(state, droppedTemplate, layer, segment, px, py);
      state = { ...state, entities: [...state.entities, rootEntity] };
      persist();
      draggingTemplate = null;
      dragLayer = null;
      dragSegment = null;
      renderCanvas();
    };

    // Delegated DnD handlers are more reliable than per-cell listeners while rerendering.
    canvasEl.ondragenter = (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      setHoverFromEvent(ev);
    };
    canvasEl.ondragover = (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      setHoverFromEvent(ev);
    };
    canvasEl.ondragleave = (ev) => {
      const related = ev.relatedTarget as Node | null;
      if (!related || !canvasEl.contains(related)) {
        dragLayer = null;
        dragSegment = null;
        renderCanvas();
      }
    };
    canvasEl.ondrop = handleDrop;

    canvasEl.querySelectorAll<HTMLElement>(".builder-entity").forEach((entityEl) => {
      entityEl.addEventListener("click", () => {
        const rootId = entityEl.dataset.rootId!;
        setSelection({ kind: "entity", rootId });
      });
    });

    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-port").forEach((portEl) => {
      portEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!linkMode) return;
        const rootId = portEl.dataset.rootId!;
        const port = Number(portEl.dataset.port);
        if (!pendingLinkSource) {
          pendingLinkSource = { rootId, port };
          renderCanvas();
          return;
        }
        if (pendingLinkSource.rootId === rootId && pendingLinkSource.port === port) {
          pendingLinkSource = null;
          renderCanvas();
          return;
        }
        const fromRoot = state.entities.find((e) => e.id === pendingLinkSource!.rootId);
        const toRoot = state.entities.find((e) => e.id === rootId);
        if (!fromRoot || !toRoot) {
          pendingLinkSource = null;
          renderCanvas();
          return;
        }
        const link = createLinkRoot(state, fromRoot.id, pendingLinkSource.port, toRoot.id, port);
        state = { ...state, links: [...state.links, link] };
        persist();
        pendingLinkSource = null;
        setSelection({ kind: "link", rootId: link.id });
      });
    });

    const cycleValue = (value: string, options: string[]): string => {
      const idx = options.indexOf(value);
      return options[(idx + 1 + options.length) % options.length];
    };
    const setFilterSetting = (rootId: string, key: string): void => {
      const root = state.entities.find((e) => e.id === rootId);
      if (!root) return;
      const current = root.settings[key] ?? "";
      let next = current;
      if (key === "operatingPort") next = current === "1" ? "0" : "1";
      if (key === "addressField") next = current === "source" ? "destination" : "source";
      if (key === "operation") next = current === "match" ? "differ" : "match";
      if (key === "action") next = current === "drop" ? "send_back" : "drop";
      if (key === "collisionHandling") {
        next = cycleValue(current || "send_back_outbound", [
          "send_back_outbound",
          "drop_inbound",
          "drop_outbound",
        ]);
      }
      state = updateEntitySettings(state, root.id, { ...root.settings, [key]: next });
      persist();
      renderCanvas();
      renderInspector();
    };
    const updateMaskAt = (rootId: string, maskIdx: number, dir: "up" | "down"): void => {
      const root = state.entities.find((e) => e.id === rootId);
      if (!root) return;
      const parts = (root.settings.mask ?? "*.*.*.*").split(".");
      while (parts.length < 4) parts.push("*");
      let value = Number(parts[maskIdx]);
      if (!Number.isFinite(value)) value = 0;
      value = dir === "up" ? (value + 1) % 4 : (value + 3) % 4;
      const nextParts = ["*", "*", "*", "*"];
      nextParts[maskIdx] = String(value);
      state = updateEntitySettings(state, root.id, { ...root.settings, mask: nextParts.join(".") });
      persist();
      renderCanvas();
      renderInspector();
    };

    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-inline-btn[data-setting-toggle]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rootId = btn.dataset.rootId;
        const key = btn.dataset.settingToggle;
        if (!rootId || !key) return;
        setFilterSetting(rootId, key);
      });
    });
    canvasEl.querySelectorAll<HTMLButtonElement>(".builder-mask-arrow").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rootId = btn.dataset.rootId;
        const rawIdx = btn.dataset.maskIdx;
        const dir = btn.dataset.maskDir === "down" ? "down" : "up";
        if (!rootId || rawIdx === undefined) return;
        updateMaskAt(rootId, Number(rawIdx), dir);
      });
    });

    canvasEl.querySelectorAll<HTMLElement>(".builder-entity").forEach((entityEl) => {
      entityEl.addEventListener("mousedown", (ev) => {
        const target = ev.target as HTMLElement;
        if (target.closest("button")) return;
        const rootId = entityEl.dataset.rootId!;
        const root = state.entities.find((e) => e.id === rootId);
        const seg = entityEl.closest<HTMLElement>(".builder-segment");
        if (!root || !seg) return;
        ev.preventDefault();
        const segRect = seg.getBoundingClientRect();
        const anchorX = (ev.clientX - segRect.left) / Math.max(1, segRect.width);
        const anchorY = (ev.clientY - segRect.top) / Math.max(1, segRect.height);
        const dx = anchorX - root.x;
        const dy = anchorY - root.y;
        const onMove = (mv: MouseEvent): void => {
          const x = (mv.clientX - segRect.left) / Math.max(1, segRect.width) - dx;
          const y = (mv.clientY - segRect.top) / Math.max(1, segRect.height) - dy;
          state = updateEntityPosition(state, root.id, x, y);
          renderCanvas();
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          persist();
          renderInspector();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    });

    renderWireOverlay(expanded.links);
  }

  function renderInspector(): void {
    if (!selection) {
      inspectorEl.textContent = "No selection.";
      return;
    }
    if (selection.kind === "link") {
      const link = state.links.find((l) => l.id === selection.rootId);
      if (!link) {
        inspectorEl.textContent = "Link missing.";
        return;
      }
      inspectorEl.innerHTML = `
        <div class="kv"><span>Type</span><strong>Link</strong></div>
        <div class="kv"><span>From</span><strong>${link.fromEntityId}:${link.fromPort}</strong></div>
        <div class="kv"><span>To</span><strong>${link.toEntityId}:${link.toPort}</strong></div>
      `;
      return;
    }
    const entity = state.entities.find((e) => e.id === selection.rootId);
    if (!entity) {
      inspectorEl.textContent = "Entity missing.";
      return;
    }
    const entries = Object.entries(entity.settings);
    inspectorEl.innerHTML = `
      <div class="kv"><span>Type</span><strong>${entity.templateType}</strong></div>
      <div class="kv"><span>Layer</span><strong>${entity.layer}</strong></div>
      <div class="kv"><span>Segment</span><strong>${entity.segmentIndex}</strong></div>
      <div class="builder-settings">
        ${entries
          .map(
            ([k, v]) =>
              `<label class="builder-setting"><span>${k}</span><input data-setting-key="${k}" type="text" value="${v}" /></label>`,
          )
          .join("")}
      </div>
    `;
    inspectorEl.querySelectorAll<HTMLInputElement>("input[data-setting-key]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.settingKey!;
        const next = { ...entity.settings, [key]: input.value };
        state = updateEntitySettings(state, entity.id, next);
        persist();
        renderInspector();
        renderCanvas();
      });
    });
  }

  linkModeBtn.addEventListener("click", () => {
    linkMode = !linkMode;
    linkModeBtn.textContent = `Link Mode: ${linkMode ? "On" : "Off"}`;
    pendingLinkSource = null;
    renderCanvas();
  });

  deleteBtn.addEventListener("click", () => {
    if (!selection) return;
    if (selection.kind === "entity") {
      state = removeEntityGroup(state, selection.rootId);
    } else {
      state = removeLinkGroup(state, selection.rootId);
    }
    persist();
    selection = null;
    renderInspector();
    renderCanvas();
  });

  exportBtn.addEventListener("click", async () => {
    const text = exportBuilderStateText(state);
    await navigator.clipboard.writeText(text);
    alert("Builder state copied to clipboard.");
  });

  importBtn.addEventListener("click", () => {
    const text = window.prompt("Paste builder JSON:");
    if (!text) return;
    const parsed = importBuilderStateText(text);
    if (!parsed) {
      alert("Invalid builder JSON.");
      return;
    }
    state = parsed;
    persist();
    selection = null;
    renderInspector();
    renderCanvas();
  });

  previewBtn.addEventListener("click", () => {
    const payload = compileBuilderToViewerPayload(state);
    window.sessionStorage.setItem(VIEWER_PREVIEW_KEY, JSON.stringify(payload));
    onPreviewReady?.();
  });

  renderTemplates();
  renderInspector();
  renderCanvas();
}

export { VIEWER_PREVIEW_KEY };
