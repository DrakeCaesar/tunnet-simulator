/** Layout metrics for packet dots / IP labels on the builder packet SVG overlay. */

export const PACKET_IP_LABEL_CHAR_COUNT = 7;
export const PACKET_IP_LABEL_MONO_CHAR_ADVANCE_PX = 6.1;
export const PACKET_IP_LABEL_WIDTH_PX = Math.ceil(PACKET_IP_LABEL_CHAR_COUNT * PACKET_IP_LABEL_MONO_CHAR_ADVANCE_PX + 8);
export const PACKET_IP_LABEL_HEIGHT_PX = 24;
export const PACKET_DOT_RADIUS_PX = 8;
/** Gap from dot edge to label (text + bg follow this anchor). */
export const PACKET_LABEL_ANCHOR_GAP_PX = 12;
export const PACKET_LABEL_ANCHOR_X_PX = PACKET_DOT_RADIUS_PX + PACKET_LABEL_ANCHOR_GAP_PX;
export const PACKET_IP_LABEL_OFFSET_X_PX = -3;
export const PACKET_IP_LABEL_OFFSET_Y_PX = -13;
/** Extra vertical space when showing subject line under src/dest. */
export const PACKET_IP_LABEL_HEIGHT_WITH_SUBJECT_PX = 38;
export const PACKET_SUBJECT_LABEL_MAX_CHARS = 40;

export function formatPacketLabelSubject(subject: string | undefined): string {
  const t = (subject ?? "").trim();
  if (!t.length) return "";
  return t.length > PACKET_SUBJECT_LABEL_MAX_CHARS
    ? `${t.slice(0, PACKET_SUBJECT_LABEL_MAX_CHARS - 1)}…`
    : t;
}

export function packetIpLabelBgDimensions(
  src: string,
  dest: string,
  subjectDisplay: string,
): { width: number; height: number } {
  const maxChars = Math.max(src.length, dest.length, subjectDisplay.length, PACKET_IP_LABEL_CHAR_COUNT);
  const width = Math.min(
    260,
    Math.ceil(maxChars * PACKET_IP_LABEL_MONO_CHAR_ADVANCE_PX + 10),
  );
  const height = subjectDisplay.length ? PACKET_IP_LABEL_HEIGHT_WITH_SUBJECT_PX : PACKET_IP_LABEL_HEIGHT_PX;
  return { width, height };
}
