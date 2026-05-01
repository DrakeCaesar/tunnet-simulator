/**
 * Exact string forms of the 32-bit packet header word used by the recovered
 * scheduler (`sub_1402f9a40`–style values). Same numeric `header` in JSON,
 * multiple equivalent renderings for logs, diffs, and wire dumps.
 */

export type HeaderExactStrings = {
  /** Lowercase `0x` + unsigned 32-bit hex (same convention as literals in `recovered-endpoint-scheduler.ts`). */
  headerHexU32: string;
  /** Eight lowercase hex nybbles: first byte = least significant byte of the word (typical x86 memory order). */
  headerBytesLe: string;
  /** Eight lowercase hex nybbles: first byte = most significant byte of the word. */
  headerBytesBe: string;
};

const u32 = (n: number): number => n >>> 0;

/** Fixed headers for `a === 4` mainframe path, phaseB `0..5` (from recovered model / BN switch cases). */
export const MainframeHeaderU32 = {
  phase0: 0x1020104,
  phase1: 0x4020104,
  phase2: 0x1020104,
  phase3: 0x2020104,
  phase4: 0x3020104,
  phase5: 0x4020104,
} as const;

export function formatHeaderExact(header: number): HeaderExactStrings {
  const v = u32(header);
  const hex = v.toString(16);
  const headerHexU32 = `0x${hex}`;
  const b0 = v & 0xff;
  const b1 = (v >>> 8) & 0xff;
  const b2 = (v >>> 16) & 0xff;
  const b3 = (v >>> 24) & 0xff;
  const byte = (x: number): string => x.toString(16).padStart(2, "0");
  return {
    headerHexU32,
    headerBytesLe: `${byte(b0)}${byte(b1)}${byte(b2)}${byte(b3)}`,
    headerBytesBe: `${byte(b3)}${byte(b2)}${byte(b1)}${byte(b0)}`,
  };
}

/** Maps header u32 (LE bytes) to wiki-style dotted mask (`0` in header → `*`, else `byte-1`). */
export function headerToMask(header: number): string {
  const a = header & 0xff;
  const b = (header >>> 8) & 0xff;
  const c = (header >>> 16) & 0xff;
  const d = (header >>> 24) & 0xff;
  const part = (v: number): string => (v === 0 ? "*" : String(v - 1));
  return `${part(a)}.${part(b)}.${part(c)}.${part(d)}`;
}

/**
 * Wiki **`0.k.0.0`** with **`k` in 1..3** — regional mainframe; broadcast scope **`0.k.*.*`**.
 * Fixed **`mainframe-phase-sequence`** headers (`0x1020104`, …) do not encode that scope in {@link headerToMask}.
 */
export function mainframeRegionalBroadcastMaskFromWikiAddress(address: string): string | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  if (parts[0] === "0" && parts[2] === "0" && parts[3] === "0") {
    const k = parts[1];
    if (k === "1" || k === "2" || k === "3") return `0.${k}.*.*`;
  }
  return null;
}

/**
 * Destination wiki mask for logging / non-mainframe routing.
 * **`mainframe-phase-sequence`**: returns **`0.k.*.*`** for wiki **`0.k.0.0`**; edge lists in
 * **`compare-endpoint-edges`** / **`export-message-sequence`** still expand **every** wiki **`sends_to`**
 * target on that send (wiki table semantics; header does not encode cross-region picks).
 */
export function dstWikiMaskForRecoveredSend(
  wikiSourceAddress: string,
  header: number,
  profile: string,
): string {
  if (profile === "mainframe-phase-sequence") {
    const m = mainframeRegionalBroadcastMaskFromWikiAddress(wikiSourceAddress);
    if (m !== null) return m;
  }
  return headerToMask(header);
}
