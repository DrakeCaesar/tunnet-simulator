# TTL first-writer hunt v2 (active)

Purpose: find the earliest writer that sets packet TTL-like state before relay/filter decrement logic.

This file is an execution log + checklist for fresh MCP work. It complements:
- `analysis/RECOVERED_TTL.md` (current summary)
- `analysis/BINARY_NINJA_MCP_WORKFLOW.md` (§J deep evidence)

---

## 1) Target question

For each emitted packet profile (tape, compose, bridge/chamber, relay-forward), identify:

1. First write site of TTL-like value into live packet state.
2. Whether the value is copied from prior state, decremented, or overwritten with a constant/profile.
3. Which state lane eventually drains into encode/send.

---

## 2) Priority writer candidates

1. `sub_1402f5840` slot pack:
   - `0x1402f7581`: `*(slot+0x58) = var_350`
   - `0x1402f7585`: `*(slot+0x60) = var_200.q`
2. Relay decrement arm:
   - `0x14044fae1`: `slot[1].q -= 1` on one `sub_14044eae0` path.
3. Tape seed path:
   - `0x1402f5cd2`: `var_300.d = rax_11[1].d`
   - `0x1402f5f26`: ring row `+0x18 = var_200`
4. `sub_140516d40` callsite packing:
   - `arg2[4]` dword -> row `+0x48`
5. Bridge/chamber transform path:
   - spines that rewrite first octet (`1.*.1.0` <-> `0.*.1.0`) and potentially rewrite TTL.

---

## 3) Execution protocol (MCP)

At each promising function:

1. Pin all stores to candidate lane(s): `slot[1].q`, `slot+0x60`, `row+0x48`, ring row `+0x18`.
2. For each store, trace backwards to the first non-phi source:
   - constant/immediate,
   - tape row (`+0x10/+0x18` pair),
   - prior slot field,
   - bridge transform branch input.
3. Mark branch predicates (`+0x7a`, `+0x3a`, class id, bridge state).
4. Mark whether path is create, forward, bounce, or synthetic packet.

---

## 4) Evidence table template

| Candidate lane | Writer (fn @ VA) | Source expression | Path predicate(s) | First-writer confidence | Notes |
|---|---|---|---|---|---|
| `slot+0x60` | | | | | |
| `slot[1].q` | | | | | |
| `0x58 row +0x48` | | | | | |
| ring row `+0x18` | | | | | |

---

## 5) Session log

### 2026-05-05 (this session)

- Created this hunt file.
- MCP pass run over `sub_1402f5840` and `sub_14044eae0` decompilation.
- Reconfirmed strongest candidate first-writer in `sub_1402f5840`:
  - tape lane: `var_300.d = rax_11[1].d` (`0x1402f5cd2`)
  - durable pack: `*(slot+0x60) = rbp_19` (`0x1402f7585`)
  - ring lane: `*(row+0x18) = var_200` (`0x1402f5f26`)
- Reconfirmed relay behavior in `sub_14044eae0`:
  - one branch decrements `var_218`/`slot[1].q` by exactly 1 (`0x14044fae1`)
  - other branches copy-through or synthetic-rewrite; relay is likely consumer/mutator, not initial creator.
- Rechecked `sub_1402f5840` flow around compose gate:
  - compose (`slot+0x7a==2`) still bypasses tape reload site used on non-compose path.
- New bridge-adjacent lead checked: `sub_140165cb0`.
  - disassembly shows `0x60`/`0x58` table reads and row writes, plus constants such as `0x10c` and message-tag builds.
  - current evidence suggests queue/event payload updates rather than a clean direct write to the known TTL lanes (`slot+0x60`, `slot[1].q`, `row+0x48`), but this function remains useful for chamber/bridge state transitions.

### New actionable leads

1. Find first read-after-write of `slot+0x60` outside `sub_1402f5840` pack tail:
   - prioritize call graph reachable after `0x1402f7585`.
2. Find proven copy edge from `slot+0x60` or `slot[1].q` into encode input:
   - inspect encode-adjacent functions for source lane mapping into pushed buffers.
3. Chamber/bridge rewrite criterion:
   - search for path where source/destination octet transform and TTL-lane assignment happen in same basic block cluster.

