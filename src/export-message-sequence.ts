import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyRecoveredStateTransitions,
  EndpointAddress,
  RecoveredSchedulerState,
  advanceNetTick,
  evaluateEndpointSend,
} from "./recovered-endpoint-scheduler.js";

type AddressEncodingStrategy =
  | "identity"
  | "plus_one_all_octets"
  | "plus_one_first_octet";

type EndpointRow = {
  address: string;
  sends_to: string[];
};

type MessageEvent = {
  tick: number;
  src: string;
  dstMask: string;
  matchedDestinations: string[];
  header: number;
  profile: string;
};

type OutputJson = {
  metadata: {
    encodingStrategy: AddressEncodingStrategy;
    phaseA: number;
    phaseB: number;
    analyzedTicks: number;
    repeatPeriodTicks: number;
    eventsInPeriod: number;
  };
  events: MessageEvent[];
};

function parseAddress(address: string): EndpointAddress {
  const parts = address.split(".").map((v) => Number(v));
  if (parts.length !== 4 || parts.some((v) => Number.isNaN(v))) {
    throw new Error(`Invalid endpoint address: ${address}`);
  }
  return { a: parts[0], b: parts[1], c: parts[2], d: parts[3] };
}

function encodeAddress(address: EndpointAddress, strategy: AddressEncodingStrategy): EndpointAddress {
  switch (strategy) {
    case "identity":
      return address;
    case "plus_one_first_octet":
      return { ...address, a: address.a + 1 };
    case "plus_one_all_octets":
      return {
        a: address.a + 1,
        b: address.b + 1,
        c: address.c + 1,
        d: address.d + 1,
      };
    default:
      return address;
  }
}

function matchMask(mask: string, candidate: string): boolean {
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

function loadEndpoints(path = "data.json"): EndpointRow[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { endpoints: EndpointRow[] };
  return parsed.endpoints;
}

function buildDestinationList(src: string, masks: string[], allAddresses: string[]): string[] {
  const dests = new Set<string>();
  for (const mask of masks) {
    for (const candidate of allAddresses) {
      if (candidate === src) continue;
      if (matchMask(mask, candidate)) dests.add(candidate);
    }
  }
  return [...dests].sort();
}

function headerToMask(header: number): string {
  const a = header & 0xff;
  const b = (header >>> 8) & 0xff;
  const c = (header >>> 16) & 0xff;
  const d = (header >>> 24) & 0xff;
  const part = (v: number): string => (v === 0 ? "*" : String(v - 1));
  return `${part(a)}.${part(b)}.${part(c)}.${part(d)}`;
}

function signaturesByTick(events: MessageEvent[], ticks: number): string[] {
  const byTick = new Map<number, MessageEvent[]>();
  for (const ev of events) {
    if (!byTick.has(ev.tick)) byTick.set(ev.tick, []);
    byTick.get(ev.tick)?.push(ev);
  }
  const out: string[] = [];
  for (let t = 0; t < ticks; t += 1) {
    const list = (byTick.get(t) ?? [])
      .map((e) => `${e.src}>${e.dstMask}>${e.matchedDestinations.join(",")}|${e.header}|${e.profile}`)
      .sort()
      .join(";");
    out.push(list);
  }
  return out;
}

function detectPeriod(signatures: string[]): number {
  const n = signatures.length;
  for (let p = 1; p <= Math.floor(n / 2); p += 1) {
    let ok = true;
    for (let i = 0; i + p < n; i += 1) {
      if (signatures[i] !== signatures[i + p]) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return n;
}

function main(): void {
  const ticksArg = process.argv[2];
  const strategyArg = process.argv[3] as AddressEncodingStrategy | undefined;

  const analyzedTicks = ticksArg ? Number(ticksArg) : 2048;
  if (!Number.isFinite(analyzedTicks) || analyzedTicks <= 0) {
    throw new Error(`Invalid analyzed tick count: ${ticksArg}`);
  }
  const strategy: AddressEncodingStrategy = strategyArg ?? "plus_one_all_octets";
  const state: RecoveredSchedulerState = { phaseA: 0, phaseB: 0 };

  const endpoints = loadEndpoints("data.json");
  const allAddresses = endpoints.map((e) => e.address);
  const destinationsBySource = new Map<string, string[]>();
  for (const endpoint of endpoints) {
    destinationsBySource.set(
      endpoint.address,
      buildDestinationList(endpoint.address, endpoint.sends_to ?? [], allAddresses),
    );
  }

  let netTick = 0;
  const events: MessageEvent[] = [];
  for (let tick = 0; tick < analyzedTicks; tick += 1) {
    netTick = advanceNetTick(netTick);
    for (const endpoint of endpoints) {
      const encoded = encodeAddress(parseAddress(endpoint.address), strategy);
      const decision = evaluateEndpointSend(state, encoded, netTick);
      if (!decision.shouldSend || decision.header === null || decision.profile === null) {
        continue;
      }
      const dstMask = headerToMask(decision.header);
      const sourceAllowed = destinationsBySource.get(endpoint.address) ?? [];
      const matchedDestinations = allAddresses.filter(
        (candidate) =>
          candidate !== endpoint.address &&
          matchMask(dstMask, candidate) &&
          sourceAllowed.includes(candidate),
      );
      events.push({
        tick,
        src: endpoint.address,
        dstMask,
        matchedDestinations,
        header: decision.header,
        profile: decision.profile,
      });
      applyRecoveredStateTransitions(state, encoded, decision);
    }
  }

  const signatures = signaturesByTick(events, analyzedTicks);
  const repeatPeriodTicks = detectPeriod(signatures);
  const periodEvents = events.filter((e) => e.tick < repeatPeriodTicks);

  const output: OutputJson = {
    metadata: {
      encodingStrategy: strategy,
      phaseA: state.phaseA,
      phaseB: state.phaseB,
      analyzedTicks,
      repeatPeriodTicks,
      eventsInPeriod: periodEvents.length,
    },
    events: periodEvents,
  };

  mkdirSync("out", { recursive: true });
  const outPath = join("out", "message-sequence.json");
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(
    `[message-sequence] wrote ${outPath} period=${repeatPeriodTicks} events=${periodEvents.length} strategy=${strategy}`,
  );
}

main();

