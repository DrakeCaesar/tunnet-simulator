# Binary Ninja MCP Workflow and Exact Replication Guide

This is the canonical process for recovering Tunnet packet behavior from `tunnet.exe.bndb` and reproducing it in code.

---

## 1) Hard MCP rule (critical)

Use **exactly one Binary Ninja MCP request at a time**.

- Never batch/parallelize Binary Ninja MCP calls.
- Wait for each response before issuing the next call.
- Multi-request patterns frequently cause:
  - `Connection closed`
  - `Not connected`

If disconnected, see recovery steps below.

---

## 2) Preconditions

- Binary Ninja running
- `tunnet.exe.bndb` loaded and focused
- MCP server `user-binary_ninja_mcp` available

---

## 3) Tooling used

- `list_binaries`
- `list_imports`
- `get_xrefs_to`
- `decompile_function`
- `get_il`
- `list_strings_filter`
- `get_data_decl`

---

## 4) Proven call chain (network + scheduler)

### Socket wrappers (ground truth send path)

- `sub_142345c30`, `sub_142346810` -> `send`
- `sub_142367ae0` -> `sendto`
- `sub_142345a90`, `sub_142345c90`, `sub_14235a330` -> `WSASend`

### Upstream scheduler path

- `sub_1402f5840` (driver / endpoint processing loop)
- `sub_1402f9a40` (packet generation and tick/address gates)

### Tick source

Inside `sub_1402f5840`:

- `*arg11 = zx.d((*arg11).w + 1)`
- same `*arg11` passed to `sub_1402f9a40(..., arg4)`

So `arg4` in `sub_1402f9a40` is the scheduling tick/counter.

---

## 5) Confirmed behavior (binary-backed)

### A) Deterministic tick gating (not random min/max interval)

`sub_1402f9a40` uses bit/shift gates like:

- `(arg4 & 1)`
- `(arg4 & 3)`
- `(arg4 & 7)`
- `((arg4 >> 1) & 3)`
- larger windows (`>>7`, `>>9`) in some branches

### B) Address tuple driven branching

Packet profile choice depends on tuple components read from `arg3`:

- `a = arg3[0]`
- `b = arg3[1]`
- `c = arg3[2]`
- `d = arg3[3]`

### C) Wildcard matcher semantics

`sub_1406b6550` confirms matching with per-octet wildcard `0`:

- rule octet `0` => wildcard
- otherwise exact compare against corresponding `arg2` octet

### D) Random selection exists in game logic

`sub_140673b40` / `sub_140673740` perform uniform sampling over candidate arrays using internal RNG state (`sub_1406734a0` feeds entropy/state refresh).

This means destination/message candidate selection is not a fixed hash; game uses RNG-backed sampling.

### E) Same-tick receive/send interaction

In endpoint processing within `sub_1402f5840`, packet slot/state fields are rewritten in a single pass. Based on order and slot rewrites:

- normal scheduled send is not emitted as a second packet when receive/bounce path claims the slot
- behavior is single-slot resolution for that tick
- practical effect: receive/bounce path can override regular scheduled output that tick

(Treat this as confirmed ordering model; exact branch-by-branch priority should still be validated per endpoint class while finalizing parity.)

### F) Confirmed `0x1c4` phase advancement points

Within `sub_1402f5840`, the following state transitions are directly visible:

- `0x1c4: 5 -> 6` after the status-family send path (same branch that enqueues event `0x0f`)
- `0x1c4: 6 -> 7` in the follow-up branch when normalized route tuple has `c < 2` (normalization treats octet `0` and `2` as `1` before compare)

These two transitions are now safe to model as binary-backed behavior.

### G) Confirmed read semantics for `0x1c5` (mainframe phase index)

In `sub_1402f9a40`, the decompiler shows `uint64_t rax_37 = zx.q(*(arg2 + 0x1c5))` immediately before a `switch (rax_37)` with cases `0` through `5` for the `a == 4` / `(1,1,1)` tuple path. Each case sets the corresponding `0x1020104`-style header table and optional side buffers (for example case `2` uses `sub_14067a670` with `&data_1424246e0[0x30]`).

So for that branch, **`0x1c5` is the mainframe sub-phase index** (not a tick gate). The TypeScript model field `phaseB` in `src/recovered-endpoint-scheduler.ts` is intended to mirror this byte/word at `+0x1c5` for parity with the `a === 4` profile.

**Writes to `0x1c5`:** The scheduler pair **`sub_1402f5840` / `sub_1402f9a40`** only **read** `+0x1c5` (`movzx`; confirmed in saved disassembly). Advancement is **not** there.

**Primary writer (found): `sub_1401f5660`** — large Bevy-style system; `r14` is the same endpoint-style blob pointer (`arg4[2]`). It implements an explicit **state machine** on `*(r14 + 0x1c5)`:

