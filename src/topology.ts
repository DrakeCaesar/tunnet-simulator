import { FlowEdge, FlowGraph, SynthesisResult, Topology } from "./types.js";

export function createEndpointOnlyTopology(flowGraph: FlowGraph): Topology {
  const devices: Topology["devices"] = {};

  for (const address of flowGraph.nodes) {
    devices[`ep:${address}`] = {
      id: `ep:${address}`,
      type: "endpoint",
      address,
      state: { nextSendTick: 0 },
    };
  }

  return { devices, links: [] };
}

/**
 * Tiny working topology used to verify tick behavior before full synthesis:
 * endpoint(0.0.0.1) <-> relay <-> endpoint(0.0.0.2)
 */
export function createTwoEndpointRelayDemo(): Topology {
  return {
    devices: {
      "ep:0.0.0.1": {
        id: "ep:0.0.0.1",
        type: "endpoint",
        address: "0.0.0.1",
        generator: {
          destinations: ["0.0.0.2"],
          minIntervalTicks: 2,
          maxIntervalTicks: 4,
          sensitiveChance: 0.15,
          ttl: 8,
          subjectPrefix: "DEMO-",
        },
        state: { nextSendTick: 0 },
      },
      "ep:0.0.0.2": {
        id: "ep:0.0.0.2",
        type: "endpoint",
        address: "0.0.0.2",
        state: { nextSendTick: 0 },
      },
      "relay:r0": {
        id: "relay:r0",
        type: "relay",
      },
    },
    links: [
      {
        a: { deviceId: "ep:0.0.0.1", port: 0 },
        b: { deviceId: "relay:r0", port: 0 },
      },
      {
        a: { deviceId: "relay:r0", port: 1 },
        b: { deviceId: "ep:0.0.0.2", port: 0 },
      },
    ],
  };
}

function edgeSortKey(edge: FlowEdge): string {
  return `${edge.src}->${edge.dst}`;
}

/**
 * Phase 1 deterministic synthesizer.
 *
 * Generates a concrete device/port topology that strictly obeys endpoint single-port constraints.
 * Each selected edge is implemented as a one-way rail:
 *
 * src(endpoint:0) -> relay -> filter(directionality) -> relay -> dst(endpoint:0)
 *
 * Directionality filter config:
 * - operatingPort=1 so src->dst path is bypassed (no filter TTL decrement)
 * - mask=*.*.*.*, operation=match, action=drop on operating side => reverse traffic is dropped
 *
 * Limitation:
 * - Because an endpoint has one port, this phase selects a disjoint subset of edges
 *   (each endpoint appears in at most one selected edge).
 */
export function synthesizePhase1Topology(flowGraph: FlowGraph): SynthesisResult {
  const devices: Topology["devices"] = {};
  const links: Topology["links"] = [];

  for (const address of [...flowGraph.nodes].sort()) {
    devices[`ep:${address}`] = {
      id: `ep:${address}`,
      type: "endpoint",
      address,
      state: { nextSendTick: 0 },
    };
  }

  const usedEndpoint = new Set<string>();
  const selectedEdges: FlowEdge[] = [];
  const unselectedEdges: FlowEdge[] = [];

  const sortedEdges = [...flowGraph.edges].sort((a, b) =>
    edgeSortKey(a).localeCompare(edgeSortKey(b)),
  );

  for (const edge of sortedEdges) {
    const srcId = `ep:${edge.src}`;
    const dstId = `ep:${edge.dst}`;
    if (edge.src === edge.dst) {
      unselectedEdges.push(edge);
      continue;
    }
    if (usedEndpoint.has(srcId) || usedEndpoint.has(dstId)) {
      unselectedEdges.push(edge);
      continue;
    }

    usedEndpoint.add(srcId);
    usedEndpoint.add(dstId);
    selectedEdges.push(edge);
  }

  selectedEdges.forEach((edge, i) => {
    const railId = i.toString().padStart(4, "0");
    const relayA = `relay:rail:${railId}:a`;
    const relayB = `relay:rail:${railId}:b`;
    const filter = `filter:rail:${railId}`;

    devices[relayA] = { id: relayA, type: "relay" };
    devices[relayB] = { id: relayB, type: "relay" };
    devices[filter] = {
      id: filter,
      type: "filter",
      operatingPort: 1,
      addressField: "destination",
      operation: "match",
      mask: "*.*.*.*",
      action: "drop",
      collisionHandling: "send_back_outbound",
    };

    const srcId = `ep:${edge.src}`;
    const dstId = `ep:${edge.dst}`;

    links.push(
      { a: { deviceId: srcId, port: 0 }, b: { deviceId: relayA, port: 0 } },
      { a: { deviceId: relayA, port: 1 }, b: { deviceId: filter, port: 0 } },
      { a: { deviceId: filter, port: 1 }, b: { deviceId: relayB, port: 0 } },
      { a: { deviceId: relayB, port: 1 }, b: { deviceId: dstId, port: 0 } },
    );
  });

  for (const [deviceId, device] of Object.entries(devices)) {
    if (device.type !== "endpoint") {
      continue;
    }
    const outgoing = selectedEdges
      .filter((e) => `ep:${e.src}` === deviceId)
      .map((e) => e.dst);
    if (outgoing.length > 0) {
      device.generator = {
        destinations: outgoing,
        minIntervalTicks: 3,
        maxIntervalTicks: 7,
        sensitiveChance: 0.1,
        ttl: 12,
        subjectPrefix: "AUTO-",
      };
    }
  }

  return {
    topology: { devices, links },
    report: {
      totalEdges: flowGraph.edges.length,
      coveredEdges: selectedEdges.length,
      deferredEdges: unselectedEdges.length,
      selectedEdges,
      unselectedEdges,
    },
  };
}

