import {
  type AddressEncodingStrategy,
  encodeEndpointAddressForStrategy,
  parseEndpointAddressString,
} from "../../src/analysis/endpoint-address-encoding.js";
import {
  applyRecoveredStateTransitions,
  advanceNetTick,
  evaluateEndpointSend,
  initialRecoveredSchedulerState,
  type RecoveredSchedulerState,
} from "../../src/analysis/recovered-endpoint-scheduler.js";
import {
  buildWikiDestinationMaps,
  destinationsForRecoveredDecision,
} from "../../src/analysis/recovered-send-destinations.js";
import { endpointData } from "../../src/wiki-endpoint-data.js";
import { INFINITE_PACKET_TTL } from "../../src/types.js";
import type { TunnetSimulatorOptions } from "../../src/simulator.js";

export type { TunnetSimulatorOptions };

export type Address = string;

export interface Packet {
  id: number;
  src: Address;
  dest: Address;
  ttl: number;
  sensitive: boolean;
  subject?: string;
}

export interface EndpointGeneratorConfig {
  destinations: Address[];
  replyToSources?: Address[];
  minIntervalTicks: number;
  maxIntervalTicks: number;
  sensitiveChance: number;
  ttl?: number;
  subjectPrefix?: string;
}

export interface EndpointState {
  nextSendTick: number;
}

export interface EndpointDevice {
  id: string;
  type: "endpoint";
  address: Address;
  generator?: EndpointGeneratorConfig;
  state: EndpointState;
}

export interface RelayDevice {
  id: string;
  type: "relay";
}

export interface HubDevice {
  id: string;
  type: "hub";
  rotation: "clockwise" | "counterclockwise";
}

export interface FilterDevice {
  id: string;
  type: "filter";
  operatingPort: 0 | 1;
  addressField: "source" | "destination";
  operation: "match" | "differ";
  mask: string;
  action: "send_back" | "drop";
  collisionHandling: "drop_inbound" | "drop_outbound" | "send_back_outbound";
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

export interface SimulatorRuntimeState {
  tick: number;
  packetIdCounter: number;
  rndState: number;
  sendRateMultiplier: number;
  stats: SimulationStats;
  occupancy: Array<{ port: PortRef; packet: Packet }>;
  endpointNextSendTickById: Record<string, number>;
}

interface StepContext {
  tick: number;
  adjacency: Map<string, PortRef>;
  nextPortPackets: Map<string, Packet>;
  droppedDeviceIds: Set<string>;
  /** One entry per counted drop (same device may appear multiple times per tick). */
  dropEventDeviceIds: string[];
  packetIdCounter: number;
  rnd: () => number;
  stats: SimulationStats;
}

function recordDeviceDrop(ctx: StepContext, deviceId: string): void {
  ctx.droppedDeviceIds.add(deviceId);
  ctx.dropEventDeviceIds.push(deviceId);
}

function makePortKey(ref: PortRef): string {
  return `${ref.deviceId}:${ref.port}`;
}

/** Adjacency: each port key → the port on the other end of the link. */
export function buildPortAdjacency(topology: Topology): Map<string, PortRef> {
  const out = new Map<string, PortRef>();
  for (const link of topology.links) {
    out.set(makePortKey(link.a), link.b);
    out.set(makePortKey(link.b), link.a);
  }
  return out;
}

/** Egress port after internal hub routing (matches `processHub`). */
export function getHubEgressPort(rotation: "clockwise" | "counterclockwise", ingressPort: number): number {
  if (rotation === "clockwise") {
    if (ingressPort === 0) return 1;
    if (ingressPort === 1) return 2;
    return 0;
  }
  if (ingressPort === 0) return 2;
  if (ingressPort === 2) return 1;
  return 0;
}

export function portKey(ref: PortRef): string {
  return makePortKey(ref);
}

function splitPortKey(key: string): PortRef {
  const idx = key.lastIndexOf(":");
  if (idx < 0) return { deviceId: key, port: 0 };
  return { deviceId: key.slice(0, idx), port: Number(key.slice(idx + 1)) };
}

function clonePacket(packet: Packet): Packet {
  return { ...packet };
}

function decrementTtl(packet: Packet): Packet | null {
  const next = clonePacket(packet);
  const ttl = next.ttl - 1;
  next.ttl = ttl;
  if (ttl < 0) {
    return null;
  }
  return next;
}

function matchAddress(mask: string, candidate: Address): boolean {
  const m = mask.split(".");
  const c = candidate.split(".");
  if (m.length !== 4 || c.length !== 4) {
    return false;
  }
  for (let i = 0; i < 4; i += 1) {
    if (m[i] === "*") continue;
    if (m[i] !== c[i]) return false;
  }
  return true;
}

function buildAdjacency(topology: Topology): Map<string, PortRef> {
  const out = new Map<string, PortRef>();
  for (const link of topology.links) {
    out.set(makePortKey(link.a), link.b);
    out.set(makePortKey(link.b), link.a);
  }
  return out;
}

function cloneTopology(topology: Topology): Topology {
  const devices: Record<string, Device> = {};
  for (const [id, device] of Object.entries(topology.devices)) {
    if (device.type === "endpoint") {
      devices[id] = {
        ...device,
        generator: device.generator
          ? {
              ...device.generator,
              destinations: [...device.generator.destinations],
              replyToSources: device.generator.replyToSources
                ? [...device.generator.replyToSources]
                : undefined,
            }
          : undefined,
        state: { ...device.state },
      };
      continue;
    }
    devices[id] = { ...device };
  }
  const links = topology.links.map((link) => ({
    a: { ...link.a },
    b: { ...link.b },
  }));
  return { devices, links };
}

export class TunnetSimulator {
  private readonly topology: Topology;
  private readonly adjacency: Map<string, PortRef>;
  private readonly currentPortPackets = new Map<string, Packet>();
  private readonly pendingEndpointReplies = new Map<string, Packet>();
  private tick = 0;
  private netTick = 0;
  private packetIdCounter = 1;
  private rndState: number;
  private readonly stats: SimulationStats;
  private sendRateMultiplier = 1;

