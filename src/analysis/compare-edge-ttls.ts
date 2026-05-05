import { wikiSchedulerEndpointRows } from "./wiki-endpoint-rows.js";
import {
  type AddressEncodingStrategy,
  encodeEndpointAddressForStrategy,
  parseEndpointAddressString,
} from "./endpoint-address-encoding.js";
import {
  applyRecoveredStateTransitions,
  advanceNetTick,
  evaluateEndpointSend,
  initialRecoveredSchedulerState,
  type RecoveredDecision,
} from "./recovered-endpoint-scheduler.js";
import {
  buildWikiDestinationMaps,
  destinationsForRecoveredDecision,
} from "./recovered-send-destinations.js";
import {
  evaluateBridgeAdjustment,
  evaluateEndpointTtl,
  mergeTtlValues,
} from "./ttl-evaluator.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

type EndpointRow = {
  address: string;
  send_rate: number;
  sends_to: string[];
  replies_to: string[];
};

type EdgeTtlSummary = {
  ttlValues: Set<number>;
  ruleIds: Set<string>;
  reasons: Set<string>;
  status: "resolved" | "unresolved";
  profile: string | null;
};

const BRIDGE_ADDRESSES = ["1.0.1.0", "1.1.1.0", "1.2.1.0", "1.3.1.0"] as const;

const ENCODING_STRATEGIES: readonly AddressEncodingStrategy[] = [
  "identity",
  "plus_one_all_octets",
  "plus_one_all_octets_regional_mainframe",
  "plus_one_first_octet",
];

function isEncodingStrategy(value: string): value is AddressEncodingStrategy {
  return (ENCODING_STRATEGIES as readonly string[]).includes(value);
}

function stripPnpmArgDelimiter(argv: string[]): string[] {
  return argv.filter((a) => a !== "--");
}

function getOrCreatePairSummary(map: Map<string, EdgeTtlSummary>, pair: string): EdgeTtlSummary {
  let row = map.get(pair);
  if (!row) {
    row = {
      ttlValues: new Set(),
      ruleIds: new Set(),
      reasons: new Set(),
      status: "resolved",
      profile: null,
    };
    map.set(pair, row);
  }
  return row;
}

type OutputGroup = {
  key: string;
  values: string;
  ruleIds: string;
  reasons: string;
  pairs: string[];
  isResolved: boolean;
};

function summarizePairs(pairs: string[], maxShown = 20): string {
  if (pairs.length <= maxShown) return pairs.join(", ");
  const shown = pairs.slice(0, maxShown).join(", ");
  return `${shown}, ... (+${pairs.length - maxShown} more)`;
}

