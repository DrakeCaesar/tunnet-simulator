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
 */

/** Before **`sub_140673b40`** at **`0x1402fb0cf`** (status / mainframe branch). */
export const STATUS_FAMILY_THREE_SUBJECT_POOL = [
  "Mainframe update",
  "Please forward to your endpoints",
  "Status report",
] as const;

/** Before **`sub_140673b40`** at **`0x1402fa5bd`** (ad-style branch in same function). */
export const AD_FAMILY_THREE_SUBJECT_POOL = [
  "BEST PRICES",
  "HUGE DISCOUNT!",
  "SALES",
] as const;

/**
 * Before **`sub_140673b40`** at **`0x1402fbbb3`** (search-rotation–adjacent branch;
 * same function — wire only where HLIL matches this path).
 */
export const SEARCH_INVESTMENT_THREE_SUBJECT_POOL = [
  "My money is working for me",
  "Economists hate this simple trick",
  "INVEST NOW!",
] as const;

/** Same strings as `STATUS_FAMILY_THREE_SUBJECT_POOL` for spread / JSON. */
export function statusFamilySubjectCandidates(): readonly string[] {
  return STATUS_FAMILY_THREE_SUBJECT_POOL;
}

export function adFamilySubjectCandidates(): readonly string[] {
  return AD_FAMILY_THREE_SUBJECT_POOL;
}

export function searchInvestmentSubjectCandidates(): readonly string[] {
  return SEARCH_INVESTMENT_THREE_SUBJECT_POOL;
}

/**
 * Deterministic placeholder — **not** yet `sub_140673b40`.
 * Status-family sends only fire on **even** `tick`; we step the index on `(tick >> 1)`.
 */
export function pickStatusFamilySubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 1) % 3;
  return STATUS_FAMILY_THREE_SUBJECT_POOL[idx];
}

/** Ad-family uses an 8-tick gate; step index on `tick >> 3` so sends do not all alias. */
export function pickAdFamilySubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 3) % 3;
  return AD_FAMILY_THREE_SUBJECT_POOL[idx];
}

/** Search-family `d === 2` rotation fires on even ticks; align with `(tick >> 1)`. */
export function pickSearchInvestmentSubjectPlaceholder(tick: number): string {
  const idx = (tick >>> 1) % 3;
  return SEARCH_INVESTMENT_THREE_SUBJECT_POOL[idx];
}
