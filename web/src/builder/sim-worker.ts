import {
  type Device,
  type Packet,
  type PortRef,
  type SimulationStats,
  type SimulatorRuntimeState,
  type Topology,
  TunnetSimulator,
} from "../simulation";

type SimWorkerFrame = {
  prevOccupancy: Array<{ port: PortRef; packet: Packet }>;
  currentOccupancy: Array<{ port: PortRef; packet: Packet }>;
  stats: SimulationStats;
  stepComputeMs: number;
};

type ToWorkerMessage =
  | { type: "init"; topology: Topology; seed: number; sendRateMultiplier: number }
  | { type: "update_topology"; topology: Topology }
  | { type: "set_send_rate"; sendRateMultiplier: number }
  | { type: "precompute"; count: number };

type FromWorkerMessage =
  | { type: "initialized"; occupancy: Array<{ port: PortRef; packet: Packet }>; stats: SimulationStats }
  | { type: "batch"; frames: SimWorkerFrame[] }
  | { type: "error"; message: string };

let simulator: TunnetSimulator | null = null;
let currentOccupancy: Array<{ port: PortRef; packet: Packet }> = [];

function cloneOccupancy(
  occ: Array<{ port: PortRef; packet: Packet }>,
): Array<{ port: PortRef; packet: Packet }> {
  return occ.map((e) => ({ port: { ...e.port }, packet: { ...e.packet } }));
}

function post(msg: FromWorkerMessage): void {
  self.postMessage(msg);
}

function portCountForDevice(device: Device): number {
  if (device.type === "endpoint") return 1;
  if (device.type === "relay") return 2;
  if (device.type === "filter") return 2;
  return 3;
}

function projectRuntimeStateToTopology(
  state: SimulatorRuntimeState,
  topology: Topology,
): SimulatorRuntimeState {
  const occupancy = state.occupancy.filter(({ port }) => {
    const device = topology.devices[port.deviceId];
    if (!device) return false;
    return Number.isInteger(port.port) && port.port >= 0 && port.port < portCountForDevice(device);
  });
  const endpointNextSendTickById: Record<string, number> = {};
  for (const dev of Object.values(topology.devices)) {
    if (dev.type !== "endpoint") continue;
    const existing = state.endpointNextSendTickById[dev.id];
    if (Number.isFinite(existing)) {
      endpointNextSendTickById[dev.id] = existing;
    }
  }
  return {
    ...state,
    occupancy,
    endpointNextSendTickById,
  };
}

self.addEventListener("message", (ev: MessageEvent<ToWorkerMessage>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  try {
    if (msg.type === "init") {
      simulator = new TunnetSimulator(msg.topology, msg.seed);
      simulator.setSendRateMultiplier(msg.sendRateMultiplier);
      currentOccupancy = cloneOccupancy(simulator.getPortOccupancy());
      const stats: SimulationStats = {
        tick: 0,
        emitted: 0,
        delivered: 0,
        dropped: 0,
        bounced: 0,
        ttlExpired: 0,
        collisions: 0,
      };
      post({ type: "initialized", occupancy: cloneOccupancy(currentOccupancy), stats });
      return;
    }

    if (!simulator) {
      post({ type: "error", message: "Simulator is not initialized" });
      return;
    }

    if (msg.type === "set_send_rate") {
      simulator.setSendRateMultiplier(msg.sendRateMultiplier);
      return;
    }

    if (msg.type === "update_topology") {
      const runtime = simulator.exportRuntimeState();
      const projected = projectRuntimeStateToTopology(runtime, msg.topology);
      const next = new TunnetSimulator(msg.topology, projected.rndState);
      next.importRuntimeState(projected);
      simulator = next;
      currentOccupancy = cloneOccupancy(simulator.getPortOccupancy());
      post({ type: "initialized", occupancy: cloneOccupancy(currentOccupancy), stats: { ...projected.stats } });
      return;
    }

    if (msg.type === "precompute") {
      const count = Math.max(0, Math.floor(msg.count));
      if (count === 0) {
        post({ type: "batch", frames: [] });
        return;
      }
      const frames: SimWorkerFrame[] = [];
      for (let i = 0; i < count; i += 1) {
        const prev = cloneOccupancy(currentOccupancy);
        const t0 = performance.now();
        const snap = simulator.step();
        const stepComputeMs = performance.now() - t0;
        currentOccupancy = cloneOccupancy(simulator.getPortOccupancy());
        frames.push({
          prevOccupancy: prev,
          currentOccupancy: cloneOccupancy(currentOccupancy),
          stats: { ...snap.stats },
          stepComputeMs,
        });
      }
      post({ type: "batch", frames });
    }
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
});