  private readonly recoveredState: RecoveredSchedulerState;
  private readonly recoveredStrategy: AddressEncodingStrategy;
  private readonly destinationsBySource: Map<string, string[]>;
  private readonly endpointCatalogAddresses: readonly string[];
  private readonly catalogSensitiveByAddress: Map<string, boolean>;
  private readonly recoveredDatasetEndpoints: EndpointDevice[];
  private readonly nonCatalogEndpoints: EndpointDevice[];
  private readonly scheduleEndpointSends: boolean;

  constructor(topology: Topology, seed = 1337, options?: TunnetSimulatorOptions) {
    this.topology = cloneTopology(topology);
    this.adjacency = buildAdjacency(this.topology);
    this.rndState = seed >>> 0;
    const phase = options?.recoveredPhase ?? { phaseA: 0, phaseB: 0 };
    this.recoveredState = initialRecoveredSchedulerState(phase.phaseA, phase.phaseB);
    this.recoveredStrategy = options?.recoveredEncoding ?? "plus_one_all_octets_regional_mainframe";
    const { allWikiAddresses: endpointCatalogAddresses, destinationsBySource } = buildWikiDestinationMaps(endpointData);
    this.endpointCatalogAddresses = endpointCatalogAddresses;
    this.destinationsBySource = destinationsBySource;
    this.catalogSensitiveByAddress = new Map(endpointData.map((r) => [r.address, r.sensitive]));

    const catalogAddrToDevice = new Map<string, EndpointDevice>();
    for (const d of Object.values(this.topology.devices)) {
      if (d.type === "endpoint" && destinationsBySource.has(d.address)) {
        catalogAddrToDevice.set(d.address, d);
      }
    }
    const recoveredDatasetEndpoints: EndpointDevice[] = [];
    for (const row of endpointData) {
      const dev = catalogAddrToDevice.get(row.address);
      if (dev) recoveredDatasetEndpoints.push(dev);
    }
    this.recoveredDatasetEndpoints = recoveredDatasetEndpoints;
    const catalogAddressSet = new Set(recoveredDatasetEndpoints.map((e) => e.address));
    this.nonCatalogEndpoints = Object.values(this.topology.devices)
      .filter((d): d is EndpointDevice => d.type === "endpoint" && !catalogAddressSet.has(d.address))
      .sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));

    this.scheduleEndpointSends = options?.scheduleEndpointSends !== false;