---

## 6) Live slot writer inventory (current)

Goal here: enumerate all code clusters that write the `0x98` packet slot body (`+0x40..+0x7c` band), then isolate TTL-lane writers (`+0x58/+0x60`, `slot[1].q` image).

### A) `sub_1402f5840` (primary scheduler writer)

- Compose/mirror writer:
  - `*(slot+0x40..+0x70)` in one cluster around `0x1402f5c56`-`0x1402f5c87`.
- Pack writer with strongest TTL candidate:
  - `*(slot+0x58)=var_350` @ `0x1402f7581`
  - `*(slot+0x60)=rbp_19` @ `0x1402f7585`
  - full block writes `+0x40..+0x7f` @ `0x1402f755d`-`0x1402f75e5`.

### B) `sub_14044eae0` (relay)

- Writes slot tail via `rsi_15 = &result[8]` / `rsi_23 = &result[8]`:
  - stores four contiguous lanes into `+0x40..+0x70` (`*rsi_*`, `rsi_*[1]`, `rsi_*[2]`, `rsi_*[3]`).
- Includes one branch-local decrement before writeback (`0x14044fae1` equivalent in decompile), consistent with relay consumption.

### C) `sub_1404f3a90` (multi-endpoint packet path)

- Multiple direct writes to live slot:
  - `*(slot+0x40..+0x70)` in clusters around:
    - `0x1404f3f81` (via `rdi_7`)
    - `0x1404f4377` (explicit scalar stores)
    - `0x1404f4be0` / `0x1404f4dd8` (vectorized slot image copies)
- Also calls `sub_140516d40` at several sites (queue append in parallel).

### D) `sub_14074aa00` (large nav/path system touching packet slots)

- Confirmed direct slot writes for matched packet record (`rdi_14 + i_4`):
  - `+0x40`, `+0x48`, `+0x50`, `+0x58`, `+0x68`, `+0x70`, `+0x74`, `+0x75`, `+0x79`, `+0x7a`, `+0x7b`, `+0x7c`
  - cluster around `0x14074ca69`-`0x14074cad1`.
- This is a real slot writer, not only queue plumbing.

### E) `sub_1403a7a00` (graph/path cache propagation)

- Writes `*(rax_111 + 0x40)`, `+0x50`, `+0x60`, `+0x70` in one packet-update path (`0x1403a87f7`-`0x1403a8800` in decompile listing).
- Also emits through `sub_140516d40` for queue rows.

### Provisional count

- Strong confirmed live-slot writers: at least 5 functions (A-E above).
- Strong TTL-initializer candidates among them likely narrower:
  - `sub_1402f5840` (highest confidence),
  - plus selective branches in `sub_14074aa00` / `sub_1404f3a90` / `sub_1403a7a00` pending lane-source tracing.

### TTL-lane shortlist (likely what user expected as "2-4")

If we constrain to the specific TTL-like lanes (`slot+0x58`, `slot+0x60`, and relay `slot[1].q` image), the likely practical set is:

1. `sub_1402f5840` (definite `+0x58` and `+0x60` writer, strongest first-writer candidate).
2. `sub_14044eae0` (relay rewrite/copy path that writes full slot image including the second lane).
3. `sub_1404f3a90` (multi-endpoint direct writes to `+0x40..+0x70`).
4. `sub_14074aa00` and/or `sub_1403a7a00` (both write slot image, but need one more pass to confirm if their `+0x58`/`+0x60` lanes are the same semantic TTL lane vs sibling payload field).

So yes: the "real TTL-setting subset" may collapse to about 3-4 sites once lane identity is proven.

---

## 7) Endpoint vs bridge classification pass (writer-shape)

Heuristic used:
- **Endpoint-create shape:** same block writes destination/header bytes (`+0x70/+0x74/+0x75/+0x79`) and TTL-like lane (`+0x58/+0x60`) together.
- **Bridge-rewrite shape:** updates destination bytes and may preserve or overwrite TTL lane based on branch predicates.

### Observed shapes

