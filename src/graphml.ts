import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Device, Topology } from "./types.js";

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeColor(input?: string): string {
  if (!input) {
    return "#d9d9d9";
  }
  const raw = input.trim().toLowerCase();
  if (raw.startsWith("#")) {
    return raw.length === 4
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
  }
  const map: Record<string, string> = {
    blue: "#1f77b4",
    red: "#d62728",
    grey: "#7f7f7f",
    gray: "#7f7f7f",
    green: "#2ca02c",
    brown: "#8c564b",
  };
  return map[raw] ?? "#d9d9d9";
}

function endpointColorFromMap(address: string, nodeColors: Map<string, string>): string {
  return normalizeColor(nodeColors.get(address));
}

function nodeLabel(device: Device): string {
  if (device.type === "endpoint") {
    return `${device.address}`;
  }
  if (device.type === "relay") {
    return `${device.id}\nrelay`;
  }
  if (device.type === "hub") {
    return `${device.id}\nhub\nrotation=${device.rotation}`;
  }
  return [
    `${device.id}`,
    "filter",
    `operatingPort=${device.operatingPort}`,
    `addressField=${device.addressField}`,
    `operation=${device.operation}`,
    `mask=${device.mask}`,
    `action=${device.action}`,
    `collision=${device.collisionHandling}`,
  ].join("\n");
}

function nodeFill(device: Device, nodeColors: Map<string, string>): string {
  if (device.type === "endpoint") {
    return endpointColorFromMap(device.address, nodeColors);
  }
  if (device.type === "hub") {
    return "#f9e2af";
  }
  if (device.type === "filter") {
    return "#f5c2e7";
  }
  return "#cdd6f4";
}

function deviceSettingsText(device: Device): string {
  if (device.type === "endpoint") {
    const parts = [`address=${device.address}`];
    if (device.generator) {
      parts.push(`generator.destinations=${device.generator.destinations.join(",")}`);
      parts.push(
        `generator.interval=${device.generator.minIntervalTicks}-${device.generator.maxIntervalTicks}`,
      );
      parts.push(`generator.sensitiveChance=${device.generator.sensitiveChance}`);
      if (device.generator.ttl !== undefined) {
        parts.push(`generator.ttl=${device.generator.ttl}`);
      }
    }
    return parts.join(";");
  }
  if (device.type === "relay") {
    return "mode=pass-through";
  }
  if (device.type === "hub") {
    return `rotation=${device.rotation}`;
  }
  return [
    `operatingPort=${device.operatingPort}`,
    `addressField=${device.addressField}`,
    `operation=${device.operation}`,
    `mask=${device.mask}`,
    `action=${device.action}`,
    `collisionHandling=${device.collisionHandling}`,
  ].join(";");
}

/**
 * Export topology to yEd-compatible GraphML.
 * Endpoints display their IP and color; configurable devices include settings.
 */
export function exportTopologyGraphMl(
  topology: Topology,
  outputPath: string,
  nodeColors: Map<string, string>,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });

  const nodeXml = Object.values(topology.devices)
    .map((device) => {
      const label = xmlEscape(nodeLabel(device));
      const fill = xmlEscape(nodeFill(device, nodeColors));
      const type = xmlEscape(device.type);
      const settings = xmlEscape(deviceSettingsText(device));
      const id = xmlEscape(device.id);
      return [
        `    <node id="${id}">`,
        `      <data key="d0">${type}</data>`,
        `      <data key="d1">${settings}</data>`,
        `      <data key="d2">`,
        `        <y:ShapeNode>`,
        `          <y:Fill color="${fill}" transparent="false"/>`,
        `          <y:BorderStyle color="#333333" type="line" width="1.0"/>`,
        `          <y:NodeLabel>${label}</y:NodeLabel>`,
        `          <y:Shape type="roundrectangle"/>`,
        `        </y:ShapeNode>`,
        `      </data>`,
        `    </node>`,
      ].join("\n");
    })
    .join("\n");

  const edgeXml = topology.links
    .map((link, index) => {
      const id = `e${index}`;
      const source = xmlEscape(link.a.deviceId);
      const target = xmlEscape(link.b.deviceId);
      const ports = xmlEscape(`${link.a.port}<->${link.b.port}`);
      return [
        `    <edge id="${id}" source="${source}" target="${target}">`,
        `      <data key="d3">${ports}</data>`,
        `      <data key="d4">`,
        `        <y:PolyLineEdge>`,
        `          <y:LineStyle color="#808080" type="line" width="1.0"/>`,
        `          <y:Arrows source="none" target="none"/>`,
        `          <y:EdgeLabel>${ports}</y:EdgeLabel>`,
        `        </y:PolyLineEdge>`,
        `      </data>`,
        `    </edge>`,
      ].join("\n");
    })
    .join("\n");

  const graphml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<graphml`,
    `  xmlns="http://graphml.graphdrawing.org/xmlns"`,
    `  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
    `  xmlns:y="http://www.yworks.com/xml/graphml"`,
    `  xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns`,
    `   http://www.yworks.com/xml/schema/graphml/1.1/ygraphml.xsd">`,
    `  <key id="d0" for="node" attr.name="deviceType" attr.type="string"/>`,
    `  <key id="d1" for="node" attr.name="settings" attr.type="string"/>`,
    `  <key id="d2" for="node" yfiles.type="nodegraphics"/>`,
    `  <key id="d3" for="edge" attr.name="ports" attr.type="string"/>`,
    `  <key id="d4" for="edge" yfiles.type="edgegraphics"/>`,
    `  <graph id="G" edgedefault="undirected">`,
    nodeXml,
    edgeXml,
    `  </graph>`,
    `</graphml>`,
    "",
  ].join("\n");

  writeFileSync(outputPath, graphml, "utf8");
}
