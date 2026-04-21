import { parseFlowFile, mergeFlowGraphs } from "./flow-parser.js";
import { exportTopologyGraphMl } from "./graphml.js";
import { TunnetSimulator } from "./simulator.js";
import {
  createEndpointOnlyTopology,
  createTwoEndpointRelayDemo,
  synthesizePhase1Topology,
  synthesizePhase2Topology,
  synthesizePhase3Topology,
  synthesizePhase4RingTopology,
  synthesizePhase5HierarchicalRings,
} from "./topology.js";
import { verifyEdgesIndividually } from "./verification.js";

function main(): void {
  const dot = parseFlowFile("dot-product.txt");
  const extra = parseFlowFile("two-dot-two-product.txt");
  const merged = mergeFlowGraphs(dot, extra);

  console.log(
    `[flows] nodes=${merged.nodes.size} edges=${merged.edges.length} colors=${merged.nodeColors.size}`,
  );

  const endpointSkeleton = createEndpointOnlyTopology(merged);
  console.log(
    `[topology-skeleton] endpoint devices=${Object.keys(endpointSkeleton.devices).length} links=${endpointSkeleton.links.length}`,
  );

  const phase1 = synthesizePhase1Topology(merged);
  console.log(
    `[phase1] covered=${phase1.report.coveredEdges}/${phase1.report.totalEdges} deferred=${phase1.report.deferredEdges} devices=${Object.keys(phase1.topology.devices).length} links=${phase1.topology.links.length}`,
  );

  const phase1Sim = new TunnetSimulator(phase1.topology, 20260421);
  const phase1Snapshot = phase1Sim.run(60);
  console.log(
    `[phase1-sim] tick=${phase1Snapshot.tick} inFlight=${phase1Snapshot.inFlightPackets} emitted=${phase1Snapshot.stats.emitted} delivered=${phase1Snapshot.stats.delivered} dropped=${phase1Snapshot.stats.dropped} bounced=${phase1Snapshot.stats.bounced} ttlExpired=${phase1Snapshot.stats.ttlExpired} collisions=${phase1Snapshot.stats.collisions}`,
  );

  const phase2 = synthesizePhase2Topology(merged);
  console.log(
    `[phase2] covered=${phase2.report.coveredEdges}/${phase2.report.totalEdges} deferred=${phase2.report.deferredEdges} devices=${Object.keys(phase2.topology.devices).length} links=${phase2.topology.links.length}`,
  );
  const phase2Sim = new TunnetSimulator(phase2.topology, 20260421);
  const phase2Snapshot = phase2Sim.run(60);
  console.log(
    `[phase2-sim] tick=${phase2Snapshot.tick} inFlight=${phase2Snapshot.inFlightPackets} emitted=${phase2Snapshot.stats.emitted} delivered=${phase2Snapshot.stats.delivered} dropped=${phase2Snapshot.stats.dropped} bounced=${phase2Snapshot.stats.bounced} ttlExpired=${phase2Snapshot.stats.ttlExpired} collisions=${phase2Snapshot.stats.collisions}`,
  );

  const phase3 = synthesizePhase3Topology(merged);
  console.log(
    `[phase3] covered=${phase3.report.coveredEdges}/${phase3.report.totalEdges} deferred=${phase3.report.deferredEdges} devices=${Object.keys(phase3.topology.devices).length} links=${phase3.topology.links.length}`,
  );
  exportTopologyGraphMl(phase3.topology, "out/phase3-topology.graphml", merged.nodeColors);
  console.log(`[phase3] wrote out/phase3-topology.graphml`);
  const phase3Sim = new TunnetSimulator(phase3.topology, 20260421);
  const phase3Snapshot = phase3Sim.run(60);
  console.log(
    `[phase3-sim] tick=${phase3Snapshot.tick} inFlight=${phase3Snapshot.inFlightPackets} emitted=${phase3Snapshot.stats.emitted} delivered=${phase3Snapshot.stats.delivered} dropped=${phase3Snapshot.stats.dropped} bounced=${phase3Snapshot.stats.bounced} ttlExpired=${phase3Snapshot.stats.ttlExpired} collisions=${phase3Snapshot.stats.collisions}`,
  );

  const verification = verifyEdgesIndividually(phase3.topology, merged.edges, {
    maxTicksPerEdge: 180,
    ttl: 40,
  });
  console.log(
    `[verify-single] delivered=${verification.delivered}/${verification.total} dropped=${verification.dropped} timeout=${verification.timeout} injectFailed=${verification.injectFailed}`,
  );
  const firstFailures = verification.results
    .filter((r) => r.status !== "delivered")
    .slice(0, 8)
    .map((r) => `${r.edge.src}->${r.edge.dst}:${r.status}${r.reason ? `(${r.reason})` : ""}`);
  if (firstFailures.length > 0) {
    console.log(`[verify-single] sample-failures=${firstFailures.join(", ")}`);
  }

  const phase4 = synthesizePhase4RingTopology(merged);
  console.log(
    `[phase4] covered=${phase4.report.coveredEdges}/${phase4.report.totalEdges} deferred=${phase4.report.deferredEdges} devices=${Object.keys(phase4.topology.devices).length} links=${phase4.topology.links.length}`,
  );
  exportTopologyGraphMl(phase4.topology, "out/phase4-topology.graphml", merged.nodeColors);
  console.log(`[phase4] wrote out/phase4-topology.graphml`);
  const phase4Verification = verifyEdgesIndividually(phase4.topology, merged.edges, {
    maxTicksPerEdge: 300,
  });
  console.log(
    `[verify-single-phase4] delivered=${phase4Verification.delivered}/${phase4Verification.total} dropped=${phase4Verification.dropped} timeout=${phase4Verification.timeout} injectFailed=${phase4Verification.injectFailed}`,
  );
  const phase4Failures = phase4Verification.results
    .filter((r) => r.status !== "delivered")
    .slice(0, 8)
    .map((r) => `${r.edge.src}->${r.edge.dst}:${r.status}${r.reason ? `(${r.reason})` : ""}`);
  if (phase4Failures.length > 0) {
    console.log(`[verify-single-phase4] sample-failures=${phase4Failures.join(", ")}`);
  }

  const phase5 = synthesizePhase5HierarchicalRings(merged);
  console.log(
    `[phase5] covered=${phase5.report.coveredEdges}/${phase5.report.totalEdges} deferred=${phase5.report.deferredEdges} devices=${Object.keys(phase5.topology.devices).length} links=${phase5.topology.links.length}`,
  );
  exportTopologyGraphMl(phase5.topology, "out/phase5-topology.graphml", merged.nodeColors);
  console.log(`[phase5] wrote out/phase5-topology.graphml`);
  const phase5Verification = verifyEdgesIndividually(phase5.topology, merged.edges, {
    maxTicksPerEdge: 600,
  });
  console.log(
    `[verify-single-phase5] delivered=${phase5Verification.delivered}/${phase5Verification.total} dropped=${phase5Verification.dropped} timeout=${phase5Verification.timeout} injectFailed=${phase5Verification.injectFailed}`,
  );
  const phase5Failures = phase5Verification.results
    .filter((r) => r.status !== "delivered")
    .slice(0, 8)
    .map((r) => `${r.edge.src}->${r.edge.dst}:${r.status}${r.reason ? `(${r.reason})` : ""}`);
  if (phase5Failures.length > 0) {
    console.log(`[verify-single-phase5] sample-failures=${phase5Failures.join(", ")}`);
  }

  const demo = createTwoEndpointRelayDemo();
  const sim = new TunnetSimulator(demo, 20260421);
  const snapshot = sim.run(40);

  console.log(
    `[demo-sim] tick=${snapshot.tick} inFlight=${snapshot.inFlightPackets} emitted=${snapshot.stats.emitted} delivered=${snapshot.stats.delivered} dropped=${snapshot.stats.dropped} bounced=${snapshot.stats.bounced} ttlExpired=${snapshot.stats.ttlExpired} collisions=${snapshot.stats.collisions}`,
  );
}

main();
