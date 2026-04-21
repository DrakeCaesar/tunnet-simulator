import { Network } from "vis-network";
import { DataSet } from "vis-data";
import "vis-network/styles/vis-network.css";
import "./style.css";

type ViewerNode = {
  id: string;
  label: string;
  type: string;
  color: string;
  settings: string;
};

type ViewerEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
};

type ViewerPayload = {
  metadata: {
    generatedAt: string;
    phase: string;
    deviceCount: number;
    linkCount: number;
    flowCount: number;
  };
  nodes: ViewerNode[];
  edges: ViewerEdge[];
};

type GraphTheme = {
  endpointTextColor: string;
  deviceTextColor: string;
  edgeColor: string;
  edgeTextColor: string;
};

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function graphThemeFromCss(): GraphTheme {
  return {
    endpointTextColor: cssVar("--graph-node-endpoint-text", "#f0f2f7"),
    deviceTextColor: cssVar("--graph-node-device-text", "#111111"),
    edgeColor: cssVar("--graph-edge-color", "#7b8496"),
    edgeTextColor: cssVar("--graph-edge-text", "#9aa3b2"),
  };
}

function mountLayout(): {
  metaEl: HTMLDivElement;
  detailsEl: HTMLDivElement;
  graphEl: HTMLDivElement;
} {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("Missing #app root");
  }
  app.innerHTML = `
    <div class="layout">
      <div id="graph" class="graph"></div>
      <div class="panel">
        <h1 class="panel-title">Tunnet Topology Viewer</h1>
        <div id="meta" class="meta"></div>
        <div class="hint">Drag nodes, zoom, and click a node to inspect settings.</div>
        <div id="details" class="details">No node selected.</div>
      </div>
    </div>
  `;

  return {
    metaEl: app.querySelector<HTMLDivElement>("#meta")!,
    detailsEl: app.querySelector<HTMLDivElement>("#details")!,
    graphEl: app.querySelector<HTMLDivElement>("#graph")!,
  };
}

function render(payload: ViewerPayload): void {
  const { metaEl, detailsEl, graphEl } = mountLayout();
  const theme = graphThemeFromCss();

  metaEl.textContent =
    `Phase: ${payload.metadata.phase}\n` +
    `Generated: ${payload.metadata.generatedAt}\n` +
    `Devices: ${payload.metadata.deviceCount}  Links: ${payload.metadata.linkCount}  Flows: ${payload.metadata.flowCount}`;

  const nodes = new DataSet<any>(
    payload.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      color: n.color,
      shape: n.type === "endpoint" ? "dot" : "box",
      size: n.type === "endpoint" ? 12 : 16,
      borderWidth: 1,
      margin: { top: 8, right: 8, bottom: 8, left: 8 },
      font: {
        color: n.type === "endpoint" ? theme.endpointTextColor : theme.deviceTextColor,
        size: 12,
      },
      raw: n,
      title: n.settings,
    })),
  );

  const edges = new DataSet<any>(
    payload.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label,
      color: { color: theme.edgeColor, opacity: 0.6 },
      width: 1,
      smooth: { enabled: true, type: "dynamic", roundness: 0.5 },
      font: { color: theme.edgeTextColor, size: 10, align: "middle" as const },
      arrows: { to: { enabled: false } },
    })),
  );

  const network = new Network(
    graphEl,
    { nodes, edges },
    {
      interaction: { hover: true, multiselect: false, dragView: true, zoomView: true },
      physics: {
        enabled: true,
        stabilization: { iterations: 1200, fit: true },
        barnesHut: {
          gravitationalConstant: -4500,
          springLength: 90,
          springConstant: 0.04,
          damping: 0.14,
          avoidOverlap: 0.3,
        },
      },
      layout: { improvedLayout: true },
      edges: { selectionWidth: 2 },
    },
  );

  network.on("click", (params) => {
    if (!params.nodes.length) {
      detailsEl.textContent = "No node selected.";
      return;
    }
    const node = nodes.get(params.nodes[0]) as { raw?: ViewerNode } | null;
    if (!node?.raw) {
      detailsEl.textContent = "No details.";
      return;
    }
    detailsEl.textContent =
      `id=${node.raw.id}\n` +
      `type=${node.raw.type}\n` +
      `label=${node.raw.label}\n` +
      `settings:\n${node.raw.settings}`;
  });
}

async function main(): Promise<void> {
  try {
    const res = await fetch("/data/topology.json");
    if (!res.ok) {
      throw new Error(`Unable to load /data/topology.json (${res.status})`);
    }
    const payload = (await res.json()) as ViewerPayload;
    render(payload);
  } catch (err) {
    const { detailsEl } = mountLayout();
    detailsEl.textContent = `Failed to load topology data.\nRun: pnpm viewer:build\n\n${String(err)}`;
  }
}

void main();