1. `sub_1402f5840`:
   - Strong endpoint-create/writeback shape.
   - In one tight cluster, writes:
     - `+0x58`, `+0x60` (TTL-like lane),
     - `+0x70`, `+0x74`, `+0x75`, `+0x79`, `+0x7a`, `+0x7b`, `+0x7c` (destination/state profile bytes).
   - This is currently the clearest packet-creation writer.

2. `sub_14074aa00`:
   - Also shows same combined write shape:
     - `movdqu [slot+0x58], ...`
     - scalar writes to `+0x70/+0x74/+0x75/+0x79/+0x7a/+0x7b/+0x7c`.
   - Candidate for bridge/transform path because this function also performs routing/transform-style calls before writeback.

3. `sub_1404f3a90`:
   - Confirmed slot-image writer (`+0x60/+0x70` vector clusters), with `+0x74/+0x75/+0x79/+0x7b` reads used for pack decisions.
   - Still needs one more mapping pass to prove it is same semantic destination+TTL lane as `2f5840` (likely yes, not yet mechanically pinned for every branch).

### Updated practical plan

Given your model (endpoints create, bridges rewrite), next step is to treat all three functions above as the full short writer set and for each:

1. identify branch predicates that choose overwrite vs preserve of `+0x58/+0x60`;
2. identify branch predicates that change destination bytes;
3. mark branch as endpoint-create vs bridge-rewrite candidate.

---

## 8) Per-site branch tables (current best)

### `sub_1402f5840` (slot write cluster `0x1402f7527`-`0x1402f75e5`)

| Branch / guard | Destination write (`+0x70/+0x74/+0x75/+0x79`) | TTL-lane write (`+0x58/+0x60`) | TTL source summary | TTL behavior | Classification |
|---|---|---|---|---|---|
| `cmp byte [slot+0x7a],2` then optional free of old `+0x58/+0x60` payload | Always written in this cluster | Always written (`[slot+0x58]=rax`, `[slot+0x60]=rbp`) | `rbp` comes from branch-selected `rbp_19`: most send branches use `rbp_19 = var_200.q` (tape/compose-fed lane), while some special packet branches set `rbp_19` to freshly allocated payload pointers | **Overwrite** (new packed values replace prior lane) | Endpoint-create primary |
| PONG rewrite subpath (`0x1402f783d` onward) | Writes destination/state bytes; sets `slot+0x7a=1` | Writes `slot+0x60` (new pointer/value) | Derived from PONG path-local payload; not copied unchanged from prior slot lane | **Overwrite** | Bridge/transform-like rewrite candidate |

Notes:
- This is the strongest confirmed creation writer.
- Same block couples destination profile fields and TTL-like lane, consistent with packet creation/rewrite semantics.

### `sub_1404f3a90` (multiple slot-image writers)

| Branch / guard | Destination write band | TTL-lane write band | TTL source summary | TTL behavior | Classification |
|---|---|---|---|---|---|
| `cmp byte [slot+0x7a],2` fast copy path (`0x1404f434c` -> `0x1404f4377`) | `movups [slot+0x70]` (includes destination/state bytes) | `movups [slot+0x60]` (includes TTL-like lane) | Staged from current slot-derived locals (`var_1a8_1`, `rbp_10`, `var_188`, `rcx_18`) | **Overwrite but semantically preserve/copy** | Endpoint/rewrite mixed |
| Additional slot image commits (`0x1404f4be0`, `0x1404f4dd8`) | Full band copied from staged stack lanes | Full band copied from staged stack lanes | Same staged image path; branch-dependent fields may be rewritten before commit | **Overwrite** | Rewrite-capable |
| Branches with local arithmetic before commit (e.g. `if (rbx_6 != 0) r15_2 -= 1`) | Destination fields still written from staged bundle | TTL-like qword in staged bundle may be decremented before writeback | Indicates branch-local mutation of the lane before slot commit (not pure pass-through) | **Rewrite/mutate** | Bridge-style candidate branch inside function |

Notes:
- This function clearly writes same slot band, but per-branch TTL source identity (same semantic lane as `2f5840` every time) remains partially open.

### `sub_14074aa00` (slot write cluster `0x14074ca2a`-`0x14074cad1`)

