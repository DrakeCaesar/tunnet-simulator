import {
  AddressEncodingStrategy,
  compareRecoveredAgainstCurrentImplementation,
} from "./scheduler-comparison.js";

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function main(): void {
  const ticksArg = process.argv[2];
  const strategyArg = process.argv[3] as AddressEncodingStrategy | undefined;
  const ticks = ticksArg ? Number(ticksArg) : 4096;
  if (!Number.isFinite(ticks) || ticks <= 0) {
    throw new Error(`Invalid ticks value: ${ticksArg}`);
  }

  const strategy: AddressEncodingStrategy = strategyArg ?? "plus_one_all_octets";
  const report = compareRecoveredAgainstCurrentImplementation(ticks, "data.json", strategy);

  console.log(
    `[scheduler-compare] ticks=${report.ticks} endpoints=${report.endpointsCompared} strategy=${report.encodingStrategy}`,
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

