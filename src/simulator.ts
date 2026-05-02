import {
  type AddressEncodingStrategy,
  encodeEndpointAddressForStrategy,
  parseEndpointAddressString,
} from "./analysis/endpoint-address-encoding.js";
import {
  applyRecoveredStateTransitions,
  advanceNetTick,
  evaluateEndpointSend,
  initialRecoveredSchedulerState,
  type RecoveredSchedulerState,
} from "./analysis/recovered-endpoint-scheduler.js";
import {
  buildWikiDestinationMaps,
  destinationsForRecoveredDecision,
} from "./analysis/recovered-send-destinations.js";
import { endpointData } from "./wiki-endpoint-data.js";
import {
  Address,
  Device,
  EndpointDevice,
  FilterDevice,
  INFINITE_PACKET_TTL,
  Packet,
  PortRef,
  SimulationSnapshot,
  SimulationStats,
  Topology,
} from "./types.js";

/** Optional tuning for {@link TunnetSimulator} recovered scheduler (destination expansion uses wiki-derived `endpointData`). */
export type TunnetSimulatorOptions = {
  recoveredEncoding?: AddressEncodingStrategy;
  recoveredPhase?: { phaseA: number; phaseB: number };
  /**
   * When false, endpoints do not run {@link evaluateEndpointSend} (no scheduler-driven primaries).
   * Use for isolated trials (e.g. {@link verifyEdgesIndividually}) so only injected traffic runs.
   */
  scheduleEndpointSends?: boolean;
};

type PacketAtPort = Packet | null;
type PortKey = string;

interface PacketMove {
  from: PortRef;
  to: PortRef;
  packet: Packet;
}

function makePortKey(ref: PortRef): PortKey {
  return `${ref.deviceId}:${ref.port}`;
}

function splitPortKey(key: PortKey): PortRef {
  const [deviceId, rawPort] = key.split(":");
  return { deviceId, port: Number(rawPort) };
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
    if (m[i] === "*") {
      continue;
    }
    if (m[i] !== c[i]) {
      return false;
    }
  }
  return true;
}

function devicePortCount(device: Device): number {
  switch (device.type) {
    case "endpoint":
      return 1;
    case "relay":
      return 2;
    case "filter":
      return 2;
    case "hub":
      return 3;
    default:
      return 0;
  }
}

function buildAdjacency(topology: Topology): Map<PortKey, PortRef> {
  const out = new Map<PortKey, PortRef>();
  for (const link of topology.links) {
    out.set(makePortKey(link.a), link.b);
    out.set(makePortKey(link.b), link.a);
  }
  return out;
}

function validateTopology(topology: Topology): void {
  for (const device of Object.values(topology.devices)) {
    const count = devicePortCount(device);
    for (const link of topology.links) {
      for (const endpoint of [link.a, link.b]) {
        if (endpoint.deviceId !== device.id) {
          continue;
        }
        if (endpoint.port < 0 || endpoint.port >= count) {
          throw new Error(
            `Invalid link: ${endpoint.deviceId}:${endpoint.port} out of range for ${device.type}`,
          );
        }
      }
    }
  }
}

interface StepContext {
  tick: number;
  adjacency: Map<PortKey, PortRef>;
  currentPortPackets: Map<PortKey, Packet>;
  nextPortPackets: Map<PortKey, Packet>;
  packetIdCounter: number;
  rnd: () => number;
  stats: SimulationStats;
}

export class TunnetSimulator {
  private readonly topology: Topology;
  private readonly adjacency: Map<PortKey, PortRef>;
  private readonly currentPortPackets = new Map<PortKey, Packet>();
  private tick = 0;
  /** Half/tick counter fed to {@link evaluateEndpointSend} (`advanceNetTick` each {@link step}). */
  private netTick = 0;
  private packetIdCounter = 1;
  private rndState: number;
  private readonly stats: SimulationStats;

  /** Single shared scheduler blob (`*(node+0x1c4)` / `0x1c5`) — matches analysis exporters. */
  private readonly recoveredState: RecoveredSchedulerState;
  private readonly recoveredStrategy: AddressEncodingStrategy;
  private readonly destinationsBySource: Map<string, string[]>;
  /** Sorted addresses from `endpointData` (wiki-derived catalog). */
  private readonly endpointCatalogAddresses: readonly string[];
  private readonly catalogSensitiveByAddress: Map<string, boolean>;
  /**
   * Endpoints that appear in `endpointData`, iterated in catalog row order for recovered primaries
   * (`evaluateEndpointSend`). Scheduling is reverse-engineered; the catalog only supplies masks / `sends_to`.
   */
  private readonly recoveredDatasetEndpoints: EndpointDevice[];
  /** Topology endpoints with no `endpointData` row — no recovered primary sends, receive/bounce only. */
  private readonly nonCatalogEndpoints: EndpointDevice[];
  private readonly scheduleEndpointSends: boolean;

