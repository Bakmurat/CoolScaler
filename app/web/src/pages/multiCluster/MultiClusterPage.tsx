// Multi-cluster launcher
import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import Checkbox from '@mui/material/Checkbox';
import { Link, useSearchParams } from 'react-router-dom';
import { getJson } from '../../api/client';
import { useClusterData, automationCounts } from '../../providers/ClusterDataProvider';
import { usd, coresFmt, mibFmt } from '../../lib/format';
import { Dropdown } from '../rightsizing/ui';
import {
  JavaIcon,
  NodesIcon,
  PlacementIcon,
  ReplicasIcon,
  RightsizingIcon,
  SchedulingIcon,
} from '../../components/NavIcons';

// product tabs
const PRODUCTS: { key: string; label: string; icon?: JSX.Element }[] = [
  { key: '', label: 'All' },
  { key: 'rightsizing', label: 'Workload Rightsizing', icon: <RightsizingIcon /> },
  { key: 'replicas', label: 'Replicas Optimization', icon: <ReplicasIcon /> },
  { key: 'pod-placement', label: 'Pod Placement', icon: <PlacementIcon /> },
  { key: 'pod-scheduling', label: 'Pod Scheduling', icon: <SchedulingIcon /> },
  { key: 'java', label: 'Java Optimization', icon: <JavaIcon /> },
  { key: 'node-management', label: 'Node Management', icon: <NodesIcon /> },
];

