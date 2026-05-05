# Recovered TTL / hop-lifetime notes (Tunnet binary)

This file pulls together **everything the repo currently believes** about **time-to-live**, **remaining-hop-style counters**, and **TTL-adjacent fields** recovered from **`tunnet.exe`** via Binary Ninja. It is a **summary**; line-by-line evidence, tables, and exhausted leads stay in **`analysis/BINARY_NINJA_MCP_WORKFLOW.md`** **§J** (especially **§J.3–§J.5**).

**Not game truth:** `src/simulator.ts` TTL behavior is a **topology scaffold** (`ttl === undefined` ⇒ never expires). That design is **not** proven to match live slot layout until we map the same fields here into wire bytes.

**TypeScript pins:** `src/analysis/recovered-ttl.ts` re-exports scheduler anchors and adds a few helper VAs cited only in TTL narrative.

---

## 1. Questions we are answering

1. **Where** is an initial **TTL-like dword** (per-destination tape seed, compose stack, neighbor swap, `0x58` row, slot pack) **written**?
2. **What** decrements or mutates it on **relay / filter / bridge** paths?
3. **Whether** that dword is the **same bits** that appear **on the wire** (UDP) — **still open** for several paths (**§J.5**, Lead #1).

---

## 2. Vocabulary (do not conflate)

| Term | Meaning |
|------|--------|
| **`MainframeHeaderU32` / `var_10b`** | Header constant family from **`sub_1402f9a40`** — **not** the hop counter (**workflow §J.3.1**, **§J.4** intro). |
| **Tape `rax_11[1].d` / `var_300.d`** | **`dword *(tape_row + 8)`** after **`[[rsp+0x298]]`** reload (**Gate B**, **`0x1402f5ccf`** when **`*(slot+0x7a) != 2`**). Comes from **`sub_1404628b0` → `sub_1420519a0` / RNG** then **`sub_14204f0e0`** (ChaCha-style mix) — **not** raw **`0x424286e0`** at **`row+8`** (**§J.3.2**). |
| **Ring row `+0x18` (40-byte stride)** | On beep/PINGPONG path, **`var_200`** (= **`var_300.d`** on tape branch) stored at **deque row `+0x18`** (**§J.4**, **§J.4.8**). |
| **`0x58` row `+0x48`** | **`arg2[4]`** dword from **`sub_140516d40`** callers — **same logical dword** as **`rax_11[1].d`** on scheduler sites that pack **`[rsp+0x148]`** from **`[rsp+0x1a8]`** (**§J.4.1**). |
| **`*(arg1[2]+0x48)`** in **`516d40`** | **Deque routing flag** — **not** the **`arg2[4]`** dword (**§J.4.11**). |
| **`slot+0x48`** on live **`NetNode`** | **Overloaded**: tape-related packs **vs** SIMD bitmask branch (**§J.4.9**). |
| **`sub_1405208d0` `*(arg1+0x18)`** | **Rust `String` / allocator math** — **closed as non–hop-TTL** (**§J.4.5**). |

---

## 3. Scheduler gates (compose vs tape dword reload)

- **Gate A — `*(slot+0x7a)==2` ⇒ `sub_1402f9a40`:** **`0x1402f5bf5`** — **`§J.3.4`**.
- **Gate B — `*(slot+0x7a)==2` ⇒ skip `[[rsp+0x298]]+8 → [rsp+0x108]`:** **`0x1402f5cbd`–`0x1402f5cc1`** — **`§J.3.4` exhausted**.

**Implication:** on **compose**, **`var_300.d`** is **not** refreshed from the **tape ChaCha row** at that merge; TTL-like tooling must track **compose / neighbor / `516d40`** writers instead (**§J.3.4** conclusion).

---

## 4. Where the tape dword flows (when Gate B falls through)

1. **`var_300.d = rax_11[1].d`** @ **`0x1402f5cd2`** (**tape branch**).
2. **`var_200 = var_300.d`** @ **`0x1402f5da5`**.
3. Ring store **`*(ring_row + 0x18) = var_200`** @ **`0x1402f5f26`** (**§J.4.8**).
4. **`sub_140516d40`** packs **`arg2[4]`** so **`dword` lands at `0x58` row `+0x48`** (**§J.4.1**).

**Infection template:** **`var_300.d`** at **`row+0x18`** @ **`0x1402f8f09`** (**§J.4.8**).

---

## 5. Compose and neighbor swap (`+0x18` traffic)

- **`sub_1402f9a40`**: **`*(arg1+0x18) = var_130:8.q`** @ **`0x1402fbd3b`** — upper lane after **`var_f8`** / header pools (**§J.3.3**).
- **`sub_1423b0fc0` → `sub_1423af220`**: **`String` reserve** — **not** wire TTL (**§J.3.3**).
- **`sub_14037d450`**: swaps **`*(neighbor+0x18)`** with **`&var_308`** scratch (**§J.4.4**).

---

## 6. Slot pack after fmt (`+0x58` / `+0x60`)

**`sub_1423a0360`** does **not** assign **`var_200`**. After **`var_350` / `var_200.q`** staging:

- **`*(slot+0x58) = var_350`** @ **`0x1402f7581`**
- **`*(slot+0x60) = var_200.q`** @ **`0x1402f7585`** (**§J.4.9**)

**Relay **`sub_14044eae0` → `516d40`**: does **not** read **`slot+0x60`** on traced slices (**§J.4.9**).

---

## 7. Relay decrement heuristic (`slot[1].q`)

On **`label_14044f160` (B)** only: **`slot[1].q -= 1`** before **`516d40`** @ **`0x14044fae1`**. Other relay arms copy **verbatim** (**§J.1**, **§E.3**).

**Hypothesis:** **`slot[1].q`** is a **remaining-hop / classifier** on **(B)** — **not** proved identical to **tape `rax_11[1].d` → row `+0x48`** without a shared-writer proof (**§J.1**).

---

## 8. `memcpy` / `5211a0` / portal **`0x190`**

**Sites A–D** (**§J.4.2–§J.4.7**): **`sub_1405211a0` + `sub_1405208d0`** **clobber** **`rsp+0x108`** class scratch; **`memcpy(...,0x90)`** does **not** carry **`var_300`** as trailing **`0x90`** tail (**§J.1** bullet 1). **`0x190`** path → canned dialog (**§J.4.7**) — **not** **`rax_11[1].d`**.

---

## 9. Encode drain vs `WSASend` (Lead #1 partial)

- **`sub_1407baf90`**: **`0x60`** rows → **`sub_142244e00` → `sub_141fcee80`**; **no `row+0x48`** load (**§J.4.13**).
- **`sub_1405f0920` / `sub_1407ad390`**: **vtable-only** entries (**.rdata** **`0x1424a9e00` / `0x1424a9df8`**) — **§J.4.14**.
- **`WSASend`**: **`82c450` → `142345a90`**; **HTTP-ish** **`83e490`** vtable **`0x144d59a88`** — **not merged** with **`7baf90`** (**§J.4.14**).

**Still missing:** proof that **`0x58` row `+0x48`** or **`slot+0x60`** copies into **UDP `sendto`** buffers (**§J.5**).

---

## 10. Initial TTL “profile” table (from §J.5)

| Source | TTL-like dword | All packets? |
|--------|----------------|--------------|
| **Tape / `0x7a != 2`** | **`rax_11[1].d` → ring `+0x18` / `516d40` `+0x48`** | **Per destination row** — varies with **`rdi_43`** (**§J.5**). |
| **Compose / `0x7a == 2`** | **Not** tape reload at **`0x1402f5ccf`** — from **`2f9a40`**, neighbors, later **`516d40`** | Only emits through compose + gates (**§J.5**). |
| **`516d40` / `memcpy 0x90`** | **`arg2+0x48` → row** vs **`String` metadata** confusion resolved in **§J.4.3–§J.4.5** | Subset; **`+0x3a==2`** skips **`516d40`** block (**§J.5**). |

---

## 11. Tooling gap

Until **`MessageEvent`** (or export JSON) carries something like **`ttlInitial`**, **`pnpm sched:sequence`** cannot regress **per-packet TTL** against captures (**§J.5** repo note).

---

## 12. Chamber / bridge hint (**§J.2**)

**`1.*.1.0`** chamber endpoints: bridge may **rewrite first octet** and **TTL**; relay-only slices show **at most `-1`** — multi-step decrements point **bridge-ward** (**§J.2**).

---

## 13. 2026-05-05 closure update (both pending steps)

### 13.1 Representative staged-producer traces (now pinned)

- **`sub_1402f5840`**: `rax_11[1].d -> var_300.d -> var_200 -> rbp_19 -> *(slot+0x60)` on tape-fed/non-compose branches.
- **`sub_1404f3a90`**: staged `var_188/var_238` slot-image lanes feed `movups [slot+0x60]`; some branches mutate lane before commit (`r15_2 -= 1`).
- **`sub_14074aa00`**: `sub_1423a1b30(&var_ba8,...) -> var_a18 -> movdqu [slot+0x58]`.

### 13.2 Encode linkage proof improved

- `get_xrefs_to(0x142244e00)` now confirms **multiple direct calls from `sub_1402f5840`** (`0x1402f76ca`, `0x1402f792a`, `0x1402f79d9`, `0x1402f7a96`, `0x1402f7b5d`, `0x1402f7e4e`, `0x1402f80d5`, `0x1402f8435`, `0x1402f87d0`, `0x1402f9689`).
- `sub_1407baf90` confirms builder+drain primitive shape (`sub_142244e00` -> `sub_141fcee80`), and `sub_141fcee80` performs direct stream append (`*(result + rdi) = zmm6.q`).

### 13.3 Current state

- **Writer identity question:** effectively closed to a small set (`2f5840`, `4f3a90`, `74aa00`) with branch-level semantics.
- **Wire identity question:** still partially open; need final lane-to-UDP-byte equality proof for `slot+0x58/+0x60` across selected branches.

---

## 14. Concrete written values (current best)

This section answers the practical question: **what values are actually written into the TTL-like lanes on each writer family**.

| Writer / branch family | Write site | Value written | Value form |
|---|---|---|---|
| `sub_1402f5840` main pack | `*(slot+0x58)` @ `0x1402f7581` | `var_350` | **Either dynamic copy** (`var_208.q`) or **hard constants** seen in branch arms: `5`, `7`, `0xD` |
| `sub_1402f5840` main pack | `*(slot+0x60)` @ `0x1402f7585` | `rbp_19` | **Usually tape/stack-fed dynamic value** (`var_200.q` chain from `rax_11[1].d` on non-compose branches), but some branches overwrite from path-local payload pointers/temps (`rax_118`, `rax_136`, `rax_146`, `rax_151`, `rax_162`, `rax_407`, `var_138`) |
| `sub_1404f3a90` fast image commit (`0x1404f434c` path) | `movups [slot+0x60]` @ `0x1404f437c` | `xmm2` (from staged stack image) | **Copy-through bundle write** of staged lane(s), not immediate constants |
| `sub_1404f3a90` mutate branch | staged qword feeding later slot commit | `old_value - 1` (e.g. `dec r15` @ `0x1404f4399`) | **Decrement-by-one** branch before commit |
| `sub_14074aa00` matched slot commit | `*(slot+0x58)` @ `0x14074ca8e` | `var_a18.o` | **Transformed 128-bit scratch**, loaded via `sub_1423a1b30(&var_ba8,...)` then copied (`var_a18.o = var_ba8.o`); other paths also show `var_a18` assembled from mixed dynamic parts (`var_a18.d = var_ba8`, high bytes from `var_bee...`) |

### Practical readout

- **Hard numeric values recovered so far:** `5`, `7`, `13` (`0xD`) on `sub_1402f5840` branch families.
- **Other cases:** dynamic copy/rewrite values (including decrement-by-1 branches), not fixed constants.
- **Important caveat:** these are values written to **TTL-like storage lanes** (`+0x58/+0x60` image family). Final proof that every one of these is the exact wire TTL byte(s) still needs the final lane-to-UDP-byte mapping pass.

---

## 15. Dynamic value formulas needed for replication

Condensed from the path-family map:

- **`sub_1402f5840`**
  - final sink: `slot+0x58 <- [rsp+0xb8]`, `slot+0x60 <- rbp`
  - copy formula: `[rsp+0xb8]=[rsp+0x200]`, `rbp=[rsp+0x208]` (builder/tape-derived dynamic lane)
  - constant-tag formulas: `slot+0x58` can be `5`, `7`, or `13`, while `slot+0x60` is still dynamic payload pointer/value
  - release guard: if previous slot is non-compose and old `+0x58` exists, release old `{+0x58,+0x60}` before overwrite
- **`sub_1404f3a90`**
  - copy formula: `slot+0x60 <- xmm2` from staged image (`[rsp+0x190]` family)
  - mutate formula: branch with `dec r15` gives decrement-by-1 dynamic lane before later commit
  - non-compose branches may release old payload then overwrite from staged image
- **`sub_14074aa00`**
  - transform formula: `slot+0x58 <- vector(sub_1423a1b30(...))` (via `xmm0/[rsp+0x2c0]`)
  - non-compose branches similarly release old payload prior to overwrite
  - additional mixed scalar/vector composition paths exist for the same lane family

This is now enough to emulate the branch-selected value families, with one remaining caveat: final lane-to-wire TTL-byte identity is still pending.

---

## 16. Endpoint vs bridge value behavior (replication view)

### Endpoint-create (`sub_1402f5840`)

- Packet families with embedded payload text show fixed TTL-like tags at `slot+0x58`:
  - `"Search result"` family -> `13`
  - `"Token"` families -> `5`
  - `"Catalog"` family -> `7`
- Same branches still pair `slot+0x60` with dynamic payload pointer/value.
- Generic builder/tape families remain fully dynamic (`[rsp+0x200]/[rsp+0x208]` pair).

### Bridge/rewrite side

- `sub_14074aa00`: rewrites from transform output (`sub_1423a1b30` vector) into `slot+0x58`.
- `sub_1404f3a90`: has decrement branch (`-1`) and staged overwrite branches.
- `sub_14044eae0` relay branch B: decrement-by-1 on `slot[1].q` family.

Interpretation for simulation:

1. Endpoint establishes baseline value family (fixed tag or dynamic builder/tape).
2. Bridge/relay path mutates/replaces baseline by transform or decrement logic.

---

## 17. BN closure: `sub_1423a0360` output layout (critical)

New Binary Ninja decompile evidence:

- `sub_1423a0360` writes:
  - `*arg1 = rbx_1` (aggregate length/sum path)
  - `arg1[1] = rax_1` (allocated pointer)
  - `arg1[2] = 0`
- In `sub_1402f5840` copy families, this output is consumed as:
  - `[rsp+0x200] -> [rsp+0xb8] -> slot+0x58`
  - `[rsp+0x208] -> rbp -> slot+0x60`

Interpretation:

- `slot+0x58` behaves as payload-length lane.
- `slot+0x60` behaves as payload pointer/capability lane.

Consequence for range recovery:

- For many endpoint packets, concrete numeric ranges can be recovered directly from observed subject lengths (and fixed branches `5/7/13`).
- Remaining unresolved parts are mainly bridge/relay rewrite semantics and exact wire-byte correspondence, not endpoint value observability.

---

## 18. Proven vs hypothesis reset (strict)

### Proven (high confidence)

- `slot+0x58` and `slot+0x60` in the `sub_1402f5840` pack are payload-lane fields (length/pointer shape), not proven hop-TTL.
- `sub_14044eae0` contains explicit decrement behavior (`-1`) on a relay path (`0x14044fae1` family) involving the lane represented by `slot[1].q` / packed relay image.
- Bridge-capable writers (`sub_14074aa00`, `sub_1404f3a90`) can mutate or overwrite lane bundles before commit.

### Not yet proven (must not be stated as fact)

- Exact identity of gameplay hop-TTL field across all writer families.
- Exact function mapping from scheduler decision (`profile`, `header`, state) to the true hop-TTL write expression.
- Exact bridge rewrite numeric outcomes for that true hop-TTL lane on exercised runtime paths.
- Exact wire-byte location corresponding to the gameplay hop-TTL value.

### Operational rule

- Any analysis output using subject-length or payload-lane measurements is evidence for payload behavior only, not hop-count semantics.
- **Enqueue / queued-record TTL dword** (**`sub_1406b6820`/`sub_1402f5840`** path documented in **§19–§20**) is now treated as **`resolved`** in tooling when predicates match (**no subject-length proxies**).
- **Remaining-hop / relay decrement field** (**`hop.44eae0`**) and bridge rewrites remain **explicitly segmented** until the same caliber of linkage is pinned per path.

---

## 19. Branch-level rule table (ruleId indexed)

| ruleId | Writer | Lane | Predicate | Expression | Status |
|---|---|---|---|---|---|
| `ttl.6b6820.table_times_r15` | `sub_1406b6820` | initial wire / queue TTL (dword) | `sub_1406b6820` fast path | `eax = (r15==0 ? 2 : 2*r15); return eax * dword[data_1424906b8 + (idx<<2)]` where `idx = byte[((lea rsp+0xc0) from `sub_1402f5840`) + 0x31]` (= second byte of dword saved from `slot+0x30` at `0x1402f5f5a`) | proven |
| `ttl.2f5840.encode_buffer_plus8` | `sub_1402f5840` | same (post-scale + enqueue) | gate: `byte[rsp+0xf5] not in {0,3}` (`slot+0x35` low byte staging; matches `header & 0xff` on `label_1402faadc` stores) | signed half floor toward `-inf` unless `*tape==0x0a`, then clamp min `1`; `*(send_chunk+8) = sx.q(final)` after `sub_142244e00` staging @ `0x1402f7744` | proven |
| `payload.2f5840.pack.length_ptr` | `sub_1402f5840` | payload-lane | main slot pack path | `slot+0x58 <- [rsp+0x200]`, `slot+0x60 <- [rsp+0x208]` | proven |
| `payload.2f5840.const_tag_5_7_13` | `sub_1402f5840` | payload-lane | special payload branches | constant writes `5/7/13` on payload-tag lane | proven |
| `hop.44eae0.relay_minus_1` | `sub_14044eae0` | hop-lane-candidate | relay path B | decrement by `1` before relay commit | proven |
| `hop.4f3a90.mutate_minus_1` | `sub_1404f3a90` | hop-lane-candidate | mutate branch | staged decrement by `1` then commit | hypothesis |
| `hop.74aa00.transform_overwrite` | `sub_14074aa00` | hop-lane-candidate | transform commit branch | overwrite lane bundle from transformed scratch | hypothesis |

This table is now the canonical index used by script artifacts and unresolved-reason reporting.

---

## 20. Closure note (enqueue / wire-queue initial TTL via `sub_1406b6820`)

Closed for the **enqueue path**:

- **`sub_1406b6820` + dword table `data_1424906b8`** computes a **scaled product** keyed by **`byte[((lea rsp+0xc0) in `sub_1402f5840`) + 0x31]`**, i.e. **the second byte of the `slot+0x30` dword** captured **before** the **`movups [rsp+0xc0]`** overwrite (`0x1402f5f5a` → `rsp+0xf1` bundle). MCP disasm: **`0x1406b692b`**– **`0x1406b6969`** (table LEA **`0x1424906b8`**, **`imul eax,[rdx+rcx*4]`**); **`sub_1402f5840`** call site **`0x1402f7602`** / **`0x1402f7612`**.
- **`sub_1402f5840`** post-process applies **signed `/2` toward `-infinity`** (`0x1402f766b`–`0x1402f7672`) unless **`*tape==0x0a`**, then enforces **`min 1`** (`0x1402f7674`–`0x1402f767c`) before enqueue **`mov qword [...+8], rax`** @ **`0x1402f7744`** (**`ttl.2f5840.encode_buffer_plus8`**).
- Repo tooling (`src/analysis/ttl-evaluator.ts`) maps **`idx := (MainframeHeaderU32>>>8)&0xff`**, **`mult := dword_table[idx]`**, **`raw := 2*mult`** (**assume `r15=1`, `[node+50]==0`** fast-path), **`ttl := SAR((raw+(raw>>>31)),1)` by default**, **`clamp <2 → 1`**, gated by **`(header&0xff) ∉ {0,3}`** (matches **`byte[rsp+0xf5]`** test @ **`0x1402f75e9`**– **`0x1402f75fc`** aligned with **`label_1402faadc`** **`*(slot+0x35)=truncate8(header)`** stores).

Still separate / weaker:

- **`r15 != 1`** when **`sub_1406b6820` walks **`[rdx+0x58]` bitmask rows** (**`assume scale=2` may drift** until modeled).
- **Tape sentinel `0x0a`** (skip-half branch) defaults **on** in scripts — flip when capture proves otherwise.
- **Relay decrement** (**`hop.44eae0`**) and **bridge overwrite** (**`hop.74aa00`**, **`hop.4f3a90`**) after enqueue.

**Artifact:** `analysis/pair-ttl-values.json` emits per-pair **union** **`ttlValues[]`**, **`min`/`max`**, **`ruleIds`**.

---

## 21. BN correction: why prior resolved numbers were reverted

New MCP pass on `sub_1402f5840` + `sub_1406b6820` establishes:

- `sub_1402f5840` calls `sub_1406b6820` at **three** sites:
  - `0x1402f7612`
  - `0x1402f844e`
  - `0x1402f87e9`
- These sites do **not** share identical post-processing:
  - `0x1402f7612` path includes gate/conditional-half/clamp flow.
  - `0x1402f87e9` path stores `sx.q(rax_333.d) u>> 1` directly at queue `+8`.
  - `0x1402f844e` path stores `sx.q(rax_293)` at queue `+8`.
- In `sub_1406b6820`, multiplier is **not** fixed:
  - `r15` is loaded from matched hash-row field `*(rsi + 0x18)` on success path.
  - final core expression remains `eax = (r15==0 ? 2 : 2*r15) * dword[data_1424906b8 + idx*4]`.

Consequence:

- The earlier static shortcut (`assume r15=1`, single post-process) is invalid and was removed.
- Pair outputs are intentionally back to `unresolved(reason)` until `r15` provenance from the row writers is recovered from BN chain.

---

## See also

- **`analysis/BINARY_NINJA_MCP_WORKFLOW.md`** — **§J** (full BN narrative), **§E.3** (relay), **§H** (bounce lead).
- **`src/analysis/recovered-ttl.ts`** — VA exports for this topic.
- **`src/simulator.ts`** — scaffold TTL decrement (**not** recovered from binary).
