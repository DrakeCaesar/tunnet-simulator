import {
  pickAdFamilySubjectPlaceholder,
  pickSearchInvestmentSubjectPlaceholder,
  pickStatusFamilySubjectPlaceholder,
  adFamilySubjectCandidates,
  searchInvestmentSubjectCandidates,
  statusFamilySubjectCandidates,
} from "./game-packet-strings.js";

export type EndpointAddress = {
  a: number;
  b: number;
  c: number;
  d: number;
};

/**
 * Values of `*(node + 0x1c4)` seen in the binary (not exhaustive).
 * - `5`–`7`: `sub_1402f5840` status-family path (also modeled in {@link applyRecoveredStateTransitions}).
 * - `0xc`–`0xe`, `0x13`: `sub_140165cb0` zone/map graph (HLIL); not yet driven by the tick exporter.
 */
export const BinaryObservedPhaseA = {
  statusAfterSend5: 5,
  statusAfterSend6: 6,
  statusAfterSend7: 7,
  /** Branch compares `*(node+0x1c4) == 0xc` before other work. */
  zoneCompare12: 0x0c,
  /** Written when advancing certain cave / route branches. */
  zoneForce13: 0x0d,
  /** Written when `*(node+0x1c5) != 0xb` on the “new zone” path (with event `0x2c`). */
  zoneForce14: 0x0e,
  /** Written from `sub_140165cb0` when `*(node+0x1c4) != 0x13` on another branch. */
  zoneForce19: 0x13,
} as const;

/** Game `NetNode`/endpoint blob fields used by the recovered scheduler (offsets from sub_1402f5840 / sub_1402f9a40). */
export type RecoveredSchedulerState = {
  /** Mirrors `*(node + 0x1c4)` — use {@link BinaryObservedPhaseA} for known binary-backed constants. */
  phaseA: number;
  /**
   * Mirrors `*(node + 0x1c5)`: sub-phase index for mainframe-style endpoints.
   * In `sub_1402f9a40`, the `a === 4` path only switches on **0..5** for fixed headers.
   * Elsewhere (`sub_1401f5660`) the same byte is advanced in a larger story/state machine (**0..0xa**, plus **0xb**).
   */
  phaseB: number;
};

/** Inclusive max for `phaseB` when modeling **`sub_1402f9a40`** mainframe headers only (cases 0..5). */
export const MAINFRAME_SUBPHASE_MAX = 5;

export type PacketProfile =
  | "mainframe-phase-sequence"
  | "reply-chain"
  | "track-broadcast"
  | "school-chat"
  | "search-family"
  | "ad-family"
  | "status-family"
  | "short-fixed";

export type RecoveredDecision = {
  shouldSend: boolean;
  header: number | null;
  profile: PacketProfile | null;
  reason: string;
  /**
   * Game **`.rdata`** subject line for this send when recovered (see `game-packet-strings.ts`).
   * **`packetSubjectCandidates`**: pool before in-game RNG; selection may still be a placeholder.
   */
  packetSubject?: string | null;
  packetSubjectCandidates?: readonly string[] | null;
};

export type PhaseTransitionResult = {
  phaseAChanged: boolean;
  phaseBChanged: boolean;
};

function mod4FromFloorDivPow2(value: number, shift: number): number {
  const div = Math.floor(value / (1 << shift));
  return div & 3;
}

function dynamicAdHeader(b: number, tick: number): number {
  const hi16 = ((Math.floor(tick / 512) & 3) << 16) + 0x10000;
  const hi24 = ((Math.floor(tick / 128) & 3) << 24) + 0x1000000;
  return (hi24 | hi16) + (b << 8) + 1;
}

function dynamicStatusHeader(tick: number): number {
  const bucket = (((Math.floor((tick + 31) / 32) % 3) + 1) & 3) >>> 0;
  return ((bucket & 0xff) << 8) + 0x1010001;
}

function dynamicJoinUsHeader(tick: number): number {
  const part8 = (((Math.floor((tick + 63) / 64) & 3) << 8) + 0x101) >>> 0;
  const part16 = (((Math.floor((tick + 15) / 16) & 3) << 16) + 0x10000) >>> 0;
  const part24 = (((Math.floor(Math.floor((tick + 3) / 4) & 3) << 24) + 0x1000000) >>> 0);
  return (part24 | part16 | part8) >>> 0;
}

function dynamicPrayerHeader(tick: number): number {
  const part16 = (((Math.floor((tick + 15) / 16) & 3) << 16) + 0x10301) >>> 0;
  const part24 = (((Math.floor(Math.floor((tick + 3) / 4) & 3) << 24) + 0x1000000) >>> 0);
  return (part24 | part16) >>> 0;
}