- `switch (*(r14 + 0x1c5))` with cases **0–9** advancing **0→1→2→3→4→5→6→7→8→9→0xa** (each case writes the next value and `continue`s).
- Additional writes set **`0xb`** (grep HLIL for `*(r14 + 0x1c5) = 0xb`) and **`6`** when `zx.q(*(r14 + 0x1c5)) - 6 u<= 4` (i.e. current value already in **6..10**), used together with **`'P'` / `'N'`** byte-array edits on `r14[5]` / `r14[6]` (route-string style data).

So the **same byte** at `+0x1c5` spans at least **0..0xb** across the binary, not only **0..5** as exercised by `sub_1402f9a40`’s mainframe header switch.

**Callers of `sub_1401f5660`** (MCP `get_xrefs_to` on `0x1401f5660`): `sub_1401e1b20` @ `0x1401e217c`, `sub_14058d390` @ `0x14058d65f`, `sub_1405ca030` @ `0x1405ca6a6` (likely registration / schedule glue — name in BN UI).

**Callers of `sub_140165cb0`** (`get_xrefs_to` **`0x140165cb0`**): `sub_14015c6f0` @ `0x14015cb8a`, `sub_14058ad70` @ `0x14058af99`, `sub_1405b6360` @ `0x1405b680c`.

**Secondary writer: `sub_140165cb0`** (contains VA **`0x140166850`**). Large Bevy-style system (zone / map graph: strings like **`bunker`**, **`surface`**, **`underwater`**, **`cavesnd/.ogg`**, **`snd/new_zone.ogg`**, **`sub_140673740`** RNG, **`sub_1405211a0`** events). HLIL includes **`if (*(rcx_1 + 0x1c5) != 0xb)`** then **`*(rcx_1 + 0x1c4) = 0xe`** / event **`0x2c`**, and later **`*(rcx_1 + 0x1c5) = 0xb`** at the instruction previously seen as raw **`mov byte [reg+0x1c5], 0x0b`**. Same blob also gets **`0x1c4`** updates (**`0xd`**, **`0xe`**, **`0x13`**, tests for **`0xc`**) in this function — useful for extending **`applyRecoveredStateTransitions`**.

**MCP note:** `function_at` for **`0x140166850`** returns **`sub_140165cb0`** in the bridge payload, but the MCP client schema may **error** (expects a string; server returns structured JSON). Use **`decompile_function("sub_140165cb0")`** directly.

**Discovery method:** scan the mapped `.text` of `tunnet.exe` for **`C6 xx C5 01 00 00`** (`mov byte [reg+disp32], imm8` with disp **0x1c5**), then map hit VA → **`function_at`** / BN **Navigate**.

**Still spot-checked negative** (no `+0x1c5` store in decompile): `sub_140bd6f00`, `sub_140516d40`, `sub_140643f00`, `sub_1400a6cf0`, `sub_140326b90`, `sub_1407759c0`, `sub_14079a770`, `sub_140290120`, `sub_1403ceff0`, `sub_1403a08e0`, `sub_1401cf3e0`, `sub_1404eb580`, `sub_1403b4c60`. Optional MCP `get_xrefs_to_type` may **HTTP timeout**; retry when BN is idle.

### H) Address / endpoint slot resolution (`sub_1400af880`)

`sub_1400af880` is called from the big driver with `(arg4, arg5)` as the **packed address tuple** (see `sub_1402f5840` calling `sub_142244e00` then this). It:

- Validates the tuple against a **bitset** on `arg2` (`*(arg2+0x30)` / `*(arg2+0x38)`).
- Uses `arg3+0x120` as a table of **per-address records**; index path involves `*(arg3+0x128)` as an upper bound and `*(arg3+0xd0)` as the **per-entity `0x60`-stride array** keyed by the resolved slot index, then `*(slot+0x38)` component tables for the active generation counter `*(arg2+0x50)`.

This function is the right anchor for recovering **“which NetNode row matches this address”** (a prerequisite for exact destination lists, before RNG picks among neighbors).

**Code xrefs to `sub_1400af880`** (MCP `get_xrefs_to` on `0x1400af880`):

| Caller | Call site(s) |
|--------|----------------|
| `sub_1401cf3e0` | `0x1401d0fce` |
| `sub_1402f5840` | `0x1402f764b`, `0x1402f7da3`, `0x1402f7de8`, `0x1402f8bce` |
| `sub_1403a08e0` | `0x1403a10dd` |
| `sub_1403b4c60` | `0x1403b55bf` |
| `sub_1404eb580` | `0x1404ec9df`, `0x1404ed536` |

`sub_1403a08e0` decompiles to a **relay / “tape”** style path (`sub_140300e30`, literal `"tape"`, `sub_140642cd0`, `sub_1400b3fd0`) that still uses the same tuple → `sub_142244e00` → `sub_141fcee80` pattern after `sub_1400af880`. **`sub_1401cf3e0`** and **`sub_1404eb580`** full decompiles were scanned for `+0x1c4` / `+0x1c5` HLIL forms; **no hits** for `0x1c5` (writer is **`sub_1401f5660`**, not these).

