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
