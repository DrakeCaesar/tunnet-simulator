import { TunnetSimulator } from "./simulator.js";
import { FlowEdge, Topology } from "./types.js";

export type VerificationStatus = "delivered" | "dropped" | "timeout" | "inject_failed";

export interface EdgeVerificationResult {
  edge: FlowEdge;
  status: VerificationStatus;
  ticksUsed: number;
  reason?: string;
}

export interface VerificationSummary {
  total: number;
  delivered: number;
  dropped: number;
  timeout: number;
  injectFailed: number;
  results: EdgeVerificationResult[];
}

function cloneTopologyWithoutGenerators(topology: Topology): Topology {
  const copy = structuredClone(topology) as Topology;
  for (const device of Object.values(copy.devices)) {
    if (device.type === "endpoint") {
      delete device.generator;
      device.state.nextSendTick = 0;
    }
  }
  return copy;
}

export function verifyEdgesIndividually(
  topology: Topology,
  edges: FlowEdge[],
  options?: { maxTicksPerEdge?: number; ttl?: number },
): VerificationSummary {
  const maxTicksPerEdge = options?.maxTicksPerEdge ?? 180;
  const ttl = options?.ttl;
  const results: EdgeVerificationResult[] = [];

  for (const edge of edges) {
    const isolatedTopology = cloneTopologyWithoutGenerators(topology);
    const sim = new TunnetSimulator(isolatedTopology, 20260421);
    const inject = sim.injectPacketFromEndpoint(edge.src, edge.dst, {
      ttl,
      sensitive: false,
      subject: "VERIFY",
    });

    if (!inject.ok) {
      results.push({
        edge,
        status: "inject_failed",
        ticksUsed: 0,
        reason: inject.reason,
      });
      continue;
    }

    let status: VerificationStatus = "timeout";
    let ticksUsed = maxTicksPerEdge;
    for (let t = 1; t <= maxTicksPerEdge; t += 1) {
      const snap = sim.step();
      if (snap.stats.delivered > 0) {
        status = "delivered";
        ticksUsed = t;
        break;
      }
      if (snap.stats.dropped > 0 || snap.stats.ttlExpired > 0) {
        status = "dropped";
        ticksUsed = t;
        break;
      }
    }

    results.push({ edge, status, ticksUsed });
  }

  return {
    total: results.length,
    delivered: results.filter((r) => r.status === "delivered").length,
    dropped: results.filter((r) => r.status === "dropped").length,
    timeout: results.filter((r) => r.status === "timeout").length,
    injectFailed: results.filter((r) => r.status === "inject_failed").length,
    results,
  };
}
