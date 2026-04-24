/** Send rate = 2^exponent (each slider step doubles/halves emission rate). */
export const SEND_RATE_EXP_MIN = -6;
export const SEND_RATE_EXP_MAX = 6;
export const SEND_RATE_EXP_DEFAULT = 0;

export function sendRateMultiplierFromExponent(exp: number): number {
  return 2 ** exp;
}

export function formatSendRateLabel(exp: number): string {
  const m = sendRateMultiplierFromExponent(exp);
  return `${m}× (2^${exp})`;
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
  return `${m}× (2^${exp})`;
}