function dynamicEmergencyHeader(tick: number): number {
  const part16 = (((Math.floor((tick + 7) / 8) & 3) << 16) + 0x10201) >>> 0;
  const part24 = (((Math.floor(Math.floor((tick >> 1)) & 3) << 24) + 0x1000000) >>> 0);
  return (part24 | part16) >>> 0;
}

function rawAddrHeader(addr: EndpointAddress): number {
  return ((addr.d & 0xff) << 24) | ((addr.c & 0xff) << 16) | ((addr.b & 0xff) << 8) | (addr.a & 0xff);
}

export function evaluateEndpointSend(
  state: RecoveredSchedulerState,
  addr: EndpointAddress,
  tick: number,
): RecoveredDecision {
  const { a, b, c, d } = addr;

  if (a === 4) {
    if (!(b === 1 && c === 1 && d === 1)) {
      return { shouldSend: false, header: null, profile: null, reason: "a=4 requires tuple (1,1,1)" };
    }
    if ((tick & 3) !== mod4FromFloorDivPow2(tick, 2)) {
      return { shouldSend: false, header: null, profile: null, reason: "a=4 tick gate failed" };
    }
    switch (state.phaseB) {
      case 0:
        return { shouldSend: true, header: 0x1020104, profile: "mainframe-phase-sequence", reason: "a=4 phase 0" };
      case 1:
        return { shouldSend: true, header: 0x4020104, profile: "mainframe-phase-sequence", reason: "a=4 phase 1" };
      case 2:
        return { shouldSend: true, header: 0x1020104, profile: "mainframe-phase-sequence", reason: "a=4 phase 2" };
      case 3:
        return { shouldSend: true, header: 0x2020104, profile: "mainframe-phase-sequence", reason: "a=4 phase 3" };
      case 4:
        return { shouldSend: true, header: 0x3020104, profile: "mainframe-phase-sequence", reason: "a=4 phase 4" };
      case 5:
        return { shouldSend: true, header: 0x4020104, profile: "mainframe-phase-sequence", reason: "a=4 phase 5" };
      default:
        return { shouldSend: false, header: null, profile: null, reason: "a=4 unknown phaseB" };
    }
  }

  if (a === 2) {
    if (!(b === 4 && c === 2 && d === 1)) {
      return { shouldSend: false, header: null, profile: null, reason: "a=2 requires tuple (4,2,1)" };
    }
    return { shouldSend: true, header: rawAddrHeader(addr), profile: "reply-chain", reason: "a=2 fixed path" };
  }

  if (a !== 1) {
    return { shouldSend: false, header: null, profile: null, reason: "a must be 1/2/4" };
  }
  if (b < 1 || b > 4 || c < 1 || c > 4) {
    return { shouldSend: false, header: null, profile: null, reason: "b/c outside supported range" };
  }

  switch (c) {
    case 1: {
      if (d === 3 || (d === 4 && (b === 3 || b === 4))) {
        if ((tick & 1) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "track-broadcast even tick gate" };
        }
        const k = (tick >> 1) & 3;
        const base = b << 8;
        const header = k === 0 ? base | 0x4040001 : k === 1 ? base | 0x3020001 : k === 2 ? base | 0x2040001 : base | 0x4030001;
        return { shouldSend: true, header, profile: "track-broadcast", reason: "track-broadcast rotation" };
      }

      if (d === 2 && b >= 2 && b <= 4) {
        if ((tick & 1) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "school-chat even tick gate" };
        }
        const header = (((tick >> 1) & 3) === 0) ? ((b << 8) | 0x2040001) : ((b << 8) | 0x1020001);
        return { shouldSend: true, header, profile: "school-chat", reason: "school-chat gate branch" };
      }

      if (d === 4 && b >= 2 && b <= 4) {
        if ((tick & 7) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "ad-family 8-tick gate" };
        }
        return {
          shouldSend: true,
          header: dynamicAdHeader(b, tick),
          profile: "ad-family",
          reason: "ad-family dynamic header",
          packetSubject: pickAdFamilySubjectPlaceholder(tick),
          packetSubjectCandidates: adFamilySubjectCandidates(),
        };
      }

      if (d === 1 && b === 1) {
        if ((tick & 1) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "status-family even tick gate" };
        }
        if (((tick >> 1) & 0x0f) === 0) {
          return {
            shouldSend: true,
            header: dynamicStatusHeader(tick),
            profile: "status-family",
            reason: "status-family periodic branch",
            packetSubject: pickStatusFamilySubjectPlaceholder(tick),
            packetSubjectCandidates: statusFamilySubjectCandidates(),
          };
        }
        return {
          shouldSend: true,
          header: dynamicStatusHeader(tick),
          profile: "status-family",
          reason: "status-family default branch",
          packetSubject: pickStatusFamilySubjectPlaceholder(tick),
          packetSubjectCandidates: statusFamilySubjectCandidates(),
        };
      }

      return { shouldSend: false, header: null, profile: null, reason: "c=1 unmatched tuple" };
    }

    case 2: {
      if (!(d === 3 && b >= 2 && b <= 4)) {
        return { shouldSend: false, header: null, profile: null, reason: "c=2 requires d=3 and b in [2..4]" };
      }
      if ((tick & 1) !== 0) {
        return { shouldSend: false, header: null, profile: null, reason: "c=2 even tick gate" };
      }
      const header = (((tick >> 1) & 3) === 0) ? ((b << 8) | 0x2040001) : ((b << 8) | 0x1020001);
      return { shouldSend: true, header, profile: "school-chat", reason: "c=2 branch selection" };
    }

    case 3: {
      if (!(d === 1 || d === 2)) {
        return { shouldSend: false, header: null, profile: null, reason: "c=3 requires d=1 or d=2" };
      }
      if ((tick & 1) !== 0) {
        return { shouldSend: false, header: null, profile: null, reason: "c=3 even tick gate" };
      }

      if (d === 2) {
        const k = (tick >> 1) & 3;
        const base = b << 8;
        const header = k === 0 ? 0x1010301 : k === 1 ? base | 0x1030001 : k === 2 ? base | 0x1020001 : base | 0x2020001;
        return {
          shouldSend: true,
          header,
          profile: "search-family",
          reason: "search-family rotation",
          packetSubject: pickSearchInvestmentSubjectPlaceholder(tick),
          packetSubjectCandidates: searchInvestmentSubjectCandidates(),
        };
      }

      if ((tick & 0b10) === 0) {
        return { shouldSend: true, header: dynamicJoinUsHeader(tick), profile: "search-family", reason: "join-us dynamic branch" };
      }
      return { shouldSend: true, header: dynamicPrayerHeader(tick), profile: "search-family", reason: "prayer dynamic branch" };
    }

    case 4: {
      if (d !== 1) {
        return { shouldSend: false, header: null, profile: null, reason: "c=4 requires d=1" };
      }
      if ((tick & 3) !== 0) {
        return { shouldSend: false, header: null, profile: null, reason: "c=4 every-4-ticks gate" };
      }
      return { shouldSend: true, header: 0x1030203, profile: "short-fixed", reason: "c=4 fixed packet" };
    }

    default:
      return { shouldSend: false, header: null, profile: null, reason: "unsupported c value" };
  }
}

