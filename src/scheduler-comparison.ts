import { readFileSync } from "node:fs";
import {
  type AddressEncodingStrategy,
  encodeEndpointAddressForStrategy,
  parseEndpointAddressString,
} from "./endpoint-address-encoding.js";
import { RecoveredSchedulerState, advanceNetTick, evaluateEndpointSend } from "./recovered-endpoint-scheduler.js";

type EndpointRow = {
  address: string;
  send_rate: number;
  sends_to: string[];
};

type EndpointComparison = {
  address: string;
  recoveredEmits: number;
  legacyEmits: number;
  recoveredRatePerTick: number;
  legacyRatePerTick: number;
  absoluteDeltaPerTick: number;
};

type ComparisonSummary = {
  ticks: number;
  encodingStrategy: AddressEncodingStrategy;
  endpointsCompared: number;
  averageRecoveredRate: number;
  averageLegacyRate: number;
  averageAbsoluteDelta: number;
  topDivergences: EndpointComparison[];
  byEndpoint: EndpointComparison[];
};

export type { AddressEncodingStrategy } from "./endpoint-address-encoding.js";

function loadEndpointRows(path = "data.json"): EndpointRow[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { endpoints: EndpointRow[] };
  return parsed.endpoints;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    let x = state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state = x >>> 0;
    return state / 0xffffffff;
  };
}

function randomIntInclusive(min: number, max: number, rnd: () => number): number {
  return Math.floor(rnd() * (max - min + 1)) + min;
}

/**
 * Mirrors the current simulator's endpoint cadence model:
 * - no address-based deterministic branch tree
 * - random next-send interval in [min,max]
 */
function simulateLegacyIntervalModel(
  endpoints: EndpointRow[],
  ticks: number,
  minIntervalTicks = 3,
  maxIntervalTicks = 7,
  seed = 1337,
): Map<string, number> {
  const rnd = createRng(seed);
  const nextSendTick = new Map<string, number>();
  const emitted = new Map<string, number>();

  for (const endpoint of endpoints) {
    nextSendTick.set(endpoint.address, 0);
    emitted.set(endpoint.address, 0);
  }

  for (let tick = 0; tick < ticks; tick += 1) {
    for (const endpoint of endpoints) {
      // Approximate "generator exists" based on endpoint having send targets.
      if (endpoint.sends_to.length === 0) {
        continue;
      }
      const gate = nextSendTick.get(endpoint.address) ?? 0;
      if (tick < gate) {
        continue;
      }
      emitted.set(endpoint.address, (emitted.get(endpoint.address) ?? 0) + 1);
      const delay = randomIntInclusive(minIntervalTicks, maxIntervalTicks, rnd);
      nextSendTick.set(endpoint.address, tick + delay);
    }
  }

  return emitted;
}

function simulateRecoveredModel(
  endpoints: EndpointRow[],
  ticks: number,
  encodingStrategy: AddressEncodingStrategy,
  initialState: RecoveredSchedulerState = { phaseA: 0, phaseB: 0 },
): Map<string, number> {
  const emitted = new Map<string, number>();
  let netTick = 0;
  const state = { ...initialState };

  for (const endpoint of endpoints) {
    emitted.set(endpoint.address, 0);
  }

  for (let i = 0; i < ticks; i += 1) {
    netTick = advanceNetTick(netTick);
    for (const endpoint of endpoints) {
      const addr = encodeEndpointAddressForStrategy(
        parseEndpointAddressString(endpoint.address),
        encodingStrategy,
      );
      const decision = evaluateEndpointSend(state, addr, netTick);
      if (decision.shouldSend) {
        emitted.set(endpoint.address, (emitted.get(endpoint.address) ?? 0) + 1);
      }
    }
  }

  return emitted;
}

export function compareRecoveredAgainstCurrentImplementation(
  ticks = 4096,
  dataPath = "data.json",
  encodingStrategy: AddressEncodingStrategy = "plus_one_all_octets",
  initialRecoveredState: RecoveredSchedulerState = { phaseA: 0, phaseB: 0 },
): ComparisonSummary {
  const endpoints = loadEndpointRows(dataPath);
  const recovered = simulateRecoveredModel(endpoints, ticks, encodingStrategy, initialRecoveredState);
  const legacy = simulateLegacyIntervalModel(endpoints, ticks);

  const byEndpoint: EndpointComparison[] = endpoints.map((endpoint) => {
    const recoveredEmits = recovered.get(endpoint.address) ?? 0;
    const legacyEmits = legacy.get(endpoint.address) ?? 0;
    const recoveredRatePerTick = recoveredEmits / ticks;
    const legacyRatePerTick = legacyEmits / ticks;
    return {
      address: endpoint.address,
      recoveredEmits,
      legacyEmits,
      recoveredRatePerTick,
      legacyRatePerTick,
      absoluteDeltaPerTick: Math.abs(recoveredRatePerTick - legacyRatePerTick),
    };
  });

  const averageRecoveredRate =
    byEndpoint.reduce((sum, r) => sum + r.recoveredRatePerTick, 0) / byEndpoint.length;
  const averageLegacyRate =
    byEndpoint.reduce((sum, r) => sum + r.legacyRatePerTick, 0) / byEndpoint.length;
  const averageAbsoluteDelta =
    byEndpoint.reduce((sum, r) => sum + r.absoluteDeltaPerTick, 0) / byEndpoint.length;

  const topDivergences = [...byEndpoint]
    .sort((a, b) => b.absoluteDeltaPerTick - a.absoluteDeltaPerTick)
    .slice(0, 12);

  return {
    ticks,
    encodingStrategy,
    endpointsCompared: byEndpoint.length,
    averageRecoveredRate,
    averageLegacyRate,
    averageAbsoluteDelta,
    topDivergences,
    byEndpoint,
  };
}