interface PairCandidate {
  a: string;
  b: string;
  weight: number;
  coversAtoB: boolean;
  coversBtoA: boolean;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function buildPairCandidates(flowGraph: FlowGraph): PairCandidate[] {
  const edgeSet = new Set(flowGraph.edges.map((e) => `${e.src}->${e.dst}`));
  const addresses = [...flowGraph.nodes].sort();
  const out: PairCandidate[] = [];

  for (let i = 0; i < addresses.length; i += 1) {
    for (let j = i + 1; j < addresses.length; j += 1) {
      const a = addresses[i];
      const b = addresses[j];
      const coversAtoB = edgeSet.has(`${a}->${b}`);
      const coversBtoA = edgeSet.has(`${b}->${a}`);
      const weight = Number(coversAtoB) + Number(coversBtoA);
      if (weight > 0) {
        out.push({ a, b, weight, coversAtoB, coversBtoA });
      }
    }
  }

  out.sort((x, y) => {
    if (x.weight !== y.weight) {
      return y.weight - x.weight;
    }
    return pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b));
  });
  return out;
}

/**
 * Phase 2 synthesizer.
 *
 * Improvement over phase 1:
 * - Selects disjoint endpoint pairs by descending edge coverage weight.
 * - A single bidirectional rail can satisfy up to 2 required directed edges (A->B and B->A).
 *
 * Topology per selected pair:
 *   ep:A:0 <-> relay:pX:a:0/1 <-> relay:pX:b:0/1 <-> ep:B:0
 *
 * This still preserves strict endpoint single-port constraints.
 */
