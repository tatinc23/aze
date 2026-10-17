/** Split a payment between the filer and the platform. Integer micro-USDC; the platform gets the rounding remainder. */
export function split(amountMicro: number, filerBps: number): { filer: number; platform: number } {
  if (!Number.isInteger(amountMicro) || amountMicro < 0) throw new Error(`split: bad amount ${amountMicro}`);
  if (!Number.isInteger(filerBps) || filerBps < 0 || filerBps > 10000) throw new Error(`split: bad bps ${filerBps}`);
  const filer = Math.floor((amountMicro * filerBps) / 10000);
  return { filer, platform: amountMicro - filer };
}
