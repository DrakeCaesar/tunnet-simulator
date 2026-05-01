/**
 * Compare **author wiki table** traffic (`data.json` `send_rate` + `sends_to`) vs **recovered**
 * scheduler (`evaluateEndpointSend` + header masks) over N ticks.
 *
 * **`data.json` is not ground truth** — it is a convenience baseline and may disagree with the game or BN.
 * Recovered behavior follows **`sub_1402f9a40` / `sub_1402f5840`** modeling in `recovered-endpoint-scheduler.ts`
 * plus numeric {@link encodeEndpointAddressForStrategy} only (no wiki topology overrides beyond encoding).
 *
 * Only **(sender, receiver)** edges are compared — not headers or RNG pools. Optional
 * **`--edge-subjects-file=`** writes recovered **`packetSubject` / `packetSubjectCandidates`** (union over
 * the run), grouped so every **`src>dst`** with the **same** sorted **`possibleSubjects`** list appears under
 * one **`subjectGroups[]`** entry for the same simulation as edge-compare.
 *
 * Wiki **edge-compare** baseline (not `simulator.ts`, which uses **one random** destination from the list):
 * - Emit when `send_rate > 0`, expanded `sends_to` is non-empty, and `tick % send_rate === 0`.
 * - Each emit adds one edge per destination in the expanded list (broadcast interpretation for **set** parity).
 *
 * Recovered model: same as `export-message-sequence.ts` (one header-derived mask × expanded `sends_to`, state transitions).
 *
 * Comparison is **only** the set of unique **`src>dst`** pairs observed over the whole run (order and
 * per-tick grouping are ignored).
 *
 * **Why sets often disagree:** the wiki side assumes **every** expanded `sends_to` target on each fire;
 * the recovered side usually emits **one header-derived mask per tick**, so receivers are a **subset** of
 * `sends_to`. For several {@link packetProfileUsesWikiSendsToFanOut} profiles, edge-compare mirrors the wiki
 * table by expanding **full** `sends_to` per emit (binary may still route a subset on one tick). That alone can explain gaps without a phase bug.
 *
 * **Phases:** `phaseB` is consulted only for **`a === 4` / `(1,1,1)`** in {@link evaluateEndpointSend} when the
 * encoded tuple hits that path. `phaseA` is **not** read there — it only advances via
 * {@link applyRecoveredStateTransitions} after status-family sends. Use **`plus_one_all_octets_regional_mainframe`**
 * so wiki **`0.{1,2,3}.0.0`** maps to **`(4,1,1,1)`** (`sub_1402f9a40` **`r13 == 4`** gate @ **`0x1402f9ba7`**).
 *
 * CLI: `tsx src/compare-endpoint-edges.ts [ticks] [strategy] [phaseA] [phaseB] [--list-pairs] [--edge-subjects-file=out/edges.json]`
 * With **pnpm**: `pnpm compare:edges -- 10000 … --list-pairs` — a forwarded **`--`** is stripped so **`ticks`** stays numeric.
 * Scan: `tsx src/compare-endpoint-edges.ts scan [ticks] [aMin] [aMax] [bMin] [bMax] [encoding...|all]`
 * - Trailing encodings: `identity`, `plus_one_all_octets`, `plus_one_all_octets_regional_mainframe`, `plus_one_first_octet`, or **`all`**.
 * - Omit encodings → defaults to **`identity` + `plus_one_all_octets` + `plus_one_all_octets_regional_mainframe`**; combined union vs wiki is printed.
 * - Omit phase bounds → ticks=10000, a 0..20, b 0..11.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AddressEncodingStrategy,
  encodeEndpointAddressForStrategy,
  parseEndpointAddressString,
} from "./endpoint-address-encoding.js";
import { dstWikiMaskForRecoveredSend } from "./packet-header-format.js";
import {
  BinaryObservedPhaseA,
  MAINFRAME_SUBPHASE_MAX,
  applyRecoveredStateTransitions,
  packetProfileUsesWikiSendsToFanOut,
  RecoveredSchedulerState,
  advanceNetTick,
  evaluateEndpointSend,
  initialRecoveredSchedulerState,
  type RecoveredDecision,
} from "./recovered-endpoint-scheduler.js";

type EndpointRow = {
  address: string;
  send_rate: number;
  sends_to: string[];
};

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

function collectWikiEdgesForTick(
  tick: number,
  endpoints: EndpointRow[],
  destinationsBySource: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const ep of endpoints) {
    const rate = Math.max(0, Math.floor(ep.send_rate));
    if (rate <= 0) continue;
    const dests = destinationsBySource.get(ep.address) ?? [];
    if (dests.length === 0) continue;
    if (tick % rate !== 0) continue;
    for (const dst of dests) {
      out.push(`${ep.address}>${dst}`);
    }
  }
  return out;
}

type RecoveredEdgeContribution = { pair: string; decision: RecoveredDecision };

function collectRecoveredEdgesForTick(
  netTick: number,
  endpoints: EndpointRow[],
  destinationsBySource: Map<string, string[]>,
  allAddresses: string[],
  state: RecoveredSchedulerState,
  strategy: AddressEncodingStrategy,
  collectContributions: boolean,
): { edges: string[]; contributions: RecoveredEdgeContribution[] } {
  const edges: string[] = [];
  const contributions: RecoveredEdgeContribution[] = [];
  for (const endpoint of endpoints) {
    const encoded = encodeEndpointAddressForStrategy(parseEndpointAddressString(endpoint.address), strategy);
    const decision = evaluateEndpointSend(state, encoded, netTick);
    if (!decision.shouldSend || decision.header === null || decision.profile === null) {
      continue;
    }
    const header = decision.header;
    const profile = decision.profile;
    const sourceAllowed = destinationsBySource.get(endpoint.address) ?? [];
    const matched = packetProfileUsesWikiSendsToFanOut(profile)
      ? sourceAllowed.filter((candidate) => candidate !== endpoint.address)
      : allAddresses.filter(
          (candidate) =>
            candidate !== endpoint.address &&
            matchMask(dstWikiMaskForRecoveredSend(endpoint.address, header, profile), candidate) &&
            sourceAllowed.includes(candidate),
        );
    for (const dst of matched) {
      const pair = `${endpoint.address}>${dst}`;
      edges.push(pair);
      if (collectContributions) {
        contributions.push({ pair, decision });
      }
    }
    applyRecoveredStateTransitions(state, encoded, decision);
  }
  return { edges, contributions };
}

function mergeSubjectStringsFromDecision(target: Set<string>, d: RecoveredDecision): void {
  if (d.packetSubjectCandidates?.length) {
    for (const s of d.packetSubjectCandidates) {
      if (s) target.add(s);
    }
  }
  if (d.packetSubject != null && d.packetSubject !== "") {
    target.add(d.packetSubject);
  }
}

type EdgeSubjectAgg = { subjects: Set<string>; profiles: Set<string> };

function getOrCreateEdgeSubjectAgg(map: Map<string, EdgeSubjectAgg>, pair: string): EdgeSubjectAgg {
  let row = map.get(pair);
  if (!row) {
    row = { subjects: new Set(), profiles: new Set() };
    map.set(pair, row);
  }
  return row;
}

function aggregateSets(edges: readonly string[]): {
  senders: Set<string>;
  receivers: Set<string>;
  pairs: Set<string>;
} {
  const senders = new Set<string>();
  const receivers = new Set<string>();
  const pairs = new Set<string>();
  for (const e of edges) {
    const gt = e.indexOf(">");
    if (gt <= 0) continue;
    senders.add(e.slice(0, gt));
    receivers.add(e.slice(gt + 1));
    pairs.add(e);
  }
  return { senders, receivers, pairs };
}

function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

function setDifference(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) {
    if (!b.has(x)) out.push(x);
  }
  return out.sort();
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) {
    if (b.has(x)) n += 1;
  }
  return n;
}

function simulateRecoveredPairs(params: {
  endpoints: EndpointRow[];
  destinationsBySource: Map<string, string[]>;
  allAddresses: string[];
  ticks: number;
  strategy: AddressEncodingStrategy;
  phaseA: number;
  phaseB: number;
  collectEdgeSubjects?: boolean;
}): {
  pairs: Set<string>;
  totalEdges: number;
  finalPhaseA: number;
  finalPhaseB: number;
  edgeSubjectsByPair?: Map<string, EdgeSubjectAgg>;
} {
  const {
    endpoints,
    destinationsBySource,
    allAddresses,
    ticks,
    strategy,
    phaseA,
    phaseB,
    collectEdgeSubjects = false,
  } = params;
  const state = initialRecoveredSchedulerState(phaseA, phaseB);
  const pairs = new Set<string>();
  const edgeSubjectsByPair = collectEdgeSubjects ? new Map<string, EdgeSubjectAgg>() : undefined;
  let totalEdges = 0;
  let netTick = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    netTick = advanceNetTick(netTick);
    const { edges: tickEdges, contributions } = collectRecoveredEdgesForTick(
      netTick,
      endpoints,
      destinationsBySource,
      allAddresses,
      state,
      strategy,
      collectEdgeSubjects,
    );
    totalEdges += tickEdges.length;
    for (const edge of tickEdges) {
      pairs.add(edge);
    }
    if (edgeSubjectsByPair && contributions.length > 0) {
      for (const { pair, decision } of contributions) {
        const row = getOrCreateEdgeSubjectAgg(edgeSubjectsByPair, pair);
        if (decision.profile) {
          row.profiles.add(decision.profile);
        }
        mergeSubjectStringsFromDecision(row.subjects, decision);
      }
    }
  }
  return {
    pairs,
    totalEdges,
    finalPhaseA: state.phaseA,
    finalPhaseB: state.phaseB,
    ...(edgeSubjectsByPair !== undefined ? { edgeSubjectsByPair } : {}),
  };
}

const ENCODING_STRATEGIES: readonly AddressEncodingStrategy[] = [
  "identity",
  "plus_one_all_octets",
  "plus_one_all_octets_regional_mainframe",
  "plus_one_first_octet",
];

function isEncodingStrategy(value: string): value is AddressEncodingStrategy {
  return (ENCODING_STRATEGIES as readonly string[]).includes(value);
}

function parseScanArgs(rest: string[]): {
  ticks: number;
  aMin: number;
  aMax: number;
  bMin: number;
  bMax: number;
  strategies: AddressEncodingStrategy[];
} {
  const tail = [...rest];
  const strategies: AddressEncodingStrategy[] = [];
  while (tail.length > 0 && isEncodingStrategy(tail[tail.length - 1]!)) {
    strategies.unshift(tail.pop() as AddressEncodingStrategy);
  }
  if (tail.length > 0 && tail[tail.length - 1] === "all") {
    tail.pop();
    strategies.push(...ENCODING_STRATEGIES);
  }
  if (strategies.length === 0) {
    strategies.push("identity", "plus_one_all_octets", "plus_one_all_octets_regional_mainframe");
  }

  const dedupStrategies: AddressEncodingStrategy[] = [];
  const seen = new Set<AddressEncodingStrategy>();
  for (const s of strategies) {
    if (seen.has(s)) continue;
    seen.add(s);
    dedupStrategies.push(s);
  }

  const ticks = tail[0] !== undefined ? Number(tail[0]) : 10_000;
  const aMin = tail[1] !== undefined ? Number(tail[1]) : 0;
  const aMax = tail[2] !== undefined ? Number(tail[2]) : 20;
  const bMin = tail[3] !== undefined ? Number(tail[3]) : 0;
  const bMax = tail[4] !== undefined ? Number(tail[4]) : 11;
  if (!Number.isFinite(ticks) || ticks <= 0) throw new Error(`Invalid scan ticks: ${tail[0]}`);
  for (const [name, v] of [
    ["aMin", aMin],
    ["aMax", aMax],
    ["bMin", bMin],
    ["bMax", bMax],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 0xff) {
      throw new Error(`Invalid scan ${name} (use 0..255): ${v}`);
    }
  }
  if (aMin > aMax || bMin > bMax) {
    throw new Error(`scan range inverted: phaseA ${aMin}..${aMax}, phaseB ${bMin}..${bMax}`);
  }
  return { ticks, aMin, aMax, bMin, bMax, strategies: dedupStrategies };
}

type ScanPhaseRow = {
  phaseA: number;
  phaseB: number;
  intersection: number;
  recoveredSize: number;
  totalEdges: number;
  jaccard: number;
  finalPhaseA: number;
  finalPhaseB: number;
};

function buildPhaseGridRows(
  endpoints: EndpointRow[],
  destinationsBySource: Map<string, string[]>,
  allAddresses: string[],
  wikiPairs: Set<string>,
  ticks: number,
  aMin: number,
  aMax: number,
  bMin: number,
  bMax: number,
  strategy: AddressEncodingStrategy,
): { rows: ScanPhaseRow[]; pairUnionAcrossGrid: Set<string> } {
  const pairUnionAcrossGrid = new Set<string>();
  const rows: ScanPhaseRow[] = [];
  for (let pa = aMin; pa <= aMax; pa += 1) {
    for (let pb = bMin; pb <= bMax; pb += 1) {
      const { pairs, totalEdges, finalPhaseA, finalPhaseB } = simulateRecoveredPairs({
        endpoints,
        destinationsBySource,
        allAddresses,
        ticks,
        strategy,
        phaseA: pa,
        phaseB: pb,
      });
      for (const p of pairs) {
        pairUnionAcrossGrid.add(p);
      }
      const inter = intersectionSize(wikiPairs, pairs);
      const unionSize = wikiPairs.size + pairs.size - inter;
      const jaccard = unionSize === 0 ? 1 : inter / unionSize;
      rows.push({
        phaseA: pa,
        phaseB: pb,
        intersection: inter,
        recoveredSize: pairs.size,
        totalEdges,
        jaccard,
        finalPhaseA,
        finalPhaseB,
      });
    }
  }
  return { rows, pairUnionAcrossGrid };
}

function printPhaseGridSummary(rows: ScanPhaseRow[], wikiSize: number, strategy: AddressEncodingStrategy): void {
  rows.sort((x, y) => y.intersection - x.intersection || y.jaccard - x.jaccard);
  const best = rows[0];
  const allSame =
    rows.length > 0 &&
    rows.every(
      (r) =>
        r.intersection === best!.intersection &&
        r.recoveredSize === best!.recoveredSize &&
        r.totalEdges === best!.totalEdges,
    );

  console.log(`[edge-compare scan] --- encoding=${strategy} ---`);
  if (allSame) {
    console.log(
      `[edge-compare scan] all (${rows.length}) phase cells agree: intersection=${best.intersection} recoveredPairs=${best.recoveredSize} totalEdges=${best.totalEdges} jaccard=${best.jaccard.toFixed(4)}`,
    );
    console.log(
      `[edge-compare scan] (flat phases: expected if evaluateEndpointSend ignores initial phaseA/phaseB for this data + encoding — see file header.)`,
    );
  } else {
    console.log("[edge-compare scan] top cells by |wiki ∩ recovered|, then Jaccard:");
    for (const r of rows.slice(0, 20)) {
      console.log(
        `  phaseA=${r.phaseA} phaseB=${r.phaseB}  intersection=${r.intersection}/${wikiSize}  recoveredPairs=${r.recoveredSize}  totalEdges=${r.totalEdges}  jaccard=${r.jaccard.toFixed(4)}  finalPhase=(${r.finalPhaseA},${r.finalPhaseB})`,
      );
    }
  }
}

function runScan(params: {
  endpoints: EndpointRow[];
  destinationsBySource: Map<string, string[]>;
  allAddresses: string[];
  wikiPairs: Set<string>;
  ticks: number;
  aMin: number;
  aMax: number;
  bMin: number;
  bMax: number;
  strategies: AddressEncodingStrategy[];
}): void {
  const {
    endpoints,
    destinationsBySource,
    allAddresses,
    wikiPairs,
    ticks,
    aMin,
    aMax,
    bMin,
    bMax,
    strategies,
  } = params;

  const wikiSize = wikiPairs.size;
  console.log(
    `[edge-compare scan] grid phaseA=${aMin}..${aMax} phaseB=${bMin}..${bMax} ticks=${ticks} encodings=${strategies.join(",")}`,
  );
  console.log(
    `[edge-compare scan] binary hints: MAINFRAME_SUBPHASE_MAX=${MAINFRAME_SUBPHASE_MAX} (HLIL mainframe cases); BinaryObservedPhaseA samples = 5,6,7,0xc,0xd,0xe,0x13 (not exhaustive).`,
  );
  console.log(`[edge-compare scan] wiki uniquePairs=${wikiSize}`);

  const unionAcrossEncodingsAndPhases = new Set<string>();

  for (const strategy of strategies) {
    const { rows, pairUnionAcrossGrid } = buildPhaseGridRows(
      endpoints,
      destinationsBySource,
      allAddresses,
      wikiPairs,
      ticks,
      aMin,
      aMax,
      bMin,
      bMax,
      strategy,
    );
    for (const p of pairUnionAcrossGrid) {
      unionAcrossEncodingsAndPhases.add(p);
    }
    const uInter = intersectionSize(wikiPairs, pairUnionAcrossGrid);
    const uUnion = wikiPairs.size + pairUnionAcrossGrid.size - uInter;
    const uJaccard = uUnion === 0 ? 1 : uInter / uUnion;
    console.log(
      `[edge-compare scan] union(unique pairs over phase grid only) encoding=${strategy}: size=${pairUnionAcrossGrid.size} intersection=${uInter}/${wikiSize} jaccard=${uJaccard.toFixed(4)}`,
    );
    printPhaseGridSummary(rows, wikiSize, strategy);
  }

  const grandInter = intersectionSize(wikiPairs, unionAcrossEncodingsAndPhases);
  const grandUnionSize = wikiPairs.size + unionAcrossEncodingsAndPhases.size - grandInter;
  const grandJaccard = grandUnionSize === 0 ? 1 : grandInter / grandUnionSize;
  console.log("[edge-compare scan] === combined (all encodings × phase grid) ===");
  console.log(
    `[edge-compare scan] union uniquePairs=${unionAcrossEncodingsAndPhases.size} intersection=${grandInter}/${wikiSize} jaccard=${grandJaccard.toFixed(4)}`,
  );
}

function stripListPairsFlag(argv: string[]): { argv: string[]; listPairs: boolean } {
  const listPairs = argv.includes("--list-pairs");
  return { argv: argv.filter((a) => a !== "--list-pairs"), listPairs };
}

function stripEdgeSubjectsFileFlag(argv: string[]): { argv: string[]; edgeSubjectsFile: string | null } {
  let edgeSubjectsFile: string | null = null;
  const next: string[] = [];
  const prefix = "--edge-subjects-file=";
  for (const a of argv) {
    if (a === "--edge-subjects-file") {
      throw new Error(
        "--edge-subjects-file requires a path: --edge-subjects-file=out/edge-pairs-subjects.json",
      );
    }
    if (a.startsWith(prefix)) {
      const pathPart = a.slice(prefix.length);
      if (!pathPart) {
        throw new Error("--edge-subjects-file= must be followed by a non-empty path");
      }
      edgeSubjectsFile = pathPart;
      continue;
    }
    next.push(a);
  }
  return { argv: next, edgeSubjectsFile };
}

function writeEdgeSubjectsReport(params: {
  outPath: string;
  ticks: number;
  strategy: AddressEncodingStrategy;
  phaseA: number;
  phaseB: number;
  finalPhaseA: number;
  finalPhaseB: number;
  edgeSubjectsByPair: Map<string, EdgeSubjectAgg>;
}): void {
  type Row = { pair: string; profiles: string[]; possibleSubjects: string[] };
  const rows: Row[] = [...params.edgeSubjectsByPair.entries()].map(([pair, agg]) => ({
    pair,
    profiles: [...agg.profiles].sort(),
    // Union of packetSubjectCandidates + packetSubject over ticks where this edge fired.
    possibleSubjects: [...agg.subjects].sort(),
  }));

  const subjectKey = (subjects: readonly string[]): string => JSON.stringify([...subjects]);
  const bucket = new Map<
    string,
    { possibleSubjects: string[]; profiles: Set<string>; pairs: string[] }
  >();
  for (const row of rows) {
    const key = subjectKey(row.possibleSubjects);
    let g = bucket.get(key);
    if (!g) {
      g = { possibleSubjects: row.possibleSubjects, profiles: new Set(), pairs: [] };
      bucket.set(key, g);
    }
    g.pairs.push(row.pair);
    for (const p of row.profiles) {
      g.profiles.add(p);
    }
  }

  const subjectGroups = [...bucket.values()]
    .map((g) => ({
      possibleSubjects: g.possibleSubjects,
      profiles: [...g.profiles].sort(),
      pairCount: g.pairs.length,
      pairs: g.pairs.sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      const byCount = b.pairCount - a.pairCount;
      if (byCount !== 0) return byCount;
      return subjectKey(a.possibleSubjects).localeCompare(subjectKey(b.possibleSubjects));
    });

  const doc = {
    meta: {
      ticks: params.ticks,
      strategy: params.strategy,
      initialPhaseA: params.phaseA,
      initialPhaseB: params.phaseB,
      finalPhaseA: params.finalPhaseA,
      finalPhaseB: params.finalPhaseB,
    },
    subjectGroups,
  };
  const dir = path.dirname(params.outPath);
  if (dir !== "." && dir !== "") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(params.outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/** `pnpm run script -- args…` may pass a standalone `--` through to the child; ignore it. */