export function synthesizePhase2Topology(flowGraph: FlowGraph): SynthesisResult {
  const devices: Topology["devices"] = {};
  const links: Topology["links"] = [];
  const allEdges = flowGraph.edges.map((e) => ({ ...e }));
  const coveredEdgeKeys = new Set<string>();
  const selectedPairs: PairCandidate[] = [];

  for (const address of [...flowGraph.nodes].sort()) {
    devices[`ep:${address}`] = {
      id: `ep:${address}`,
      type: "endpoint",
      address,
      state: { nextSendTick: 0 },
    };
  }

  const usedEndpoints = new Set<string>();
  for (const candidate of buildPairCandidates(flowGraph)) {
    const aId = `ep:${candidate.a}`;
    const bId = `ep:${candidate.b}`;
    if (usedEndpoints.has(aId) || usedEndpoints.has(bId)) {
      continue;
    }
    usedEndpoints.add(aId);
    usedEndpoints.add(bId);
    selectedPairs.push(candidate);
    if (candidate.coversAtoB) {
      coveredEdgeKeys.add(`${candidate.a}->${candidate.b}`);
    }
    if (candidate.coversBtoA) {
      coveredEdgeKeys.add(`${candidate.b}->${candidate.a}`);
    }
  }

  selectedPairs.forEach((pair, i) => {
    const id = i.toString().padStart(4, "0");
    const relayA = `relay:pair:${id}:a`;
    const relayB = `relay:pair:${id}:b`;
    devices[relayA] = { id: relayA, type: "relay" };
    devices[relayB] = { id: relayB, type: "relay" };

    links.push(
      { a: { deviceId: `ep:${pair.a}`, port: 0 }, b: { deviceId: relayA, port: 0 } },
      { a: { deviceId: relayA, port: 1 }, b: { deviceId: relayB, port: 0 } },
      { a: { deviceId: relayB, port: 1 }, b: { deviceId: `ep:${pair.b}`, port: 0 } },
    );
  });

  for (const device of Object.values(devices)) {
    if (device.type !== "endpoint") {
      continue;
    }
    const address = device.address;
    const outgoing = allEdges
      .filter((e) => e.src === address && coveredEdgeKeys.has(`${e.src}->${e.dst}`))
      .map((e) => e.dst);
    if (outgoing.length > 0) {
      device.generator = {
        destinations: [...new Set(outgoing)].sort(),
        minIntervalTicks: 3,
        maxIntervalTicks: 7,
        sensitiveChance: 0.1,
        ttl: 12,
        subjectPrefix: "AUTO2-",
      };
    }
  }

  const selectedEdges = allEdges.filter((e) => coveredEdgeKeys.has(`${e.src}->${e.dst}`));
  const unselectedEdges = allEdges.filter((e) => !coveredEdgeKeys.has(`${e.src}->${e.dst}`));

  return {
    topology: { devices, links },
    report: {
      totalEdges: allEdges.length,
      coveredEdges: selectedEdges.length,
      deferredEdges: unselectedEdges.length,
      selectedEdges,
      unselectedEdges,
    },
  };
}

type TripleOrientation = "clockwise" | "counterclockwise";

interface TripleCandidate {
  a: string;
  b: string;
  c: string;
  orientation: TripleOrientation;
  weight: number;
}

interface GadgetSelection {
  endpoints: string[];
  coveredEdges: string[];
  build: (index: number, devices: Topology["devices"], links: Topology["links"]) => void;
}

function edgeExists(edgeSet: Set<string>, src: string, dst: string): boolean {
  return edgeSet.has(`${src}->${dst}`);
}

function buildTripleCandidates(flowGraph: FlowGraph): TripleCandidate[] {
  const edgeSet = new Set(flowGraph.edges.map((e) => `${e.src}->${e.dst}`));
  const nodes = [...flowGraph.nodes].sort();
  const out: TripleCandidate[] = [];

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      for (let k = j + 1; k < nodes.length; k += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const c = nodes[k];

        const cwWeight =
          Number(edgeExists(edgeSet, a, b)) +
          Number(edgeExists(edgeSet, b, c)) +
          Number(edgeExists(edgeSet, c, a));
        if (cwWeight > 0) {
          out.push({ a, b, c, orientation: "clockwise", weight: cwWeight });
        }

        const ccwWeight =
          Number(edgeExists(edgeSet, a, c)) +
          Number(edgeExists(edgeSet, c, b)) +
          Number(edgeExists(edgeSet, b, a));
        if (ccwWeight > 0) {
          out.push({ a, b, c, orientation: "counterclockwise", weight: ccwWeight });
        }
      }
    }
  }

  out.sort((x, y) => {
    if (x.weight !== y.weight) {
      return y.weight - x.weight;
    }
    const xKey = `${x.a}::${x.b}::${x.c}::${x.orientation}`;
    const yKey = `${y.a}::${y.b}::${y.c}::${y.orientation}`;
    return xKey.localeCompare(yKey);
  });
  return out;
}

/**
 * Phase 3 synthesizer.
 *
 * Mixed gadget synthesis under strict endpoint single-port constraints:
 * - pair rail gadget: can cover up to 2 directed edges (A->B and B->A)
 * - 3-endpoint hub-cycle gadget: can cover up to 3 directed edges
 *
 * Greedy set-packing heuristic:
 * - choose highest edge-density gadgets first
 * - endpoints are disjoint across gadgets
 *
 * This introduces real hub entities with explicit clockwise/counterclockwise config.
 */
