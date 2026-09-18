
/** '$' + rounded, thousands-separated. */
export const usd = (n?: number | null) => '$' + Math.round(n || 0).toLocaleString();

/** cores ≥1 → "1.23", else millicores → "10m". */
export const cpuFmt = (c?: number | null) =>
  c == null ? '—' : c >= 1 ? c.toFixed(2) : Math.round(c * 1000) + 'm';

/** bytes → "1.23Gi" / "512Mi". */
export const memFmt = (b?: number | null) => {
  if (b == null) return '—';
  const g = b / 2 ** 30;
  return g >= 1 ? g.toFixed(2) + 'Gi' : Math.round(b / 2 ** 20) + 'Mi';
};

const trim2 = (n: number) => String(parseFloat(n.toFixed(2)));

export const coresFmt = (c?: number | null) => (c == null ? '—' : trim2(c));

/* bytes → "110.42 MiB" / "1.74 GiB". */
export const mibFmt = (b?: number | null) => {
  if (b == null) return '—';
  const g = b / 2 ** 30;
  return g >= 1 ? trim2(g) + ' GiB' : trim2(b / 2 ** 20) + ' MiB';
};