function main(): void {
  const args = stripPnpmArgDelimiter(process.argv.slice(2));
  const ticks = args[0] ? Number(args[0]) : 10_000;
  if (!Number.isFinite(ticks) || ticks <= 0) {
    throw new Error(`Invalid ticks: ${args[0]}`);
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

  const endpoints = wikiSchedulerEndpointRows() as EndpointRow[];
  const { allWikiAddresses, destinationsBySource } = buildWikiDestinationMaps(endpoints);
  const state = initialRecoveredSchedulerState(phaseA, phaseB);

  const pairSummaries = new Map<string, EdgeTtlSummary>();
  let netTick = 0;
  let totalRecoveredEdges = 0;

  for (let tick = 0; tick < ticks; tick += 1) {
    netTick = advanceNetTick(netTick);
    for (const endpoint of endpoints) {
      const encoded = encodeEndpointAddressForStrategy(parseEndpointAddressString(endpoint.address), strategy);
      const decision = evaluateEndpointSend(state, encoded, netTick);
      if (!decision.shouldSend || decision.profile === null || decision.header === null) {
        continue;
      }
      const matched = destinationsForRecoveredDecision(
        endpoint.address,
        decision,
        destinationsBySource,
        allWikiAddresses,
      );
      for (const dst of matched) {
        totalRecoveredEdges += 1;
        const pair = `${endpoint.address}>${dst}`;
        const summary = getOrCreatePairSummary(pairSummaries, pair);
        summary.profile = decision.profile;
        const endpointEval = evaluateEndpointTtl(decision, { encoded });
        for (const value of endpointEval.ttlValues) {
          summary.ttlValues.add(value);
        }
        for (const ruleId of endpointEval.ruleIds) {
          summary.ruleIds.add(ruleId);
        }
        if (endpointEval.reason) summary.reasons.add(endpointEval.reason);
        if (endpointEval.status === "unresolved") summary.status = "unresolved";

        const bridgeEval = evaluateBridgeAdjustment(pair);
        for (const ruleId of bridgeEval.bridgeRuleIds) {
          summary.ruleIds.add(ruleId);
        }
        if (bridgeEval.bridgeReason) summary.reasons.add(bridgeEval.bridgeReason);
      }
      applyRecoveredStateTransitions(state, encoded, decision);
    }
  }

  const sortedPairs = [...pairSummaries.keys()].sort((a, b) => a.localeCompare(b));
  const bridgeSet = new Set<string>(BRIDGE_ADDRESSES);
  const bridgePairs = sortedPairs.filter((p) => {
    const gt = p.indexOf(">");
    if (gt <= 0) return false;
    const src = p.slice(0, gt);
    const dst = p.slice(gt + 1);
    return bridgeSet.has(src) || bridgeSet.has(dst);
  });
  const bridgeCoverage = BRIDGE_ADDRESSES.map((bridge) => {
    const touches = bridgePairs.filter((pair) => pair.startsWith(`${bridge}>`) || pair.endsWith(`>${bridge}`));
    return {
      bridge,
      touchedPairCount: touches.length,
      status: touches.length > 0 ? "observed" : "not_exercised",
      reason:
        touches.length > 0
          ? "pair observed in recovered edge run"
          : "no recovered pair in this run touched bridge endpoint",
      pairs: touches,
    } as const;
  });

  console.log(
    `[edge-ttl] ticks=${ticks} strategy=${strategy} initialPhase=(${phaseA},${phaseB}) finalPhase=(${state.phaseA},${state.phaseB})`,
  );
  console.log(
    `[edge-ttl] recovered run: totalEdges=${totalRecoveredEdges} uniquePairs=${sortedPairs.length}`,
  );
  console.log(`[edge-ttl] grouped exact TTL outcomes (${sortedPairs.length} unique pairs):`);
  const groups = new Map<string, OutputGroup>();
  for (const pair of sortedPairs) {
    const row = pairSummaries.get(pair)!;
    const mergedValues = mergeTtlValues([...row.ttlValues]);
    const values = mergedValues.length > 0 ? mergedValues.join(",") : "-";
    const ruleIds = [...row.ruleIds].sort().join(",") || "-";
    const reasons = [...row.reasons].sort().join(" | ") || "-";
    const key = [values, ruleIds, reasons, row.status].join("||");
    const isResolved = row.status === "resolved";
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        values,
        ruleIds,
        reasons,
        pairs: [],
        isResolved,
      };
      groups.set(key, g);
    }
    g.pairs.push(pair);
  }
  const sortedGroups = [...groups.values()].sort((a, b) => b.pairs.length - a.pairs.length || a.key.localeCompare(b.key));
  const resolvedGroups = sortedGroups.filter((g) => g.isResolved);
  const unresolvedGroups = sortedGroups.filter((g) => !g.isResolved);

  console.log(
    `[edge-ttl] resolved groups first: resolved=${resolvedGroups.length} unresolved=${unresolvedGroups.length}`,
  );
  for (const g of resolvedGroups) {
    console.log(
      `  group pairs=${g.pairs.length} :: ttlValues=[${g.values}] ruleIds=[${g.ruleIds}]`,
    );
    console.log(`    ${summarizePairs(g.pairs)}`);
    console.log("");
  }
  console.log("  ---------------- unresolved groups ----------------");
  console.log("");
  for (const g of unresolvedGroups) {
    console.log(
      `  group pairs=${g.pairs.length} :: ttlValues=[${g.values}] ruleIds=[${g.ruleIds}] reason=[${g.reasons}]`,
    );
    console.log(`    ${summarizePairs(g.pairs)}`);
    console.log("");
  }

  console.log("");
  console.log(`[edge-ttl] bridge focus (4 known bridge endpoints): ${BRIDGE_ADDRESSES.join(", ")}`);
  console.log(`[edge-ttl] unique pairs touching bridges: ${bridgePairs.length}`);
  for (const pair of bridgePairs) {
    const row = pairSummaries.get(pair)!;
    const values = mergeTtlValues([...row.ttlValues]).join(",") || "-";
    const bridgeRuleIds = [...row.ruleIds].sort().join(",") || "-";
    const reasons = [...row.reasons].sort().join(" | ") || "-";
    console.log(
      `  ${pair} :: ttlValues=[${values}] ruleIds=[${bridgeRuleIds}] reason=[${reasons}]`,
    );
  }
  for (const c of bridgeCoverage) {
    if (c.status === "not_exercised") {
      console.log(`  ${c.bridge} :: not_exercised (${c.reason})`);
    }
  }

  const artifactRows = sortedPairs.map((pair) => {
    const row = pairSummaries.get(pair)!;
    const ttlValues = mergeTtlValues([...row.ttlValues]);
    const min = ttlValues.length ? ttlValues[0]! : null;
    const max = ttlValues.length ? ttlValues[ttlValues.length - 1]! : null;
    const reason = [...row.reasons].sort().join(" | ") || (row.status === "resolved" ? "" : "unresolved");
    return {
      pair,
      ttlValues,
      min,
      max,
      ruleIds: [...row.ruleIds].sort(),
      status: row.status,
      reason,
    };
  });
  const outputPath = resolve("analysis", "pair-ttl-values.json");
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        ticks,
        strategy,
        phaseA,
        phaseB,
        finalPhaseA: state.phaseA,
        finalPhaseB: state.phaseB,
        bridgeCoverage,
        records: artifactRows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`[edge-ttl] wrote machine-readable artifact: ${outputPath}`);

  console.log(
    `[edge-ttl] coverage summary: groupedPairs=${sortedPairs.length} resolvedGroups=${resolvedGroups.length} unresolvedGroups=${unresolvedGroups.length} bridgePairsObserved=${bridgePairs.length}`,
  );
}

main();