export function synthesizePhase3Topology(flowGraph: FlowGraph): SynthesisResult {
  const devices: Topology["devices"] = {};
  const links: Topology["links"] = [];
  const edgeSet = new Set(flowGraph.edges.map((e) => `${e.src}->${e.dst}`));

  for (const address of [...flowGraph.nodes].sort()) {
    devices[`ep:${address}`] = {
      id: `ep:${address}`,
      type: "endpoint",
      address,
      state: { nextSendTick: 0 },
    };
  }

  const gadgetPool: GadgetSelection[] = [];

  for (const pair of buildPairCandidates(flowGraph)) {
    const coveredEdges: string[] = [];
    if (pair.coversAtoB) coveredEdges.push(`${pair.a}->${pair.b}`);
    if (pair.coversBtoA) coveredEdges.push(`${pair.b}->${pair.a}`);
    gadgetPool.push({
      endpoints: [pair.a, pair.b],
      coveredEdges,
      build: (index, d, l) => {
        const id = index.toString().padStart(4, "0");
        const relayA = `relay:g3:pair:${id}:a`;
        const relayB = `relay:g3:pair:${id}:b`;
        d[relayA] = { id: relayA, type: "relay" };
        d[relayB] = { id: relayB, type: "relay" };
        l.push(
          { a: { deviceId: `ep:${pair.a}`, port: 0 }, b: { deviceId: relayA, port: 0 } },
          { a: { deviceId: relayA, port: 1 }, b: { deviceId: relayB, port: 0 } },
          { a: { deviceId: relayB, port: 1 }, b: { deviceId: `ep:${pair.b}`, port: 0 } },
        );
      },
    });
  }

  for (const triple of buildTripleCandidates(flowGraph)) {
    const coveredEdges =
      triple.orientation === "clockwise"
        ? [`${triple.a}->${triple.b}`, `${triple.b}->${triple.c}`, `${triple.c}->${triple.a}`]
        : [`${triple.a}->${triple.c}`, `${triple.c}->${triple.b}`, `${triple.b}->${triple.a}`];

    const realCovered = coveredEdges.filter((e) => edgeSet.has(e));
    gadgetPool.push({
      endpoints: [triple.a, triple.b, triple.c],
      coveredEdges: realCovered,
      build: (index, d, l) => {
        const id = index.toString().padStart(4, "0");
        const hub = `hub:g3:tri:${id}`;
        d[hub] = { id: hub, type: "hub", rotation: triple.orientation };
        l.push(
          { a: { deviceId: `ep:${triple.a}`, port: 0 }, b: { deviceId: hub, port: 0 } },
          { a: { deviceId: `ep:${triple.b}`, port: 0 }, b: { deviceId: hub, port: 1 } },
          { a: { deviceId: `ep:${triple.c}`, port: 0 }, b: { deviceId: hub, port: 2 } },
        );
      },
    });
  }

  gadgetPool.sort((x, y) => {
    const xDensity = x.coveredEdges.length / x.endpoints.length;
    const yDensity = y.coveredEdges.length / y.endpoints.length;
    if (xDensity !== yDensity) {
      return yDensity - xDensity;
    }
    if (x.coveredEdges.length !== y.coveredEdges.length) {
      return y.coveredEdges.length - x.coveredEdges.length;
    }
    const xKey = `${x.endpoints.join("|")}::${x.coveredEdges.join("|")}`;
    const yKey = `${y.endpoints.join("|")}::${y.coveredEdges.join("|")}`;
    return xKey.localeCompare(yKey);
  });

  const usedEndpoints = new Set<string>();
  const selectedGadgets: GadgetSelection[] = [];
  const coveredEdgeKeys = new Set<string>();

  for (const gadget of gadgetPool) {
    if (gadget.coveredEdges.length === 0) {
      continue;
    }
    if (gadget.endpoints.some((e) => usedEndpoints.has(e))) {
      continue;
    }
    selectedGadgets.push(gadget);
    for (const ep of gadget.endpoints) {
      usedEndpoints.add(ep);
    }
    for (const edgeKey of gadget.coveredEdges) {
      coveredEdgeKeys.add(edgeKey);
    }
  }

  selectedGadgets.forEach((gadget, i) => gadget.build(i, devices, links));

  for (const device of Object.values(devices)) {
    if (device.type !== "endpoint") {
      continue;
    }
    const outgoing = flowGraph.edges
      .filter((e) => e.src === device.address && coveredEdgeKeys.has(`${e.src}->${e.dst}`))
      .map((e) => e.dst);
    if (outgoing.length > 0) {
      device.generator = {
        destinations: [...new Set(outgoing)].sort(),
        minIntervalTicks: 3,
        maxIntervalTicks: 7,
        sensitiveChance: 0.1,
        ttl: 12,
        subjectPrefix: "AUTO3-",
      };
    }
  }

  const selectedEdges = flowGraph.edges.filter((e) => coveredEdgeKeys.has(`${e.src}->${e.dst}`));
  const unselectedEdges = flowGraph.edges.filter((e) => !coveredEdgeKeys.has(`${e.src}->${e.dst}`));

  return {
    topology: { devices, links },
    report: {
      totalEdges: flowGraph.edges.length,
      coveredEdges: selectedEdges.length,
      deferredEdges: unselectedEdges.length,
      selectedEdges,
      unselectedEdges,
    },
  };
}

