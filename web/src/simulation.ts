export type Address = string;

export interface Packet {
  id: number;
  src: Address;
  dest: Address;
  ttl?: number;
  sensitive: boolean;
  subject?: string;
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

interface StepContext {
  tick: number;
  adjacency: Map<string, PortRef>;
  nextPortPackets: Map<string, Packet>;
  packetIdCounter: number;
  rnd: () => number;
  stats: SimulationStats;
}

function makePortKey(ref: PortRef): string {
  return `${ref.deviceId}:${ref.port}`;
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
  if (packet.ttl === undefined) {
    return packet;
  }
  const next = clonePacket(packet);
  const ttl = (next.ttl ?? 0) - 1;
  next.ttl = ttl;
  if (ttl < 0) {
    return null;
  }
  return next;
}

function randomIntInclusive(min: number, max: number, rnd: () => number): number {
  return Math.floor(rnd() * (max - min + 1)) + min;
}

function chooseOne<T>(items: readonly T[], rnd: () => number): T {
  const index = Math.floor(rnd() * items.length);
  return items[index];
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

export class TunnetSimulator {
  private readonly topology: Topology;
  private readonly adjacency: Map<string, PortRef>;
  private readonly currentPortPackets = new Map<string, Packet>();
  private tick = 0;
  private packetIdCounter = 1;
  private rndState: number;
  private readonly stats: SimulationStats;
  private sendRateMultiplier = 1;

  constructor(topology: Topology, seed = 1337) {
    this.topology = topology;
    this.adjacency = buildAdjacency(topology);
    this.rndState = seed >>> 0;
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

  private emitMove(ctx: StepContext, to: PortRef, packet: Packet): void {
    const targetKey = makePortKey(to);
    if (ctx.nextPortPackets.has(targetKey)) {
      ctx.nextPortPackets.delete(targetKey);
      ctx.stats.collisions += 1;
      ctx.stats.dropped += 2;
      return;
    }
    ctx.nextPortPackets.set(targetKey, packet);
  }

  private enqueueOutbound(ctx: StepContext, sourceDeviceId: string, sourcePort: number, packet: Packet | null): void {
    if (!packet) {
      ctx.stats.ttlExpired += 1;
      ctx.stats.dropped += 1;
      return;
    }
    const to = ctx.adjacency.get(makePortKey({ deviceId: sourceDeviceId, port: sourcePort }));
    if (!to) {
      ctx.stats.dropped += 1;
      return;
    }
    this.emitMove(ctx, to, packet);
  }

  private processEndpoint(device: EndpointDevice, ctx: StepContext): void {
    const inbound = this.packetAt({ deviceId: device.id, port: 0 });
    if (inbound) {
      if (inbound.dest === device.address) {
        ctx.stats.delivered += 1;
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

    if (!device.generator) return;
    if (ctx.tick < device.state.nextSendTick) return;
    const destinations = device.generator.destinations.filter((d) => d !== device.address);
    if (destinations.length === 0) return;

    const packet: Packet = {
      id: ctx.packetIdCounter++,
      src: device.address,
      dest: chooseOne(destinations, ctx.rnd),
      ttl: device.generator.ttl,
      sensitive: ctx.rnd() < device.generator.sensitiveChance,
      subject: device.generator.subjectPrefix ? `${device.generator.subjectPrefix}${ctx.tick}` : undefined,
    };
    this.enqueueOutbound(ctx, device.id, 0, packet);
    ctx.stats.emitted += 1;
    const delay = randomIntInclusive(
      device.generator.minIntervalTicks,
      device.generator.maxIntervalTicks,
      ctx.rnd,
    );
    const adjustedDelay = Math.max(1, Math.round(delay / this.sendRateMultiplier));
    device.state.nextSendTick = ctx.tick + adjustedDelay;
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

  step(): { tick: number; inFlightPackets: number; stats: SimulationStats } {
    const nextPortPackets = new Map<string, Packet>();
    const ctx: StepContext = {
      tick: this.tick,
      adjacency: this.adjacency,
      nextPortPackets,
      packetIdCounter: this.packetIdCounter,
      rnd: () => this.random(),
      stats: this.stats,
    };

    for (const device of Object.values(this.topology.devices)) {
      if (device.type === "endpoint") this.processEndpoint(device, ctx);
      else if (device.type === "relay") this.processRelay(device, ctx);
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
    return { tick: this.tick, inFlightPackets: this.currentPortPackets.size, stats: { ...this.stats } };
  }

  setSendRateMultiplier(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
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
}