**`sub_1403b4c60`** (call at `0x1403b55bf`): large Bevy-style system with **world queries**, **`sub_140bd6610`**, **`sub_1400aeb60`**, **`sub_1400ae830`**, **`sub_1400af880`** (second address batch), **`sub_142244e00`** / **`sub_141fcee80`**, strings **`electricsnd/plug.ogg`** / **`snd/plug.ogg`**, and **`sub_140300e30`**. Same **`0x60`** NetNode row walk (`*(r13+0xd0)`, `rcx*0x60`, `+0x38` / `+0x40` generation checks) as the scheduler. Full decompile scan: **no** `+0x1c4` / `+0x1c5` HLIL.

### I) Rust type-string anchors (MCP `list_strings_filter`)

Filtered hits include the ECS system name **`tunnet::net::endpoint::update`** inside the usual long Rust metadata blob (example chunk address **`0x142441181`**). Related: **`tunnet::net::endpoint::EndpointPlugin`** near **`0x142461581`**. Use Binary Ninja’s own string/xref UI on these substrings first; **`get_xrefs_to` on the raw chunk address** often returns nothing in this MCP bridge, so treat these as **navigation hints**, not automatic xref sources.

---

## 6) What is still required for full exact parity

To replicate game behavior exactly, you must finish all three:

1. Exact public-address -> internal tuple encoding map
2. Exact candidate destination set construction per endpoint/state branch
3. Remaining phase/state progression (`0x1c4`, `0x1c5`, and related fields) over time

Until these are complete, outputs are high-fidelity approximations, not guaranteed exact parity.

Notes:

- `0x1c4` is now partially recovered (`5->6->7` known).
- `0x1c5` **read** role for the mainframe branch is confirmed (phase index `0..5` in `sub_1402f9a40`); **writes** are driven by **`sub_1401f5660`** (state machine through at least **`0xa`**, plus **`0xb`**), not the scheduler.

### MCP timeouts (`read timed out` / `Not connected`)

These are almost always **process or socket** issues on the BN side, not your repo:

1. **Binary Ninja must stay running** with `tunnet.exe.bndb` open; closing BN drops the bridge immediately (`Not connected`).
2. **First request after idle** can exceed a short HTTP timeout — retry `list_binaries` once; if it keeps timing out, restart the MCP bridge / BN plugin listener (whatever starts `localhost:9009`).
3. **Heavy views** (huge decompile on first open): wait until analysis quiesces, then retry a small call (`list_binaries`, then `function_at`).
4. Keep the **one-request-at-a-time** rule; parallel MCP calls still correlate with disconnects.

---

## 7) Repeatable MCP extraction recipe

### Step 1: Sanity check connection

1. `list_binaries`
2. verify active binary is `tunnet.exe.bndb`

### Step 2: Re-anchor send path

1. `list_imports`
2. locate `send`, `sendto`, `WSASend`
3. `get_xrefs_to(import_addr)`
4. `decompile_function(wrapper)`

### Step 3: Climb call graph

1. `get_xrefs_to(wrapper_addr)`
2. `decompile_function(caller)`
3. repeat until endpoint processing/tick branches are visible

### Step 4: Extract scheduler rules

From `sub_1402f9a40`, record:

- tuple guards (`a,b,c,d`)
- tick gates per branch
- packet profile/header assignment path
- side-condition calls (especially `sub_1406b6550`)

### Step 5: Extract randomness path

When branch selects among candidates, follow:

- `sub_140673b40`
- `sub_140673740`
- `sub_1406734a0`

Record exactly when sampling occurs and what candidate arrays are passed.

### Step 6: Validate lifecycle/ordering

In `sub_1402f5840`, trace slot/state field updates (`+0x7a` and related payload fields) to resolve:

- receive vs scheduled send precedence
- bounce vs normal send precedence
- drop/reset transitions

---

## 8) Recovery when MCP disconnects

If you see `Connection closed` / `Not connected`:

1. Stop issuing further calls.
2. Run single `list_binaries`.
3. If still disconnected, re-focus/reopen `tunnet.exe.bndb` in Binary Ninja.
4. Retry `list_binaries` until active view appears.
5. Resume from last function/address checkpoint.

---

## 9) Current repo artifacts

- `src/recovered-endpoint-scheduler.ts`
  - recovered scheduler model (WIP toward exact parity)
- `src/scheduler-comparison.ts`
  - recovered vs current-implementation comparison
- `src/export-message-sequence.ts`
  - exports tick-wise message sequence JSON

---

## 10) Practical guidance

- Follow dataflow, not symbol names (Rust binary has many generic wrappers).
- Keep a live notebook of:
  - function address
  - inferred role
  - extracted invariants
- Never trust one branch in isolation; always tie:
  - tuple guard
  - tick gate
  - state gate
  - candidate selection method
  - slot/state write-back