    this.stats = {
      tick: 0,
      emitted: 0,
      delivered: 0,
      dropped: 0,
      bounced: 0,
      ttlExpired: 0,
      collisions: 0,
    };
  }

  private random(): number {
    let x = this.rndState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rndState = x >>> 0;
    return this.rndState / 0xffffffff;
  }

  private packetAt(port: PortRef): Packet | null {
    return this.currentPortPackets.get(makePortKey(port)) ?? null;
  }

  private emitMove(ctx: StepContext, to: PortRef, packet: Packet): boolean {
    const targetKey = makePortKey(to);
    if (ctx.nextPortPackets.has(targetKey)) {
      // Keep the first packet that already claimed this wire endpoint.
      // The later packet is not sent this tick (collision), but it is not counted as a drop.
      ctx.stats.collisions += 1;
      return false;
    }
    ctx.nextPortPackets.set(targetKey, packet);
    return true;
  }

  private enqueueOutbound(ctx: StepContext, sourceDeviceId: string, sourcePort: number, packet: Packet | null): boolean {
    if (!packet) {
      ctx.stats.ttlExpired += 1;
      ctx.stats.dropped += 1;
      recordDeviceDrop(ctx, sourceDeviceId);
      return false;
    }
    const to = ctx.adjacency.get(makePortKey({ deviceId: sourceDeviceId, port: sourcePort }));
    if (!to) {
      ctx.stats.dropped += 1;
      recordDeviceDrop(ctx, sourceDeviceId);
      return false;
    }
    return this.emitMove(ctx, to, packet);
  }

  private processEndpoint(device: EndpointDevice, ctx: StepContext): void {
    const pendingReply = this.pendingEndpointReplies.get(device.id);
    if (pendingReply) {
      this.pendingEndpointReplies.delete(device.id);
      if (this.enqueueOutbound(ctx, device.id, 0, pendingReply)) {
        ctx.stats.emitted += 1;
      }
    }
    const inbound = this.packetAt({ deviceId: device.id, port: 0 });
    let receivedAddressedThisTick = false;
    let attemptedBounceThisTick = false;
    const repliedThisTick = pendingReply !== undefined;
    if (inbound) {
      if (inbound.dest === device.address) {
        receivedAddressedThisTick = true;
        ctx.stats.delivered += 1;
        const replyTo = new Set(device.generator?.replyToSources ?? []);
        if (replyTo.has(inbound.src)) {
          this.pendingEndpointReplies.set(device.id, {
            id: ctx.packetIdCounter++,
            src: device.address,
            dest: inbound.src,
            ttl: device.generator?.ttl ?? INFINITE_PACKET_TTL,
            sensitive: false,
            subject: `Re: ${inbound.subject ?? ""}`,
          });
        }
      } else if (inbound.sensitive) {
        ctx.stats.dropped += 1;
        recordDeviceDrop(ctx, device.id);
      } else {
        const bounced = decrementTtl(inbound);
        if (bounced) {
          attemptedBounceThisTick = true;
          ctx.stats.bounced += 1;
          this.enqueueOutbound(ctx, device.id, 0, bounced);
        } else {
          ctx.stats.ttlExpired += 1;
          ctx.stats.dropped += 1;
          recordDeviceDrop(ctx, device.id);
        }
      }
    }

    if (receivedAddressedThisTick) return;
    if (repliedThisTick) return;
    if (attemptedBounceThisTick) return;
    if (ctx.rnd() > this.sendRateMultiplier) return;

    if (!this.scheduleEndpointSends) {
      return;
    }

    if (!this.destinationsBySource.has(device.address)) {
      return;
    }

    const encoded = encodeEndpointAddressForStrategy(
      parseEndpointAddressString(device.address),
      this.recoveredStrategy,
    );
    const decision = evaluateEndpointSend(this.recoveredState, encoded, this.netTick);
    if (!decision.shouldSend || decision.header === null || decision.profile === null) {
      return;
    }

    const dests = destinationsForRecoveredDecision(
      device.address,
      decision,
      this.destinationsBySource,
      this.endpointCatalogAddresses,
    );
    const sensitive = this.catalogSensitiveByAddress.get(device.address) ?? false;
    const ttl = device.generator?.ttl ?? INFINITE_PACKET_TTL;

    // One outbound packet per endpoint per tick (single link). Candidate list may be large — pick one (see Node `simulator.ts`).
    if (dests.length > 0) {
      const dest = dests[Math.floor(ctx.rnd() * dests.length)]!;
      const packet: Packet = {
        id: ctx.packetIdCounter++,
        src: device.address,
        dest,
        ttl,
        sensitive,
        subject: decision.packetSubject ?? undefined,
      };
      if (this.enqueueOutbound(ctx, device.id, 0, packet)) {
        ctx.stats.emitted += 1;
      }
    }

    applyRecoveredStateTransitions(this.recoveredState, encoded, decision);
  }

  private processRelay(device: RelayDevice, ctx: StepContext): void {
    const p0 = this.packetAt({ deviceId: device.id, port: 0 });
    const p1 = this.packetAt({ deviceId: device.id, port: 1 });
    if (p0) this.enqueueOutbound(ctx, device.id, 1, p0);
    if (p1) this.enqueueOutbound(ctx, device.id, 0, p1);
  }

  private hubEgressPort(rotation: "clockwise" | "counterclockwise", ingressPort: number): number {
    if (rotation === "clockwise") {
      if (ingressPort === 0) return 1;
      if (ingressPort === 1) return 2;
      return 0;
    }
    if (ingressPort === 0) return 2;
    if (ingressPort === 2) return 1;
    return 0;
  }

  private processHub(device: HubDevice, ctx: StepContext): void {
    for (let ingress = 0; ingress < 3; ingress += 1) {
      const packet = this.packetAt({ deviceId: device.id, port: ingress });
      if (!packet) continue;
      const egress = this.hubEgressPort(device.rotation, ingress);
      this.enqueueOutbound(ctx, device.id, egress, packet);
    }
  }

  private shouldFilterAct(filter: FilterDevice, packet: Packet): boolean {
    const value = filter.addressField === "source" ? packet.src : packet.dest;
    const matched = matchAddress(filter.mask, value);
    return filter.operation === "match" ? matched : !matched;
  }

  private processFilter(device: FilterDevice, ctx: StepContext): void {
    const op = device.operatingPort;
    const nonOp = op === 0 ? 1 : 0;
    const inbound = this.packetAt({ deviceId: device.id, port: op });
    const outbound = this.packetAt({ deviceId: device.id, port: nonOp });

    let inboundOutPort: number | null = null;
    let inboundOutPacket: Packet | null = null;
    let outboundOutPort: number | null = null;
    let outboundOutPacket: Packet | null = null;

    if (inbound) {
      const decremented = decrementTtl(inbound);
      if (!decremented) {
        ctx.stats.ttlExpired += 1;
        ctx.stats.dropped += 1;
        recordDeviceDrop(ctx, device.id);
      } else {
        const acted = this.shouldFilterAct(device, decremented);
        if (acted && device.action === "drop") {
          ctx.stats.dropped += 1;
          recordDeviceDrop(ctx, device.id);
        } else if (acted && device.action === "send_back") {
          inboundOutPort = op;
          inboundOutPacket = decremented;
        } else {
          inboundOutPort = nonOp;
          inboundOutPacket = decremented;
        }
      }
    }

    if (outbound) {
      outboundOutPort = op;
      outboundOutPacket = outbound;
    }

    if (
      inboundOutPort !== null &&
      outboundOutPort !== null &&
      inboundOutPort === outboundOutPort &&
      inboundOutPacket &&
      outboundOutPacket
    ) {
      if (device.collisionHandling === "drop_inbound") {
        ctx.stats.dropped += 1;
        recordDeviceDrop(ctx, device.id);
        inboundOutPort = null;
        inboundOutPacket = null;
      } else if (device.collisionHandling === "drop_outbound") {
        ctx.stats.dropped += 1;
        recordDeviceDrop(ctx, device.id);
        outboundOutPort = null;
        outboundOutPacket = null;
      } else {
        outboundOutPort = nonOp;
      }
    }

    if (inboundOutPort !== null && inboundOutPacket) {
      this.enqueueOutbound(ctx, device.id, inboundOutPort, inboundOutPacket);
    }
    if (outboundOutPort !== null && outboundOutPacket) {
      this.enqueueOutbound(ctx, device.id, outboundOutPort, outboundOutPacket);
    }
  }

  step(): {
    tick: number;
    inFlightPackets: number;
    stats: SimulationStats;
    droppedDeviceIds: string[];
    dropEventDeviceIds: string[];
  } {
    this.netTick = advanceNetTick(this.netTick);

    const nextPortPackets = new Map<string, Packet>();
    const droppedDeviceIds = new Set<string>();
    const dropEventDeviceIds: string[] = [];
    const ctx: StepContext = {
      tick: this.tick,
      adjacency: this.adjacency,
      nextPortPackets,
      droppedDeviceIds,
      dropEventDeviceIds,
      packetIdCounter: this.packetIdCounter,
      rnd: () => this.random(),
      stats: this.stats,
    };

    for (const device of this.recoveredDatasetEndpoints) {
      this.processEndpoint(device, ctx);
    }
    for (const device of this.nonCatalogEndpoints) {
      this.processEndpoint(device, ctx);
    }
    for (const device of Object.values(this.topology.devices)) {
      if (device.type === "relay") this.processRelay(device, ctx);
      else if (device.type === "hub") this.processHub(device, ctx);
      else if (device.type === "filter") this.processFilter(device, ctx);
    }

    this.packetIdCounter = ctx.packetIdCounter;
    this.currentPortPackets.clear();
    nextPortPackets.forEach((v, k) => {
      this.currentPortPackets.set(k, v);
    });
    this.tick += 1;
    this.stats.tick = this.tick;
    return {
      tick: this.tick,
      inFlightPackets: this.currentPortPackets.size,
      stats: { ...this.stats },
      droppedDeviceIds: Array.from(droppedDeviceIds),
      dropEventDeviceIds,
    };
  }

  setSendRateMultiplier(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1) {
      return;
    }
    this.sendRateMultiplier = multiplier;
  }

  getPortOccupancy(): Array<{ port: PortRef; packet: Packet }> {
    return Array.from(this.currentPortPackets.entries()).map(([key, packet]) => ({
      port: splitPortKey(key),
      packet,
    }));
  }

  exportRuntimeState(): SimulatorRuntimeState {
    const endpointNextSendTickById: Record<string, number> = {};
    for (const dev of Object.values(this.topology.devices)) {
      if (dev.type === "endpoint") {
        endpointNextSendTickById[dev.id] = dev.state.nextSendTick;
      }
    }
    return {
      tick: this.tick,
      packetIdCounter: this.packetIdCounter,
      rndState: this.rndState >>> 0,
      sendRateMultiplier: this.sendRateMultiplier,
      stats: { ...this.stats },
      occupancy: this.getPortOccupancy().map((e) => ({ port: { ...e.port }, packet: { ...e.packet } })),
      endpointNextSendTickById,
    };
  }

  importRuntimeState(state: SimulatorRuntimeState): void {
    if (Number.isFinite(state.tick)) {
      this.tick = Math.max(0, Math.floor(state.tick));
    }
    if (Number.isFinite(state.packetIdCounter)) {
      this.packetIdCounter = Math.max(1, Math.floor(state.packetIdCounter));
    }
    if (Number.isFinite(state.rndState)) {
      this.rndState = (Math.floor(state.rndState) >>> 0);
    }
    if (Number.isFinite(state.sendRateMultiplier) && state.sendRateMultiplier > 0) {
      this.sendRateMultiplier = state.sendRateMultiplier;
    }
    this.stats.tick = this.tick;
    this.stats.emitted = Number.isFinite(state.stats.emitted) ? Math.max(0, state.stats.emitted) : 0;
    this.stats.delivered = Number.isFinite(state.stats.delivered) ? Math.max(0, state.stats.delivered) : 0;
    this.stats.dropped = Number.isFinite(state.stats.dropped) ? Math.max(0, state.stats.dropped) : 0;
    this.stats.bounced = Number.isFinite(state.stats.bounced) ? Math.max(0, state.stats.bounced) : 0;
    this.stats.ttlExpired = Number.isFinite(state.stats.ttlExpired) ? Math.max(0, state.stats.ttlExpired) : 0;
    this.stats.collisions = Number.isFinite(state.stats.collisions) ? Math.max(0, state.stats.collisions) : 0;

    this.currentPortPackets.clear();
    this.pendingEndpointReplies.clear();
    for (const e of state.occupancy) {
      this.currentPortPackets.set(makePortKey(e.port), { ...e.packet });
    }

    for (const dev of Object.values(this.topology.devices)) {
      if (dev.type !== "endpoint") continue;
      const nextSendTick = state.endpointNextSendTickById[dev.id];
      if (Number.isFinite(nextSendTick)) {
        dev.state.nextSendTick = Math.max(0, Math.floor(nextSendTick));
      }
    }
  }
}
