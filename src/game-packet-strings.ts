/**
 * Literal packet copy strings taken from **`tunnet.exe`** (verified by reading
 * `.rdata` at the RVAs referenced before **`sub_140673b40`** in **`sub_1402f9a40`**).
 *
 * Each **`mov edx, 3`** site builds **three** `(ptr, len)` rows and picks one with
 * **`sub_140673b40`** — so “only three” means **three choices per pool**, not three
 * strings for the whole game. The binary has **many** such call sites (`edx` 1, 2,
 * 3, 4, 0xc, 0xf, …); only pools we have decoded are listed here.
 *
 * **Selection:** the game uses internal RNG (`sub_140673b40` / `sub_1406734a0`).
 * Until that state is ported, **`pick*Placeholder`** functions pick deterministically
 * from the tick (stand-in — replace when RNG is matched).
 *
 * **Gaps:** `scripts/extract-packet-string-pools.py` covers all **25** Tunnet **`sub_140673b40`**
 * callsites (three via a **manual** table for nonlinear builders). Some scheduler paths build
 * copy text via **`sub_14067a670`** only (no **`sub_140673b40`** row pool) — those are not in
 * **`out/packet-string-pools.json`**.
 */

/**
 * **`sub_1402f9a40`** reply branch (`r13.d == 2`, tuple `(4,2,1)` on the five-dword row passed as **`arg3`**):
 * `__builtin_strncpy(..., "Re: Re: Re: Re: ...", 0x13)` @ **`0x1402f9d8f`** (subject length **`0x13`** on the outbound layout).
 * The same ASCII appears inside the compound `.rdata` blob at **`data_1424246e0`** (between the Killswitch literals and **`Token`**; see BN **list_strings_filter** `"Re: Re:"`).
 */
export const REPLY_CHAIN_PACKET_SUBJECT = "Re: Re: Re: Re: ..." as const;

/**
 * Single compound `.rdata` row (length **270**) used for infected / “hacked” spam subjects — the game
 * indexes `(ptr, len)` pairs into this blob (see `sub_1402f5840` / HLIL around **`0x1402f8d39`**).
 *
 * **Intentionally unused** here: we do not model hacker endpoints. Kept so tooling and humans can
 * match **`out/sorted.jsonl`** / BN without re-parsing the exe.
 */
export const HACKED_ENDPOINT_SUBJECT_RDATA_BLOB =
  "Congrats! U won!1 simple trick to get **RICH**Free credits! $$$**Perfectly s4fe packet**[URGENT] Open me!U have been hacked!!!Susan shared a document with uRe:Hello :)1nvoice dueD1rect d3positR3sponse requiredEmployee raises!!!Totally n0t a v1rusbeep_infectedbeep_credit" as const;

/**
 * Trivial one-row “pool” wrapper around {@link HACKED_ENDPOINT_SUBJECT_RDATA_BLOB} (same bytes as the game blob).
 * Still **not** wired into {@link pick*} or the scheduler.
 */
export const HACKED_ENDPOINT_SUBJECT_POOL = [HACKED_ENDPOINT_SUBJECT_RDATA_BLOB] as const;

/**
 * Compound `.rdata` row (length **88**) at **`data_1424246e0`**: **`Killswitch (n/4)`** countdown strings,
 * then **`Re: Re: Re: Re: ...`**, then **`Token`**. The scheduler uses slices of this via **`sub_14067a670`**
 * (mainframe / killswitch path); the **`Re:`** substring is also the fixed reply subject in **`sub_1402f9a40`**
 * ({@link REPLY_CHAIN_PACKET_SUBJECT}).
 */
export const KILLSWITCH_REPLY_TOKEN_RDATA_BLOB =
  "Killswitch (4/4)Killswitch (3/4)Killswitch (2/4)Killswitch (1/4)Re: Re: Re: Re: ...Token" as const;

