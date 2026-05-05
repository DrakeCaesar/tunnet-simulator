export type TtlRuleStatus = "proven" | "hypothesis" | "unresolved";

export type TtlRule = {
  ruleId: string;
  writer: string;
  lane: string;
  predicate: string;
  expression: string;
  status: TtlRuleStatus;
  evidence: string;
  notes?: string;
};

/**
 * Branch-level TTL/hop-lane rule inventory.
 *
 * Important:
 * - `payload-lane` entries are included to prevent conflating them with hop-TTL.
 * - `hop-lane` entries indicate decrement/mutation evidence but may still be unresolved
 *   for scheduler profile mapping.
 */
export const recoveredTtlRules: readonly TtlRule[] = [
  {
    ruleId: "ttl.6b6820.table_times_r15",
    writer: "sub_1406b6820",
    lane: "initial-wire-ttl-i32",
    predicate: "`[rdx+0x50]` zero ⇒ `r15` stays `1`; else match path may load `r15` from `[rsi+0x18]`",
    expression: "`eax = (r15==0 ? 2 : 2*r15); return eax * dword[data_1424906b8 + (byte[(arg1)+0x31] << 2)]`",
    status: "proven",
    evidence: "sub_1406b6820 disasm @ 0x1406b692b–0x1406b6969 (table LEA 0x1424906b8, `imul eax, [rdx+rcx*4]`)",
    notes:
      "Indexes the **byte at `((sub_1402f5840` stack) lea rsp+0xc0)+0x31`**; scale source is branch-dependent and may come from matched row `+0x18`.",
  },
  {
    ruleId: "ttl.2f5840.encode_buffer_plus8",
    writer: "sub_1402f5840",
    lane: "queued-ttl-qword",
    predicate: "multiple `sub_1406b6820` callsites in `sub_1402f5840` (`0x7612`, `0x844e`, `0x87e9`) with path-specific post-processing",
    expression:
      "queue `+8` sink receives either raw / shifted / conditional-halved helper output depending on branch family",
    status: "proven",
    evidence:
      "0x1402f7612, 0x1402f844e, 0x1402f87e9 callsites; sinks at 0x1402f7744, 0x1402f84ca, 0x1402f8868",
    notes:
      "Do not collapse to a single formula until callsite selection and row-derived `r15` are mapped.",
  },
  {
    ruleId: "payload.2f5840.pack.length_ptr",
    writer: "sub_1402f5840",
    lane: "payload-lane",
    predicate: "main slot pack path",
    expression: "slot+0x58 <- [rsp+0x200], slot+0x60 <- [rsp+0x208]",
    status: "proven",
    evidence: "0x1402f7581,0x1402f7585 + sub_1423a0360 output layout",
    notes: "Length/pointer semantics; not hop-TTL.",
  },
  {
    ruleId: "payload.2f5840.const_tag_5_7_13",
    writer: "sub_1402f5840",
    lane: "payload-lane",
    predicate: "special payload branches",
    expression: "slot+0x58 uses constant tags 5/7/13 on selected branches",
    status: "proven",
    evidence: "0x1402f7046,0x1402f728b,0x1402f6ea7,0x1402f948a",
    notes: "These are payload-tag writes; do not treat as hop-TTL baseline.",
  },
  {
    ruleId: "hop.44eae0.relay_minus_1",
    writer: "sub_14044eae0",
    lane: "hop-lane-candidate",
    predicate: "relay path B",
    expression: "decrement by 1 before relay pack/callsite path",
    status: "proven",
    evidence: "0x14044fae1",
    notes: "Strongest direct decrement evidence for hop behavior.",
  },
  {
    ruleId: "hop.4f3a90.mutate_minus_1",
    writer: "sub_1404f3a90",
    lane: "hop-lane-candidate",
    predicate: "mutate branch",
    expression: "decrement staged value then commit slot image",
    status: "hypothesis",
    evidence: "0x1404f4399",
    notes: "Likely hop-lane mutation but lane identity vs relay decrement lane is unresolved.",
  },
  {
    ruleId: "hop.74aa00.transform_overwrite",
    writer: "sub_14074aa00",
    lane: "hop-lane-candidate",
    predicate: "transform commit branch",
    expression: "overwrite lane bundle from transformed scratch",
    status: "hypothesis",
    evidence: "0x14074c9b3,0x14074ca12,0x14074ca8e",
    notes: "Bridge-style rewrite; exact hop field inside written bundle unresolved.",
  },
] as const;

export function ttlRulesByStatus(status: TtlRuleStatus): TtlRule[] {
  return recoveredTtlRules.filter((r) => r.status === status);
}

