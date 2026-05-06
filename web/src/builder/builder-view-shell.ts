import {
  CANVAS_SCALE_X_STEPS,
  canvasScaleXIndexFromValue,
  formatScaleLabel,
  type CanvasScale,
} from "./canvas-scale";

/** Static builder layout markup (scale slider initial values come from `canvasScale`). */
export function builderViewShellHtml(canvasScale: CanvasScale): string {
  return `
    <div
      class="builder-layout"
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
    >
      <aside class="builder-sidebar ui-panel">
        <div id="builder-controls-sidebar-host" class="builder-controls-sidebar-host"></div>
      </aside>
      <div class="builder-sidebar-resizer" role="button" tabindex="0" aria-label="Close side panel" title="Close side panel"></div>
      <main class="builder-main ui-panel">
        <div class="builder-canvas-wrap">
          <svg id="builder-wire-overlay" class="builder-wire-overlay"></svg>
          <canvas id="builder-packet-overlay" class="builder-packet-overlay" aria-hidden="true"></canvas>
          <div id="builder-canvas" class="builder-canvas"></div>
        </div>
        <div id="builder-controls-floating-host" class="builder-controls-floating-host" aria-label="Canvas tools">
          <div id="builder-panel-templates" class="builder-floating-tool-stack">
            <div id="builder-delete-drop-zone" class="builder-delete-drop-zone" aria-label="Drop here to delete">
              Drop to delete
            </div>
            <div id="builder-templates" class="builder-floating-templates"></div>
          </div>
          <div id="builder-wire-color-wheel-host" class="builder-wire-color-wheel-host"></div>
          <div id="builder-panel-scale" class="builder-floating-scale-area">
            <div class="builder-floating-scale" aria-label="Canvas scale controls">
              <div class="builder-scale-controls">
                <label class="builder-scale-row" for="builder-scale-x">
                  <span>Horizontal</span>
                  <input id="builder-scale-x" type="range" min="0" max="${CANVAS_SCALE_X_STEPS.length - 1}" step="1" value="${canvasScaleXIndexFromValue(canvasScale.x)}" />
                  <span id="builder-scale-x-value">${formatScaleLabel(canvasScale.x)}</span>
                </label>
                <label class="builder-scale-row" for="builder-scale-y-outer64">
                  <span>Octet 4</span>
                  <input id="builder-scale-y-outer64" type="range" min="0.25" max="4" step="0.25" value="${canvasScale.yByLayer.outer64.toFixed(2)}" />
                  <span id="builder-scale-y-outer64-value">${formatScaleLabel(canvasScale.yByLayer.outer64)}</span>
                </label>
                <label class="builder-scale-row" for="builder-scale-y-middle16">
                  <span>Octet 3</span>
                  <input id="builder-scale-y-middle16" type="range" min="0.25" max="4" step="0.25" value="${canvasScale.yByLayer.middle16.toFixed(2)}" />
                  <span id="builder-scale-y-middle16-value">${formatScaleLabel(canvasScale.yByLayer.middle16)}</span>
                </label>
                <label class="builder-scale-row" for="builder-scale-y-inner4">
                  <span>Octet 2</span>
                  <input id="builder-scale-y-inner4" type="range" min="0.25" max="4" step="0.25" value="${canvasScale.yByLayer.inner4.toFixed(2)}" />
                  <span id="builder-scale-y-inner4-value">${formatScaleLabel(canvasScale.yByLayer.inner4)}</span>
                </label>
                <label class="builder-scale-row" for="builder-scale-y-core1">
                  <span>Octet 1</span>
                  <input id="builder-scale-y-core1" type="range" min="0.25" max="4" step="0.25" value="${canvasScale.yByLayer.core1.toFixed(2)}" />
                  <span id="builder-scale-y-core1-value">${formatScaleLabel(canvasScale.yByLayer.core1)}</span>
                </label>
              </div>
            </div>
          </div>
          <div id="builder-sim-panel-host"></div>
          <div id="builder-panel-layouts" class="builder-floating-loadouts builder-floating-loadouts-detached">
            <div id="builder-layout-slots" class="builder-layout-slots builder-layout-slots--floating"></div>
          </div>
          <div id="builder-panel-performance" class="builder-floating-performance">
            <pre id="builder-perf" class="builder-perf">Collecting samples...</pre>
          </div>
        </div>
      </main>
    </div>
  `;
}
