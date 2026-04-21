export type Address = string;

export interface Packet {
  id: number;
  src: Address;
  dest: Address;
  ttl?: number;
  sensitive: boolean;
  subject?: string;
}

export type DeviceType = "endpoint" | "relay" | "hub" | "filter";

export interface BaseDevice {
  id: string;
  type: DeviceType;
}

export interface EndpointGeneratorConfig {
  destinations: Address[];
  minIntervalTicks: number;
  maxIntervalTicks: number;
  sensitiveChance: number;
  ttl?: number;
  subjectPrefix?: string;
}

export interface EndpointState {
  nextSendTick: number;
}

export interface EndpointDevice extends BaseDevice {
  type: "endpoint";
  address: Address;
  generator?: EndpointGeneratorConfig;
  state: EndpointState;
}

export interface RelayDevice extends BaseDevice {
  type: "relay";
}

export type HubRotation = "clockwise" | "counterclockwise";

export interface HubDevice extends BaseDevice {
  type: "hub";
  rotation: HubRotation;
}

export type FilterAddressField = "source" | "destination";
export type FilterOperation = "match" | "differ";
export type FilterAction = "send_back" | "drop";
export type FilterCollisionHandling =
  | "drop_inbound"
  | "drop_outbound"
  | "send_back_outbound";

export interface FilterDevice extends BaseDevice {
  type: "filter";
  operatingPort: 0 | 1;
  addressField: FilterAddressField;
  operation: FilterOperation;
  mask: string;
  action: FilterAction;
  collisionHandling: FilterCollisionHandling;
}

export type Device = EndpointDevice | RelayDevice | HubDevice | FilterDevice;

export interface PortRef {
  deviceId: string;
  port: number;
}

export interface Link {
  a: PortRef;
  b: PortRef;
}

export interface Topology {
  devices: Record<string, Device>;
  links: Link[];
}

export interface SimulationStats {
  tick: number;
  emitted: number;
  delivered: number;
  dropped: number;
  bounced: number;
  ttlExpired: number;
  collisions: number;
}

export interface SimulationSnapshot {
  tick: number;
  inFlightPackets: number;
  stats: SimulationStats;
}

export interface FlowEdge {
  src: Address;
  dst: Address;
  color?: string;
}

export interface FlowGraph {
  nodes: Set<Address>;
  nodeColors: Map<Address, string>;
  edges: FlowEdge[];
}

export interface SynthesisReport {
  totalEdges: number;
  coveredEdges: number;
  deferredEdges: number;
  selectedEdges: FlowEdge[];
  unselectedEdges: FlowEdge[];
}

export interface SynthesisResult {
  topology: Topology;
  report: SynthesisReport;
}
