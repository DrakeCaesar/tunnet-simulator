import type { CameraPersistState, PilotPositionPersistState } from "./view-3d";

export const STORAGE_KEYS = {
  viewMode: "tunnet.saveViewer.viewMode",
  firstPersonMode: "tunnet.saveViewer.firstPersonMode",
  gravityEnabled: "tunnet.saveViewer.gravityEnabled",
  ssaoEnabled: "tunnet.saveViewer.aoEnabled",
  blockAoEnabled: "tunnet.saveViewer.blockAoEnabled",
  hemisphereAoEnabled: "tunnet.saveViewer.hemisphereAoEnabled",
  cameraState3d: "tunnet.saveViewer.cameraState3d",
  cameraStatePilot: "tunnet.saveViewer.cameraStatePilot",
  playerPositionPilot: "tunnet.saveViewer.playerPositionPilot",
  tickIntervalMs: "tunnet.saveViewer.tickIntervalMs",
  packetLabelMode: "tunnet.saveViewer.packetLabelMode",
} as const;

export function parseCameraState(raw: string | null): CameraPersistState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CameraPersistState;
    if (
      parsed &&
      Array.isArray(parsed.position) &&
      parsed.position.length >= 3 &&
      Array.isArray(parsed.target) &&
      parsed.target.length >= 3
    ) {
      return {
        position: [Number(parsed.position[0]), Number(parsed.position[1]), Number(parsed.position[2])],
        target: [Number(parsed.target[0]), Number(parsed.target[1]), Number(parsed.target[2])],
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function parsePilotPosition(raw: string | null): PilotPositionPersistState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length >= 3 &&
      Number.isFinite(Number(parsed[0])) &&
      Number.isFinite(Number(parsed[1])) &&
      Number.isFinite(Number(parsed[2]))
    ) {
      return [Number(parsed[0]), Number(parsed[1]), Number(parsed[2])];
    }
  } catch {
    return null;
  }
  return null;
}
