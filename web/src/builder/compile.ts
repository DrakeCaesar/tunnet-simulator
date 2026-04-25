import { BuilderEntityInstance, expandBuilderState } from "./clone-engine";
import { BuilderState } from "./state";

interface BuilderNode {
  id: string;
  label: string;
  type: string;
  color: string;
  settings: Record<string, string>;
  settingsText: string;
}

interface BuilderEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

interface DeviceBase {
  id: string;
  type: string;
}

interface TopologyLinkPort {
  deviceId: string;
  port: number;
}

function settingsToText(settings: Record<string, string>): string {
  return Object.entries(settings)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function colorForType(type: string): string {
  if (type === "endpoint") return "#89b4fa";
  if (type === "hub") return "#f9e2af";
  if (type === "filter") return "#f5c2e7";
  return "#cdd6f4";
}

function makeDevice(entity: BuilderEntityInstance): (DeviceBase & Record<string, unknown>) | null {
  if (entity.templateType === "text") {
    return null;
  }
  if (entity.templateType === "endpoint") {
    return {
      id: entity.instanceId,
      type: "endpoint",
      address: entity.settings.address ?? "0.0.0.0",
      state: { nextSendTick: 0 },
    };
  }
  if (entity.templateType === "hub") {
    return {
      id: entity.instanceId,
      type: "hub",
      rotation: entity.settings.rotation === "counterclockwise" ? "counterclockwise" : "clockwise",
    };
  }
  if (entity.templateType === "filter") {
    return {
      id: entity.instanceId,
      type: "filter",
      operatingPort: Number(entity.settings.operatingPort ?? 0) === 1 ? 1 : 0,
      addressField: entity.settings.addressField === "source" ? "source" : "destination",
      operation: entity.settings.operation === "match" ? "match" : "differ",
      mask: entity.settings.mask ?? "*.*.*.*",
      action: entity.settings.action === "drop" ? "drop" : "send_back",
      collisionHandling:
        entity.settings.collisionHandling === "drop_inbound" ||
        entity.settings.collisionHandling === "drop_outbound"
          ? entity.settings.collisionHandling
          : "send_back_outbound",
    };
  }
  return {
    id: entity.instanceId,
    type: "relay",
  };
}

export interface CompiledBuilderPayload {
  metadata: {
    generatedAt: string;
    phase: string;
    boundaryOrder: number;
    deviceCount: number;
    linkCount: number;
    flowCount: number;
    sourceEndpointCount: number;
  };
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  topology: {
    devices: Record<string, Record<string, unknown>>;
    links: Array<{ a: TopologyLinkPort; b: TopologyLinkPort }>;
  };
}

export function compileBuilderPayload(state: BuilderState): CompiledBuilderPayload {
  const expanded = expandBuilderState(state);
  const nodes = expanded.entities.map((entity) => ({
    id: entity.instanceId,
    label: `${entity.templateType}:${entity.instanceId}`,
    type: entity.templateType,
    color: colorForType(entity.templateType),
    settings: entity.settings,
    settingsText: settingsToText(entity.settings),
  }));
  const edges = expanded.links.map((link) => ({
    id: link.instanceId,
    from: link.fromInstanceId,
    to: link.toInstanceId,
    label: `${link.fromPort}<->${link.toPort}`,
  }));
  const devices: Record<string, Record<string, unknown>> = {};
  expanded.entities.forEach((entity) => {
    const device = makeDevice(entity);
    if (device) {
      devices[entity.instanceId] = device;
    }
  });
  const links = expanded.links
    .filter((link) => devices[link.fromInstanceId] !== undefined && devices[link.toInstanceId] !== undefined)
    .map((link) => ({
      a: { deviceId: link.fromInstanceId, port: link.fromPort },
      b: { deviceId: link.toInstanceId, port: link.toPort },
    }));
  const endpointEntities = expanded.entities.filter((e) => e.templateType === "endpoint");
  const sourceEndpointEntities = endpointEntities.filter((e) => !e.isShadow);
  const uniqueAddresses = Array.from(
    new Set(endpointEntities.map((e) => e.settings.address ?? "0.0.0.0")),
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  sourceEndpointEntities.forEach((entity) => {
    const addr = entity.settings.address ?? "0.0.0.0";
    const destinations = uniqueAddresses.filter((d) => d !== addr);
    if (destinations.length === 0) return;
    const device = devices[entity.instanceId];
    if (!device || device.type !== "endpoint") return;
    (device as Record<string, unknown>).generator = {
      destinations: [...destinations],
      replyToSources: [...destinations],
      minIntervalTicks: 3,
      maxIntervalTicks: 7,
      sensitiveChance: 0.1,
      subjectPrefix: "BDR-",
    };
  });
  const sourceEndpointCount = sourceEndpointEntities.length;
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      phase: "builder-manual",
      boundaryOrder: 0,
      deviceCount: nodes.length,
      linkCount: edges.length,
      flowCount: 0,
      sourceEndpointCount,
    },
    nodes,
    edges,
    topology: { devices, links },
  };
}
