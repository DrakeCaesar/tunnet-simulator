export function mountLayout(): HTMLDivElement {
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
          <div id="sv-selected-device" class="meta sv-selected-device">Click a device in 2D view to inspect it.</div>
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
