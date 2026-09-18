// "Unevictable pods by node"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PpBlockedNode } from './types';

export interface PpNodeCats {
  optimized: number;
  unevictable: number;
  notReady: number;
  ownerless: number;
}

/** Nested objects the backend might hang the per-node counts on. */
const NESTED_KEYS = ['podCategories', 'podsByCategory', 'categoryCounts', 'podBreakdown', 'breakdown', 'categories'];

/** Aliases per category — first numeric hit wins. */
const CAT_ALIASES: [keyof PpNodeCats, string[]][] = [
  ['optimized', ['optimized', 'optimizedBinPacked', 'binPacked', 'optimizedPods', 'optimizedBinPackedPods']],
  ['unevictable', ['unevictable', 'unevictablePods']],
  ['notReady', ['notReady', 'unready', 'notReadyPods', 'unreadyPods']],
  ['ownerless', ['ownerless', 'withoutOwner', 'noOwner', 'ownerlessPods', 'withoutOwnerPods']],
];

/** Extract the per-node category counts, or null when the backend doesn't send them yet. */
export function nodeCategoryCounts(n: PpBlockedNode): PpNodeCats | null {
  const rec = n as unknown as Record<string, unknown>;
  let src: Record<string, unknown> = rec;
  for (const k of NESTED_KEYS) {
    const v = rec[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      src = v as Record<string, unknown>;
      break;
    }
  }
  const out: PpNodeCats = { optimized: 0, unevictable: 0, notReady: 0, ownerless: 0 };
  let found = false;
  for (const [cat, aliases] of CAT_ALIASES) {
    for (const a of aliases) {
      const v = src[a];
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[cat] = v;
        found = true;
        break;
      }
    }
  }
  return found ? out : null;
}

export function hasNodeCategoryData(nodes: PpBlockedNode[]): boolean {
  return nodes.some((n) => nodeCategoryCounts(n) !== null);
}

const CAT_META: [keyof PpNodeCats, string, string][] = [
  ['optimized', 'Optimized bin-packed', '#3fae6f'],
  ['unevictable', 'Unevictable', '#1e2a5a'],
  ['notReady', 'Not ready', '#a5b4fc'],
  ['ownerless', 'Without owner', '#fbbf24'],
];

const shortName = (s: string) => (s.length > 16 ? '…' + s.slice(-15) : s);

export function UnevictableByNodeChart({ nodes }: { nodes: PpBlockedNode[] }) {
  const data = nodes.map((n) => {
    const c = nodeCategoryCounts(n) || { optimized: 0, unevictable: 0, notReady: 0, ownerless: 0 };
    return { node: n.node, ...c };
  });
  const NAMES: Record<string, string> = Object.fromEntries(CAT_META.map(([k, l]) => [k, l]));
  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke="#f0f1f6" vertical={false} />
          <XAxis
            dataKey="node"
            interval={0}
            tickFormatter={shortName}
            tick={{ fontSize: 9, fill: '#8a93a8' }}
            tickLine={false}
            axisLine={{ stroke: '#e2e5ef' }}
          />
          <YAxis
            allowDecimals={false}
            domain={[0, (dataMax: number) => Math.max(2, Math.ceil(dataMax))]}
            tick={{ fontSize: 9, fill: '#aab' }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            cursor={{ fill: 'rgba(148,163,184,.08)' }}
            formatter={(v: unknown, name: unknown) =>
              [String(v), NAMES[String(name)] || String(name)] as [string, string]
            }
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            labelStyle={{ fontSize: 11 }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            iconSize={10}
            iconType="circle"
            formatter={(v: string) => <span style={{ color: '#475569' }}>{NAMES[v] || v}</span>}
          />
          {CAT_META.map(([k, label, color]) => (
            <Bar key={k} dataKey={k} name={label} stackId="pods" fill={color} isAnimationActive={false} maxBarSize={56} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