/**
 * Phase 4 synthesizer (full-coverage target).
 *
 * Builds a single directed ring of hub+filter endpoint access gadgets.
 *
 * Gadget per endpoint E (clockwise hub):
 *   prev.hub:2 -> hubE:0
 *   hubE:1 <-> filterE:0 (operating/core side)
 *   filterE:1 <-> endpointE:0 (endpoint side)
 *   hubE:2 -> next.hub:0
 *
 * FilterE is configured so:
 * - packets from core side are checked by destination;
 *   - if destination differs from E: send back to hub (continue ring)
 *   - if destination matches E: pass to endpoint E
 * - packets from endpoint side bypass to core (no filter analysis).
 *
 * This allows any endpoint to inject into the ring and any destination endpoint
 * to consume when reached, while preserving endpoint single-port constraints.
 */
export function synthesizePhase4RingTopology(flowGraph: FlowGraph): SynthesisResult {
  const devices: Topology["devices"] = {};
  const links: Topology["links"] = [];
  const addresses = [...flowGraph.nodes].sort();

  for (const address of addresses) {
    const epId = `ep:${address}`;
    const hubId = `hub:ring:${address}`;
    const filterId = `filter:ring:${address}`;

    devices[epId] = {
      id: epId,
      type: "endpoint",
      address,
      state: { nextSendTick: 0 },
    };
    devices[hubId] = {
      id: hubId,
      type: "hub",
      rotation: "clockwise",
    };
    devices[filterId] = {
      id: filterId,
      type: "filter",
      operatingPort: 0,
      addressField: "destination",
      operation: "differ",
      mask: address,
      action: "send_back",
      collisionHandling: "send_back_outbound",
    };

    // endpoint <-> filter(endpoint side)
    links.push({ a: { deviceId: epId, port: 0 }, b: { deviceId: filterId, port: 1 } });
    // filter(core side) <-> hub port 1
    links.push({ a: { deviceId: filterId, port: 0 }, b: { deviceId: hubId, port: 1 } });
  }

  for (let i = 0; i < addresses.length; i += 1) {
    const current = addresses[i];
    const next = addresses[(i + 1) % addresses.length];
    links.push({
      a: { deviceId: `hub:ring:${current}`, port: 2 },
      b: { deviceId: `hub:ring:${next}`, port: 0 },
    });
  }

  for (const device of Object.values(devices)) {
    if (device.type !== "endpoint") {
      continue;
    }
    const outgoing = flowGraph.edges
      .filter((e) => e.src === device.address)
      .map((e) => e.dst);
    if (outgoing.length > 0) {
      device.generator = {
        destinations: [...new Set(outgoing)].sort(),
        minIntervalTicks: 3,
        maxIntervalTicks: 7,
        sensitiveChance: 0.1,
        // Leave TTL undefined by default for full-reachability baseline.
        subjectPrefix: "AUTO4-",
      };
    }
  }

  return {
    topology: { devices, links },
    report: {
      totalEdges: flowGraph.edges.length,
      coveredEdges: flowGraph.edges.length,
      deferredEdges: 0,
      selectedEdges: [...flowGraph.edges],
      unselectedEdges: [],
    },
  };
}

function addressRegion(address: string): string {
  const parts = address.split(".");
  return parts.length >= 2 ? parts[1] : "0";
}

/**
 * Phase 5 synthesizer: hierarchical "tree of rings".
 *
 * - One regional ring per second dibit (0.0.*.*, 0.1.*.*, 0.2.*.*, 0.3.*.*)
 * - One core ring connecting regional gateways
 * - Endpoint stations (hub+filter) on regional rings
 * - Gateway stations (hub+filter) bridge region <-> core
 *
 * Routing behavior:
 * - Endpoint station delivers only when destination equals endpoint IP.
 * - Gateway station keeps region-local packets on the region ring, but forwards
 *   non-local packets to core.
 * - Core ring probes gateways; wrong-region gateway reinjects to core, correct
 *   region gateway keeps packet on region ring for local delivery.
 */