function stripPnpmArgDelimiter(argv: string[]): string[] {
  return argv.filter((a) => a !== "--");
}

function printSortedPairs(label: string, pairs: Set<string>): void {
  const sorted = [...pairs].sort();
  console.log(`[edge-compare] ${label} (${sorted.length}):`);
  for (const p of sorted) {
    console.log(`  ${p}`);
  }
}

function main(): void {
  const strippedPnpm = stripPnpmArgDelimiter(process.argv.slice(2));
  const { argv: afterSubjects, edgeSubjectsFile } = stripEdgeSubjectsFileFlag(strippedPnpm);
  const { argv: args, listPairs } = stripListPairsFlag(afterSubjects);

  const endpoints = loadEndpoints("data.json");
  const allAddresses = endpoints.map((e) => e.address);
  const destinationsBySource = new Map<string, string[]>();
  for (const endpoint of endpoints) {
    destinationsBySource.set(
      endpoint.address,
      buildDestinationList(endpoint.address, endpoint.sends_to ?? [], allAddresses),
    );
  }

  if (args[0] === "scan") {
    const { ticks, aMin, aMax, bMin, bMax, strategies } = parseScanArgs(args.slice(1));
    const wikiAllEdges: string[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      wikiAllEdges.push(...collectWikiEdgesForTick(tick, endpoints, destinationsBySource));
    }
    const wikiPairs = aggregateSets(wikiAllEdges).pairs;
    runScan({
      endpoints,
      destinationsBySource,
      allAddresses,
      wikiPairs,
      ticks,
      aMin,
      aMax,
      bMin,
      bMax,
      strategies,
    });
    return;
  }

  const ticksArg = args[0];
  const ticks = ticksArg ? Number(ticksArg) : 10_000;
  if (!Number.isFinite(ticks) || ticks <= 0) {
    throw new Error(`Invalid ticks: ${ticksArg}`);
  }

  let strategy: AddressEncodingStrategy = "plus_one_all_octets_regional_mainframe";
  let phaseArgOffset = 1;
  if (args[1] !== undefined && isEncodingStrategy(args[1])) {
    strategy = args[1];
    phaseArgOffset = 2;
  }

  let phaseA = 0;
  let phaseB = 0;
  if (args[phaseArgOffset] !== undefined) {
    phaseA = Number(args[phaseArgOffset]);
    if (!Number.isFinite(phaseA)) throw new Error(`Invalid phaseA: ${args[phaseArgOffset]}`);
  }
  if (args[phaseArgOffset + 1] !== undefined) {
    phaseB = Number(args[phaseArgOffset + 1]);
    if (!Number.isFinite(phaseB)) throw new Error(`Invalid phaseB: ${args[phaseArgOffset + 1]}`);
  }

  const wikiAllEdges: string[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    wikiAllEdges.push(...collectWikiEdgesForTick(tick, endpoints, destinationsBySource));
  }

  const {
    pairs: recPairs,
    totalEdges: recoveredTotalEdges,
    finalPhaseA,
    finalPhaseB,
    edgeSubjectsByPair,
  } = simulateRecoveredPairs({
    endpoints,
    destinationsBySource,
    allAddresses,
    ticks,
    strategy,
    phaseA,
    phaseB,
    collectEdgeSubjects: edgeSubjectsFile !== null,
  });
  const recoveredAllEdges = [...recPairs];

  const wikiAgg = aggregateSets(wikiAllEdges);
  const recAgg = aggregateSets(recoveredAllEdges);
  const pairsMatch = setEqual(wikiAgg.pairs, recAgg.pairs);

  console.log(
    `[edge-compare] ticks=${ticks} strategy=${strategy} initialPhase=(${phaseA},${phaseB}) finalPhase=(${finalPhaseA},${finalPhaseB})`,
  );
  console.log(
    `[edge-compare] wiki model: send_rate>0, tick%send_rate==0, edges = full expanded sends_to (broadcast).`,
  );
  console.log(
    `[edge-compare] mismatch note: wiki baseline may be wrong or incomplete. Recovered uses header mask × sends_to (subset), except profiles in packetProfileUsesWikiSendsToFanOut() which mirror full wiki sends_to per emit. phaseA advances only after status sends (${BinaryObservedPhaseA.statusAfterSend5}→${BinaryObservedPhaseA.statusAfterSend6}→${BinaryObservedPhaseA.statusAfterSend7}).`,
  );

  console.log("[edge-compare] over full run (multiset edge counts + unique src>dst sets):");
  console.log(
    `  wiki      totalEdges=${wikiAllEdges.length} uniquePairs=${wikiAgg.pairs.size} uniqueSenders=${wikiAgg.senders.size} uniqueReceivers=${wikiAgg.receivers.size}`,
  );
  console.log(
    `  recovered totalEdges=${recoveredTotalEdges} uniquePairs=${recAgg.pairs.size} uniqueSenders=${recAgg.senders.size} uniqueReceivers=${recAgg.receivers.size}`,
  );
  console.log(`[edge-compare] same unique src>dst pairs: ${pairsMatch}`);

  if (listPairs) {
    if (pairsMatch) {
      printSortedPairs("unique src>dst pairs (wiki = recovered)", wikiAgg.pairs);
    } else {
      printSortedPairs("unique src>dst pairs — wiki only", wikiAgg.pairs);
      printSortedPairs("unique src>dst pairs — recovered only", recAgg.pairs);
    }
  }

  if (edgeSubjectsFile !== null) {
    if (!edgeSubjectsByPair) {
      throw new Error("internal: edgeSubjectsByPair missing despite --edge-subjects-file");
    }
    writeEdgeSubjectsReport({
      outPath: edgeSubjectsFile,
      ticks,
      strategy,
      phaseA,
      phaseB,
      finalPhaseA,
      finalPhaseB,
      edgeSubjectsByPair,
    });
    console.log(`[edge-compare] wrote recovered edge subjects: ${edgeSubjectsFile}`);
  }

  if (!pairsMatch) {
    const onlyWiki = setDifference(wikiAgg.pairs, recAgg.pairs);
    const onlyRec = setDifference(recAgg.pairs, wikiAgg.pairs);
    console.log(`[edge-compare] only in wiki (${onlyWiki.length}):`);
    for (const p of onlyWiki.slice(0, 12)) {
      console.log(`  ${p}`);
    }
    if (onlyWiki.length > 12) console.log(`  … ${onlyWiki.length - 12} more`);
    if (onlyRec.length > 0) {
      console.log(`[edge-compare] only in recovered (${onlyRec.length}):`);
      for (const p of onlyRec.slice(0, 12)) {
        console.log(`  ${p}`);
      }
      if (onlyRec.length > 12) console.log(`  … ${onlyRec.length - 12} more`);
    }
  }
}

main();