/** `sub_140673b40` @ `0x1402fb97c/0x1402fb91a/0x1402fa3b1/0x1402fb9db`. */
export const TRACK_BROADCAST_SUBJECTS_BY_HALF_TICK_MOD4 = [
  "Track #1",
  "Track #2",
  "Track #3",
  "Track #4",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fb0cf`** (status / mainframe branch). */
export const STATUS_FAMILY_THREE_SUBJECT_POOL = [
  "Status report",
  "Please forward to your endpoints",
  "Mainframe update",
] as const;

/**
 * Before **`sub_140673b40`** at **`0x1402fb46a`** (firmware branch when **`(floor(tick/2)&0xf)!=0`** in **`sub_1402f9a40`**).
 * Matches **`MANUAL_SUB_140673B40_POOLS[0x2FB46A]`** in **`scripts/extract-packet-string-pools.py`**.
 */
export const FIRMWARE_UPDATE_FOUR_SUBJECT_POOL = [
  "Firmware update",
  "Test",
  "Contribute to science",
  "[PATCH] Fix netcode",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fa5bd`** (ad-style branch in same function). */
export const AD_FAMILY_THREE_SUBJECT_POOL = [
  "SALES",
  "HUGE DISCOUNT!",
  "BEST PRICES",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fb2f8`** (`search-family` half-tick mod4 = 0). */
export const SEARCH_REQUEST_SINGLETON_SUBJECT_POOL = ["Search request"] as const;

/** Before **`sub_140673b40`** at **`0x1402fb29b`** (`search-family` half-tick mod4 = 1). */
export const SEARCH_QUERY_SINGLETON_SUBJECT_POOL = ["Search query"] as const;

/** Before **`sub_140673b40`** at **`0x1402fa286`** (`search-family` half-tick mod4 = 2). */
export const SEARCH_ARCHITECTS_FOUR_SUBJECT_POOL = [
  "Where is everyone?",
  "Who are the Architects?",
  "Did anyone survive the Apocalypse?",
  "Where are the Architects?",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fa147`** (`search-family` join-us branch). */
export const SEARCH_JOIN_US_SINGLETON_SUBJECT_POOL = ["Join us!"] as const;

/** Before **`sub_140673b40`** at **`0x1402fb82c`** (`search-family` prayer branch). */
export const SEARCH_PRAYER_TWO_SUBJECT_POOL = [
  "Call To Prayer",
  "We haven't seen you at church today",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fa873`** (school-chat variant). */
export const SCHOOL_HOMEWORK_TWO_SUBJECT_POOL = ["Do my homework", "What's 6 * 7?"] as const;

/** Before **`sub_140673b40`** at **`0x1402fb042`** (`c=2` / `school-chat` header variant). */
export const SCHOOL_SUPPLY_TWO_SUBJECT_POOL = [
  "One bottle of corn oil, please",
  "One battery, please",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fa799`** (`c=2` / `school-chat` long pool). */
export const SCHOOL_CASUAL_FIFTEEN_SUBJECT_POOL = [
  "corn bread recipe",
  "how do I delete this",
  "teddy bear pattern",
  "happy birthday?",
  "how to recharge battery?",
  ":)",
  "need corn oil",
  "do you get these messages?",
  "3615 TUNNET",
  "Bless you!!!",
  "Good morning",
  "I have lost 6 pounds since June",
  "family pictures",
  "how do i use the computer?",
  "hello",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fafcd`** (`c=1`, **`d=3`**, **`test_bit(tick,1)`** true — Student Exchange path). */
export const SCHOOL_STUDENT_EXCHANGE_SINGLETON_POOL = ["Student Exchange Program"] as const;

/** Before **`sub_140673b40`** at **`0x1402fa471`** (`c=3`, **`d=3`**, third-of-half-tick gate — field rations). */
export const SUPPLY_FIELD_RATIONS_SINGLETON_POOL = ["We need field rations"] as const;

/** Before **`sub_140673b40`** at **`0x1402fb572`** (`c=3`, **`d=3`**, third-of-half-tick gate — ammunition). */
export const SUPPLY_AMMUNITION_SINGLETON_POOL = ["We need ammunition"] as const;

/** Before **`sub_140673b40`** at **`0x1402fb62f`** / **`0x1402fb74c`** (two HLIL paths — same two literals). */
export const CONFIDENTIAL_TWO_SUBJECT_POOL = ["CONFIDENTIAL", "TOP SECRET"] as const;

/** Before **`sub_140673b40`** at **`0x1402faecf`** (`c=4`, **`d=4`**, **`test_bit(tick,1)`** false — Status Report capitalized). */
export const STATUS_REPORT_MEETING_HEADER_POOL = ["Status Report"] as const;

/** Before **`sub_140673b40`** at **`0x1402fbab8`** (`c=4`, **`d=4`**, **`test_bit(tick,1)`** true — Meeting minutes). */
export const MEETING_MINUTES_SINGLETON_POOL = ["Meeting minutes"] as const;

/** Before **`sub_140673b40`** at **`0x1402fbbbb`** (`search-family`, fourth rotation slot **`k=3`**). */
export const SEARCH_INVESTMENT_THREE_SUBJECT_POOL = [
  "INVEST NOW!",
  "Economists hate this simple trick",
  "My money is working for me",
] as const;

/** Same strings as `STATUS_FAMILY_THREE_SUBJECT_POOL` for spread / JSON. */
export function statusFamilySubjectCandidates(): readonly string[] {
  return STATUS_FAMILY_THREE_SUBJECT_POOL;
}

export function adFamilySubjectCandidates(): readonly string[] {
  return AD_FAMILY_THREE_SUBJECT_POOL;
}

export function trackBroadcastSubjectForTick(tick: number): string {
  const idx = (tick >>> 1) & 3;
  return TRACK_BROADCAST_SUBJECTS_BY_HALF_TICK_MOD4[idx];
}

export function searchRequestSubjectCandidates(): readonly string[] {
  return SEARCH_REQUEST_SINGLETON_SUBJECT_POOL;
}

export function searchQuerySubjectCandidates(): readonly string[] {
  return SEARCH_QUERY_SINGLETON_SUBJECT_POOL;
}

export function searchArchitectsSubjectCandidates(): readonly string[] {
  return SEARCH_ARCHITECTS_FOUR_SUBJECT_POOL;
}

export function pickSearchArchitectsSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 1) % SEARCH_ARCHITECTS_FOUR_SUBJECT_POOL.length;
  return SEARCH_ARCHITECTS_FOUR_SUBJECT_POOL[idx];
}

export function searchJoinUsSubjectCandidates(): readonly string[] {
  return SEARCH_JOIN_US_SINGLETON_SUBJECT_POOL;
}

export function searchPrayerSubjectCandidates(): readonly string[] {
  return SEARCH_PRAYER_TWO_SUBJECT_POOL;
}

export function pickSearchPrayerSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 4) & 1;
  return SEARCH_PRAYER_TWO_SUBJECT_POOL[idx];
}

export function schoolHomeworkSubjectCandidates(): readonly string[] {
  return SCHOOL_HOMEWORK_TWO_SUBJECT_POOL;
}

export function pickSchoolHomeworkSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 1) & 1;
  return SCHOOL_HOMEWORK_TWO_SUBJECT_POOL[idx];
}

export function schoolSupplySubjectCandidates(): readonly string[] {
  return SCHOOL_SUPPLY_TWO_SUBJECT_POOL;
}

export function pickSchoolSupplySubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 3) & 1;
  return SCHOOL_SUPPLY_TWO_SUBJECT_POOL[idx];
}

export function schoolCasualSubjectCandidates(): readonly string[] {
  return SCHOOL_CASUAL_FIFTEEN_SUBJECT_POOL;
}

export function pickSchoolCasualSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 1) % SCHOOL_CASUAL_FIFTEEN_SUBJECT_POOL.length;
  return SCHOOL_CASUAL_FIFTEEN_SUBJECT_POOL[idx];
}

export function schoolStudentExchangeSubjectCandidates(): readonly string[] {
  return SCHOOL_STUDENT_EXCHANGE_SINGLETON_POOL;
}

export function supplyFieldRationsSubjectCandidates(): readonly string[] {
  return SUPPLY_FIELD_RATIONS_SINGLETON_POOL;
}

export function supplyAmmunitionSubjectCandidates(): readonly string[] {
  return SUPPLY_AMMUNITION_SINGLETON_POOL;
}

export function confidentialSubjectCandidates(): readonly string[] {
  return CONFIDENTIAL_TWO_SUBJECT_POOL;
}

/** Matches **`sub_140673b40`** row order at **`0x1402fb62f`** (decode aligns with **`out/packet-string-pools.json`**). */
export function pickConfidentialSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 5) & 1;
  return CONFIDENTIAL_TWO_SUBJECT_POOL[idx];
}

export function statusReportMeetingHeaderSubjectCandidates(): readonly string[] {
  return STATUS_REPORT_MEETING_HEADER_POOL;
}

export function meetingMinutesSubjectCandidates(): readonly string[] {
  return MEETING_MINUTES_SINGLETON_POOL;
}

export function searchInvestmentSubjectCandidates(): readonly string[] {
  return SEARCH_INVESTMENT_THREE_SUBJECT_POOL;
}

export function pickSearchInvestmentSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 3) % SEARCH_INVESTMENT_THREE_SUBJECT_POOL.length;
  return SEARCH_INVESTMENT_THREE_SUBJECT_POOL[idx];
}

/**
 * Deterministic placeholder — **not** yet `sub_140673b40`.
 * Status-family **mainframe-update** sends only fire on **even** `tick`; we step the index on `(tick >> 1)`.
 */
export function pickStatusFamilySubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 1) % 3;
  return STATUS_FAMILY_THREE_SUBJECT_POOL[idx];
}

export function firmwareUpdateSubjectCandidates(): readonly string[] {
  return FIRMWARE_UPDATE_FOUR_SUBJECT_POOL;
}

/** Row order matches **`FIRMWARE_UPDATE_FOUR_SUBJECT_POOL`** (RNG stand-in). */
export function pickFirmwareUpdateSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 1) & 3;
  return FIRMWARE_UPDATE_FOUR_SUBJECT_POOL[idx];
}

/** Ad-family uses an 8-tick gate; step index on `tick >> 3` so sends do not all alias. */
export function pickAdFamilySubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 3) % 3;
  return AD_FAMILY_THREE_SUBJECT_POOL[idx];
}
