/** Send probability per eligible tick = 2^exponent (1/128 ... 1). */
export const SEND_RATE_EXP_MIN = -7;
export const SEND_RATE_EXP_MAX = 0;
export const SEND_RATE_EXP_DEFAULT = 0;

export function sendRateMultiplierFromExponent(exp: number): number {
  return 2 ** exp;
}

export function formatSendRateLabel(exp: number): string {
  const p = sendRateMultiplierFromExponent(exp);
  if (p >= 0.999999) return "1 (100%)";
  if (exp < 0) return `1/${2 ** (-exp)} (${(p * 100).toFixed(2)}%)`;
  return `${p.toFixed(3)} (${(p * 100).toFixed(2)}%)`;
}

/** Tick animation speed = 2^exponent (0.25× … 64×). */
export const SPEED_EXP_MIN = -2;
export const SPEED_EXP_MAX = 6;
export const SPEED_EXP_DEFAULT = 1;

export function speedMultiplierFromExponent(exp: number): number {
  return 2 ** exp;
}

export function formatSpeedLabel(exp: number): string {
  const m = speedMultiplierFromExponent(exp);
  if (exp < 0 && Number.isInteger(exp)) {
    return `1/${2 ** (-exp)}x`;
  }
  return `${m}x`;
}
