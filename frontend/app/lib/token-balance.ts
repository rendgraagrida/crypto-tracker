/** Normalize raw ERC-20 units only when the provider supplied valid decimals. */
export function formatTokenBalance(raw: unknown, decimals: unknown): { balance: string | null; numericBalance: number | null } {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(raw)) return { balance: null, numericBalance: null };
  const precision = typeof decimals === 'number' ? decimals : typeof decimals === 'string' && /^\d+$/.test(decimals) ? Number(decimals) : NaN;
  if (!Number.isInteger(precision) || precision < 0 || precision > 255) return { balance: null, numericBalance: null };
  const digits = BigInt(raw).toString().padStart(precision + 1, '0');
  const fraction = precision ? digits.slice(-precision).replace(/0+$/, '') : '';
  const balance = precision ? `${digits.slice(0, -precision)}${fraction ? `.${fraction}` : ''}` : digits;
  const numeric = Number(balance);
  return { balance, numericBalance: Number.isFinite(numeric) && (numeric !== 0 || BigInt(raw) === BigInt(0)) ? numeric : null };
}