| Branch / guard | Destination write (`+0x70/+0x74/+0x75/+0x79`) | TTL-lane write (`+0x58/+0x60`) | TTL source summary | TTL behavior | Classification |
|---|---|---|---|---|---|
| `cmp byte [slot+0x7a],2`; if not, free old `+0x58/+0x60` payload | Always written in this cluster | `movdqu [slot+0x58]` from staged lane (`xmm0`) | Staged via `var_a18 <- var_ba8 <- sub_1423a1b30(&var_ba8,&var_790)` after transform/routing work (`sub_1400ae2a0`) | **Overwrite** | Endpoint/bridge candidate |
| Same cluster writes mode/state bytes (`+0x7a/+0x7b/+0x7c`) from computed branch vars | Yes | Yes (`+0x58` lane rewritten while `+0x60` participates in free path) | Lane is branch-selected scratch, not a direct untouched copy of previous slot | **Overwrite with branch-selected state** | Bridge-transform likely on selected branches |

Notes:
- Writer shape strongly matches “destination rewrite + optional TTL rewrite”.
- Because it runs after transform-style calls, it is a high-priority bridge candidate.

---

## 9) Narrowed working conclusion

- The effective small writer set is real (3 major sites):
  1. `sub_1402f5840`
  2. `sub_1404f3a90`
  3. `sub_14074aa00`
- All three have overwrite-capable slot-band writes.
- The main remaining question is not “who writes”, but “which branches preserve vs rewrite TTL semantic value” per site.

---

## 10) Final compact matrix (writer x branch x TTL action)

| Writer | Branch key | Destination action | TTL action | Endpoint vs bridge signal | Confidence |
|---|---|---|---|---|---|
| `sub_1402f5840` | Main pack (`0x1402f7527` -> `0x1402f75e5`) | Writes full dst/state (`+0x70/+0x74/+0x75/+0x79/+0x7a/+0x7b/+0x7c`) | `+0x58/+0x60` overwritten from branch-selected staged values (`var_350`/`rbp_19`) | Endpoint-create dominant | High |
| `sub_1402f5840` | PONG/reply rewrite (`~0x1402f783d`+) | Rewrites dst/state, mode (`+0x7a=1`) | `+0x60` rewritten from path-local payload pointer/value | Bridge/rewrite-like | High |
| `sub_1404f3a90` | Fast slot-image commit (`0x1404f434c` -> `0x1404f4377`) | `movups` writes slot `+0x70` band | `movups` writes slot `+0x60` band from staged image | Endpoint/rewrite mixed | Medium-high |
| `sub_1404f3a90` | Mutating branch before commit (`r15_2 -= 1` path) | Destination fields still committed | TTL-like staged lane can be decremented before writeback | Bridge-style mutate candidate | Medium |
| `sub_14074aa00` | Matched slot commit (`0x14074ca2a` -> `0x14074cad1`) | Writes full dst/state (`+0x70/+0x74/+0x75/+0x79/+0x7a/+0x7b/+0x7c`) | `movdqu [slot+0x58]` overwrite from transformed scratch; old `+0x58/+0x60` payload optionally freed first | Bridge/transform-capable; may also serve endpoint-like creates | High |

### Practical interpretation

- **Creation-capable, definitive:** `sub_1402f5840`.
- **Rewrite-capable, definitive:** `sub_14074aa00`.
- **Hybrid/multipath writer:** `sub_1404f3a90` (copy + mutate branches).

### Next minimal closure step

To finish TTL recovery with minimal extra work:

1. pick one representative branch per matrix row above;
2. trace the exact producer of staged TTL lane (`var_200`, `var_188/var_238`, `var_a18`);
3. link one branch to encode/send bytes (wire proof).

---

## 11) Dynamic value map (predicate -> formula)

This section captures the dynamic expressions needed to replicate behavior, not only constant cases.

### A) `sub_1402f5840` dynamic formulas

Stable final sink:

- `slot+0x58 <- [rsp+0xb8]` (`0x1402f7581`)
- `slot+0x60 <- rbp` (`0x1402f7585`)

Core dynamic seed:

- `[rsp+0x208] <- eax` at `0x1402f5da5`, where `eax` comes from tape lane (`rax_11[1].d` path).