interface ClusterRow {
  name: string;
  monthlyCost: number | null;
  availableSavings: number | null;
  cpuRequest: number | null; // cores
  memoryRequest: number | null; // bytes
  totalGpu: number | null;
  replicas: number | null;
  automationPct: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

/** Defensive mapper — the /api/multicluster contract is provisional, so accept
 * a few plausible key spellings and fall back to null (rendered as em dash). */
function toRow(c: Record<string, unknown>): ClusterRow | null {
  const name = (c.name ?? c.clusterName ?? c.cluster) as string | undefined;
  if (!name) return null;
  const pctRaw = num(c.automationPct) ?? num(c.automationPercentage) ?? num(c.automation);
  return {
    name,
    monthlyCost: num(c.monthlyCost) ?? num(c.cost),
    availableSavings: num(c.availableSavings) ?? num(c.savingsAvailable) ?? num(c.savings),
    cpuRequest: num(c.cpuRequest) ?? num(c.reqCpu),
    memoryRequest: num(c.memoryRequest) ?? num(c.memRequest) ?? num(c.reqMem),
    totalGpu: num(c.totalGpu) ?? num(c.gpu),
    replicas: num(c.replicas) ?? num(c.replicaCount),
    automationPct: pctRaw != null && pctRaw <= 1 && pctRaw > 0 ? pctRaw * 100 : pctRaw,
  };
}

interface Col {
  key: keyof ClusterRow;
  label: string;
}
const COLS: Col[] = [
  { key: 'monthlyCost', label: 'Monthly Cost' },
  { key: 'availableSavings', label: 'Available Savings' },
  { key: 'cpuRequest', label: 'CPU Request' },
  { key: 'memoryRequest', label: 'Memory Request' },
  { key: 'totalGpu', label: 'Total GPU' },
  { key: 'replicas', label: 'Replicas' },
  { key: 'automationPct', label: 'Automation %' },
];

export default function MultiClusterPage() {
  const { overview, workloads } = useClusterData();
  const [params, setParams] = useSearchParams();
  const product = params.get('product') ?? '';
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<ClusterRow[] | null>(null); // null = endpoint absent
  const [page, setPage] = useState(0);
  const [rpp, setRpp] = useState(10);
  const [colsOpen, setColsOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const colsBtnRef = useRef<HTMLDivElement | null>(null);

  // Backend list (feature-detected — 404 on older backends keeps fallback).
  useEffect(() => {
    let dead = false;
    const qs = product ? `?product=${encodeURIComponent(product)}` : '';
    getJson<Record<string, unknown>>(`/api/multicluster${qs}`)
      .then((d) => {
        if (dead) return;
        const list = Array.isArray(d) ? d : (d?.clusters as unknown[] | undefined);
        if (Array.isArray(list)) {
          setRows(list.map((c) => toRow(c as Record<string, unknown>)).filter(Boolean) as ClusterRow[]);
        }
      })
      .catch(() => {}); // endpoint not deployed yet — keep overview fallback
    return () => {
      dead = true;
    };
  }, [product]);

  // Single-cluster fallback row from the polled overview.
  const fallbackRows = useMemo<ClusterRow[]>(() => {
    if (!overview) return [];
    const repl = workloads.length
      ? workloads.reduce((s, w) => s + (typeof w.replicas === 'number' ? w.replicas : 0), 0)
      : null;
    return [
      {
        name: overview.clusterName || 'cluster',
        monthlyCost: num(overview.monthlyCost),
        availableSavings: num(overview.availableSavings) ?? num(overview.potentialSavings),
        cpuRequest: num(overview.reqCpu),
        memoryRequest: num(overview.reqMem),
        totalGpu: null,
        replicas: repl,
        automationPct: automationCounts(overview).pct,
      },
    ];
  }, [overview, workloads]);

  const allRows = rows ?? fallbackRows;
  const filtered = allRows.filter(
    (r) => !search || r.name.toLowerCase().includes(search.toLowerCase()),
  );
  const paged = filtered.slice(page * rpp, page * rpp + rpp);
  const visCols = COLS.filter((c) => !hidden.has(c.key));

  const cellFor = (r: ClusterRow, c: Col) => {
    const v = r[c.key] as number | null;
    if (v == null) return <span style={{ color: '#94a3b8' }}>—</span>;
    switch (c.key) {
      case 'monthlyCost':
        return usd(v);
      case 'availableSavings':
        return <span style={{ color: '#22c55e', fontWeight: 600 }}>{usd(v)}</span>;
      case 'cpuRequest':
        return coresFmt(v);
      case 'memoryRequest':
        return mibFmt(v);
      case 'automationPct':
        return (
          <Box
            component="span"
            sx={{
              display: 'inline-block',
              minWidth: 56,
              px: '12px',
              py: '3px',
              borderRadius: '999px',
              background: '#22c55e',
              border: '2px solid #14532d',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {Math.round(v)}%
          </Box>
        );
      default:
        return String(v);
    }
  };

  return (
    <Box component="main" sx={{ p: '16px 20px', display: 'flex', flexDirection: 'column' }}>
      {/* product tabs */}
      <Box sx={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {PRODUCTS.map((p) => {
          const active = product === p.key;
          return (
            <Box
              key={p.key}
              onClick={() => {
                const next = new URLSearchParams(params);
                if (p.key) next.set('product', p.key);
                else next.delete('product');
                setParams(next, { replace: true });
                setPage(0);
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                background: '#fff',
                border: '1px solid #d8dbe4',
                borderBottom: 'none',
                borderRadius: '10px 10px 0 0',
                px: '16px',
                py: '10px',
                fontSize: 13.5,
                fontWeight: 600,
                color: '#1e2536',
                cursor: 'pointer',
                position: 'relative',
                '& svg': { width: 17, height: 17, color: '#475569' },
                ...(active && {
                  '&::after': {
                    content: '""',
                    position: 'absolute',
                    left: 14,
                    right: 14,
                    bottom: 6,
                    height: 2.5,
                    borderRadius: 2,
                    background: '#4f46e5',
                  },
                }),
              }}
            >
              {p.icon}
              {p.label}
            </Box>
          );
        })}
      </Box>

      {/* card: search + columns + cluster table */}
      <Box
        sx={{
          background: '#fff',
          border: '1px solid #d8dbe4',
          borderRadius: '0 12px 12px 12px',
          p: '16px',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: '14px' }}>
          <Box
            component="input"
            placeholder="search..."
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            sx={{
              width: 230,
              px: '16px',
              py: '8px',
              borderRadius: '999px',
              border: '1.5px solid #1e2536',
              fontSize: 13,
              fontFamily: 'inherit',
              outline: 'none',
              '&::placeholder': { color: '#94a3b8' },
            }}
          />
          <Box ref={colsBtnRef} sx={{ position: 'relative' }}>
            <Box
              component="button"
              onClick={() => setColsOpen((o) => !o)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: '#4b5563',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                px: '14px',
                py: '7px',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                <circle cx="12" cy="12" r="2.5" />
              </svg>
              Columns
            </Box>
            <Dropdown open={colsOpen} onClose={() => setColsOpen(false)} style={{ right: 0, minWidth: 210, padding: 8 }}>
              {COLS.map((c) => (
                <Box
                  key={c.key}
                  sx={{ display: 'flex', alignItems: 'center', fontSize: 13, color: '#334155', cursor: 'pointer' }}
                  onClick={() =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(c.key)) n.delete(c.key);
                      else n.add(c.key);
                      return n;
                    })
                  }
                >
                  <Checkbox size="small" checked={!hidden.has(c.key)} sx={{ py: '4px' }} />
                  {c.label}
                </Box>
              ))}
            </Dropdown>
          </Box>
        </Box>

        <Box sx={{ border: '1px solid #d8dbe4', borderRadius: '8px', overflow: 'hidden' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ background: '#eef0f5' }}>
                <TableCell sx={{ fontWeight: 700, fontSize: 13, py: '14px', textAlign: 'center' }}>
                  Cluster Name
                </TableCell>
                {visCols.map((c) => (
                  <TableCell key={c.key} align="center" sx={{ fontWeight: 700, fontSize: 13 }}>
                    {c.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {paged.map((r) => (
                <TableRow key={r.name} hover>
                  <TableCell sx={{ fontSize: 13.5, py: '14px' }}>
                    <Link
                      to="/overview/multi-product"
                      style={{ color: '#1e2536', textDecoration: 'none', fontWeight: 500 }}
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  {visCols.map((c) => (
                    <TableCell key={c.key} align="center" sx={{ fontSize: 13.5 }}>
                      {cellFor(r, c)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!paged.length && (
                <TableRow>
                  <TableCell colSpan={visCols.length + 1} align="center" sx={{ color: '#94a3b8', py: 4 }}>
                    {overview ? 'No clusters match' : 'Loading clusters…'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={filtered.length}
            page={page}
            onPageChange={(_e, p) => setPage(p)}
            rowsPerPage={rpp}
            onRowsPerPageChange={(e) => {
              setRpp(parseInt(e.target.value, 10));
              setPage(0);
            }}
            rowsPerPageOptions={[10, 25, 50]}
          />
        </Box>
      </Box>
    </Box>
  );
}
