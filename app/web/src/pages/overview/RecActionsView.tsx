import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import InputBase from '@mui/material/InputBase';
import { useNavigate } from 'react-router-dom';
import { cardSx, numSx, OutlineButton, ApplyButton, useApplyWorkload, recommendedActions, OverviewFooter } from './shared';
import { usd } from '../../lib/format';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { useGlobalSearchString } from '../../hooks/useUrlState';
import { workloadOverviewId } from '../rightsizing/lib';

// Full "Recommended Actions" view (multi-cluster "View all")

const th: React.CSSProperties = {
  padding: '12px 0',
  fontWeight: 700,
  textAlign: 'center',
  borderRight: '1px solid #f6f7fb',
};

const chipSelectSx = {
  fontSize: 12,
  fontWeight: 500,
  fontFamily: 'inherit',
  px: '11px',
  py: '5px',
  borderRadius: 999,
  border: '1px solid #e3e5ee',
  background: '#fff',
  color: '#5b6479',
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
  outline: 'none',
  '&:hover': { borderColor: '#c7cadb', color: '#1e2536' },
};

export default function RecActionsView() {
  const { workloads, ro, overview } = useClusterData();
  const navigate = useNavigate();
  const search = useGlobalSearchString();
  const applyWl = useApplyWorkload();
  const cluster = overview?.clusterName || 'cluster';

  const [q, setQ] = useState('');
  const [clSel, setClSel] = useState('');
  const [typ, setTyp] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const acts = useMemo(() => {
    let a = recommendedActions(workloads).map((w) => ({
      w,
      name: 'Rightsize ' + w.name,
      type: 'rightsize',
    }));
    if (typ) a = a.filter((x) => x.type === typ);
    if (clSel && clSel !== cluster) a = []; // single-cluster deployment
    const f = q.toLowerCase();
    if (f) a = a.filter((x) => x.name.toLowerCase().includes(f));
    return a;
  }, [workloads, typ, clSel, cluster, q]);

  const total = acts.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(page, 1), pages);
  const start = (cur - 1) * pageSize;
  const pageRows = acts.slice(start, start + pageSize);

  return (
    <Box component="main" sx={{ p: '20px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* banner header */}
      <Box
        sx={{
          ...cardSx,
          p: 2,
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          background: 'linear-gradient(to right, rgba(236,253,245,.8), #fff, #fff)',
        }}
      >
        <Box
          sx={{
            height: 36,
            width: 36,
            borderRadius: '8px',
            background: '#22c55e',
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 1px 2px rgba(16,24,40,.08)',
          }}
        >
          <svg style={{ width: 20, height: 20, color: '#fff' }} viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
          </svg>
        </Box>
        <Box component="h1" sx={{ m: 0, fontSize: 19, fontWeight: 700, color: '#1e2536' }}>
          Recommended Actions
        </Box>
      </Box>

      <Box sx={{ ...cardSx, p: 0, overflow: 'hidden' }}>
        {/* filters */}
        <Box
          sx={{
            px: '20px',
            py: 2,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
          }}
        >
          <Box sx={{ position: 'relative' }}>
            <svg
              style={{
                width: 16,
                height: 16,
                color: '#94a3b8',
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
              }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4-4" />
            </svg>
            <InputBase
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="search…"
              sx={{
                background: '#fff',
                border: '1px solid #dfe2ec',
                borderRadius: 999,
                pl: '36px',
                pr: '12px',
                py: '2px',
                fontSize: 14,
                width: 256,
                '&.Mui-focused': { borderColor: '#a5b4fc' },
              }}
            />
          </Box>
          <Box
            component="select"
            value={clSel}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              setClSel(e.target.value);
              setPage(1);
            }}
            sx={chipSelectSx}
          >
            <option value="">clusters</option>
            <option value={cluster}>{cluster}</option>
          </Box>
          <Box
            component="select"
            value={typ}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              setTyp(e.target.value);
              setPage(1);
            }}
            sx={chipSelectSx}
          >
            <option value="">action type</option>
            <option value="rightsize">rightsize</option>
            <option value="rollout">rollout</option>
          </Box>
        </Box>

        {/* table */}
        <Box sx={{ overflowX: 'auto', px: '20px' }}>
          <Box
            component="table"
            sx={{ width: '100%', fontSize: 13, border: '1px solid #e6e8f0', borderCollapse: 'collapse' }}
          >
            <thead>
              <tr style={{ background: '#e9ebf3', fontSize: 13, color: '#2b3147' }}>
                <th style={th}>Name</th>
                <th style={th}>Cluster</th>
                <th style={{ ...th, width: 128 }}>Savings</th>
                <th style={{ ...th, width: 144 }}>Explore</th>
                <th style={{ ...th, borderRight: 'none', width: 160 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    style={{ padding: '40px 20px', textAlign: 'center', color: '#94a3b8' }}
                  >
                    No recommended actions — all workloads are right-sized.
                  </td>
                </tr>
              ) : (
                pageRows.map((a) => {
                  const dis = ro || !!a.w.hpaManaged;
                  return (
                    <Box
                      component="tr"
                      key={a.w.key}
                      sx={{
                        borderBottom: '1px solid #eef0f5',
                        transition: 'background-color .15s',
                        '&:hover': { background: '#eef1fc' },
                      }}
                    >
                      <td style={{ padding: '12px 20px' }}>
                        <Box sx={{ fontWeight: 600, color: '#1e2536' }}>{a.name}</Box>
                        <Box sx={{ fontSize: 11, color: '#94a3b8' }}>
                          {a.w.namespace} · {a.w.kind}
                        </Box>
                      </td>
                      <td style={{ padding: '0 12px', textAlign: 'center', color: '#475569' }}>
                        {cluster}
                      </td>
                      <Box
                        component="td"
                        sx={{
                          px: '12px',
                          textAlign: 'center',
                          fontWeight: 600,
                          color: '#16a34a',
                          ...numSx,
                        }}
                      >
                        {usd(a.w.savings)}
                      </Box>
                      <td style={{ padding: '0 12px', textAlign: 'center' }}>
                        <OutlineButton
                          onClick={() => {
                            const sp = new URLSearchParams(search);
                            sp.set('selectedWorkloadOverviewId', workloadOverviewId(cluster, a.w));
                            navigate({
                              pathname: '/rightSizing/workloads',
                              search: '?' + sp.toString(),
                            });
                          }}
                          sx={{ fontSize: 12, fontWeight: 600 }}
                        >
                          Explore
                        </OutlineButton>
                      </td>
                      <td style={{ padding: '0 12px', textAlign: 'center' }}>
                        <ApplyButton disabled={dis} onClick={() => applyWl(a.w)}>
                          Apply
                        </ApplyButton>
                      </td>
                    </Box>
                  );
                })
              )}
            </tbody>
          </Box>
        </Box>

        {/* pagination footer */}
        <Box
          sx={{
            px: '20px',
            py: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 2,
            fontSize: 12,
            color: '#64748b',
          }}
        >
          <span>Rows per page:</span>
          <Box
            component="select"
            value={String(pageSize)}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              setPageSize(+e.target.value || 10);
              setPage(1);
            }}
            sx={{
              background: 'transparent',
              border: '1px solid #e9eaf0',
              borderRadius: '6px',
              px: '6px',
              py: '4px',
              outline: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              color: '#64748b',
            }}
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
          </Box>
          <Box component="span" sx={numSx}>
            {total ? `${start + 1}–${Math.min(start + pageSize, total)} of ${total}` : '0 of 0'}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <ButtonBase
              disabled={cur <= 1}
              onClick={() => setPage(cur - 1)}
              sx={{
                px: 1,
                py: '4px',
                borderRadius: '6px',
                border: '1px solid #e9eaf0',
                fontFamily: 'inherit',
                fontSize: 12,
                '&.Mui-disabled': { opacity: 0.4 },
                '&:hover': { background: '#f8fafc' },
              }}
            >
              ‹
            </ButtonBase>
            <ButtonBase
              disabled={cur >= pages}
              onClick={() => setPage(cur + 1)}
              sx={{
                px: 1,
                py: '4px',
                borderRadius: '6px',
                border: '1px solid #e9eaf0',
                fontFamily: 'inherit',
                fontSize: 12,
                '&.Mui-disabled': { opacity: 0.4 },
                '&:hover': { background: '#f8fafc' },
              }}
            >
              ›
            </ButtonBase>
          </Box>
        </Box>
      </Box>
      <OverviewFooter />
    </Box>
  );
}