Recovered predicate families and formulas:

| Predicate family (observed) | `slot+0x58` formula | `slot+0x60` formula | Notes |
|---|---|---|---|
| Final compose gate: `cmp byte [slot+0x7a],2` (`0x1402f7527`) | uses staged `[rsp+0xb8]` | uses staged `rbp` | If non-compose and old `+0x58` exists, old `{+0x58,+0x60}` is released first (`0x1402f7536` -> `0x1402f754a`). |
| Copy families via `sub_1423a0360` (`0x1402f6ab1`, `0x1402f6d62`, `0x1402f71aa`, `0x1402f7430`, `0x1402f92bb`, `0x1402f9395`) | `[rsp+0xb8] = [rsp+0x200]` | `rbp = [rsp+0x208]` | Main dynamic copy profile. |
| Constant-tag branch (`0x1402f6e33` arm) | `[rsp+0xb8] = 0xD` (`0x1402f6ea7`) | `rbp = rcx` (`0x1402f6e78`) | Mixed constant + dynamic payload pointer/value. |
| Constant-tag branch (`0x1402f700a` arm) | `[rsp+0xb8] = 5` (`0x1402f7046`) | `rbp = rax` (`0x1402f700a`) | Token-style dynamic payload. |
| Constant-tag branch (`0x1402f724f` arm) | `[rsp+0xb8] = 5` (`0x1402f728b`) | `rbp = rax` (`0x1402f724f`) | Sister token branch. |
| Constant-tag branch (`0x1402f945b` arm) | `[rsp+0xb8] = 7` (`0x1402f948a`) | `rbp = rax` (`0x1402f945b`) | Catalog-style payload branch. |

### B) `sub_1404f3a90` dynamic formulas

Primary guarded sink:

- `cmp byte [slot+0x7a],2` at `0x1404f434c`
- commit `slot+0x60 <- xmm2` at `0x1404f437c` (plus neighboring lanes).

Recovered dynamic families:

| Predicate family (observed) | Dynamic formula written | Notes |
|---|---|---|
| Fast compose image path (`[slot+0x7a]==2`) | `xmm2 <- [rsp+0x190]`, then `slot+0x60 <- xmm2` | Copy-through staged image. |
| Mutate arm (`test bl,bl`, then `dec r15` at `0x1404f4399`) | `r15 := r15 - 1`, stored to `[rsp+0xe0]` | Explicit decrement dynamic path. |
| Non-compose rewrite/release (`0x1404f460f` + `0x1404f4635`, and siblings) | release old payload with `j_sub_1423512f0`, then commit staged `[rsp+0x60..0x90]` at `0x1404f4be0` / `0x1404f4dbe` | Dynamic overwrite after release. |

### C) `sub_14074aa00` dynamic formulas

Primary guarded sink:

- `cmp byte [slot+0x7a],2` at `0x14074ca2a`
- `slot+0x58 <- xmm0` at `0x14074ca8e`.

Recovered dynamic families:

| Predicate family (observed) | Dynamic formula written | Notes |
|---|---|---|
| Transform vector family | `xmm0 <- [rsp+0x130]` from `sub_1423a1b30(&rsp+0x548)`, then `[rsp+0x2c0] <- xmm0`, then `slot+0x58 <- [rsp+0x2c0]` | Main transformed dynamic overwrite. |
| Non-compose old-payload-present | if old `slot+0x58 != 0`, release old `{+0x58,+0x60}` via `j_sub_1423512f0` (`0x14074ca32`..`0x14074ca57`) before overwrite | Same release pattern as other writers. |
| Mixed scalar/vector assembly side path | low dword + selected upper bytes (`var_a18.d = var_ba8`, high byte from `var_bee...`) | Confirms dynamic composed variants exist beyond pure vector copy. |

### D) Replication rule of thumb (current)

1. Select writer family (`2f5840`, `4f3a90`, `74aa00`).
2. Evaluate local branch guard(s), especially compose mode (`+0x7a==2`) and branch-local tests.
3. Pick value expression:
   - copy from builder/tape (`[rsp+0x208]` family),
   - constants (`5/7/13`) plus dynamic payload pointer,
   - decrement (`x := x-1`),
   - transform output (`sub_1423a1b30` vector).