  constructor(topology: Topology, seed = 1337, options?: TunnetSimulatorOptions) {
    validateTopology(topology);
    this.topology = topology;
    this.adjacency = buildAdjacency(topology);
    this.rndState = seed >>> 0;
    const phase = options?.recoveredPhase ?? { phaseA: 0, phaseB: 0 };
    this.recoveredState = initialRecoveredSchedulerState(phase.phaseA, phase.phaseB);
    this.recoveredStrategy = options?.recoveredEncoding ?? "plus_one_all_octets_regional_mainframe";
    const { allWikiAddresses: endpointCatalogAddresses, destinationsBySource } = buildWikiDestinationMaps(endpointData);
    this.endpointCatalogAddresses = endpointCatalogAddresses;
    this.destinationsBySource = destinationsBySource;
    this.catalogSensitiveByAddress = new Map(endpointData.map((r) => [r.address, r.sensitive]));

    const catalogAddrToDevice = new Map<string, EndpointDevice>();
    for (const d of Object.values(topology.devices)) {
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
    this.nonCatalogEndpoints = Object.values(topology.devices)
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
    // xorshift32
    let x = this.rndState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rndState = x >>> 0;
    return this.rndState / 0xffffffff;
  }

  private packetAt(port: PortRef): PacketAtPort {
    return this.currentPortPackets.get(makePortKey(port)) ?? null;
  }

  /** @returns true if the packet was placed on the target wire port for this tick. */
  private emitMove(ctx: StepContext, move: PacketMove): boolean {
    const targetKey = makePortKey(move.to);
    if (ctx.nextPortPackets.has(targetKey)) {
      // Multiple packets trying to arrive at same port in same tick -> collision.
      // Keep the first packet that already claimed this target; drop the later one.
      ctx.stats.collisions += 1;
      ctx.stats.dropped += 1;
      return false;
    }
    ctx.nextPortPackets.set(targetKey, move.packet);
    return true;
  }

  /** @returns true if the packet entered the network (adjacent link exists and no collision on that wire). */
  private enqueueOutbound(
    ctx: StepContext,
    sourceDeviceId: string,
    sourcePort: number,
    packet: Packet | null,
  ): boolean {
    if (!packet) {
      ctx.stats.ttlExpired += 1;
      ctx.stats.dropped += 1;
      return false;
    }

    const from: PortRef = { deviceId: sourceDeviceId, port: sourcePort };
    const to = ctx.adjacency.get(makePortKey(from));
    if (!to) {
      // Unconnected port = packet fizzles.
      ctx.stats.dropped += 1;
      return false;
    }
    return this.emitMove(ctx, { from, to, packet });
  }

  private processEndpoint(device: EndpointDevice, ctx: StepContext): void {
    const inbound = this.packetAt({ deviceId: device.id, port: 0 });
    let repliedThisTick = false;
    if (inbound) {
      if (inbound.dest === device.address) {
        ctx.stats.delivered += 1;
        const replyTo = new Set(device.generator?.replyToSources ?? []);
        if (replyTo.has(inbound.src)) {
          const reply: Packet = {
            id: ctx.packetIdCounter++,
            src: device.address,
            dest: inbound.src,
            ttl: device.generator?.ttl ?? INFINITE_PACKET_TTL,
            sensitive: false,
            subject: undefined,
          };
          if (this.enqueueOutbound(ctx, device.id, 0, reply)) {
            ctx.stats.emitted += 1;
          }
          repliedThisTick = true;
        }
      } else if (inbound.sensitive) {
        ctx.stats.dropped += 1;
      } else {
        const bounced = decrementTtl(inbound);
        if (bounced) {
          ctx.stats.bounced += 1;
          this.enqueueOutbound(ctx, device.id, 0, bounced);
        } else {
          ctx.stats.ttlExpired += 1;
          ctx.stats.dropped += 1;
        }
      }
    }

    if (repliedThisTick) {
      return;
    }

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

    // One packet per endpoint per tick on its single uplink — matches physical port semantics.
    // `destinationsForRecoveredDecision` may list many candidates (edge-compare fan-out); the sim picks one.
    // See `packetProfileUsesWikiSendsToFanOut` note in `recovered-endpoint-scheduler.ts`.
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

  private processRelay(device: Device, ctx: StepContext): void {
    const p0 = this.packetAt({ deviceId: device.id, port: 0 });
    const p1 = this.packetAt({ deviceId: device.id, port: 1 });
    if (p0) {
      this.enqueueOutbound(ctx, device.id, 1, p0);
    }
    if (p1) {
      this.enqueueOutbound(ctx, device.id, 0, p1);
    }
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

  private processHub(device: Device, ctx: StepContext): void {
    if (device.type !== "hub") {
      return;
    }
    for (let ingress = 0; ingress < 3; ingress += 1) {
      const packet = this.packetAt({ deviceId: device.id, port: ingress });
      if (!packet) {
        continue;
      }
      const egress = this.hubEgressPort(device.rotation, ingress);
      this.enqueueOutbound(ctx, device.id, egress, packet);
    }
  }

  private shouldFilterAct(filter: FilterDevice, packet: Packet): boolean {
    const value = filter.addressField === "source" ? packet.src : packet.dest;
    const matched = matchAddress(filter.mask, value);
    return filter.operation === "match" ? matched : !matched;
  }

  private processFilter(device: Device, ctx: StepContext): void {
    if (device.type !== "filter") {
      return;
    }

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
      } else {
        const acted = this.shouldFilterAct(device, decremented);
        if (acted && device.action === "drop") {
          ctx.stats.dropped += 1;
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
        inboundOutPort = null;
        inboundOutPacket = null;
      } else if (device.collisionHandling === "drop_outbound") {
        ctx.stats.dropped += 1;
        outboundOutPort = null;
        outboundOutPacket = null;
      } else {
        // send_back_outbound
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

  injectPacketFromEndpoint(
    srcAddress: Address,
    destAddress: Address,
    options?: { ttl?: number; sensitive?: boolean; subject?: string },
  ): { ok: true; packetId: number } | { ok: false; reason: string } {
    const sourceEndpoint = Object.values(this.topology.devices).find(
      (d) => d.type === "endpoint" && d.address === srcAddress,
    );
    if (!sourceEndpoint || sourceEndpoint.type !== "endpoint") {
      return { ok: false, reason: `source endpoint not found: ${srcAddress}` };
    }

    const endpointPort: PortRef = { deviceId: sourceEndpoint.id, port: 0 };
    const ingress = this.adjacency.get(makePortKey(endpointPort));
    if (!ingress) {
      return { ok: false, reason: `source endpoint has no connected link: ${srcAddress}` };
    }

    const ingressKey = makePortKey(ingress);
    if (this.currentPortPackets.has(ingressKey)) {
      return { ok: false, reason: `ingress port is occupied: ${ingress.deviceId}:${ingress.port}` };
    }

    const packet: Packet = {
      id: this.packetIdCounter++,
      src: srcAddress,
      dest: destAddress,
      ttl: options?.ttl ?? INFINITE_PACKET_TTL,
      sensitive: options?.sensitive ?? false,
      subject: options?.subject,
    };
    this.currentPortPackets.set(ingressKey, packet);
    return { ok: true, packetId: packet.id };
  }

  step(): SimulationSnapshot {
    if (this.scheduleEndpointSends) {
      this.netTick = advanceNetTick(this.netTick);
    }

    const nextPortPackets = new Map<PortKey, Packet>();
    const ctx: StepContext = {
      tick: this.tick,
      adjacency: this.adjacency,
      currentPortPackets: this.currentPortPackets,
      nextPortPackets,
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
      if (device.type === "relay") {
        this.processRelay(device, ctx);
      } else if (device.type === "hub") {
        this.processHub(device, ctx);
      } else if (device.type === "filter") {
        this.processFilter(device, ctx);
      }
    }

    this.packetIdCounter = ctx.packetIdCounter;
    this.currentPortPackets.clear();
    for (const [k, v] of nextPortPackets.entries()) {
      this.currentPortPackets.set(k, v);
    }
    this.tick += 1;
    this.stats.tick = this.tick;

    return {
      tick: this.tick,
      inFlightPackets: this.currentPortPackets.size,
      stats: { ...this.stats },
    };
  }

  run(ticks: number): SimulationSnapshot {
    let snapshot: SimulationSnapshot = {
      tick: this.tick,
      inFlightPackets: this.currentPortPackets.size,
      stats: { ...this.stats },
    };
    for (let i = 0; i < ticks; i += 1) {
      snapshot = this.step();
    }
    return snapshot;
  }

  getPortOccupancy(): Array<{ port: PortRef; packet: Packet }> {
    return [...this.currentPortPackets.entries()].map(([key, packet]) => ({
      port: splitPortKey(key),
      packet,
    }));
  }
}
