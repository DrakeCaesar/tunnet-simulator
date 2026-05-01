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

In endpoint processing within `sub_1402f5840`, packet slot/state fields are rewritten across nested loops (**§E.1a**–**§E.1b**). Summary:

- **Merge tail (`0x1402f75bf`):** on the **`0x1402f965f`** inner-loop spine, HLIL places **`0x1402f5bfe` before** the **`label_1402f90e8` → `r8_13.b = 2` → `0x1402f75bf`** merge, so **`sub_1402f9a40` does not consume that fresh `= 2` on the same inner-loop spin**; the next **`0x1402f5bfe`** is a **later** evaluation (**often** `rdi_43` advance **inside** the same **`sub_1402f5840`**, or the next **`NetTock`**—see **§E.1a**).
- **Jump-table / infection (`0x1402f5bdb`):** **`*(rbx_30 + 0x7a) = 2`** is followed by the **`+0x98`** slot walk and **`rdi_43 = rbp_3`**; the **next** inner-loop iteration can hit **`0x1402f5bfe`** with **`==2`** and call **`sub_1402f9a40` in the same `sub_1402f5840` invocation`** (**§E.1a**, CFG).
- **Multi-slot endpoints:** extra packet records are **`+0x98`** apart (**§E.1a**); each has its own **`+0x7a`**.
- **`SendBack` / `PacketDrop` strings:** MCP xrefs are **serde / JSON / particle UI** classifiers (**§E.1b**), not proof of where **wrong-address wire bounce** lives.

**TypeScript hook:** `RecoveredSlotTickContext` + optional 4th argument to **`evaluateEndpointSend`** in **`src/recovered-endpoint-scheduler.ts`**. When **`receiveOrBounceClaimedSlot: true`**, the recovered model returns **`shouldSend: false`** with reason **`same-tick slot: receive/bounce claimed`** so export/compare can opt in once inbound simulation sets the flag. Call sites that omit the argument behave as before.

**MCP / BN check (`decompile_function sub_1402f5840`, stock `tunnet.exe.bndb`):**

- **`0x1402f5bfe`**: `if (*(rbx_3 + 0x7a) == 2)` immediately before **`sub_1402f9a40`** @ **`0x1402f5c26`** (full header/subject composer).
- **`0x1402f5cc1`**: `if (*(rbx_3 + 0x7a) != 2)` → packs from **`rax_11`** / **`sub_1404628b0`** / tape-style path **without** that **`sub_1402f9a40`** call — same slot, **non-compose** outbound.
- **`0x1402f75bf`**: `*(rdi_14 + 0x7a) = r8_13.b` on inbound merge into **`rdi_14`** (packet slot); **`r8_13.b = 2`** is prepared @ **`0x1402f90ed`** on the path into that merge.

So “game code” definitely splits **compose (`0x7a==2`) → `sub_1402f9a40`** vs **copy/other builder**. **§E.1a** documents **HLIL order** (**`0x1402f5bfe` before `0x1402f75bf`**), **`NetTock` cadence**, the **`0x1402f5bdb` same-invocation compose** spine, and **§E.1b** debunks **`SendBack`** string xrefs as **serde/particles**.

### E.1) Reply / “reply-chain” subject and slot flag **`+0x7a`**

In **`sub_1402f5840`**, the outbound builder **`sub_1402f9a40`** is invoked only when **`*(packet_slot + 0x7a) == 2`** (HLIL @ `0x1402f5bfe` → call @ `0x1402f5c26`). Other values take the branch that copies from **`rax_11`** instead (same function, @ `0x1402f5cc1`).

After inbound handling, the receive path writes **`*(slot + 0x7a) = r8_13.b`** with **`r8_13.b = 2`** on the merge into that block (HLIL @ **`0x1402f75bf`**). **HLIL order** puts **`0x1402f5bfe` before** this merge on the **`0x1402f965f`** spine, so **`sub_1402f9a40` does not read that `= 2` on the same inner-loop iteration** as the merge write. A **later** **`0x1402f5bfe`** (often **same `sub_1402f5840`**, next **`rdi_43`**, if the slot pointer repeats and **`0x7a` is still `2`**—or after **PING/PONG** paths that may rewrite **`0x7a`** to **`1`** @ **`0x1402f78a5`**) decides the actual composer. **§E.1a** documents **`NetTock` cadence**; **§E.1a** “CFG” documents the **infection `0x1402f5bdb`** case where **same-invocation compose is explicit in HLIL**.

**Other `+0x7a` writers in the same function (HLIL anchors):**

| Value | Site | Notes |
|------:|------|--------|
| **2** | `0x1402f5bdb` | After **`sub_1400af880`** @ **`0x1402f8bce`** and the **`jump_table_1402f9a18`** dispatch @ **`0x1402f8c0d`**: writes **`*(rbx_30 + 0x7a) = 2`** when not already **`2`**. HLIL then runs the **`+0x98`** **`do while`** @ **`0x1402f5bef`**, sets **`rdi_43 = rbp_3`**, and **re-enters `while (true)` @ `0x1402f965f`** — so **`sub_1402f9a40` can run later in the *same* `sub_1402f5840`** on a **later `rdi_43`** pass if **`rbx_3` still points at that slot** (**§E.1a**). |
| **1** | `0x1402f78a5` | **PING → PONG** staging: fills the slot buffer, then sets **`0x7a = 1`** when the slot was not already **`2`** (see `if (*(var_3a8_1 + 0x7a) != 2)` immediately before). |
| **0** | `0x1402f85f3` | **“LAW ENFORCEMENT OPERATION”** / spam-template branch: clears **`0x7a`** after populating the slot for that outbound. |
| **propagated** | `0x1402f65ac` | **`*(slot + 0x7a) = *(slot + 0x3a)`** (HLIL: **`rbx_5 = *(rbx_3 + 0x3a)`** @ **`0x1402f5f3f`**, then stored @ **`0x1402f65ac`**). There is a guard **`if (rbx_5 != 2)`** @ **`0x1402f5f46`** earlier on the same slot pointer. |

So **`0x7a`** is both a **mode enum** (at least **0 / 1 / 2** observed) and, in one branch, a **copy of another slot byte at `+0x3a`**. **`+0x3a`** is the next place to xref when modeling reply / infection state without guessing.

### E.1a) NetTock cadence, `0x98` slot list, deferred compose, and “next tick” behavior

This subsection summarizes **`get_xrefs_to(0x1402f5840)`** + **`decompile_function sub_14026cc80`** + **`get_il sub_1402f5840` (HLIL)** so the **mechanism** for future emissions is explicit.

**Who runs `sub_1402f5840`, and how often**

- **Direct code xrefs** (MCP): **`sub_14026cc80`** @ **`0x14026d2d2`**, **`sub_140276b60`** @ **`0x140276dc0`**, **`sub_14058d950`** @ **`0x14058dbb0`**, **`sub_1405b8160`** @ **`0x1405b87bc`** — all Bevy-style system glue (panic blobs in the same neighborhood name **`Events<NetTockEvent>`**, **`NetNode`**, etc.).
- **`sub_14026cc80`** (representative): loads **`rbp = *(arg2 + 0x270)`**, then **`*(arg2 + 0x270) += 1`** (world / schedule counter), eventually calls **`sub_1402f5840`**, then stores **`*(arg1 + 0x598) = rbp`**. So **`sub_1402f5840` is one net pass per scheduled system invocation**, not a tight inner callback loop by itself.

**What the big driver walks (HLIL skeleton)**

- **Outer step:** **`while (r12_1 != rax_8)`** @ **`0x1402f94fc`** — advances the **entity / endpoint queue** (`r12_1` steps; **`continue`** when **`r13_1 == 0`** @ **`0x1402f94ee`** / **`0x1402f95f2`**).
- **Inner send index:** **`while (true)`** @ **`0x1402f965f`** with **`rdi_43`** — each iteration reaches the outbound gate **`if (*(rbx_3 + 0x7a) == 2)`** @ **`0x1402f5bfe`** early (**`rbx_3`** is the **`0x98`-strided packet blob** for the active row: **`var_e8_1 = rcx_9 * 0x98 + rbx_3`** @ **`0x1402f5bbf`**, **`result_2 = var_120_1 + rdi_43 * 5`** @ **`0x1402f5b8d`**).
- **Secondary slots on the same endpoint:** **`rbx_30 = var_3a8_1`**, **`rbx_3 = rbx_30 + 0x98`**, **`do while (rbx_3 != var_e8_1)`** @ **`0x1402f5bef`–`0x1402f5be0`** — walks **more packet-slot structs** at **`+0x98`** strides (same function, infection / template tail). So one **NetNode** can own **multiple** **`0x98`** packet records; each has its **own** **`+0x7a`**.

**How `+0x7a` drives the *next* emission**

- **`+0x7a` lives in the slot struct in RAM** until another writer overwrites it (**§E.1** table).
- The **only** full composer is **`sub_1402f9a40`**, gated by **`*(slot + 0x7a) == 2`** @ **`0x1402f5bfe`**. Whatever **`+0x7a`** is **when that `if` runs** picks **compose vs copy / tape** for that evaluation.

**HLIL ordering on the `0x1402f965f` spine (merge path `0x1402f75bf`)**

- **`0x1402f5bfe`** (**read `+0x7a` → maybe `sub_1402f9a40`**) appears **before** the merge tail **`0x1402f75bf`** (**`*(rdi_14 + 0x7a) = r8_13.b`**, with **`r8_13.b = 2`** from **`0x1402f90ed`** on the **`label_1402f90e8`** path).
- So **on the same `rdi_43` inner-loop iteration**, **`sub_1402f9a40` cannot be triggered by the `= 2` just written at `0x1402f75bf`** — the **next** **`0x1402f5bfe`** is at least the **next time** control reaches that site (**often** after **`rdi_43`** advances to **`rbp_3`** @ **`0x1402f5b6a`**, still inside **`sub_1402f5840`**, if the same **`rbx_3` / `var_3a8_1`** is reused and **`0x7a` stayed `2`**; or a **later `NetTock`** if the slot is rewritten first, e.g. **`0x1402f78a5`** (**`0x7a = 1`**) on PING→PONG staging).

**CFG: infection / jump-table path (`0x1402f5bdb`) — same-invocation `sub_1402f9a40` is possible**

- From **`label_1402f88e7`** through **`sub_1400af880`** @ **`0x1402f8bce`**, HLIL hits **`*(rbx_30 + 0x7a) = 2`** @ **`0x1402f5bdb`** (same VA as the table row in **§E.1**), then executes the large template / **`arg12`** writer, then **`rbx_30 = var_3a8_1`**, **`rbx_3 = rbx_30 + 0x98`**, **`do while (rbx_3 != var_e8_1)`** @ **`0x1402f5bef`**, then **`if (rbp_3 == r13_1) break`**, else **`rdi_43 = rbp_3`** @ **`0x1402f5b6a`** and **falls through to `while (true)` @ `0x1402f965f`** (**`get_il sub_1402f5840`**, lines **`0x1402f8bce`–`0x1402f9700`** region).
- Therefore **`0x7a` is armed to `2` and then a *new* inner-loop iteration can reach `0x1402f5bfe` with `==2`** without leaving **`sub_1402f5840`** — **not** deferred to the next **`NetTock`** for that branch class.

**Wire-level “bounce wrong destination”**

- Still **not** located in **`sub_1402f5840`** by name. **`sub_14079a770`** @ **`0x1402f7cb1`** remains a **credit / strip** helper in the subject-line tail, not a proven reflect-to-sender routine (**§E.1a** legacy note). **§E.1b** explains why **`SendBack`** / **`PacketDrop`** **`.rdata`** hits are **misleading** for net parity.

### E.1b) `SendBack` / `PacketDrop` **`.rdata`** hits (MCP `get_xrefs_to`) — serde & particles, not the relay

**`get_xrefs_to(0x142473c18)`** (“`variant identifierSendBackPacketDropPacket`”):

| Function | Site | Role |
|----------|------|------|
| **`sub_1404d9170`** | **`0x1404d9173`** | **`Display` / `Debug` tailcall** into **`sub_1423afb20`** with that static string — **Rust formatting**, not gameplay dispatch. |

**`get_xrefs_to(0x142473c88)`** (“`DropInboundDropOutboundSendBackOutbound`” …):

| Function | Site | Role |
|----------|------|------|
| **`sub_1403698e0`** | **`0x14036999a`** | **`serde_json`** enum serialization: **`sub_14032b9a0`** compares against **`"DropInbound…"` / `"SendBackOutbound"` / `"DropOutbound…"`** byte slices when writing JSON. |
| **`sub_14054cbc0`** | **`0x14054cbed`** | Same pattern: **JSON variant tagging** for a small discriminant in **`arg1`**. |
| **`sub_14047e340`** | **`0x14047e4fe`** etc. | **Parser**: walks bytes in **`arg2`**, compares windows to **`"SendBackOutbound"`** / **`"DropOutbound…"`** / **`"DropInbound…"`**, sets **`arg1[1]`** to **`0 / 1 / 2`**. Callers include **`sub_14054c8f0`** @ **`0x14054c990`**, **`0x14054c9ae`** — **particle / UI JSON**, not **`sub_1402f5840`**. |

**Conclusion:** those strings label **serde + particle packet-kind JSON**, **not** the in-world **wrong-address bounce** implementation. Finding **real bounce** still means tracing **relay / address filter** code (e.g. **`sub_14044eae0`**, **`sub_1400af880`** families) **without** relying on these xrefs.

### E.2) Five-byte `result_2` row (pointer into stride-5 table)

In **`sub_1402f5840`**, the pointer passed as **`arg3`** to **`sub_1402f9a40`** is:

- **`result_2 = var_120_1 + rdi_43 * 5`** @ **`0x1402f5b8d`**, with **`rdi_43`** the per-endpoint send index in the inner loop.

**`var_120_1`** is loaded from a **`0x58`-byte strided table** (same family as other Bevy component rows in this function):

- **`var_120_1 = *(*(r8_52 + 8) + *(rcx_297 + result + 8) * 0x58 + 0x40)`** @ **`0x1402f961a`**.

So the **base of the 5-byte rows** is a **pointer at field `+0x40`** of the row selected by **`*(rcx_297 + result + 8)`** (entity/context index into **`rcx_297`**). Populating that **`+0x40`** field is the right anchor for replacing **`encodeEndpointAddressForStrategy`** heuristics with binary-accurate tuples (spawn / map / asset systems, not **`sub_142244e00`**’s **`var_308`** fill).

**Mechanical writer of `0x58` rows:** **`sub_140516d40`** (`0x140516d40`) grows the same table shape: for index **`rdx`** it stores **`arg2[0..3]`** into **`+0x00..+0x30`**, **`arg2[4]`** into **`+0x40`**, and a length/cursor field into **`+0x50`**. **`get_xrefs_to(0x140516d40)`** (MCP) lists **twelve** code sites — **`§E.6`** table (**`sub_1402f5840` ×2**, **`sub_14044eae0` ×3**, **`sub_1403a7a00`**, **`sub_1404f0910`**, **`sub_1404f3a90` ×4**, **`sub_14074aa00`**). So **`+0x40`** is filled whenever those paths pass the packed **`arg2`** blob—often alongside **`sub_140516d40(&…, &var_228)`**-style locals built from a live packet slot.

### E.3) Staging halfword **`+0x3a` / `+0x3b`** (`sub_14044eae0`)

The large relay **`sub_14044eae0`** (`0x14044eae0`, callers **`sub_140444950`**, **`sub_140584790`**, **`sub_1405e5170`**) walks the same **`0x60`** NetNode rows and **`0x58`** side tables as **`sub_1402f5840`**. On several paths it **skips work when `*(packet_slot + 0x3a) == 2`** (HLIL **`continue`** right after the test, e.g. @ **`0x14044efa4`**, **`0x14044f179`**, **`0x14044f39e`**).

HLIL often loads **`int16_t` at `slot + 0x3a`** (e.g. **`0x14044f0a3`**, **`0x14044f6c3`**) into locals that become part of the **`var_228`** bundle passed to **`sub_140516d40`**. **`+0x3b`** appears as a separate byte in the same flows (**`*(slot + 0x3b)`** @ **`0x14044fa14`** and packed into **`var_1ee:1`** @ **`0x14044fd60`**).

Concrete staging literals in the same function:

- **PING** inject: **`var_1ee = 0`** @ **`0x14044f8fc`** (with **`var_1ec_3 = 0`**) before writing the outbound slice at **`slot + 8`**.
- **PONG** inject: **`var_1ee = 1`** @ **`0x1404500e1`** before the same style of slot write.

Together with **`§E.1`**, this supports treating **low `+0x3a`** values **0 / 1 / 2** as the same **staging / compose** family as **`+0x7a`**, with **`+0x7a := +0x3a`** on the **`0x1402f65ac`** path.

### E.3a) **`sub_14044eae0` → `sub_140516d40`:** three tails + where **`slot[1].q`** decrements

Inside the relay **`while`**, **`sx.q(jump_table_1404504bc[zx.q(r15_2[result_1 * 4 + 1].b)]) + &jump_table_1404504bc`** dispatches **PING/PONG–style** handlers (**HLIL @ `0x14044ef85`**, outer **`0x14044ef1c`**). Exactly **three** code sites call **`sub_140516d40(&var_b8, &var_228)`**:

| **Call site** | **HLIL label** | **`var_228` / `var_218` / `var_1ee`** | **`rbp_5[1].q` / `r15_5[1].q` decrement?** |
|---|---|---|---|
| **`0x14044f13a`** | **`label_14044ef8a`** | **`var_228 = *r15_5`**, **`var_218 = r15_5[1].q`**, **`var_1ee = *(int16_t*)(r15_5+0x3a)`** after **`sub_1406b6550`** address / PING–PONG checks (**`0x14044efd7`–`0x14044f11b`**). | **No** |
| **`0x14044f758`** | **`label_14044f5a2`** | **`var_228 = *rbp_9`**, **`var_218 = rbp_9[1].q`**, **`var_1ee = *(int16_t*)(rbp_9+0x3a)`** (**`0x14044f707`–`0x14044f739`**). | **No** |
| **`0x14044fd7f`** | **`label_14044f160`** | **Split on `if (… \|\| *(rbp_5+0x3b) != 0)` @ `0x14044fa24`:** **(A)** fall into **`0x14044fc99`** → **`var_218 = var_240_4`** (still **`rbp_5[1].q`**, captured **before** later byte tests), **`var_1ee.b ← *(rbp_5+0x3a)`**, **`var_1ee:1.b ← *(rbp_5+0x3b)`** (**`0x14044fd59`–`0x14044fd60`**). **(B)** else **`0x14044fa2e`**: **`rdi_27 = rbp_5[1].q`**, **`if (*(rbp_5+0x3a) != 0) rdi_27 -= 1`** (**`0x14044fa9f`–`0x14044fae1`**), rebuild **`var_228` / `var_218` / `var_210` / `var_208`**, then **`var_1ee.b = *(rbp_5+0x3a)`**, **`var_1ee:1.b = 0`** (**`0x14044fb9f`–`0x14044fba6`**). | **Only (B)** when **`*(rbp_5+0x3a) != 0`** |

On **(B)** after **`0x14044fd7f`**, HLIL reaches **`sub_14037bf80`** and **`*(slot+0x7a) != 2`** stores that **copy `var_228`… back into `&slot[8]`** (**`rsi_15` @ `0x14044fc44`**, **`rsi_23` @ `0x140450341`**), so the **decremented second `qword`** is not **only** a **`0x58`** queue artifact—it can **round-trip into the live packet slot**.

**Simulator note:** do **not** model relay as a single **`var_228` packer**: **(A)** preserves **`slot[1].q`** and keeps **`+0x3b`** in **`var_1ee:1`**, while **(B)** may **clear `var_1ee:1`** and **subtract one** from **`slot[1].q`**. The **byte predicate** ahead of **`0x14044fa24`** mixes **`rbp_5[1].q`** with **`*(rbp_5+0x3a)`** (**`0x14044f9ec`–`0x14044fa0f`**) — treat as **relay classifier**, not the **tape `rax_11[1].d`** dword (**§J.4.1**).

### E.4) Who calls **`sub_14044eae0`** (Rust names from panic metadata)

Three direct callers are visible in BN:

| Function | Call site | Role |
|----------|-----------|------|
| **`sub_140444950`** | **`0x140444b73`** | Bevy system glue: resolves world resources with **`sub_14225f810`**, reads **`*(table + 0x10)`** / **`*(table + 0x40)`** pairs (same shape as the **`0x58`** row metadata elsewhere), then **`sub_14044eae0`**. On failure, panic blobs name **`Events<NetTockEvent>`** with **`Fragile`** sign, and **`tunnet::net::relay::Relay`** alongside **`tunnet::story::Story`**, **`setup_doors`**, **`QueryState<(Entity, &NetNode, …)`**. |
| **`sub_1405e5170`** | **`0x1405e53a6`** | Same control flow as **`sub_140444950`** (increment **`*(world + 0x270)`**, same resource lookups, same **`sub_14044eae0`** argument layout); different static descriptor pointer in the panic path. |
| **`sub_140584790`** | **`0x14058489a`** | Thin wrapper: packs stack locals and **`return sub_14044eae0(...)`** (no extra logic in the decompile snippet). |

So the **relay / PING-PONG / `0x3a` gate** logic is not an orphan—it sits under **`tunnet::net::relay::Relay`**-flavored schedules and the same **`NetTockEvent`** family as the main tick driver.

### E.5) Graph routing **`sub_1403a7a00`** (propagating **`+0x40`**)

**`sub_1403a7a00`** is a large **NetNode walk + 3D distance / path** system (**`sub_1400b0930`**, **`sub_14037cea0`**, **`sub_140764ba0`** over a **`0x58`-strided open-addressed table** whose SIMD probe base is **`&data_142429eb0`** (**`var_160_1`**, HLIL **`neg.q(…) * 0x58`** steps @ **`0x1403a8a05`** / **`0x1403a80b5`**). Do **not** confuse this with **`sub_14037e9d0 → sub_1406425d0`** (**`0xc`** inline cells — **§E.12**). It:

- Loads **`rbp_25 = *(rdx_27 + rbp_24 + 0x40)`** @ **`0x1403a88e4`** — the **existing neighbor row’s `+0x40` pointer** (same field **`sub_1402f5840`** later dereferences for **`result_2`**).
- Matches candidate rows (**`r13_9`**) and calls **`sub_140516d40(&var_a0, &var_298)`** @ **`0x1403a8e7d`**, where **`var_298`** is filled from the **matched `0x58` slot** (headers, **`+0x3a`**, **`+0x3b`**, etc.).

So at least on this path, **`+0x40`** is not minted from thin air: it is **copied forward from table data already attached to other nodes / candidates** when the graph search commits a row.

### E.6) Remaining **`sub_140516d40`** callers (full xref list)

**`get_xrefs_to(0x140516d40)`** (MCP, code only) — **twelve** call sites; no data xrefs:

| **Function** | **Call site** |
|---|---|
| **`sub_1402f5840`** | **`0x1402f66ea`**, **`0x1402f6808`** |
| **`sub_1403a7a00`** | **`0x1403a8e7d`** |
| **`sub_14044eae0`** | **`0x14044f13a`**, **`0x14044f758`**, **`0x14044fd7f`** |
| **`sub_1404f0910`** | **`0x1404f0b1b`** |
| **`sub_1404f3a90`** | **`0x1404f4513`**, **`0x1404f48ef`**, **`0x1404f4a13`**, **`0x1404f4d3d`** |
| **`sub_14074aa00`** | **`0x14074b501`** |

Narrative notes below group paths by subsystem (same sites as the table).

**`sub_1404f0910`** (`0x1404f0910`, call @ **`0x1404f0b1b`**)

- Same **`0x60` / `0x58`** walk as the scheduler.
- **`rbp_1 = *(*(node + 8) + index * 0x58 + 0x40)`** @ **`0x1404f0a59`** — reuses the **existing** five-byte table pointer.
- **`r14 = *(netnode + 0x58)`** drives a loop; each iteration builds a **“Dummy packet”** string (**`strncpy` @ `0x1404f0aa9`**), a **static** header blob (**`"ffaeb6"`** @ **`0x1404f0ae3`**, small **`memcpy`**), then **`sub_140516d40(&var_78, &var_128)`**.
- Looks like **test / injector traffic** (same world shape as **`tunnet::net::tester::SendButton`** query chunks seen near other net systems). It **does not** show allocation of a brand-new **`+0x40`** target—only **appends `0x58` rows** using a **stack template**.

**`sub_1404f3a90`** (`0x1404f3a90`, multiple **`sub_140516d40`** sites e.g. **`0x1404f4513`**, **`0x1404f48ef`**, **`0x1404f4a13`**, **`0x1404f4d3d`**)

- Another **multi-endpoint** walker with **`*(slot + 0x3a) != 2`** gates and **`*(slot + 0x7a)`** handling like **`sub_1402f5840`** / **`sub_14044eae0`**.
- **`r8_1`**, **`rdi_5`**, **`rdx_6`** are loaded from **three** **`*(… * 0x58 + 0x40)`** slots @ **`0x1404f3e4b`**, **`0x1404f3e50`**, **`0x1404f3e5b`** — always **existing** table pointers.
- **`sub_14079fa10`** + manual stores **`0x1404f4b36`–`0x1404f4b81`** mirror **`sub_140516d40`’s** **`0x58`** write pattern (**`+0x40` ← `var_278`**, packed from the **per-connection block** at **`rcx_11`** inside a sibling’s heap buffer). This is a **connection commit / copy** path, not first-time worldgen.

**`sub_14074aa00`** (`0x14074aa00`, **`sub_140516d40`** @ **`0x14074b501`**)

- Very large Bevy-style system (many query parameters); touches **`0x1cf`** flags, **`sub_1400ae2a0`**, **`0x98`**-strided packet slots, **`*(slot + 0x7a)`**, and the usual **`0x60` / `0x58`** NetNode tables.
- **`sub_140516d40(&var_7c0, &var_7a8)`** feeds **`var_7a8`** from **`r15_5`** packet/relay state.
- **Side buffer** (HLIL **`var_b70_1`**, rows spaced by **`0x68`**) gets **`*(row + 0x40) = …`** @ **`0x14074b60f`** — a **packed 64-bit** built from SIMD lanes (decompiler artifact around pointer-sized data).
- **Direct slot writes:** **`*(slot + 0x40) = rbx_29`**, **`*(slot + 0x48) = r8_25`** @ **`0x14074ca69`–`0x14074ca6e`** (`rbx_29` / `r8_25` from **`var_7a8`**).
- **Closest “bootstrap” pattern so far:** **`rbx_30 = *(0x58_row + 0x40)`** @ **`0x14074cc5f`**, then a loop @ **`0x14074cc73`–`0x14074cc84`** **zeroes** **`rbx_30 + i * 0x20 + {0x10,0x18}`** for **`i in 0 .. *(netnode+0x58)`** — clears destination-side memory **through** the pointer already stored at **`+0x40`**, i.e. **prepares** the buffer the scheduler later reads as **`result_2`**. The instruction that **first assigned** that pointer is **not pinned** in the snippets above; **`sub_140292f00`** / **`sub_14079f290`** in the same function only handle **contiguous buffer growth**—the original **`+0x40`** store likely occurs earlier in this system or in **build/spawn** code still to be found.

### E.7) **`sub_14074aa00`** — who registers it (pathfinding / nav)

**`get_xrefs_to(0x14074aa00)`** yields three code refs:

| Caller | Call site | Notes |
|--------|-----------|--------|
| **`sub_14058e470`** | **`0x14058e726`** | Argument packer only; forwards many query handles into **`sub_14074aa00`**. |
| **`sub_1405be400`** | **`0x1405bea00`** | Full Bevy **`sub_14225f810`** resource resolution; panic metadata includes **`tunnet::net::transport::Handles`**, **`tunnet::map::setup`**, **`tunnet::hud::nav`**, and **`QueryState<(Entity, &mut Transform, &mut tunnet::npc::path_finding::PathFinding`, …** — same broad family as **`§E.5`** graph work but wired as a **scheduled system** over **net handles**. |
| **`sub_14073eeb0`** | **`0x14073f496`** | Parallel layout (larger **`arg1`** offsets); same **`Handles` / `map::setup` / `PathFinding`** string chunk on the failure path that reaches **`sub_14074aa00`**. |

So **`sub_14074aa00`** is not the main **`NetTock`** emitter; it is **pathfinding + transport handle maintenance** that also **clears / repacks** slot memory tied to **`+0x40`** (**`§E.6`**).

### E.8) **`sub_1404f3a90`** — extra callers

**`get_xrefs_to(0x1404f3a90)`**:

| Caller | Call site | Notes |
|--------|-----------|--------|
| **`sub_1404d4100`** | **`0x1404d43a4`** | Bevy glue (increment **`*(world+0x270)`**, **`sub_14225f810`** lookups). Failure strings include **`Compass`**, **`Credits`**, **`SendButton`**, etc.—success path calls **`sub_1404f3a90`** with packed **`NetNode`** query state. |
| **`sub_1405849d0`** | **`0x140584ae4`** | Thin **`return sub_1404f3a90(...)`** wrapper (same pattern as **`sub_140584790`** → **`sub_14044eae0`**). |
| **`sub_1405e7bb0`** | **`0x1405e7e65`** | **Twin of `sub_1404d4100`**: same **`arg1+0x120` / `rbx+8` / `0x1b0..0x1c8`** resource walk, same **`sub_1404f3a90`** argument packing, same **`*(arg1+0x298)`** tick counter write—only the static panic descriptor pointer differs (**`data_1424741f0`** vs **`data_14243dd28`** on some branches). Second **Bevy schedule strip** for the same net-slot logic. |

The same **`update_preview_connections`** subsystem is now tied to **`sub_1401597f0` → `sub_140175c50`** (see **§E.11**). The **`.rdata`** substring @ **`0x142453b81`** still yields **empty** MCP **`get_xrefs_to`** on the string VA—navigate via those functions instead. **`get_xrefs_to(0x1404d4100)`** may also return **no code refs** (vtable / registration path); use **`sub_1404d4100`** / **`sub_1405e7bb0`** as **direct navigation** targets.

**`DeferredConnection` / `NewNode` / `remove_new_nodes`** appear only in **`.rdata` blobs** in this session (e.g. string hits @ **`0x14243fd81`**, **`0x142440881`**); **`get_xrefs_to`** on those VAs returns **empty** in MCP—use BN’s **Data** view. Resolving them to a **`sub_140516d40`** or **`+0x40`** writer still needs UI xrefs or a **`mov`** scan on **`.text`** for **`0x58`**-row stores.

### E.9) Helpers around **`sub_14074aa00`** (int queue + schedule preludes)

**`sub_140292f00`** (`0x140292f00`)

- Small **`i32`** buffer helper: **`sub_1407a03f0`** then **`memmove` / `memcpy`** with **`<< 2`** (element size **4**).
- **`get_xrefs_to`**: **`sub_140293600`** @ **`0x14029361a`**, **`sub_14074aa00`** @ **`0x14074ccc1`**.
- In **`sub_14074aa00`**, it runs when **`rax_4[3] == *rax_4`** (length == capacity) **before** appending another **`i32`**; after it runs, the code stores into **`rax_4[1]`** and bumps **`rax_4[3]`**, and when **`rax_4[3] + 1 >= 0x21`** it **rolls the base index** **`rax_4[2]`** and clears **`rax_4[5]`**—a **fixed-capacity (~0x20 slot) ring / dequeue** of **`u32`** used alongside **`sub_14079f290`** growth for pointer side tables @ **`0x14074cd47`–`0x14074cd8f`**. It is **not** an allocator for **`+0x40`** five-byte row bases.

**`sub_14055dfe0`** (`0x14055dfe0`) — prelude on **`sub_1405e7bb0`**

- When **`*(arg1+0x2a0)`** and schedule counters match **`arg2`**, loops **`0x138`**-byte steps, calls **`sub_1400a9240(arg1+0x40, …)`** to copy component chunks from the world, **`sub_142286e00`** on **`arg1+0x250` / `+0x270`**, etc. **ECS system-parameter refresh** before the user system body runs.

**`sub_14055e8a0`** (`0x14055e8a0`) — prelude on **`sub_1405be400`**

- Same idea with **different `arg1` offsets** (**`0xda`..`0xdc`**, **`sub_1400a01a0`**, **`sub_1400913f0`**, **`sub_140090480`**, **`sub_14008ec40`**, …)—**another system struct layout**, same **`0x138`** stride and **`sub_142286e00`** string moves.

Inside **`sub_1402f9a40`**, when **`r13.d == 2`** (first dword of the **`arg3`** row) and **`(b,c,d) == (4,2,1)`** (`rcx_1.b`, `r12.b`, **`var_a0.b`** checks @ `0x1402f9d58`), the packet subject is **`__builtin_strncpy(..., "Re: Re: Re: Re: ...", 0x13)`** @ **`0x1402f9d8f`**, with **`*(arg1 + 0x28) = 0x13`**. The same literal appears in `.rdata` inside **`data_1424246e0`** (BN string filter **`Re: Re:`**). No **`sub_140673b40`** pool is used for that subject.

### E.10) **`0x58` table growth: `sub_14079fa10`** vs append helpers **`sub_140516d40` / `sub_140516f40`**

**`sub_14079fa10`** is a **generic Rust `Vec`-style reserve** for arrays whose elements are **`0x58` bytes** wide: HLIL scales the old length by **`0x58`**, calls **`sub_14079e410`** with **`new_capacity * 0x58`**, and updates the usual triple (**ptr / len / cap**). It does **not** choose **`+0x40`** tuple bases; it only **reallocates backing storage** when something else has already decided how many **`0x58`** rows exist.

**`get_xrefs_to(0x14079fa10)`** is large; notable **net-adjacent** callees include **`sub_140516d40`** (**`0x140516da2`**, **`0x140516e36`**), **`sub_140516f40`** (**`0x140516f75`**, **`0x140516f95`**), **`sub_1404f3a90`**, the **`sub_1402f0840` / `sub_1402f0e70` / …** family next to **`sub_1402f5840`**, and **`sub_140380650`** (many sites). Treat it as **shared grow plumbing** for **`0x58`-strided** tables, not as the **first** writer of **`*(row+0x40)`**.

**`sub_140516d40`** and **`sub_140516f40`** are **the same algorithm class**: HLIL for **`sub_140516d40`** already branches on **`*(arg1[2] + 0x48)`** and calls **`sub_14079fa10`** on either **`arg1[2]+0x18`** or **`arg1[2]+0x30`** before writing the **`0x58`** row (**`+0x40` ← packed `arg2[4]`**). **`sub_140516f40`** repeats that **dual-`Vec`** choice with only **field-store ordering** differences. **`get_xrefs_to(0x140516f40)`** returns **only** **`sub_140380650`** (many internal call sites). **`get_xrefs_to(0x140380650)`** returns **only** **`sub_140175c50`** @ **`0x14017664f`**. The related **`sub_140386c30`** helper is called from **`sub_140175c50`** @ **`0x140176bd6`** **and** from the twin walker **`sub_14016d910`** @ **`0x14016f587`** (§E.11). So **`sub_140516d40`** covers **NetTock / relay / graph / pathfinding** (§E.5–E.6), while **`sub_140516f40`** is **specialized codegen** for **`sub_140380650`** inside **`sub_140175c50`** only.

### E.11) **`update_preview_connections`** — `sub_1401597f0` / **`sub_140175c50`** / **`data_142429eb0`**

**Rust string (BN `list_strings_filter`)**: **`tunnet::net::build::update_preview_connections`** @ **`0x142453b81`** (embedded in a longer **`NetNode` / `BuildingSurface`** query blob). MCP **`get_xrefs_to`** on that VA is **empty**; treat **`0x142453b81`** as a **label** and use code symbols below.

**Bevy registration / body (two near-parallel systems)**

- **`sub_1401597f0`** (`0x1401597f0`): failure strings include **`bevy_ecs::event::Events<tunnet::net::build::BuildNodeEvent>`**, **`QueryState<… &mut tunnet::net::transport::NetNode>`**, **`chunk::LoadedChunk`**, **`tunnet::npc::Handles`**, etc. It calls **`sub_140175c50`** @ **`0x140159b05`** with packed world queries (**`arg1+0xe8`** / **`0x1b8`** layout branch).
- **`sub_140156d80`** (`0x140156d80`): **same `BuildNodeEvent` + `NetNode` query** panic blobs, but **`arg1+0xd0`** / **`rsi+0x420`** offsets and a different static descriptor (**`data_142409b78`** vs **`data_14243dd28`** on some paths). It calls **`sub_14016d910`** @ **`0x140157178`** — a **second mega-walker** in the same **build-preview** family as **`sub_140175c50`**.
- **`get_xrefs_to(0x140175c50)`**: **`sub_1401597f0`** @ **`0x140159b05`**, **`sub_140588270`** @ **`0x1405883ed`**, **`sub_1405ebbe0`** @ **`0x1405ebf0a`**.
- **`get_xrefs_to(0x14016d910)`**: **`sub_140156d80`** @ **`0x140157178`**, **`sub_14058b220`** @ **`0x14058b461`**, **`sub_1405c8230`** @ **`0x1405c8642`** — same **schedule-twin** idea as **`175c50`**.

**What **`sub_140175c50`** does (selected HLIL anchors)**

- Iterates **`NetNode`**-style tables (**`0x60`** stride on **`*(world + 0xd0)`**, **`0x58`** child counts, **`unwrap`** panics on **`Option`**).
- **Reads existing **`+0x40`** pointers** from **`0x58`** rows when walking neighbors, e.g. **`0x140175ec1`**, **`0x140176278`**, **`0x140176ee8`** — preview logic **reuses** graph storage already attached to nodes; it does not invent **`+0x40`** from **`sub_142353b40`**.
- **`sub_140380650`** @ **`0x14017664f`**: large **`0x8000`**-buffer **`memcpy`** / command recording; inner **`sub_140516f40`** sites maintain the preview **`0x58`** table (**`get_xrefs_to(0x140380650)`** is **only** **`sub_140175c50`**).
- **`sub_140386c30`** @ **`0x140176bd6`** (**`sub_140175c50`**) and @ **`0x14016f587`** (**`sub_14016d910`**): **shared** alternate command-builder path (same **build** subsystem, two walkers).
- **`sub_14037e9d0`**: **open-addressed find/insert** (**`sub_140765b70`** hash, **`sub_1406425d0`** on miss — see **§E.12**). Called from **`sub_140175c50`** @ **`0x140176139`** with **`&data_142429eb0`** wired into the stack **`arg1`** bundle @ **`0x14017602f`**. That is **not** the same layout as **`sub_1403a7a00`’s** **`0x58`**-wide path cells (**§E.5** / **§E.12**): both reuse the **`data_142429eb0`** label as a **static anchor**, but **`37e9d0 → 6425d0`** stores **`0xc`**-byte **inline** payloads, not **`sub_140516d40`** row **`+0x40`** pointers.

**`sub_142353b40` — not a five-byte-row allocator**

- Decompile shows **`TlsGetValue` / `TlsSetValue`**, a **`0x20`**-byte TLS object, and **`BCryptGenRandom`**. It returns **`&tls_block[1]`** (two **`u64`** words of RNG state).
- **`sub_140175c50`** @ **`0x140175fb3`** uses **`sub_142353b40(nullptr)`**, then **`zmm0_1 = *rax; *rax += 1`** — **consumes thread-local randomness** for hashing/probing, **not** as the heap pointer stored at **`*(0x58_row + 0x40)`** for **`sub_1402f5840`’s `result_2`**.

**Still open:** the **first** heap store of **`*(row+0x40)`** for a **brand-new** runtime **`NetNode`** remains elsewhere (**`sub_14074aa00`**-class slot repack, **spawn / component insert**, or another builder — **not** **`sub_1406425d0`**); **`sub_140175c50`** mostly **propagates** existing **`+0x40`** and appends via **`sub_140516f40`**.

### E.12) **`sub_1406425d0` / `sub_14062eb10`** — **`0xc`** inline map (not **`+0x40`** / not **`0x58`** rows)

**`sub_1406425d0`** (`0x1406425d0`)

- Scans the **16-byte occupancy bitmap** at **`arg1[3]`** (SIMD **`_mm_movemask_epi8`**) to find a free **tombstone / empty** byte, then writes the **high-byte** of the **hash** (**`(arg2 >> 0x39).b`**) into the **paired** mirror slots @ **`0x14064266f` / `0x140642673`** (Robin-Hood / secondary-index pattern).
- Stores the caller’s **`arg3`** payload as **two little-endian words** @ **`0x140642691` / `0x140642698`** — offset math uses **`neg.q(rdx_2) * 3`** with **`<< 2`**, i.e. **12 bytes per logical value** adjacent to the control bytes.
- When the table is full, calls **`sub_14062eb10(arg1, arg4)`** @ **`0x1406426b1`** before retrying.

**`sub_14062eb10`** (`0x14062eb10`)

- **Load-factor / growth**: if **`arg1[2]`** (live count) exceeds about half the **mask** **`arg1[0]`**, allocates a **new** **`(capacity * 0xc + …)`** byte buffer (**`mulu …, 0xc`** @ **`0x14062ef1d`**), **`memset(0xff)`** the bitmap tail, **reinserts** every live **`0xc`** cell (**loop @ `0x14062f039`–`0x14062f02e`**), and swaps **`arg1[3]`** to the new storage (**`0x14062f0ed`**).

**`get_xrefs_to(0x1406425d0)`**

- **`sub_14037e9d0`** @ **`0x14037eade`** (the **`175c50`** / **`16d910`** **`37e9d0`** insert path).
- **Nine** immediate sites inside **`sub_14016d910`** (**`0x14016e64c`** … **`0x14016e7ec`**) — build-preview **coordinate / key** churn, **independent** of **`sub_140516d40`**.

**Contrast with `sub_1403a7a00`:** HLIL there steps **`neg.q(…) * 0x58`** (**`0x1403a8a05`**, **`0x1403a80b5`**) over **`var_160_1 → &data_142429eb0`**, i.e. **path-cache records** sized like **`sub_140516d40`** **`0x58`** rows. That is a **different** open-addressing implementation than **`6425d0`’s** **`0xc`** map, even though both stack bundles mention **`&data_142429eb0`**.

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

### H.1) What **`sub_1400af880` success/failure** does for **relay / tape** (MCP `decompile_function`)

**Return bundle `arg1` (HLIL `sub_1400af880`):**

- **Success:** **`*arg1 = 0`**, **`*(arg1 + 8)`** filled with the resolved **row / buffer pointer** (the **`sub_142220430`** fast path or the **`arg3+0x120` / `0x60`-stride** walk @ **`0x1400af918`–`0x1400af98e`**).
- **Failure — tuple not in bitset / generation:** **`arg1[1] = 0`**, **`arg1[2] = arg4`**, **`arg1[3] = arg5`** (original coords preserved), **`*arg1 ≠ 0`** (non-zero **`rax_9`** @ **`0x1400af9b1`**).
- **Failure — `sub_142220430` empty:** **`arg1[1] = 1`**, **`*(arg1 + 8) = rcx_3`**, **`*arg1 ≠ 0`** @ **`0x1400af9a6`–`0x1400af9b1`**.

So **“can this address be resolved to a live slot right now?”** is exactly **`*arg1 == 0`** after the call.

**`sub_1403a08e0`** (**tape / graph relay**, call @ **`0x1403a10dd`**): inside the open-hash probe loop over **`&data_142429eb0`**, it calls **`sub_1400af880(&var_1b8, …)`** then **`if (var_1b8.d == 0)`** only then **`sub_142244e00` → `sub_141fcee80`** (enqueue-style path). If **`var_1b8.d != 0`**, it **skips** that **`142244e00` / `141fcee80`** pair for that candidate — **no outbound for unresolved tuple** on that hop. That is **filtering**, not a **`SendBack`** string; it explains **“wrong / unknown address → don’t emit on this relay path”** for **tape**.

**`sub_14044eae0`** (**`tunnet::net::relay::Relay`**, **§E.3–E.4**): HLIL shows **no** call to **`sub_1400af880`**. “Does this packet belong on this port?” is **`sub_1406b6550`** on **`slot + 0x35`** vs staged **`rsi_3[…]`** bytes, **`&slot[3]`**, PING/PONG magic **`0x474e4950` / `0x474e4f50`**, and open-hash **`sub_140766420`** neighbor rows. **`if (sub_1406b6550(...) == 0) continue`**-style paths **skip** relay work when compares fail — again **no delivery on mismatch**, not serde **`SendBack`**.

**Still open for “bounce TTL packet back”:** a path that **builds a return tuple** (swap src/dst, decrement TTL) on purpose. That was **not** found in these **`sub_1400af880` / `sub_14044eae0` / `sub_1403a08e0`** slices; keep searching **`sub_1404eb580`** (also calls **`sub_1400af880`** @ **`0x1404ec9df`**, **`0x1404ed536`**) and **infection / monitor** systems if captures show explicit **reflect** behavior.

### I) Rust type-string anchors (MCP `list_strings_filter`)

Filtered hits include the ECS system name **`tunnet::net::endpoint::update`** inside the usual long Rust metadata blob (example chunk address **`0x142441181`**). Related: **`tunnet::net::endpoint::EndpointPlugin`** near **`0x142461581`**. Use Binary Ninja’s own string/xref UI on these substrings first; **`get_xrefs_to` on the raw chunk address** often returns nothing in this MCP bridge, so treat these as **navigation hints**, not automatic xref sources.

### J) Packet TTL (hop lifetime) — BN research checklist

**Repo context (not game truth):** `src/simulator.ts` implements a **topology scaffold**: if `Packet.ttl === undefined`, **`decrementTtl`** leaves the packet unchanged, so TTL never runs down (“infinite TTL”). When `ttl` is set, filters decrement on the operating port and wrong-address non-sensitive endpoint bounces decrement once; **`README_TS_SIM.md`** summarizes that **design** behavior. **None of this is proven from `tunnet.exe` yet** for the live slot / relay layout.

**Goal:** recover from the binary, for **in-world** packets (slot buffers, **`0x58`** rows, relay forwards — not serde JSON):

1. **Where TTL is set on create** — initial value and which code paths write it (compose vs relay vs inject).
2. **What decrements TTL** — per hop, per device class, or only on specific gates.
3. **What happens at expiry** — drop silently, enqueue an event, bounce with swapped tuple, etc.

**Anchors already in this doc (start here):**

- **`sub_140516d40` / `sub_140516f40`** (**§E.2**, **§E.10**): **`0x58`**-row layout; **`arg2`** packing into **`+0x00..+0x30`**, **`+0x40`**, **`+0x50`**. Check whether any **first-hop** builder stores a **separate hop/TTL byte** next to the five-byte tuple / header blob.
- **`sub_1402f5840`**: after inbound merge / before outbound enqueue, scan **all** **`mov byte|word|dword [slot + disp], …`** on the **`0x98`**-strided packet blob (**§E.1a**). Rename in BN once a field looks like a **small integer** copied into every new outbound.
- **`sub_14044eae0`** (**§E.3–E.4**, **§H**): relay forwarding — does TTL **copy unchanged**, **decrement once per forward**, or **reset**?
- **`sub_1403a08e0`** (tape / graph relay after **`sub_1400af880`**, **§H**): same question when the tuple resolves.
- **`sub_1404eb580`** (**§H** table): calls **`sub_1400af880`**; still a lead for **bounce / TTL** behavior not found in the smaller relay slices.

**Mechanical BN moves (obey §1 one-request-at-a-time):**

1. **`decompile_function("sub_140516d40")`** and **`get_xrefs_to(0x140516d40)`** — pick call sites that build **player-visible** traffic (not only test injectors), follow **stores** into the **`0x58`** row and into **`slot+…`** targets.
2. **`decompile_function("sub_14044eae0")`** — search HLIL for **`add …, -1`**, **`sub …, 1`**, **`dec`** on a **`slot`-relative** address; follow the **fall-through vs branch** when the field hits **0**.
3. **`get_xrefs_to`** on any **candidate field VA** once you have a **data xref** from a **`mov [reg+disp]`** pattern (or scan **`.text`** for **`C6 …`** / **`83 …`** style updates with the same **`disp32`** as your candidate slot offset — same trick as **`+0x1c5`** writers in **§G**).
4. **Do not** use **`SendBack` / `PacketDrop`** **`.rdata`** xrefs as proof of wire TTL expiry (**§E.1b**): those are **serde / particles** labels unless a **non-serde** path is shown copying from them into a live packet.

**When you have a hit, log this (for TypeScript parity):**

| Field | Base pointer | Offset + width | Writers (fn @ VA) | Readers / decrement (fn @ VA) | On zero / underflow |

#### J.1) BN session notes — “how TTL is set” (in progress)

MCP was run against the stock **`tunnet.exe.bndb`** (see **§1** one-request-at-a-time). **Initial TTL on compose** is **not** pinned yet; **relay-side decrement** of a **candidate hop/TTL field** is partially visible.

**Strings (navigation only):**

- **`.rdata`** tutorial lines **`0x14243a630`** / **`0x14243a6f8`**: “Preserves TTL…” / “Decrements TTL…” — **workshop UI copy**, not a code xref target by itself.
- **`0x14248f8c0`**: ASCII **` | ttl: \n`** — looks like a **`Debug` / `Display`** fragment for a Rust packet type. **`get_xrefs_to(0x14248f8c0)`** returned **no code xrefs** in MCP (only a data edge); use BN **Data** view / manual xref from the vtable if needed.

**`sub_140516d40` (`0x140516d40`) — row append:**

- HLIL copies **`arg2`** into a new **`0x58`** row: **`+0x00`…`+0x30`**, **`+0x40 ← arg2[4]`**, **`+0x50 ← *(arg1[2]+0x10)`** (cursor / generation). **Any TTL-like scalar is expected inside the `arg2` bundle** passed in by callers, not invented inside this helper.

**`sub_14044eae0` (`0x14044eae0`, relay) — decrement before enqueue (`sub_140516d40`):**

- **`get_xrefs_to(0x140516d40)`** includes **`sub_14044eae0`** @ **`0x14044f13a`**, **`0x14044fd7f`**, **`0x14044f758`** — full per-site field map in **§E.3a**.
- On **`label_14044f160`** only the **narrow (B)** fall-through (**`0x14044fa2e`**) does **`rdi_27 = rbp_5[1].q`**, **`if (*(rbp_5+0x3a) != 0) rdi_27 -= 1`**, then **`var_218 = rdi_27`** before **`sub_140516d40(&var_b8, &var_228)` @ `0x14044fd7f`**. The **(A)** arm (**`0x14044fc99`**) hits the **same call** with **no** **`slot[1].q--`**, but **splits `+0x3a` / `+0x3b` into `var_1ee`’s two bytes** (**§E.3a**).
- **Working hypothesis:** **`slot[1].q`** behaves like a **remaining-hop / counter** on **(B)** only; **(A)** + the **other two `516d40` sites** copy it **verbatim** — still **not** the same dword as **tape `rax_11[1].d` → `arg2+0x48`** unless you prove a shared writer.

**`sub_14037bf80` (`0x14037bf80`)** — neighbor row touch:

- On match, HLIL does **`*(rsi_1 + 0xc) = arg4`** and **`*(rsi_1 + 0x10) = arg6`** (**`rsi_1`** points into a **`0x14`**-strided open-hash value). Relay callers pass **`arg4 = 1`** and **`arg6`** from an incremented counter sourced from **`*(r13_1 + idx*0x38 + 0x30)`** in the same function — **may be path bookkeeping**, not the same field as **`slot[1]`** above; keep separate until one dataflow graph merges them.

**Next BN steps (initial TTL):**

1. **Tape row dword:** **§J.3.2** now pins **`[rsp+0x298]`**, **RNG + `.rdata` blend**, **disasm layout into `row+8`**, and **both** **`sub_14204f0e0`** sites — remaining work is **runtime correlation** (breakpoint **`0x1402f5ccf`**) or **symbolic/`i_1==6`** narrowing on **`sub_14204f0e0`**.
2. **Compose `+0x18`:** **`sub_1423b0fc0` → `sub_1423af220`** reads as **`String` reserve / UTF-8`**, not wire TTL (**§J.3.3**); still map **which ring field** carries **numeric TTL** on send. Relay **`slot[1].q`** first-writer remains **§E.3a** / **§J.1**.
3. Optional: **`get_xrefs_to`** on the **`Debug` vtable`** that references **`0x14248f8c0`**, if BN UI shows one — MCP **`get_xrefs_to`** on the string alone was empty.

#### J.2) Chamber **`1.*.1.0`** endpoints — bridge **first-octet** remap **and TTL** (topology hint for BN)

- **Address form:** endpoints in the wiki pattern **`1.b.1.0`** (e.g. **`1.3.1.0`**) are **in-chamber** identities. The **`0.b.1.0`** pattern is **not** used as the canonical in-chamber address for those sites — **`1.*.1.0`** is.
- **Bridge — addressing:** the chamber **bridge** rewrites the **first octet** on forwarded packets: **egress (out of chamber)** **`1 → 0`**, **ingress (into chamber)** **`0 → 1`**. Packets seen **outside** can therefore carry **`0.*.1.0`**-shaped addressing for the same logical chamber endpoint.
- **Bridge — TTL:** the same **bridge** code paths can **set or change TTL** (initial remaining hops / counter), not only the **relay** decrement described in **§J.1**. Treat **bridge / chamber forward** as a primary place to find **immediate constants** and **stores** into the TTL field alongside the **first-octet** transform.
- **BN:** correlate **first-dword / first-byte** transforms and **TTL writes** on the same spine as **`sub_14044eae0`**, **`sub_140516d40`**, and any **`sub_1402f5840`** slot fill that runs when a packet **crosses** a chamber boundary.

Cross-link: **§H** “bounce TTL packet back” remains **open** until a branch explicitly **reflects** or **drops** on the TTL field.

#### J.3) `0.3.0.0` / regional mainframe **source** packets — `sub_1402f9a40` vs tape (`rax_11`)

**Why there is no `"0.3.0.0"` string anchor:** MCP `list_strings_filter("0.3.0.0")` on the stock **`tunnet.exe.bndb`** returns **no hits**; the address is not stored as that ASCII quad in **`.rdata`**.

**Single composer entry:** `get_xrefs_to(0x1402f9a40)` → **only** **`sub_1402f5840` @ `0x1402f5c26`**, immediately after **`if (*(rbx_3 + 0x7a) == 2)`** @ **`0x1402f5bfe`**. First argument is **`&var_308`** (stack scratch the HLIL names **`var_308`**, not the raw **`rbx_3`** slot base).

**After `sub_1402f9a40` returns (`0x1402f5c38` …):**

- If **`*(var_3a8_1 + 0x7a) != 2`**, HLIL frees **`+0x58`**, copies **`var_308` / `var_2f8` / `var_2e8` / `var_2d8`** into **`var_3a8_1[4..7]`**, then forces **`var_308.d = 0x3020101`** @ **`0x1402f5c93`** (header reset for the next stage).
- If **`+0x7a` stays `2`**, that whole block is **skipped** — **`var_308` is not reloaded from `rax_11`** on the next gate either: **`if (*(rbx_3 + 0x7a) != 2)`** @ **`0x1402f5cc1`** is the tape path **`var_300.d = rax_11[1].d`**, **`var_308 = *rax_11`** @ **`0x1402f5cd2`–`0x1402f5cdc`**. So for **compose mode that remains `0x7a == 2`**, **initial TTL / header dwords must come from what `sub_1402f9a40` wrote into `&var_308`**, not from the **`rax_11`** table used on the **`0x7a != 2`** branch.

**`+0x3a` vs `sub_140516d40` @ `0x1402f66ea`:** **`if (*(rbx_3 + 0x3a) != 2)`** @ **`0x1402f5f46`** guards the large spine that ends in **`sub_140516d40(arg14, &var_308)`** @ **`0x1402f66ea`** (and the parallel tail @ **`0x1402f6808`**). When **`*(rbx_3 + 0x3a) == 2`**, that **`sub_140516d40`** block is skipped — other tails push **`var_308`** with **`memcpy(..., &var_308, 0x90)`** instead (e.g. **`0x1402f5ed1`**, **`0x1402f83a1`**, with nearby **`var_308.w = 0xf` / `0x14`** staging).

**5-byte row / regional tuple (ties repo TS to BN):** In **`sub_1402f9a40`**, **`r13 = zx.q(*arg3)`** @ **`0x1402f9a70`** (**arg3** is **`result_2`** from **`sub_1402f5840`**, i.e. **`var_120_1 + rdi_43 * 5`**). **`if (r13.d == 4)`** @ **`0x1402f9ba7`** plus **`arg3[1..3]`** byte checks @ **`0x1402f9e46`** matches **`src/endpoint-address-encoding.ts`** **`plus_one_all_octets_regional_mainframe`** **`(4,1,1,1)`** for wiki **`0.1.0.0` / `0.2.0.0` / `0.3.0.0`** (same 5-byte prefix; **which** regional mainframe is live is **which `NetNode` / slot** is iterating, not a different first-row byte).

##### J.3.1) `*(arg2 + 0x1c5)` switch ↔ **`MainframeHeaderU32`** ↔ two `arg1` (`&var_308`) tails

**Phase index:** **`uint64_t rax_37 = zx.q(*(arg2 + 0x1c5))`** @ **`0x1402fa00b`** in **`sub_1402f9a40`** (second arg **`arg2`** is the **`rsi_2`** / **`arg10[2]`** world node pointer from **`sub_1402f5840`**). This is the same **sub-phase** the repo models as **`RecoveredSchedulerState.phaseB`** / **`*(node + 0x1c5)`** in **`src/recovered-endpoint-scheduler.ts`**.

**`var_10b` constants match `src/packet-header-format.ts` `MainframeHeaderU32` 1:1** (HLIL **`switch (rax_37)`** @ **`0x1402fa02a`**):

| **`rax_37` (phaseB)** | **`var_10b` in `sub_1402f9a40`** | **`MainframeHeaderU32` key** |
|---:|---:|---|
| 0 | `0x1020104` | `phase0` |
| 1 | `0x4020104` | `phase1` |
| 2 | `0x1020104` | `phase2` |
| 3 | `0x2020104` | `phase3` |
| 4 | `0x3020104` | `phase4` |
| 5 | `0x4020104` | `phase5` |

The **`a === 4`** branch of **`evaluateEndpointSend`** uses the **same numeric literals** for **`header`** as this BN **`switch`** (**`recovered-endpoint-scheduler.ts`**, regional **`a === 4`** / **`phaseB` 0..5** block).

**Two different HLIL paths write `arg1` (`&var_308`):**

1. **`label_1402faadc`** (**cases 0 and 1**, and **case 1** jumps here after setting **`var_10b`**): **`arg1[3].d = rcx_8`**, **`*(arg1 + 0x34) = rcx_9`**, **`*(arg1 + 0x35) = var_10b`**, **`*(arg1 + 0x39) = var_107_3`**, **`*(arg1 + 0x3a) = var_106.d`**, **`*(arg1 + 0x3e) = …`**, plus **`arg1[2/1/0]`** string pointers (**`0x1402fab2f`–`0x1402fab61`**). Here **`var_10b`** is stored **explicitly at byte offset `+0x35`** (HLIL may overlap **`rcx_9`** at **`+0x34`** in the real layout—confirm in disasm if needed).

2. **`label_1402faba8`** (**cases 2–5** after **`sub_14067a670`** / subject blob setup): **`result[3] = rcx_8.o`**, **`result[2] = rax_2.o`**, **`result[1] = var_130`**, **`*result = var_140_1.o`** (**`0x1402fac04`–`0x1402fac10`**). This path **does not** execute the **`*(arg1 + 0x35) = var_10b`** store from **`label_1402faadc`**; the **`0x3020104`**-class value still lives in **`var_10b`** for **`case 4`** @ **`0x1402faa50`** but is folded through **`var_130` / `var_b8` / `sub_14067a670`** before the final **`int128`** writes.

**`sub_1423a1b30` (`0x1423a1b30`) — `String` triple overwrites the start of `var_308`:** HLIL is **`memcpy` + `*arg1 = _Size`**, **`arg1[1] = ptr`**, **`arg1[2] = _Size`** (**`0x1423a1b82`–`0x1423a1b8e`**). In **`sub_1402f5840`**, **`sub_1423a1b30(&var_308, rbx_3 + 0x18)`** @ **`0x1402f5f85`** runs on the **`*(rbx_3 + 0x3a) != 2`** spine **after** **`sub_1402f9a40`** may have filled **`&var_308`**. Immediately **before** that call, HLIL does **`var_208 = *(rbx_3 + 0x35)`** @ **`0x1402f5f6f`** and **`var_348 = rbx_3[3].d`** @ **`0x1402f5f5a`** — so the **32-bit “header-ish” dword at slot offset `+0x35`** is captured into **`var_208`** even though **`var_308`** is about to be repurposed as a **Rust `String`** buffer for **`rbx_3 + 0x18`**.

**Header vs TTL:** **`var_10b` / `MainframeHeaderU32`** are **not** the hop counter. See **§J.4** for **where `rax_11[1].d` lands on the outbound ring**, **`sub_14037d450`** / **`sub_140643f00`**, and **`sub_1406b6550`** roles.

##### J.3.2) **Tape: where `rax_11[1].d` is read from — `[[rsp+0x298]]+8` and the `sub_1404628b0` loop**

**Disasm `sub_1402f5840` @ `0x1402f5cc7`–`0x1402f5cdc`:** **`rcx = qword [rsp+0x298]`** (HLIL **`rax_11`**), **`eax = dword [rcx+8]`** → **`dword [rsp+0x108]`** (**`var_300.d`**, same dword as **`rax_11[1].d`** in the tape reload), and **`rax = qword [rcx]`** → **`qword [rsp+0x100]`**. So the **per-destination tape TTL seed** is **`*(row_ptr + 8)`** on the **`0x30`-byte row** pointed to by **`[rsp+0x298]`** — **not** the **`MainframeHeaderU32`** stored at **`slot + 0x35`**.

**Who materializes those rows:** **`call sub_1404628b0`** @ **`0x1402f5d09`**, **`0x1402f6f53`**, **`0x1402f8c99`** uses **`rcx = rbp`** with **`lea rbp, [rdi+0x120]`**, **`rdx = lea rsi,[rdi+0x10]`**, **`r8 = qword [rdi+0x110]`** (**`0x1402f5cf0`–`0x1402f5d08`**). That **`call`** sits on the **`0x1402f5d00`** block (**`fetch_disassembly("sub_1402f5840")`**). **`0x1402f5d1b`–`0x1402f5d40`** is a **separate inner dword walk** ( **`[rdi+rax*4+0x10]`** ) until **`rax == 0x40`**, **not** the same control flow as each **`4628b0`** invocation. **`decompile_function("sub_1404628b0")`** still matches **disasm**: **`arg1`** is the **`0x30`** row under construction.

**Who assigns `[rsp+0x298]` before `0x1402f5cc7`:** **`mov qword [rsp+0x298], rax` @ `0x1402f5bad`**. On the **`0x1402f5b20` → `0x1402f5b72`** path (**`fetch_disassembly("sub_1402f5840")`**), **`lea rax,[rdi+rdi*2]`** (**`0x1402f5b20`**) makes **`rax = 3*rdi`**, then **`shl rax, 4` @ `0x1402f5b9a`** yields **`rax = 0x30*rdi`**, then **`add rax, [rsp+0x2e0]` @ `0x1402f5ba6`–`0x1402f5ba8`** and **`add rax, 0x10` @ `0x1402f5ba9`**. So **`[rsp+0x298] = [rsp+0x2e0] + rdi*0x30 + 0x10`** for the **`rdi`** live at **`0x1402f5b20`** on that spine — a **`0x30`-strided table base** plus **fixed `+0x10`** bias (**`rax_11`** in HLIL).

**`sub_142052f70` / `sub_142313210` — RNG before static blend:** **`decompile_function("sub_142052f70")`** allocates a **`4`**-byte tagged cell and stores a **length**; **`decompile_function("sub_142313210")`** is **`BCryptGenRandom` / `SystemFunction036`** in a **`while`** until **`arg2`** bytes are filled. **`sub_1404628b0`** does **`memset` scratch `0x20`**, **`sub_142052f70(arg1, &scratch, 0x20)`**, then **`sub_1420519a0(&var_78, &scratch, &data_142428768, 8)`** — **`var_48`** in HLIL is **OS random bytes** merged with **`.rdata`**.

**`sub_1420519a0` seed (HLIL):** **`sub_1404628b0`** calls **`sub_1420519a0(&var_78, &var_48, &data_142428768, 8)`**. In **`decompile_function("sub_1420519a0")`**, that **`arg4 == 8`** site reaches **`rdx_1 = *(arg3 + 8)`** @ **`0x142051a29`** and **`*(arg1 + 0x2c) = rdx_1`** @ **`0x142051a49`** — a **`.rdata` dword at `data_142428768+8`** is copied into **`var_78+0x2c`** (**`0x424286e0`** in stock BN).

**`sub_1404628b0` disasm — where `row+8` is copied from (pre-ChaCha):** after **`sub_1420519a0`**, **`movups xmm0, [rsp+0x48]`** then **`movups [rdi+8], xmm0`** (**`0x140462955`–`0x14046295a`**) copies **`var_78` bytes `[8..0x17]`** into **`arg1+8`**. The **`.rdata` dword** above lives at **`var_78+0x2c`**, **outside** that **16-byte** window, so **even before** **`sub_14204f0e0`**, **`dword *(row+8)`** is **not** the raw **`0x424286e0`** literal — it is **RNG + layout** from **`1420519a0`**, then **still** mixed by ChaCha.

**Stock `tunnet.exe.bndb` (MCP `get_data_decl`, child VA — see §6 MCP note):** at **`0x142428770`** (**`data_142428768 + 8`**), the first **four** bytes are **`e0 86 42 42`** → **`uint32_t` `0x424286e0`** (little-endian). **`get_data_decl("0x142428768", …)`** with the **symbol base** has been observed to **hang Binary Ninja**; use **`"0x142428770"`** with **`length: 4`** (or **`8`**) instead.

**`sub_1404628b0` after the seed (`decompile_function`, post-restart MCP):** HLIL does **`*(arg1 + 8) = var_70`**, **`*(arg1 + 0x18) = var_60`**, **`*arg1 = (int64_t)var_78`** (with **`var_78`** filled by **`sub_1420519a0`**), then **tailcalls `sub_14204f0e0(arg1, 6, arg2, …)`**.

**Second `sub_14204f0e0` callsite in `sub_1402f5840`:** **`call sub_14204f0e0` @ `0x1402f5d79`** (**`rcx=rbp`**, **`edx=6`**, **`r8=rsi`**) runs after the **`[rdi+0x158]`** / **`[rdi+0x160]`** guard (**`0x1402f5d52`–`0x1402f5d5e`**), then **`jmp 0x1402f5d0e`** — **in addition to** the **`jmp` tail inside `sub_1404628b0`**. Treat **`14204f0e0`** as **potentially invoked more than once per scheduler epoch** on different control-flow spines.

**`sub_14204f0e0` is not a memcpy:** **`decompile_function("sub_14204f0e0")`** shows **`"expand 32-byte k"`**, **`ChaCha20`-style SIMD quarter-rounds**, and a **`do while` round loop** — it **mixes the `0x30` row buffer in place** on **`arg1`**. So the **`dword` at `row+8`** observed on the **`0x1402f5ccf`** tape reload is **almost certainly output of that PRF / keystream expand**, keyed/seeded by the **`1420519a0`/`142052f70`/`data_142428768`** pipeline — **not** the raw **`0x424286e0`** literal unless you prove an identity path for **`arg2 == 6`**.

**Practical next steps:** (1) **Runtime:** breakpoint **`0x1402f5ccf`**, log **`ecx`** (row ptr) and **`[ecx+8]`** once per destination index. (2) **Static:** either **narrow symbolic** evaluation of **`sub_14204f0e0` for `i_1 == 6`**, or **annotate `arg1` field names** in BN and re-HLIL so **`var_60` / `var_70` ← `var_78`** dataflow is explicit before the cipher.

**Qualitative win (unchanged):** tape hop seed is **not** **`var_10b`**; it flows through **`4628b0 → 14204f0e0`**, with **`.rdata` `data_142428768+8` (`0x424286e0`)** as **one** concrete input to **`sub_1420519a0`**.

##### J.3.3) **Compose: single explicit `*(arg1+0x18)` store — `0x1402fbd3b`**

**`grep`-style fact on `decompile_function("sub_1402f9a40")`:** the **only** **`*(arg1 + 0x18) = …`** is **`*(arg1 + 0x18) = var_130:8.q`** @ **`0x1402fbd3b`**, paired with **`arg1[1].q = var_130.q`** @ **`0x1402fbd32`**.

**HLIL immediately above:** **`var_130:8.o = var_f8.o`** (**`0x1402fb885`**) after **`sub_140275e80(&var_f8, *rax_207, rax_207[1], …)`** @ **`0x1402fb849`** (**`sub_140673b40`** pool hit — example slice builds **`"Call To Prayer"`** / **`rax_167`**). Then **`var_130.q = rax_214 + rbx_5`** (**`0x1402fbd09`**) where **`rbx_5`** defaults **`2`** or loads **`qword [(var_10b:2.b << 3) + 0x1424257d0]`** when **`var_10b:2.b ∈ {2,3,4,5}`**, and **`rax_214`** is **`switch (var_10b:3.b)`** (**`1→3`**, **`2→(sub_1406b60c0(&var_10b:2, &data_14241f6f0) ^ 3)`**, **`3→2`**, **`4→1`**, **else `0`**).

**Interpretation:** **`arg1[1].q`** on this tail is a **small integer** derived from **`var_10b`’s `b/c` nibbles** — useful for **header-side** replica work. **`*(arg1+0x18)`** is the **upper `qword` of `var_130`** after **`var_f8`** is copied then **low `qword` overwritten** — still **dominated by whatever `sub_140275e80` → `sub_1423b0fc0` wrote into `var_f8`’s high lane**.

**`sub_1423b0fc0` (`0x1423b0fc0`) — thin forward:** **`decompile_function`** is **`return sub_1423af220(arg3, arg1, arg2, arg4, arg5) __tailcall`**. **`decompile_function("sub_1423af220")`** shows **UTF-8 scalar scanning**, **SIMD ASCII-ish passes**, and **`arg1` vtable calls at `arg1[1]+0x18` / `+0x20`** — classic **Rust `String` grow / reserve** shape, **not** a hop counter. Treat **`var_f8` / `*(arg1+0x18)`** as **allocator / `String` bookkeeping** until a **separate** store into the **outbound ring `+0x18` TTL dword** is found on **`sub_1402f5840`**’s send path.

##### J.4) Deep slice — tuple filter, hash probe, neighbor **swap**, ring row layout, **TTL dword at +0x18**

**`sub_1406b6550` (`0x1406b6550`) — not TTL, tuple gate:** HLIL at the real entry (**`0x1406b6550`**) walks **four nested `switch`es** on **`arg1[0..3]`** and compares to **`arg2[0..3]`** (first bytes of the **`result_2`** / **`var_120_1 + rdi_43*5`** row). **`sub_1402f5840`** uses it as **`sub_1406b6550(&var_318, result_2, …)`** / **`(&var_313, …)`** / **`(result_2, &var_308, …)`** — **“does this 5-byte template match these prefix words?”**, not arithmetic on TTL.

**`sub_140765640` (`0x140765640`) — hash only:** Mixes **`arg2[0..4]`** with fixed XOR constants and **SipHash-like rounds** (**`0x140765655`–`0x14076582f`**), returns a **table index**. Used by **`sub_14037d450`** and the **`rbp_9[0xc]`** probe loops in **`sub_1402f5840`** to find **open-hash buckets** — **not** TTL.

**`sub_14032dfb0` (`0x14032dfb0`) — lookup key builder:** **`__builtin_memset(arg1,0,0x18)`**, seeds **`arg1[3]`**, then **`var_38 = arg2.d`**, **`var_34 = (arg2>>32).b`**, and a **`while`** calling **`sub_140658670`** — builds the **`zmm8_1`** bundle passed into **`sub_14037d450`** from **`zx.q(rcx_94) | zx.q(var_313:1.d)<<8`** style operands (**`sub_1402f5840` @ `0x1402f6864`**).

**`sub_14037d450` (`0x14037d450`) — neighbor row exchange:** **`sub_140765640(&arg2[4], &var_e0)`** then scans **`0x10`**-aligned SIMD tags over **`arg2[3]`** rows with **`*0x38` stride** (**`0x14037d529`**). On **`sub_1406b6550(&var_e0, rbx_2, …)`** hit, HLIL copies **three qwords** **`*(rbx_2+8)`**, **`*(rbx_2+0x18)`**, **`*(rbx_2+0x28)`** into **`arg1`** (e.g. **`&var_268`** in **`sub_1402f5840` @ `0x1402f68c6`**), then **writes `arg4` (`&var_308`) back through the same three offsets** on **`rbx_2`** — **swap packet scratch with a matched neighbor template row**.

**`sub_140643f00` (`0x140643f00`) — bucket metadata + 5-byte key insert + decrement:** Called as **`sub_140643f00(rbp_11 + 8, rax_50, pack, var_278)`** @ **`0x1402f911b`**. HLIL does **open-hash tombstone walking**, then:

- **`arg1[1] -= zx.q(rbx_2)`** @ **`0x140643f8f`** where **`rbx_2 ∈ {0,1}`** — **in-place decrement of the second qword of the `arg1` record** (counter / generation on the **table header** at **`rbp_11+8`**, not the subject string).
- **`*(rcx_7 + rdx_4 - 5) = arg3.d`**, **`*(rcx_7 + rdx_4 - 1) = (arg3>>32).b`** @ **`0x140643fc4`–`0x140643fc8`** with **`rdx_4 = neg(rdx_2)*5`** — writes the **packed `var_308` qword** (**`zx.q(var_308:4.d)<<32 | var_308.d`** @ **`0x1402f6333`**) into the **5-byte stride** backing store behind **`rcx_7`**.

**Concrete outbound ring row (tape / beep / PINGPONG path):** In **`sub_1402f5840` @ `0x1402f5f01`–`0x1402f5f2a`**, with **`rcx_34 = rdx_12 * 5`** and base **`rax_28`**, HLIL stores **five qwords** per **`rdx_12` slot** (stride **0x28** bytes):

| **Offset in row** | **Value** |
|---:|---|
| **`+0x00`** | **`rsi_4`** — pointer into **`.rdata`** (**`"PINGPONG"` / `beep_sendN` / …** @ **`0x1402f5d84`–`0x1402f5d9b`**) |
| **`+0x08`** | **`0xa`** |
| **`+0x10`** | **`var_208.q`** — **`var_208`** was **`*(rbx_3 + 0x35)`** @ **`0x1402f5f6f`** (slot header dword widened) |
| **`+0x18`** | **`var_200`** — and **`var_200 = var_300.d`** @ **`0x1402f5da5`**, with **`var_300.d = rax_11[1].d`** on the **`0x7a != 2`** tape path @ **`0x1402f5cd2`** |
| **`+0x20`** | **`rbx_4`** — **`*(arg12[2] + 0x10)`** cursor |

So on this spine the **hop/TTL seed from `rax_11[1].d`** is **not** merged into the **`0x3020104` header word**; it occupies **its own qword lane at ring row `+0x18`**, next to the **header qword at `+0x10`**.

**`sub_140516d40` (`0x140516d40`) vs this ring:** HLIL names the second argument **`&var_308`**, but **disassembly** is authoritative for layout: **both** call sites in **`sub_1402f5840`** pass **`lea rdx, [rsp+0x100]`** immediately before **`call 0x140516d40`** (**`0x1402f66e2`–`0x1402f66ea`**, **`0x1402f6800`–`0x1402f6808`**). That address is the **base of the contiguous `0x50` byte outgoing `arg2` blob** (five **`int128`** lanes). **`sub_140516d40`** then copies **`arg2[0..4]`** into the new **`0x58` row** at **`+0x00`…`+0x30`**, **`arg2[4]`** into **`+0x40`**, and the queue cursor into **`+0x50`** (**§E.2**).

##### J.4.1) **`sub_1402f5840` → `sub_140516d40`:** concrete `arg2` byte map (both `@0x1402f66ea` and `@0x1402f6808`)

**Common packing** (same instruction pattern at both sites; only **`mov qword [rsp+0x110], rdi`** vs **`…, rsi`** differs):

- **`arg2[0]`** (**`rsp+0x100`…`+0x10f`**, **16 bytes**): **`movdqu [rsp+0x100], xmm0`** with **`xmm0` loaded from `[rsp+0xc0]`** — the **`var_348`** / **`0xc0`** pipeline in HLIL (**not** the **`rax_11`** pair on this block).
- **`arg2[1]`** (**`+0x110`…`+0x11f`**): **low qword** **`[rsp+0x110]`** ← **`rdi`** (first site) or **`rsi`** (second site); **high qword** is the **low 8 bytes** of **`xmm1`** after **`movdqu xmm1, [rsp+0x200]`** then **`movdqu [rsp+0x118], xmm1`** (so **`[rsp+0x200]`**’s first qword continues the **`int128`**).
- **`arg2[2..3]`** (**`+0x120`…`+0x13f`**): remainder of **`xmm1`**, the **`[rsp+0x210]`** qword staged at **`[rsp+0x128]`**, and the **`[rsp+0x130]`** / **`0x135`** / **`0x139`** / **`0x13a`…`0x13c`** small-field pack from **`[rsp+0x40]`**, **`[rsp+0x44]`**, **`[rsp+0x38]`**, **`[rsp+0x3c]`**, and byte temps — **tuple / scratch**, not the **`rax_11`** reload.
- **`arg2[4]`** (**`+0x140`…`+0x14f`**): **`mov qword [rsp+0x140], rcx`** with **`rcx` from `[rsp+0x1a0]`** (**`*rax_11` / first qword of the per-destination row**), then **`mov dword [rsp+0x148], ecx`** with **`ecx` from `[rsp+0x1a8]`** (**`rax_11[1].d`**, same dword as **`var_300.d`** on the tape path), then **`mov byte [rsp+0x14c], 1`**. So within **`arg2[4]`** as an **`int128`**, the **TTL seed dword** is at **byte offset `+8`** inside that lane, i.e. **`arg2` byte offset `0x48`**, which **`sub_140516d40` lands at `row + 0x40 + 8 = row + 0x48`** inside the **`0x58` row**.

**Reconcile with §J.4 ring table:** the **same logical value** **`rax_11[1].d`** is still the per-row TTL seed, but **containers differ**: on the **beep / PINGPONG ring** it sits at **ring row `+0x18`** next to **`var_208` at `+0x10`**, while on this **`sub_140516d40`** tail it sits in **`arg2[4]`** and becomes **`(0x58 row) + 0x48`**. **`arg2[0]` does not carry that dword** on these two call sites.

##### J.4.2) **`memcpy(..., 0x90)`** from **`&var_308` / `rsp+0x100`** in **`sub_1402f5840`** (four sites)

**Shared anchor:** **`lea r14, [rsp+0x100]`** @ **`0x1402f5ad1`** — **`r14`** is the **`var_308` slab base** reused for **`sub_140516d40`** (**§J.4.1**) and for **`memcpy` sources** where the disasm uses **`mov rdx, r14`** or **`lea rsi/rdi, [rsp+0x100]`**. Destination is always **`rcx = base + (index * 9) << 4`** into **`*(entity+8)`** (same **`0x90`** stride as HLIL **`(rcx - rax) * 0x90 + table[1]`**).

**`sub_1405211a0` (`0x1405211a0`) prologue:** **`mov rsi, rcx`** then **`movzx eax, word [rdx]`** — dispatch uses the **low word of `*arg2`**, not `*arg1`. Callers therefore pre-seed **`arg2`** (**`&var_208`**, **`rsp+0x1a0`**, etc.) with tags **`0xf`**, **`0x14`**, **`0x10`**, **`0x190`** below.

**Jump table:** **`&jump_table_140536480`** @ **`0x140536480`** holds **`int32`** displacements added to **`0x140536480`** (same pattern as HLIL **`sx.q(jump_table[…]) + &jump_table`**). Resolved **targets** for the tags used on the **`memcpy`** spines: **`word == 0xf` → `0x140531dfa`**, **`0x10` → `0x14052624b`**, **`0x14` → `0x140531e59`**, **`0x190` → `0x140531832`** (all still inside **`sub_1405211a0`**’s mega-dispatch).

| **Site** | **`memcpy` @** | **Tag / prelude** | **TTL / dword anchor (for tooling)** |
|---:|---|---|---|
| **A** | **`0x1402f5ed1`** | **`mov word [rsp+0x200], 0xf`**, **`sub_1405211a0(rsp+0x108, rsp+0x200)`** @ **`0x1402f5e7a`**, **`mov word [rsp+0x100], 0xf`** @ **`0x1402f5e7f`** | **Correction (§J.4.3):** the **`rax_11[1].d`** dword staged at **`rsp+0x108`** **before** **`sub_1405211a0`** is **not** the value **`memcpy` reads** at slab **`+8`**. The **`0xf`** tail (and siblings that **`jmp` to `sub_1405208d0` @ `0x140534d1d`**) builds a **Rust `String` / alloc header** at **`arg1 = rsp+0x108`** via **`sub_1405208d0` @ `0x1405208d0`**, which **`movupd`-zeros `[arg1..+0x0f]`**, then **`movsd [arg1+0x18], xmm2`** (**allocator-derived scalar**). Treat **`memcpy` Site A** as **“post-`sub_1405211a0` slab”**, not **raw `rax_11` at `+8`**. |
| **B** | **`0x1402f83a1`** | **`mov word [rsp+0x1a0], 0x14`**, **`sub_1405211a0(rsp+0x108, rsp+0x1a0)`** @ **`0x1402f833f`**, **`mov word [rsp+0x100], 0x14`** | Same **`sub_1405208d0`** class of tail as **A** (different **`word`** → different **`jump_table`** row); **no `rax_11` reload** in the immediate prelude. |
| **C** | **`0x1402f89e0`** | **`mov word [rsp+0x200], 0x10`**, **`sub_1405211a0(rsp+0x108, rsp+0x200)`** @ **`0x1402f8986`**, **`mov word [rsp+0x100], 0x10`** | Same shape as **A** with tag **`0x10`**. |
| **D** | **`0x1402f7d60`** | **`sub_1405211a0(rsp+0x200, rsp+0x1a0)`** @ **`0x1402f7ce3`** (**`arg1` is `rsp+0x200`**, **`arg2` head `word = 0x190`**), **`mov word [rsp+0x100], 0x190`**, inner **`memcpy(rsp+0x108, rsp+0x200, 0x88)`** @ **`0x1402f7d00`**, then outer **`memcpy(..., 0x90)`** with **`rsi = rsp+0x100`** | **`0x88`** clone **still runs after** the **`arg1 = rsp+0x200`** **`sub_1405211a0`** pass, so **`rsp+0x108..`** is filled from the **already-mutated `0x200` scratch**, not from the stale **`rax_11 → 0x108`** dword alone. |

##### J.4.3) **`sub_1405208d0`** ( **`sub_1405211a0` → `sub_140534d1d` tail** ) — **clobbers `arg1` head; `+0x18` is allocator math, not `rax_11[1].d`**

Disassembly (**`0x1405208d0`**): **`movupd xmmword [rdi], xmm0`** after **`xorpd xmm0, xmm0`** (**`0x140520a46`–`0x140520a4a`**) clears **`[arg1..+0x0f]`**. With **`arg1 = rsp+0x108`** ( **`&var_300`** in HLIL at **`sub_1402f5840`** ), that **wipes the tape dword** that had just been stored at **`rsp+0x108`**. Later **`movsd qword [rdi+0x18], xmm2`** (**`0x140520a6f`**) writes a **double** derived from **`arg6` / `r14` / `sub_1423d3460`** — i.e. **Rust allocation sizing**, **not** the per-destination **`rax_11[1].d`** hop counter.

**Implication:** **`memcpy(..., 0x90)` Site A/C** cannot be documented as **“`rax_11[1].d` survives at slab `+8`”**. The **tape ring `+0x18`** dword (**§J.4**) and **`sub_140516d40` `arg2+0x48`** dword (**§J.4.1**) remain valid **where those stores actually ship**. The **`sub_1405211a0` prelude** is a **different consumer** of the same stack window.

##### J.4.4) **Compose `sub_1402f9a40` + neighbor `sub_14037d450` — explicit `arg1 + 0x18` traffic**

**`sub_1402f9a40`:** HLIL shows **`*(arg1 + 0x18) = var_130:8.q`** @ **`0x1402fbd3b`** (same **`r13 == 4`** / **`var_10b`** / **`var_130`** cluster as **`arg1[1].q = var_130.q`** immediately above). So **compose mode does write a full qword at `&var_308 + 0x18`**, sourced from **`var_130`’s upper half**, **independent** of the **`rax_11`** reload skipped when **`+0x7a == 2`**.

**`sub_14037d450`:** on **`sub_1406b6550`** hit, HLIL moves **`*(rbx_2 + 0x18)`** into **`arg1[1]`** (**`0x14037d56e`–`0x14037d57f`**) and writes **`arg4`** back through **`*(rbx_2 + 0x18)`** — the **neighbor row’s `+0x18` lane** is literally the **swap target** for **`&var_308`**.

##### J.4.5) **`sub_1405208d0` `xmm2` (the `movsd [arg1+0x18], …` value) — closed as non–hop-TTL**

HLIL for **`sub_1405208d0` @ `0x1405208d0`** shows **`*(arg1 + 0x18) = zmm2.q`** where **`zmm2[0]`** is a **pure floating pipeline** built from:

- **`arg6`** (second buffer length) through **`_mm_unpacklo_epi32`**, **`subpd`**, **`sub_1423d3460`**, **`+ 2.0`**; and  
- **`r14 = arg8[1].q`** (from **`arg8`**) through a parallel **`subpd` / `unpckhpd` / addsd / mulsd` by `5.0`**, then **`addsd` the first pipeline’s result**, then **`addsd` duplicate** (**`zmm2[0] + zmm2[0]`**).

There is **no load** of **`rax_11`**, **`var_300`**, or any **five-byte tuple / ring row** in this helper — only **`memcpy` lengths**, **`arg7`/`arg8` pointer pairs**, and **`.rdata` double constants** (**`data_14243cec0` / `…ced0` / `…cee0` / `…cef0` / `…cee8`** in disasm).

**Conclusion for tooling:** treat **`[arg1+0x18]` after `sub_1405208d0`** as **Rust `String` / allocator metadata bits** (often interpreted as **`f64`**), **not** the **wire hop counter** you get from **`rax_11[1].d`** on the **tape ring** (**§J.4**) or **`sub_140516d40` `arg2+0x48`** (**§J.4.1**). If a capture ever **numerically matches** this field, it is a **coincidence unless proven** by side-by-side register logging.

##### J.4.6) **`memcpy` Site D (`0x190`) — instruction order (still not a full byte map)**

Disasm @ **`0x1402f7cb7`–`0x1402f7d08`** in **`sub_1402f5840`**:

1. **`mov word [rsp+0x1a0], 0x190`** — seeds **`arg2`** for **`sub_1405211a0`**.
2. **`sub_1405211a0(rsp+0x200, rsp+0x1a0)`** @ **`0x1402f7ce3`** — **`arg1 = rsp+0x200`** (not **`0x108`**): **`sub_1405208d0`**, when invoked, **mutates the `0x200` scratch** the same way as **§J.4.3**, but anchored at **`rsp+0x200`**.
3. **`mov word [rsp+0x100], 0x190`** — tags the **`var_308` head** like other **`memcpy`** sites.
4. **`memcpy(rsp+0x108, rsp+0x200, 0x88)`** @ **`0x1402f7d08`** — **copies `0x88` bytes** so **`[rsp+0x108 .. +0x18f]`** is filled from the **post-`5211a0` `0x200` layout** (then the outer **`memcpy(..., 0x90)`** @ **`0x1402f7d60`** ships **`rsp+0x100`**).

**`rsp+0x200`** is **reused across many unrelated sites** in **`sub_1402f5840`** (grep **`[rsp+0x200]`** in disasm). For **TTL rules**, treat **`0x200`** here as **`String` scratch + `sub_1405208d0` header**, **not** **`rax_11[1].d`**.

##### J.4.7) **Site D path guards + what `*arg2 == 0x190` actually does**

**Guards on the fall-through into `0x1402f7cb7`** ( **`sub_1402f5840`** disasm **`0x1402f7c00`–`0x1402f7cb6`** ):

- **`[rsp+0xe8] >= 7`** else jump **`0x1402f7d69`** (skip the whole **`0x190` / `5211a0` / `memcpy`** spine).
- Load **`rcx = [rsp+0xe0]`**; XOR/OR **two immediates** against the first **`dword` / `dword`** of the buffer (**`0x1402f7c1c`–`0x1402f7c2d`**) — rejects **`str` heads** that do not match the **expected ASCII prefix** (compiler-lowered constants).
- **`rdx` length branch** and **`byte [rcx+7] > 0xbf`** or **`sub_1423babb0`** + **`test al, 1`** — UTF-8 / validity style gate; failures jump **`0x1402f7d69`**.
- **`shr rax, 0x20`** @ **`0x1402f7c5a`** folds **`sub_1423babb0`** output into **`sub_14079a770`** @ **`0x1402f7c97`** (predicate **`al`**); failure **`je 0x1402f7d69`**.
- **`[rsp+0x90]`** entity: **`cmp qword [[rsp+0x90]+0x18], 0`** @ **`0x1402f7cac`–`0x1402f7cb1`** — skip if **non-zero** ( **`String` non-empty** ).

On this **success slice**, there is **no** **`mov` / `movaps` / `movups` into `[rsp+0x200]`** between **`0x1402f7c5a`** and **`lea rcx,[rsp+0x200]` @ `0x1402f7cd3`**: the **first structured writer** is **`sub_1405211a0`**, whose prologue already **zeros `arg1`’s head** when it routes through **`sub_1405208d0`** (**§J.4.3** / **§J.4.5**). So the old “**stale stack preimage** before **`5211a0`**” concern for **Site D `0x200`** is **closed for bytes `[rsp+0x200 .. +0x0f]`**; only the **`0x88` tail** beyond the **`5208d0` header** still needs case-specific HLIL if you ever need **bit-identical** replay beyond **`memcpy`**.

**Opcode `0x190` inside `sub_1405211a0`:** **`movzx` off `*arg2`** hits **`jump_table_140536480`**; HLIL for **`sub_1405211a0`** shows **`case 0x140531832`** (**`*arg2 == 0x190`**) clearing locals then **`return sub_140531847(&jump_table_140536480, arg2, arg3, arg4) __tailcall`**. **`decompile_function("sub_140531847")`** sets **`arg_40 = 0x19b`**, wires a long **Architects / recruit** **`.rdata` string** into **`arg_20`**, and **`return sub_140534d0a(rsi, …, 0x66, &arg_f8) __tailcall`** — i.e. **another canned-dialog `String` build into `rsi` / `arg1` (`rsp+0x200` from `sub_1402f5840`)**, not a **hop counter** load from **`rax_11`**.

##### J.5) Goal: **initial TTL per packet** — all sends vs some, and what BN already implies

**End state you want:** for **each** logical emit (per **tick**, **endpoint**, **destination row** / **`rdi_43`**, and **profile**: tape vs compose vs **`memcpy`**), know the **numeric initial TTL** (or **“none / infinite”**) the game attaches **before** filters/endpoints decrement it (your simulator already matches **decrement sites**).

**It is not one global constant for every packet:**

| **Source (HLIL spine)** | **Initial TTL–like dword** | **“All packets?”** |
|---|---|---|
| **Tape / `0x7a != 2`** | **`rax_11[1].d` → `var_300.d`**, then e.g. ring row **`+0x18`** on the beep/PINGPONG path (**§J.4** table) | **Only sends that take this reload.** **`rax_11`** is **`var_128_1 + 0x10 + rdi_43*0x30`** — value can **differ per destination index** **`rdi_43`**, so TTL is **data-driven per row**, not automatically the same for every packet from that endpoint. |
| **Compose / `sub_1402f9a40` (`0x7a == 2`)** | When **`+0x7a` stays `2`**, HLIL **skips** **`var_300 ← rax_11[1].d`** (**§J.3**). TTL must come from **composer + neighbor swap** (**`sub_14037d450`** copies **`*(rbx_2+0x18)`** into **`var_268`**, etc.) or from **later** **`memcpy` / `sub_140516d40`** packing — **not** the same **`rax_11`** load. | **Only packets that actually run the compose gate** (regional mainframe / infection-style tails you care about). |
| **`sub_140516d40` / `memcpy` 0x90`** | **`sub_140516d40`:** **§J.4.1** (**`arg2+0x48` → `0x58` row `+0x48`**). **`memcpy` `0x90`:** **§J.4.2**–**§J.4.7** — **`sub_1405211a0` + `sub_1405208d0`** build **Rust `String` headers**; **`xmm2` @ `arg1+0x18` is not hop TTL** (**§J.4.5**). **Site D** order (**§J.4.6**) + guards + **`0x190 → sub_140531847`** (**§J.4.7**) — **no** **`[rsp+0x200]`** stores **before** **`5211a0`** on the traced slice; **`0x190`** is **canned dialog**, not **`rax_11[1].d`**. | **Subset** of emits (wrong branch class if you assume every send hits **`sub_140516d40` @ `0x1402f66ea`** — **`+0x3a == 2`** skips that block, **§J.3**). |

**Practical way to answer “each packet” in the tools:**

1. **Instrument or capture** one run per **profile** (tape-only, compose-only, portal **`memcpy`**) and log **two dwords**: **header** (your existing **`header` / `headerHexU32`**) and **candidate TTL** read from the **same row** offset you believe is **`+0x18`** once the **`0x58` / `0x28` / `0x90`** map is finalized.
2. **§J.4.1**–**§J.4.7** cover **`sub_140516d40`**, **`memcpy` `0x90`**, **`sub_1405211a0` / `sub_1405208d0`** (**`xmm2` closed in §J.4.5**), **compose / neighbor `+0x18`**, **Site D ordering + guards + `0x190` → `sub_140531847`**, and the **§E.6** **`516d40`** xref table. Remaining BN work: **per-callee `arg2` packing** for relay / graph / dummy / nav (**§E.6** bodies), not **`rsp+0x200` stale preimage** on Site D.

**Repo note:** until **`MessageEvent`** (or export JSON) carries **`ttlInitial`**, **`pnpm sched:sequence`** cannot regress **per-packet TTL**; add a field once the mapping row is chosen.

---

## 6) Goals: simulator vs “full game” parity

### Simulator scope (what this repo is aiming for)

The **target** is a **reasonable replica** of Tunnet’s endpoint traffic in the tools (`recovered-endpoint-scheduler`, message export, comparisons): right cadence, right branches for the tuples you care about, and **headers that match the game’s chosen values** where we have recovered them (today mostly as **32-bit integers** in code / JSON—the same bits the game packs into headers).

**Automatic phase progression** (story/zone systems writing `0x1c4` / `0x1c5` over time) is **out of scope**: treat saves as a **line-in** with **`pnpm sched:sequence`** / **`pnpm sched:compare`** (see **§9**), not something the simulator must replay from world state.

**“Exact strings of the headers”** here means: **bit-exact header values** plus stable renderings: see **`src/packet-header-format.ts`** (`formatHeaderExact`, **`MainframeHeaderU32`**) and **`out/message-sequence.json`** per-event **`headerHexU32` / `headerBytesLe` / `headerBytesBe`**. If the on-wire layout includes **extra bytes** beyond the 32-bit word, that framing is a **separate** capture task.

### Still in scope to improve the replica

1. **Public address → internal tuple** encoding: match the game for every tuple class the driver actually uses.
2. **Who can receive a send**: candidate construction and RNG sampling (**`sub_140673740` / `sub_140673b40`**) aligned with **`sub_1400af880`** / neighbor tables—not random placeholders.
3. **Same-tick ordering** where it changes who sends or what is seen first (receive vs scheduled send).
4. **Wire packet TTL** (initial value, decrement sites, expiry): **`src/simulator.ts`** is a **scaffold** with **`ttl === undefined` ⇒ never expires**; recover real rules from the binary (**§5 J**).

### Binary notes (background, not all required for the simulator)

- `0x1c4` / `0x1c5` **writers** outside the scheduler (**`sub_1401f5660`**, **`sub_140165cb0`**, …) matter for **full** game fidelity; for the **simulator**, seeding initial **`phaseA` / `phaseB`** is enough.
- Scheduler-only **`0x1c4`** ladder **`5→6→7`** remains documented in **`applyRecoveredStateTransitions`**; **`BinaryObservedPhaseA`** lists other values seen in the binary for reference.

### MCP timeouts (`read timed out` / `Not connected`)

These are almost always **process or socket** issues on the BN side, not your repo:

1. **Binary Ninja must stay running** with `tunnet.exe.bndb` open; closing BN drops the bridge immediately (`Not connected`).
2. **First request after idle** can exceed a short HTTP timeout — retry `list_binaries` once; if it keeps timing out, restart the MCP bridge / BN plugin listener (whatever starts `localhost:9009`).
3. **Heavy views** (huge decompile on first open): wait until analysis quiesces, then retry a small call (`list_binaries`, then `function_at`).
4. Keep the **one-request-at-a-time** rule; parallel MCP calls still correlate with disconnects.
5. **`get_data_decl` stalls:** some **`.rdata` symbol bases** (example **`data_142428768` @ `0x142428768`**) make BN spend a long time on **type / string decoration** for a **large** labeled object. Prefer **`get_data_decl` on a concrete numeric VA inside the blob** with a **small `length` (4–8)** — e.g. **`0x142428770`** for **`*(data_142428768+8)`** (**§J.3.2**).

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

For a **static inventory of every `.text` call to `sub_140673b40`** and the decoded **literal strings** in each candidate vector (no MCP required), run **`pnpm extract:packet-pools`** — see **§9** (**`scripts/extract-packet-string-pools.py`**). Three call sites on the stock build still need CFG/BN follow-up (**§9** lists RVAs).

### Step 6: Validate lifecycle/ordering

In `sub_1402f5840`, trace slot/state field updates (`+0x7a` and related payload fields) to resolve:

- receive vs scheduled send precedence (**partially documented §E.1a**: **`0x1402f5bfe` vs `0x1402f75bf`**, **`0x1402f5bdb` / `rdi_43` loop**)
- wire-level **wrong-address bounce** vs normal send (**not** the **`SendBack`** serde xrefs — **§E.1b**; still trace **`sub_14044eae0` / `sub_1400af880`** families)
- drop/reset transitions
- **TTL / hop field** (if distinct from the above): initial write, decrements, expiry — see **§5 J**

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

### Core sources

- **`src/simulator.ts`**
  - **Topology tick simulator** (endpoints / relays / hubs / filters): optional **`Packet.ttl`**, bounce decrement, filter operating-port decrement, **`ttlExpired`** / **`bounced`** stats. **`ttl === undefined` ⇒ no countdown** (infinite-life scaffold). **Not** recovered from **`tunnet.exe`**; replace with **§5 J** once the wire field and rules are known.

- **`src/recovered-endpoint-scheduler.ts`**
  - Recovered scheduler: `evaluateEndpointSend`, `applyRecoveredStateTransitions` (today: **`sub_1402f5840`** status ladder for `0x1c4` only).
  - **`BinaryObservedPhaseA`**: named constants for `*(node+0x1c4)` values seen in the binary (scheduler **`5`–`7`**, zone fn **`sub_140165cb0`** **`0xc`–`0xe`**, **`0x13`**).
  - **`initialRecoveredSchedulerState(phaseA?, phaseB?)`**: builds `{ phaseA, phaseB }` mirroring game **`0x1c4` / `0x1c5`** at simulation start (“save” line-in).

- **`src/scheduler-comparison.ts`**
  - **`compareRecoveredAgainstCurrentImplementation(ticks, dataPath, encodingStrategy, initialRecoveredState?)`** — fourth argument is initial **`RecoveredSchedulerState`** (default **`{ phaseA: 0, phaseB: 0 }`**).

- **`src/export-message-sequence.ts`**
  - Writes **`out/message-sequence.json`**. Each event includes **`header`** (number) plus **`headerHexU32`**, **`headerBytesLe`**, **`headerBytesBe`** from **`formatHeaderExact`** (see below).

- **`src/packet-header-format.ts`**
  - **`formatHeaderExact(header)`** — exact string forms of the 32-bit header: literal-style **`0x…`**, little-endian byte hex, big-endian byte hex.
  - **`MainframeHeaderU32`** — fixed mainframe phase header words (`a === 4`, `phaseB` **0..5**) for cross-checks against BN.

- **`src/game-packet-strings.ts`**
  - Curated **subject / copy** literals wired into the simulator for specific **`evaluateEndpointSend`** profiles (**status-family**, **ad-family**, **search-family** rotation, etc.). Each pool matches rows passed to **`sub_140673b40`** on known branches; **`pick*Placeholder`** helpers are **tick-based stand-ins** until **`sub_140673b40`** / RNG state is ported (**`packetSubjectPickMode`** in **`out/message-sequence.json`** stays **`placeholder`** until then).
  - For the **full static list** of pools from the binary (not profile-keyed), use **`pnpm extract:packet-pools`** → **`out/packet-string-pools.json`** (**§9** below).

- **`scripts/extract-packet-string-pools.py`** (+ **`pnpm extract:packet-pools`**)
  - **Purpose:** Offline PE scan of **`tunnet.exe`**: find every **`call`** in **`.text`** whose displacement targets **`sub_140673b40`** (VA **`0x140673b40`**, RVA **`0x673b40`**, PE ImageBase **`0x140000000`** on the stock Steam build).
  - **Method:** Walk backward from each callsite through the MSVC-style **slot builder** (**`lea rax, [rip+disp]`** → store pointer → store **`imm32`** length in **`[rsi|rbx|rdi]+disp`**, sometimes **`mov qword [rsp+disp], imm`** / **`mov byte [rsp+0x73], 1`** filler) until **`mov edx`, pool size**, optionally **`lea r8,[rsp+0x78]`**, then **`call`**.
  - **Output:** **`out/packet-string-pools.json`** (under **`out/`**, gitignored). Top-level fields include **`callSiteCount`**, **`decodedOkCount`**, **`decodedFailCount`**, **`noMovEdxCount`**, **`imageBase`**, **`calleeRva`**. Each **`pools[]`** entry has **`callRva`** / **`callRvaHex`**, **`poolSize`**, **`strings`** (ordered as in memory before the uniform pick), **`decodeStatus`** (**`ok`** | **`fail`** | **`no_mov_edx`**), **`decodeError`** (tail hex / reason when not **`ok`**), **`rcxNote`** (how **`rcx`** was set before the call, e.g. **`rcx_rsi`**, **`rcx_r14`**).
  - **Coverage (stock Steam `tunnet.exe`):** **25** callsites found; **22** decode with **`decodeStatus: ok`**. **3** remain **`fail`** (**`0x2fb46a`**, **`0x2fb782`**, **`0x2fb82c`**) — XMM / **`jmp`** / Rust **`&str`** paths the linear decoder does not follow; recover with Binary Ninja (CFG) or extend **`scripts/extract-packet-string-pools.py`**. Hints: **`0x2fb782`** / **`0x2fb82c`** share the **`CONFIDENTIAL` / `TOP SECRET`** builder with **`0x2fb62f`**; **`0x2fb46a`** is **`rcx = r14`** with corn **`&str`** metadata at **`0x1424247d8`** and architect text nearby in **`.rdata`**.
  - **Scope limits:** Only strings reached via **`sub_140673b40`**. Other packet copy paths (no call to this helper, different binaries, future patches) are **not** included. Re-run after game updates; RVAs and codegen can shift.
  - **CLI:** `python scripts/extract-packet-string-pools.py [--exe path/to/tunnet.exe] [--out path/to.json]`

- **`scripts/extract-tunnet-rdata-strings.py`** (+ **`pnpm extract:exe-strings`**)
  - Dumps **every** contiguous printable-ASCII run in the chosen PE section(s) (default **`.rdata`**, default **`--min-len 0`** = length **≥ 1**) to **`out/tunnet-rdata-strings.jsonl`**—**no content filter**, no second output file. There is **no VA range** beyond full section bounds. Use **`rg`** / **`grep`** on that JSONL to narrow (file is huge at **`--min-len 0`**). **`--min-len N`** (N ≥ 1) shortens runs; **`--sections .rdata,.text`** adds sections; **`--exe`** sets the binary path.

### CLI: set initial phase (save line-in)

Both **`pnpm sched:sequence`** and **`pnpm sched:compare`** accept optional trailing **`phaseA`** / **`phaseB`** after **`ticks`** and optional **`encodingStrategy`**:

| Arguments | Meaning |
|-----------|---------|
| `ticks` | Tick count (required for explicit non-default; default **2048** sequence / **4096** compare). |
| `encodingStrategy` | One of **`identity`**, **`plus_one_all_octets`**, **`plus_one_first_octet`**. If omitted, default is **`plus_one_all_octets`**. |
| `phaseA` | Initial **`*(+0x1c4)`**-mirroring value (integer). |
| `phaseB` | Initial **`*(+0x1c5)`**-mirroring value (integer). |

If **`argv[1]`** is not a known strategy string, it is parsed as **`phaseA`** (strategy stays default). Examples:

```bash
pnpm sched:sequence 2048 plus_one_all_octets 5 2
pnpm sched:sequence 2048 identity 6 0
pnpm sched:sequence 4096 5 3
pnpm sched:compare 4096 plus_one_all_octets 5 0
```

**`out/message-sequence.json`** `metadata` includes **`initialPhaseA`**, **`initialPhaseB`** (start) and **`phaseA`**, **`phaseB`** (end of run after any modeled transitions). Each **`events[]`** item includes **`headerHexU32`**, **`headerBytesLe`**, **`headerBytesBe`** alongside numeric **`header`**.

### MCP / BN quirk

- **`function_at`** may return a valid function name in the payload while the Cursor MCP client reports a **schema validation error** (expects a plain string). Prefer **`decompile_function("sub_…")`** when you already know the name (e.g. **`sub_140165cb0`** for the secondary **`0x1c5`** site near **`0x140166850`**).

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