export function synthesizePhase5HierarchicalRings(flowGraph: FlowGraph): SynthesisResult {
  const devices: Topology["devices"] = {};
  const links: Topology["links"] = [];
  const addresses = [...flowGraph.nodes].sort();
  const regionMap = new Map<string, string[]>();

  for (const address of addresses) {
    const region = addressRegion(address);
    if (!regionMap.has(region)) {
      regionMap.set(region, []);
    }
    regionMap.get(region)!.push(address);
  }

  const regions = [...regionMap.keys()].sort();

  for (const region of regions) {
    const regionAddresses = regionMap.get(region) ?? [];
    const stationHubs: string[] = [];

    for (const address of regionAddresses) {
      const epId = `ep:${address}`;
      const hubId = `hub:region:${region}:ep:${address}`;
      const filterId = `filter:region:${region}:ep:${address}`;

      devices[epId] = {
        id: epId,
        type: "endpoint",
        address,
        state: { nextSendTick: 0 },
      };
      devices[hubId] = { id: hubId, type: "hub", rotation: "clockwise" };
      devices[filterId] = {
        id: filterId,
        type: "filter",
        operatingPort: 0,
        addressField: "destination",
        operation: "differ",
        mask: address,
        action: "send_back",
        collisionHandling: "send_back_outbound",
      };

      // Endpoint station internals.
      links.push({ a: { deviceId: epId, port: 0 }, b: { deviceId: filterId, port: 1 } });
      links.push({ a: { deviceId: filterId, port: 0 }, b: { deviceId: hubId, port: 1 } });

      stationHubs.push(hubId);
    }

    // Add one gateway station hub/filter to the regional ring.
    const gwHub = `hub:region:${region}:gateway`;
    const gwFilter = `filter:region:${region}:gateway`;
    devices[gwHub] = { id: gwHub, type: "hub", rotation: "clockwise" };
    devices[gwFilter] = {
      id: gwFilter,
      type: "filter",
      operatingPort: 0,
      addressField: "destination",
      operation: "match",
      mask: `0.${region}.*.*`,
      action: "send_back",
      collisionHandling: "send_back_outbound",
    };
    links.push({ a: { deviceId: gwFilter, port: 0 }, b: { deviceId: gwHub, port: 1 } });
    stationHubs.push(gwHub);

    // Regional ring hub2 -> next hub0
    for (let i = 0; i < stationHubs.length; i += 1) {
      const current = stationHubs[i];
      const next = stationHubs[(i + 1) % stationHubs.length];
      links.push({
        a: { deviceId: current, port: 2 },
        b: { deviceId: next, port: 0 },
      });
    }
  }

  // Core ring hubs, one per region.
  for (const region of regions) {
    const coreHub = `hub:core:${region}`;
    devices[coreHub] = { id: coreHub, type: "hub", rotation: "clockwise" };

    // Gateway filter non-operating side (port 1) links to core hub port 1.
    links.push({
      a: { deviceId: `filter:region:${region}:gateway`, port: 1 },
      b: { deviceId: coreHub, port: 1 },
    });
  }
  for (let i = 0; i < regions.length; i += 1) {
    const current = regions[i];
    const next = regions[(i + 1) % regions.length];
    links.push({
      a: { deviceId: `hub:core:${current}`, port: 2 },
      b: { deviceId: `hub:core:${next}`, port: 0 },
    });
  }

  // Generators from demand graph.
  for (const device of Object.values(devices)) {
    if (device.type !== "endpoint") {
      continue;
    }
    const outgoing = flowGraph.edges
      .filter((e) => e.src === device.address)
      .map((e) => e.dst);
    if (outgoing.length > 0) {
      device.generator = {
        destinations: [...new Set(outgoing)].sort(),
        minIntervalTicks: 3,
        maxIntervalTicks: 7,
        sensitiveChance: 0.1,
        subjectPrefix: "AUTO5-",
      };
    }
  }

  return {
    topology: { devices, links },
    report: {
      totalEdges: flowGraph.edges.length,
      coveredEdges: flowGraph.edges.length,
      deferredEdges: 0,
      selectedEdges: [...flowGraph.edges],
      unselectedEdges: [],
    },
  };
}
