import type { EndpointAddress, RecoveredDecision } from "./recovered-endpoint-scheduler.js";
import { recoveredTtlRules } from "./recovered-ttl-rules.js";

export type TtlEvaluation = {
  ttlValues: number[];
  ruleIds: string[];
  status: "resolved" | "unresolved";
  reason: string;
};

export type TtlEvaluateContext = {
  encoded: EndpointAddress;
  /**
   * Match `sub_1402f5840` @ `0x1402f7669`–`0x1402f7672`: when the tape row's first byte is `0x0a`,
   * the driver keeps the full `sub_1406b6820` product (no signed half-tick floor).
   * Default `true` applies the half step (common when `*tape != 0x0a`).
   */
  applyHalfRounding?: boolean;
};

function uniqueSorted(nums: readonly number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

function i32(n: number): number {
  return n | 0;
}

/** Same as `signedHalfTickFloor` in `recovered-endpoint-scheduler.ts` — used for post-`sub_1406b6820` scaling. */
function signedHalfFloor32(value: number): number {
  const t = i32(value);
  return i32((t + (t >> 31)) >> 1);
}

/**
 * Dword table at **`data_1424906b8`** (`tunnet.exe` VA `0x1424906b8`), indexed by the **byte**
 * at **`((lea rsp+0xc0)+0x31)`** in `sub_1402f5840` (= second byte of the **`slot+0x30`** dword captured
 * at `0x1402f5f5a` before `movups [rsp+0xc0]`). See `ttl.6b6820.table_times_r15`.
 */
export const TTL_MULTIPLIER_DWORD_TABLE_0_TO_15: readonly number[] = [
  0x00000001, 0x00000001, 0x00000002, 0x00000003, 0x00000008, 0x00000000, 0x00000001, 0x00000000,
  0x00000000, 0x00000000, 0x00000001, 0x00000000, 0x00000001, 0x00000000, 0x00000001, 0x00000000,
] as const;

function ttlMultiplierForIndex(idx: number): number {
  if (!Number.isInteger(idx) || idx < 0 || idx >= TTL_MULTIPLIER_DWORD_TABLE_0_TO_15.length) {
    return -1;
  }
  const m = TTL_MULTIPLIER_DWORD_TABLE_0_TO_15[idx]! | 0;
  if (m <= 0 || m > 64) return -1;
  return m;
}

/**
 * Initial **queued / wire-queue TTL qword's low dword family** recovered from **`sub_1406b6820`**
 * + **`sub_1402f5840`** post-process (`ttl.2f5840.encode_buffer_plus8`).
 *
 * **Assumption (explicit):** `sub_1406b6820`'s **`[rdx+0x50]==0`** fast-path → scale register stays at
 * **`eax = 2*r15`** with **`r15 = 1`**, i.e. **scale = 2** (see `cmovne` sequence @ `0x1406b6936`–
 * `0x1406b693b`). Richer **`r15` from `[rsi+0x18]`** branch is **not modeled** yet.
 */
export function evaluateEndpointTtl(decision: RecoveredDecision, ctx: TtlEvaluateContext): TtlEvaluation {
  if (!decision.shouldSend) {
    return {
      ttlValues: [],
      ruleIds: [],
      status: "unresolved",
      reason: "no-send-decision",
    };
  }
  if (decision.header === null) {
    return {
      ttlValues: [],
      ruleIds: [],
      status: "unresolved",
      reason: "missing-header-u32",
    };
  }

  const header = decision.header >>> 0;
  const gateByte = header & 0xff;
  if (gateByte === 0 || gateByte === 3) {
    return {
      ttlValues: [],
      ruleIds: [],
      status: "unresolved",
      reason: "ttl-call-gated-sub_1406b6820(slot+0x35-low-byte in {0,3}); alternate path without proven formula",
    };
  }

  const ttlIndexByte = (header >>> 8) & 0xff;
  const mult = ttlMultiplierForIndex(ttlIndexByte);
  if (mult <= 0) {
    return {
      ttlValues: [],
      ruleIds: [],
      status: "unresolved",
      reason: `ttl-table-mult-zero-or-out-of-range for index_byte=${ttlIndexByte} mult=${mult}`,
    };
  }

  const _applyHalf = ctx.applyHalfRounding !== false;
  void _applyHalf;
  void mult;

  return {
    ttlValues: [],
    ruleIds: ["ttl.6b6820.table_times_r15", "ttl.2f5840.encode_buffer_plus8"],
    status: "unresolved",
    reason:
      "needs real r15 from sub_1406b6820 hash-match row(+0x18); static shortcut removed because it mismatches in-game measurements",
  };
}

export function evaluateBridgeAdjustment(pair: string): { bridgeRuleIds: string[]; bridgeReason: string | null } {
  const [src, dst] = pair.split(">");
  const isBridge =
    src === "1.0.1.0" ||
    src === "1.1.1.0" ||
    src === "1.2.1.0" ||
    src === "1.3.1.0" ||
    dst === "1.0.1.0" ||
    dst === "1.1.1.0" ||
    dst === "1.2.1.0" ||
    dst === "1.3.1.0";
  if (!isBridge) {
    return { bridgeRuleIds: [], bridgeReason: null };
  }
  return {
    bridgeRuleIds: ["hop.74aa00.transform_overwrite", "hop.4f3a90.mutate_minus_1"],
    bridgeReason: "bridge-adjacent route — relay may rewrite TTL after initial enqueue",
  };
}

export function allKnownRuleIds(): string[] {
  return recoveredTtlRules.map((r) => r.ruleId);
}

export function mergeTtlValues(values: readonly number[]): number[] {
  return uniqueSorted(values);
}