4. Apply release-before-overwrite when old payload guard is true.

---

## 12) Endpoint packets vs bridge rewrites (current map)

Goal: answer "which endpoints write what for which packet families" and "which bridge-like paths change those values to what".

### A) Endpoint-create side (`sub_1402f5840` dominant)

| Packet family signature (from branch payload text / shape) | Writer path | Written TTL-like value (`slot+0x58`) | Companion lane (`slot+0x60`) |
|---|---|---|---|
| `"Search result"` payload arm (`0x1402f6e55`+) | `sub_1402f5840` | `13` (`0xD`) via `0x1402f6ea7` | dynamic pointer/value (`rbp=rcx` at `0x1402f6e78`) |
| `"Token"` payload arm A (`0x1402f6ffb`+) | `sub_1402f5840` | `5` via `0x1402f7046` | dynamic pointer/value (`rbp=rax` at `0x1402f700a`) |
| `"Token"` payload arm B (`0x1402f7240`+) | `sub_1402f5840` | `5` via `0x1402f728b` | dynamic pointer/value (`rbp=rax` at `0x1402f724f`) |
| `"Catalog"` payload arm (`0x1402f9449`+) | `sub_1402f5840` | `7` via `0x1402f948a` | dynamic pointer/value (`rbp=rax` at `0x1402f945b`) |
| Generic/builder packet families (`sub_1423a0360` outputs) | `sub_1402f5840` | dynamic copy (`[rsp+0xb8]=[rsp+0x200]`) | dynamic copy (`rbp=[rsp+0x208]`, tape/builder-fed) |

Notes:

- Final endpoint sink remains `0x1402f7581`/`0x1402f7585`.
- So endpoint families are mixed: some fixed tags (`5/7/13`) and some fully dynamic builder/tape values.

### B) Bridge/rewrite side (value mutation/rewrite)

| Bridge-like path | Rewrite trigger shape | New TTL-like value form |
|---|---|---|
| `sub_14074aa00` transform commit (`0x14074ca2a` -> `0x14074ca8e`) | branch-local transform + optional non-compose release of old payload | overwritten from transformed vector (`slot+0x58 <- sub_1423a1b30(...)` output) |
| `sub_1404f3a90` mutate arm (`0x1404f4399` plus later commit) | branch-local mutate before vector image commit | decrement-by-1 dynamic value (`x := x-1`) |
| `sub_1404f3a90` non-compose rewrite arms (`0x1404f460f`/`0x1404f4be0`/`0x1404f4dbe`) | release old payload then commit staged image | overwrite with staged dynamic bundle |
| `sub_14044eae0` relay decrement arm (`0x14044fae1`, previously traced) | relay path B | decrement-by-1 on `slot[1].q` family |

### C) Practical replication split

1. **Endpoint emitters (`2f5840`)**: choose packet family, then set baseline TTL-like value:
   - fixed tag family: `{5,7,13}`
   - otherwise dynamic builder/tape lane.
2. **Bridge/relay mutators (`74aa00`, `4f3a90`, `44eae0`)**: rewrite baseline by:
   - transform overwrite, or
   - decrement-by-1, or
   - staged-copy overwrite.

This is the current best static map for endpoint-vs-bridge value behavior.

---

## 13) Strict lane status checkpoint

To avoid proxy drift, current lane interpretation is now split:

- **Payload lane (proven):**
  - `sub_1423a0360` output consumed by `sub_1402f5840` as:
    - `slot+0x58 <- [rsp+0x200]` (length-like)
    - `slot+0x60 <- [rsp+0x208]` (pointer-like)
- **Hop-TTL lane (still unresolved):**
  - strongest decrement evidence remains relay path in `sub_14044eae0` (`0x14044fae1` branch family).
  - cross-writer equivalence to scheduler profiles is not fully closed.

Execution constraint from this point:

- Any per-pair numeric sets derived from subject/payload lanes are tagged payload evidence only.
- Hop-TTL pair outputs remain unresolved until lane identity and write path mapping are proven.
