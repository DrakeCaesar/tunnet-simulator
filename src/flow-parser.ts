import { readFileSync } from "node:fs";
import { FlowEdge, FlowGraph } from "./types.js";

const NODE_LINE = /^"([^"]+)"(?:\[(.+)\])?$/;
const EDGE_LINE = /^"([^"]+)"\s*->\s*"([^"]+)"(?:\[(.+)\])?$/;
const COLOR_ATTR = /color=([a-zA-Z0-9#]+)/;

function parseAttrColor(attrText?: string): string | undefined {
  if (!attrText) {
    return undefined;
  }
  const m = COLOR_ATTR.exec(attrText);
  return m?.[1];
}

export function parseFlowFile(path: string): FlowGraph {
  const text = readFileSync(path, "utf8");
  const nodes = new Set<string>();
  const nodeColors = new Map<string, string>();
  const edges: FlowEdge[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    const edgeMatch = EDGE_LINE.exec(line);
    if (edgeMatch) {
      const [, src, dst, attrs] = edgeMatch;
      nodes.add(src);
      nodes.add(dst);
      edges.push({ src, dst, color: parseAttrColor(attrs) });
      continue;
    }

    const nodeMatch = NODE_LINE.exec(line);
    if (nodeMatch) {
      const [, node, attrs] = nodeMatch;
      nodes.add(node);
      const color = parseAttrColor(attrs);
      if (color) {
        nodeColors.set(node, color);
      }
    }
  }

  return { nodes, nodeColors, edges };
}

export function mergeFlowGraphs(a: FlowGraph, b: FlowGraph): FlowGraph {
  const nodes = new Set<string>([...a.nodes, ...b.nodes]);
  const nodeColors = new Map<string, string>([...a.nodeColors, ...b.nodeColors]);
  const edgeKey = new Set<string>();
  const edges: FlowEdge[] = [];

  for (const edge of [...a.edges, ...b.edges]) {
    const key = `${edge.src}::${edge.dst}`;
    if (edgeKey.has(key)) {
      continue;
    }
    edgeKey.add(key);
    edges.push(edge);
  }

  return { nodes, nodeColors, edges };
}
