import { initialRecoveredSchedulerState, type RecoveredSchedulerState } from "./recovered-endpoint-scheduler.js";
import {
  AddressEncodingStrategy,
  compareRecoveredAgainstCurrentImplementation,
} from "./scheduler-comparison.js";

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
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

function main(): void {
  const args = process.argv.slice(2);
  const ticksArg = args[0];
  const ticks = ticksArg ? Number(ticksArg) : 4096;
  if (!Number.isFinite(ticks) || ticks <= 0) {
    throw new Error(`Invalid ticks value: ${ticksArg}`);
  }

  let strategy: AddressEncodingStrategy = "plus_one_all_octets_regional_mainframe";
  let phaseArgOffset = 1;
  if (args[1] !== undefined && isEncodingStrategy(args[1])) {
    strategy = args[1];
    phaseArgOffset = 2;
  }

  let initial: RecoveredSchedulerState = initialRecoveredSchedulerState(0, 0);
  if (args[phaseArgOffset] !== undefined) {
    const phaseA = Number(args[phaseArgOffset]);
    if (!Number.isFinite(phaseA)) {
      throw new Error(`Invalid initial phaseA: ${args[phaseArgOffset]}`);
    }
    const phaseB =
      args[phaseArgOffset + 1] !== undefined ? Number(args[phaseArgOffset + 1]) : 0;
    if (args[phaseArgOffset + 1] !== undefined && !Number.isFinite(phaseB)) {
      throw new Error(`Invalid initial phaseB: ${args[phaseArgOffset + 1]}`);
    }
    initial = initialRecoveredSchedulerState(phaseA, phaseB);
  }

  const report = compareRecoveredAgainstCurrentImplementation(ticks, "data.json", strategy, initial);

  console.log(
    `[scheduler-compare] ticks=${report.ticks} endpoints=${report.endpointsCompared} strategy=${report.encodingStrategy} initialPhase=(${initial.phaseA},${initial.phaseB})`,
  );
  console.log(
    `[scheduler-compare] avgRecovered=${pct(report.averageRecoveredRate)} avgLegacy=${pct(report.averageLegacyRate)} avgAbsDelta=${pct(report.averageAbsoluteDelta)}`,
  );

  console.log("[scheduler-compare] top divergences:");
  for (const row of report.topDivergences) {
    console.log(
      `  ${row.address} recovered=${pct(row.recoveredRatePerTick)} legacy=${pct(row.legacyRatePerTick)} delta=${pct(row.absoluteDeltaPerTick)} (r=${row.recoveredEmits}, l=${row.legacyEmits})`,
    );
  }
}

main();