export function advanceNetTick(current: number): number {
  return (current + 1) & 0xffff;
}

/** Initial `RecoveredSchedulerState` for a run (e.g. “save” `*(+0x1c4)` / `*(+0x1c5)`). */
export function initialRecoveredSchedulerState(phaseA = 0, phaseB = 0): RecoveredSchedulerState {
  return { phaseA, phaseB };
}

export function shouldForcePhaseTransition(state: RecoveredSchedulerState, decision: RecoveredDecision): boolean {
  return (
    decision.shouldSend &&
    decision.profile === "status-family" &&
    state.phaseA === BinaryObservedPhaseA.statusAfterSend5
  );
}

function normalizeWildcardOctet(value: number): number {
  // Binary path normalizes 0/2 into 1 before wildcard matching.
  if (value === 0 || value === 2) {
    return 1;
  }
  return value;
}

/**
 * Applies only transitions recovered from **`sub_1402f5840`** (status-family `0x1c4` ladder).
 * Story/zone systems (**`sub_140165cb0`**, **`sub_1401f5660`**, …) write **`0x1c4` / `0x1c5`** as well; hook those here once the exporter models their triggers.
 */
export function applyRecoveredStateTransitions(
  state: RecoveredSchedulerState,
  addr: EndpointAddress,
  decision: RecoveredDecision,
): PhaseTransitionResult {
  let phaseAChanged = false;
  let phaseBChanged = false;

  if (!decision.shouldSend) {
    return { phaseAChanged, phaseBChanged };
  }

  if (decision.profile === "status-family" && state.phaseA === BinaryObservedPhaseA.statusAfterSend5) {
    state.phaseA = BinaryObservedPhaseA.statusAfterSend6;
    phaseAChanged = true;
  }

  // Confirmed in sub_1402f5840: once phaseA is 6, an additional
  // send-gated branch can advance it to 7 when normalized c < 2.
  // (The decompiler shows this as var_318:2.b < 2 after normalization.)
  if (state.phaseA === BinaryObservedPhaseA.statusAfterSend6) {
    const normalizedC = normalizeWildcardOctet(addr.c);
    if (normalizedC < 2) {
      state.phaseA = BinaryObservedPhaseA.statusAfterSend7;
      phaseAChanged = true;
    }
  }

  return { phaseAChanged, phaseBChanged };
}

