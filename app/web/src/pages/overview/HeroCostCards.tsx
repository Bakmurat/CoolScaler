// Hero cost cards
import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { getJson } from '../../api/client';
import { usd } from '../../lib/format';

interface GraphPoint {
  timestamp: string;
  values: Record<string, number | null | undefined>;
}
interface GraphResponse {
  values?: GraphPoint[];
}

const cardSx = {
  background: '#fff',
  border: '1px solid #e9eaf0',
  borderRadius: '14px',
  p: '18px 22px 8px',
  minWidth: 0,
} as const;

const titleSx = { m: 0, fontSize: 16, fontWeight: 700, color: '#1e2536' } as const;

function tickDate(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(+d) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function Gauge({ pct }: { pct: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, pct / 100));
  return (
    <svg width={110} height={110} viewBox="0 0 110 110">
      <circle cx="55" cy="55" r={r} fill="none" stroke="#e5e9ff" strokeWidth={10} />
      <circle
        cx="55"
        cy="55"
        r={r}
        fill="none"
        stroke="#f43f5e"
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c * (1 - frac)}`}
        transform="rotate(130 55 55)"
      />
      <text x="55" y="61" textAnchor="middle" fontSize="24" fontWeight="700" fill="#f43f5e">
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

export default function HeroCostCards() {
  const [rows, setRows] = useState<GraphPoint[]>([]);

  useEffect(() => {
    let dead = false;
    getJson<GraphResponse>(
      '/api/analytics/graph?range=30d&groupBy=day&types=totalWorkloadCostMonthly&types=wastedSpendPct',
    )
      .then((g) => !dead && setRows(g.values || []))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);

  const { costRows, wasteRows, lastCost, lastWaste } = useMemo(() => {
    const cr = rows.map((p) => ({ t: tickDate(p.timestamp), v: p.values?.totalWorkloadCostMonthly ?? null }));
    const wr = rows.map((p) => ({ t: tickDate(p.timestamp), v: p.values?.wastedSpendPct ?? null }));
    const lastOf = (xs: { v: number | null }[]) => {
      for (let i = xs.length - 1; i >= 0; i--) if (xs[i].v != null) return xs[i].v as number;
      return null;
    };
    return { costRows: cr, wasteRows: wr, lastCost: lastOf(cr), lastWaste: lastOf(wr) };
  }, [rows]);

  return (
    <Box
      component="section"
      sx={{
        display: 'grid',
        gridTemplateColumns: '1fr',
        '@media (min-width:1024px)': { gridTemplateColumns: '1fr 1fr' },
        gap: 2,
        alignItems: 'stretch',
      }}
    >
      {/* Live monthly cost */}
      <Box sx={cardSx}>
        <Box component="h2" sx={titleSx}>
          Live monthly cost
        </Box>
        <Box sx={{ textAlign: 'center', fontSize: 34, fontWeight: 700, color: '#4338ca', mt: '2px' }}>
          {lastCost != null ? usd(lastCost) : '—'}
        </Box>
        <Box sx={{ height: 120 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={costRows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={{ stroke: '#e3e5ee' }} minTickGap={70} />
              <YAxis hide domain={[0, 'auto']} />
              <Tooltip
                formatter={(v: unknown) => [typeof v === 'number' ? usd(v) : '—', 'Monthly cost'] as [string, string]}
                labelStyle={{ fontSize: 11 }}
                itemStyle={{ fontSize: 11, padding: 0 }}
                contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
              />
              <Area type="monotone" dataKey="v" stroke="#4338ca" strokeWidth={1.6} fill="rgba(79,70,229,.25)" dot={false} isAnimationActive={false} connectNulls />
            </AreaChart>
          </ResponsiveContainer>
        </Box>
      </Box>

      {/* Wasted spend */}
      <Box sx={cardSx}>
        <Box component="h2" sx={titleSx}>
          Wasted spend
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Gauge pct={lastWaste ?? 0} />
        </Box>
        <Box sx={{ height: 62 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={wasteRows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={{ stroke: '#e3e5ee' }} minTickGap={70} />
              <YAxis hide domain={[0, 'auto']} />
              <Tooltip
                formatter={(v: unknown) => [typeof v === 'number' ? Math.round(v) + '%' : '—', 'Wasted spend'] as [string, string]}
                labelStyle={{ fontSize: 11 }}
                itemStyle={{ fontSize: 11, padding: 0 }}
                contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
              />
              <Area type="monotone" dataKey="v" stroke="#f43f5e" strokeWidth={1.4} fill="rgba(244,63,94,.15)" dot={false} isAnimationActive={false} connectNulls />
            </AreaChart>
          </ResponsiveContainer>
        </Box>
      </Box>
    </Box>
  );
}
