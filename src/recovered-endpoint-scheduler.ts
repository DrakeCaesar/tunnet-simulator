import {
  pickAdFamilySubjectPlaceholder,
  pickConfidentialSubjectPlaceholder,
  pickSearchArchitectsSubjectPlaceholder,
  pickSearchInvestmentSubjectPlaceholder,
  pickSearchPrayerSubjectPlaceholder,
  pickSchoolCasualSubjectPlaceholder,
  pickSchoolHomeworkSubjectPlaceholder,
  pickSchoolSupplySubjectPlaceholder,
  pickFirmwareUpdateSubjectPlaceholder,
  pickStatusFamilySubjectPlaceholder,
  firmwareUpdateSubjectCandidates,
  adFamilySubjectCandidates,
  confidentialSubjectCandidates,
  meetingMinutesSubjectCandidates,
  searchArchitectsSubjectCandidates,
  searchInvestmentSubjectCandidates,
  searchJoinUsSubjectCandidates,
  searchPrayerSubjectCandidates,
  searchQuerySubjectCandidates,
  searchRequestSubjectCandidates,
  schoolCasualSubjectCandidates,
  schoolHomeworkSubjectCandidates,
  schoolStudentExchangeSubjectCandidates,
  schoolSupplySubjectCandidates,
  statusReportMeetingHeaderSubjectCandidates,
  statusFamilySubjectCandidates,
  supplyAmmunitionSubjectCandidates,
  supplyFieldRationsSubjectCandidates,
  trackBroadcastSubjectForTick,
  REPLY_CHAIN_PACKET_SUBJECT,
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

function i32(n: number): number {
  return n | 0;
}

/**
 * `((arg4 u>> 0x1f) + arg4) s>> 1` in **`sub_1402f9a40`** — half-tick / floor-two counter (**`rbp_4`** / **`rbp_14`**).
 */
function signedHalfTickFloor(tick: number): number {
  const t = i32(tick);
  return i32((t + (t >> 31)) >> 1);
}

function mod4FromFloorDivPow2(value: number, shift: number): number {
  const div = Math.floor(value / (1 << shift));
  return div & 3;
}

function dynamicAdHeader(b: number, tick: number): number {
  const hi16 = ((Math.floor(tick / 512) & 3) << 16) + 0x10000;
  const hi24 = ((Math.floor(tick / 128) & 3) << 24) + 0x1000000;
  return (hi24 | hi16) + (b << 8) + 1;
}

/** HLIL `test_bit(0x16, rcx_1)` @ **`0x1402fa4c6`** (`sub_1402f9a40`, **`c==4`**, **`d==2`**). Excludes **`b==3`**. */
function case4D2TestBitGatePasses(b: number): boolean {
  if (b < 1 || b > 4) {
    return false;
  }
  return ((0x16 >>> (b & 31)) & 1) !== 0;
}

/** `rax_76` mod-16 residue from **`rax_75 = (arg4>=0?arg4:arg4+7)>>3`** — HLIL **`0x1402fa4dd`–`0x1402fa4f3`**. */
function case4D2Rax76Mod16(tick: number): number {
  const rax74 = tick >= 0 ? i32(tick) : i32(tick + 7);
  const rax75 = i32(rax74 >> 3);
  const rcx61 = rax75 >= 0 ? rax75 : i32(rax75 + 0xf);
  return i32(rax75 - (rcx61 & 0xfffffff0)) & 0xf;
}

/**
 * **`var_10b`** on the **mainframe-update** path (**`0x1402fb069`**–**`0x1402fb0b9`**) when **`(rbp_4&0xf)==0`**.
 * Mirrors **`rax_157`…`rax_162`** (including **`0x55555556`** quotient trick for **`floor(tick/32) % 3`**).
 */
function statusMainframeUpdateHeaderU32(tick: number): number {
  const rax157 = tick >= 0 ? i32(tick) : i32(tick + 0x1f);
  const rax159 = i32(rax157 >> 5);
  const rcx128 = BigInt.asIntN(64, BigInt(rax159) * 0x55555556n);
  const rcx128u = BigInt.asUintN(64, rcx128);
  const hi = Number((rcx128u >> 32n) & 0xffffffffn) >>> 0;
  const b63 = Number((rcx128u >> 63n) & 1n);
  const rcx130 = (hi + b63) >>> 0;
  const rax159b = rax159 & 0xff;
  const rcx130b3 = (rcx130 * 3) & 0xff;
  const t = (rax159b - rcx130b3 + 1) & 0xff;
  const tSigned = (t << 24) >> 24;
  const inner = ((tSigned >> 7) >>> 6) + t;
  const rax160 = (t - (inner & 0xfc)) & 0xff;
  const rax161 = (rax160 << 24) >> 24;
  let rax162 = 0x1010001 >>> 0;
  if ((rax161 & 0xff) < 4) {
    rax162 = (((rax161 << 8) >>> 0) + 0x1010101) >>> 0;
  }
  return rax162 >>> 0;
}

/**
 * First byte at **`data_142423e77`** passed to **`sub_1406b60c0`** (Steam build): **`0x03`**.
 * That helper returns **0** iff **`rdi_3 != 0`** and **`rdi_3 != 3`** (see BN HLIL @ **`0x1406b60c0`**).
 */
const STATUS_FIRMWARE_SELECTOR_BYTE = 3;

/**
 * **`var_10b`** on the **firmware-update** path (**`0x1402f9c87`**–**`0x1402f9cff`**) when **`(rbp_4&0xf)!=0`**.
 */
function statusFirmwareUpdateHeaderU32(tick: number): number {
  const rbp4 = signedHalfTickFloor(tick);
  const rax14 = tick >= 0 ? i32(tick) : i32(tick + 7);
  const rax15 = i32(rax14 >> 3);
  const rcx10 = rax15 >= 0 ? rax15 : i32(rax15 + 3);
  const rax16 = i32(rax15 - (rcx10 & 0xfffffffc));
  let rdi3 = (rax16 & 0xff) + 1;
  if ((rax16 >>> 0) >= 4) {
    rdi3 = 0;
  }
  const rcx = rdi3 & 0xff;
  const rax17 = rcx === 0 || rcx === STATUS_FIRMWARE_SELECTOR_BYTE ? 1 : 0;
  let rax18 = 0x10000;
  if (rax17 === 0) {
    rax18 = ((rdi3 & 0xff) << 16) >>> 0;
  }
  const rcx14 = rbp4 >= 0 ? rbp4 : i32(rbp4 + 3);
  const rbp5 = i32(rbp4 - (rcx14 & 0xfffffffc));
  let rcx18 = 0;
  if ((rbp5 >>> 0) < 4) {
    rcx18 = i32((rbp5 << 24) + 0x1000000);
  }
  return (rax18 + rcx18 + 0x101) >>> 0;
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

/** Which third-of-half-tick bucket **`sub_1402f9a40`** uses for **`c=3`,`d=3`** ammo / confidential / field-rations (HLIL `rax_70 % 3`). */
function supplyTripleBucketFromTick(tick: number): 0 | 1 | 2 {
  return ((tick >>> 1) % 3) as 0 | 1 | 2;
}

export function evaluateEndpointSend(
  state: RecoveredSchedulerState,
  addr: EndpointAddress,
  tick: number,
): RecoveredDecision {
  const { a, b, c, d } = addr;

  /* `sub_1402f9a40` @ 0x1402f9ba7: r13==4; @ 0x1402f9e46 bytes 1..3 must be 1 — wiki 0.{1,2,3}.0.0 → encodeEndpointAddressForStrategy(..., "plus_one_all_octets_regional_mainframe"). */
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
    /**
     * Binary: header **`var_10b = *arg3`** and subject **`REPLY_CHAIN_PACKET_SUBJECT`** (`sub_1402f9a40` @ `0x1402f9bc1`–`0x1402f9e1c`).
     * **`sub_1402f5840`** calls **`sub_1402f9a40`** only when **`*(packet_slot + 0x7a) == 2`** (slot mode after receive / staging).
     * This exporter does not model **`0x7a`** or inbound queues yet, so **`shouldSend`** here is still a stand-in schedule, not full parity.
     */
    return {
      shouldSend: true,
      header: rawAddrHeader(addr),
      profile: "reply-chain",
      reason: "a=2 reply path (subject from sub_1402f9a40)",
      packetSubject: REPLY_CHAIN_PACKET_SUBJECT,
      packetSubjectCandidates: [REPLY_CHAIN_PACKET_SUBJECT],
    };
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
        const packetSubject = trackBroadcastSubjectForTick(tick);
        return {
          shouldSend: true,
          header,
          profile: "track-broadcast",
          reason: "track-broadcast rotation",
          packetSubject,
          packetSubjectCandidates: [packetSubject],
        };
      }

      if (d === 2 && b >= 2 && b <= 4) {
        if ((tick & 1) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "school-chat even tick gate" };
        }
        const header = (((tick >> 1) & 3) === 0) ? ((b << 8) | 0x2040001) : ((b << 8) | 0x1020001);
        return {
          shouldSend: true,
          header,
          profile: "school-chat",
          reason: "school-chat gate branch",
          packetSubject: pickSchoolHomeworkSubjectPlaceholder(tick),
          packetSubjectCandidates: schoolHomeworkSubjectCandidates(),
        };
      }

      if (d === 3 && b >= 2 && b <= 4) {
        if ((tick & 1) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "school-chat d=3 even tick gate" };
        }
        if ((tick & 2) === 0) {
          const header = (b << 8) | 0x1020001;
          return {
            shouldSend: true,
            header,
            profile: "school-chat",
            reason: "school-chat d=3 homework (HLIL test_bit false)",
            packetSubject: pickSchoolHomeworkSubjectPlaceholder(tick),
            packetSubjectCandidates: schoolHomeworkSubjectCandidates(),
          };
        }
        const rax151 = Math.floor(tick / 4) & 3;
        const header = (rax151 << 8) + 0x3010101;
        return {
          shouldSend: true,
          header,
          profile: "school-chat",
          reason: "school-chat d=3 Student Exchange (HLIL test_bit true)",
          packetSubject: "Student Exchange Program",
          packetSubjectCandidates: schoolStudentExchangeSubjectCandidates(),
        };
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
          return { shouldSend: false, header: null, profile: null, reason: "status-family odd tick skip (arg4&1)" };
        }
        const half = signedHalfTickFloor(tick);
        if ((half & 0x0f) === 0) {
          return {
            shouldSend: true,
            header: statusMainframeUpdateHeaderU32(tick),
            profile: "status-family",
            reason: "status-family mainframe-update ((floor(tick/2))&0xf)==0",
            packetSubject: pickStatusFamilySubjectPlaceholder(tick),
            packetSubjectCandidates: statusFamilySubjectCandidates(),
          };
        }
        return {
          shouldSend: true,
          header: statusFirmwareUpdateHeaderU32(tick),
          profile: "status-family",
          reason: "status-family firmware-update ((floor(tick/2))&0xf)!=0",
          packetSubject: pickFirmwareUpdateSubjectPlaceholder(tick),
          packetSubjectCandidates: firmwareUpdateSubjectCandidates(),
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
      if (((tick >> 1) & 3) === 0) {
        return {
          shouldSend: true,
          header,
          profile: "school-chat",
          reason: "c=2 branch selection",
          packetSubject: pickSchoolSupplySubjectPlaceholder(tick),
          packetSubjectCandidates: schoolSupplySubjectCandidates(),
        };
      }
      return {
        shouldSend: true,
        header,
        profile: "school-chat",
        reason: "c=2 branch selection",
        packetSubject: pickSchoolCasualSubjectPlaceholder(tick),
        packetSubjectCandidates: schoolCasualSubjectCandidates(),
      };
    }

    case 3: {
      if (!(d === 1 || d === 2 || d === 3)) {
        return { shouldSend: false, header: null, profile: null, reason: "c=3 requires d=1, d=2, or d=3" };
      }
      if ((tick & 1) !== 0) {
        return { shouldSend: false, header: null, profile: null, reason: "c=3 even tick gate" };
      }

      if (d === 3) {
        const bucket = supplyTripleBucketFromTick(tick);
        const base = b << 8;
        if (bucket === 0) {
          return {
            shouldSend: true,
            header: base | 0x2030001,
            profile: "search-family",
            reason: "c=3 d=3 ammunition pool (HLIL rax_70%3==0)",
            packetSubject: "We need ammunition",
            packetSubjectCandidates: supplyAmmunitionSubjectCandidates(),
          };
        }
        if (bucket === 1) {
          return {
            shouldSend: true,
            header: base | 0x2040001,
            profile: "search-family",
            reason: "c=3 d=3 field rations pool (HLIL rax_70%3==1)",
            packetSubject: "We need field rations",
            packetSubjectCandidates: supplyFieldRationsSubjectCandidates(),
          };
        }
        return {
          shouldSend: true,
          header: 0x1010201,
          profile: "search-family",
          reason: "c=3 d=3 confidential pool (HLIL rax_70%3==2)",
          packetSubject: pickConfidentialSubjectPlaceholder(tick),
          packetSubjectCandidates: confidentialSubjectCandidates(),
        };
      }

      if (d === 2) {
        const k = (tick >> 1) & 3;
        const base = b << 8;
        const header = k === 0 ? 0x1010301 : k === 1 ? base | 0x1030001 : k === 2 ? base | 0x1020001 : base | 0x2020001;
        if (k === 0) {
          const packetSubject = "Search request";
          return {
            shouldSend: true,
            header,
            profile: "search-family",
            reason: "search-family rotation",
            packetSubject,
            packetSubjectCandidates: searchRequestSubjectCandidates(),
          };
        }
        if (k === 1) {
          const packetSubject = "Search query";
          return {
            shouldSend: true,
            header,
            profile: "search-family",
            reason: "search-family rotation",
            packetSubject,
            packetSubjectCandidates: searchQuerySubjectCandidates(),
          };
        }
        if (k === 2) {
          return {
            shouldSend: true,
            header,
            profile: "search-family",
            reason: "search-family rotation",
            packetSubject: pickSearchArchitectsSubjectPlaceholder(tick),
            packetSubjectCandidates: searchArchitectsSubjectCandidates(),
          };
        }
        return {
          shouldSend: true,
          header,
          profile: "search-family",
          reason: "search-family rotation k=3 investment pool",
          packetSubject: pickSearchInvestmentSubjectPlaceholder(tick),
          packetSubjectCandidates: searchInvestmentSubjectCandidates(),
        };
      }

      if ((tick & 0b10) === 0) {
        const packetSubject = "Join us!";
        return {
          shouldSend: true,
          header: dynamicJoinUsHeader(tick),
          profile: "search-family",
          reason: "join-us dynamic branch",
          packetSubject,
          packetSubjectCandidates: searchJoinUsSubjectCandidates(),
        };
      }
      return {
        shouldSend: true,
        header: dynamicPrayerHeader(tick),
        profile: "search-family",
        reason: "prayer dynamic branch",
        packetSubject: pickSearchPrayerSubjectPlaceholder(tick),
        packetSubjectCandidates: searchPrayerSubjectCandidates(),
      };
    }

    case 4: {
      if (d === 4 && b >= 2 && b <= 4) {
        if ((tick & 1) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "c=4 d=4 even tick gate" };
        }
        const meetingBranch = (tick & 2) !== 0;
        if (meetingBranch) {
          const rax224 = Math.floor(tick / 4) & 3;
          const header = rax224 < 4 ? (rax224 << 8) + 0x4040101 : 0x4040001;
          return {
            shouldSend: true,
            header,
            profile: "short-fixed",
            reason: "c=4 d=4 Meeting minutes (HLIL test_bit tick bit1)",
            packetSubject: "Meeting minutes",
            packetSubjectCandidates: meetingMinutesSubjectCandidates(),
          };
        }
        return {
          shouldSend: true,
          header: (b << 8) | 0x1010001,
          profile: "short-fixed",
          reason: "c=4 d=4 Status Report (HLIL)",
          packetSubject: "Status Report",
          packetSubjectCandidates: statusReportMeetingHeaderSubjectCandidates(),
        };
      }

      if (d === 2) {
        if (!case4D2TestBitGatePasses(b)) {
          return { shouldSend: false, header: null, profile: null, reason: "c=4 d=2 HLIL test_bit(0x16,b) gate" };
        }
        if ((tick & 7) !== 0) {
          return { shouldSend: false, header: null, profile: null, reason: "c=4 d=2 (arg4&7)==0 gate" };
        }
        const rax76 = case4D2Rax76Mod16(tick);
        if (rax76 !== 0 && rax76 !== 1) {
          return { shouldSend: false, header: null, profile: null, reason: "c=4 d=2 rax_76 mod16 not 0 or 1" };
        }
        if (rax76 === 1) {
          return {
            shouldSend: true,
            header: (b << 8) | 0x2020001,
            profile: "ad-family",
            reason: "c=4 d=2 Purchase Order branch (HLIL 0x1402fbc2b)",
            packetSubject: "Purchase Order",
            packetSubjectCandidates: adFamilySubjectCandidates(),
          };
        }
        return {
          shouldSend: true,
          header: dynamicAdHeader(b, tick),
          profile: "ad-family",
          reason: "c=4 d=2 BEST PRICES branch (HLIL 0x1402fa56a, same hi16/hi24 as dynamicAdHeader)",
          packetSubject: pickAdFamilySubjectPlaceholder(tick),
          packetSubjectCandidates: adFamilySubjectCandidates(),
        };
      }

      if (d !== 1) {
        return { shouldSend: false, header: null, profile: null, reason: "c=4 requires d=1 (token), d=2, or d=4 (meeting/status)" };
      }
      if ((tick & 3) !== 0) {
        return { shouldSend: false, header: null, profile: null, reason: "c=4 every-4-ticks gate" };
      }
      return {
        shouldSend: true,
        header: 0x1030203,
        profile: "short-fixed",
        reason: "c=4 fixed packet",
        packetSubject: "Token",
        packetSubjectCandidates: ["Token"],
      };
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

