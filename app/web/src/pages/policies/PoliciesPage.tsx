// Rightsize Policies page
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import FactoryOutlinedIcon from '@mui/icons-material/FactoryOutlined';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import CycloneOutlinedIcon from '@mui/icons-material/CycloneOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import SavingsOutlinedIcon from '@mui/icons-material/SavingsOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import EventRepeatOutlinedIcon from '@mui/icons-material/EventRepeatOutlined';
import CoffeeOutlinedIcon from '@mui/icons-material/CoffeeOutlined';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import WavesOutlinedIcon from '@mui/icons-material/WavesOutlined';
import CopyAllOutlinedIcon from '@mui/icons-material/CopyAllOutlined';
import LocalFireDepartmentOutlinedIcon from '@mui/icons-material/LocalFireDepartmentOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usePrompt } from '../../components/PromptModal';
import { Dropdown } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';
import PolicyEditorDrawer from './PolicyEditorDrawer';
import { POLICY_NAME_RE, suggestDupName, type PolicyRow } from './model';
import { selStyle } from './fields';

const POL_ALL_COLS: [string, string][] = [
  ['used', 'Used By Workloads'],
  ['percentile', 'Percentile'],
  ['headroom', 'Headroom'],
  ['window', 'Window'],
  ['strategy', 'Strategy'],
  ['features', 'Features'],
];

// Per-policy distinctive icon.
const POLICY_ICONS: Record<string, ReactNode> = {
  production: <FactoryOutlinedIcon />,
  'high-availability': <HealthAndSafetyOutlinedIcon />,
  airflow: <CycloneOutlinedIcon />,
  batch: <LayersOutlinedIcon />,
  cost: <SavingsOutlinedIcon />,
  'daemonset-demand-aware': <HubOutlinedIcon />,
  'daemonset-workloads': <DnsOutlinedIcon />,
  'weekly-optimization': <EventRepeatOutlinedIcon />,
  java: <CoffeeOutlinedIcon />,
  spark: <BoltOutlinedIcon />,
  flink: <WavesOutlinedIcon />,
  'high-replica': <CopyAllOutlinedIcon />,
  prometheus: <LocalFireDepartmentOutlinedIcon />,
  system: <SettingsOutlinedIcon />,
};
function PolIcon({ name }: { name: string }) {
  const icon = POLICY_ICONS[name] || <TuneOutlinedIcon />;
  return <span style={{ display: 'inline-flex', color: '#475569', flexShrink: 0, transform: 'scale(.78)' }}>{icon}</span>;
}

export default function PoliciesPage() {
  const { toast, confirm } = useFeedback();
  const prompt = usePrompt();
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [filter, setFilter] = useState('');
  const [colsOpen, setColsOpen] = useState(false);
  const [cols, setCols] = useState<Set<string>>(new Set(['used']));
  const [editor, setEditor] = useState<{ name: string | null; create?: boolean; type?: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const policyNames = policies.length
    ? policies.filter((p) => !p.schedule).map((p) => p.name)
    : ['production', 'high-availability', 'cost'];

  const load = useCallback(async () => {
    try {
      const d = await getJson<{ policies?: PolicyRow[] }>('/api/policies');
      setPolicies(d.policies || []);
    } catch {
      setPolicies([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (!editor) void load();
    }, 30000);
    return () => window.clearInterval(t);
  }, [load, editor]);

  const duplicate = useCallback(
    async (source: string) => {
      const name = await prompt('Duplicate policy', 'New policy name', suggestDupName(source, policyNames));
      if (!name) return;
      try {
        const r = await postJson<{ ok?: boolean; message?: string }>('/api/policy/duplicate', { source, name });
        if (r?.ok) {
          toast('Policy duplicated');
          await load();
          setEditor({ name });
        } else toast(r?.message || 'Duplicate failed', 'error');
      } catch (e) {
        toast('Duplicate failed: ' + e, 'error');
      }
    },
    [prompt, policyNames, toast, load],
  );

  const del = useCallback(
    async (name: string) => {
      if (!(await confirm(`Delete policy "${name}"? Workloads using it will fall back to auto-detected policies.`)))
        return;
      try {
        const r = await postJson<{ ok?: boolean; message?: string }>('/api/policy/delete', { name });
        if (r?.ok) {
          toast('Policy deleted');
          void load();
        } else toast(r?.message || 'Delete failed', 'error');
      } catch (e) {
        toast('Delete failed: ' + e, 'error');
      }
    },
    [confirm, toast, load],
  );

  const f = filter.toLowerCase();
  const rows = policies.filter((p) => !f || (p.name + (p.description || '')).toLowerCase().includes(f));

  const featurePills = (p: PolicyRow) =>
    [
      p.inPlace ? 'in-place' : '',
      p.autoHealing ? 'auto-heal' : '',
      p.burstReaction ? 'burst' : '',
      p.bootTime ? 'boot-time' : '',
      p.initOpt ? 'init-opt' : '',
      p.ephOpt ? 'ephemeral' : '',
    ].filter(Boolean);

  const gridCols: GridColDef<PolicyRow>[] = [
    {
      field: 'name',
      headerName: 'Policy Name',
      flex: 1.6,
      minWidth: 280,
      sortable: false,
      headerAlign: 'center',
      renderCell: (params) => (
        <div style={{ padding: '10px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PolIcon name={params.row.name} />
            <span style={{ fontWeight: 600, fontSize: 14, color: '#1e2536' }}>{params.row.name}</span>
            {params.row.schedule && (
              <span className="pill" style={{ background: '#ede9fe', color: '#7c3aed', marginLeft: 4 }} title="Schedule-type policy">
                Schedule
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', maxWidth: 420, marginTop: 2, whiteSpace: 'normal' }}>
            {params.row.description || ''}
          </div>
        </div>
      ),
    },
    {
      field: 'used',
      headerName: 'Used By Workloads',
      width: 240,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => {
        const p = params.row;
        const pct = p.total ? Math.round((p.usedBy / p.total) * 100) : 0;
        return (
          <div
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 208, margin: '0 auto' }}
          >
            <div style={{ width: '100%', height: 8, borderRadius: 999, background: 'rgba(226,232,240,.8)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: pct + '%', background: '#10b981', borderRadius: 999 }} />
            </div>
            <span style={{ fontSize: 12, color: '#475569' }}>
              {p.usedBy} of {p.total}
            </span>
          </div>
        );
      },
    },
    {
      field: 'percentile',
      headerName: 'Percentile',
      width: 160,
      sortable: false,
      renderCell: (params) => (
        <div className="num" style={{ fontSize: 12, color: '#475569' }}>
          cpu p{params.row.cpuPercentile} · mem p{params.row.memPercentile}
          {params.row.ephOpt && (
            <div style={{ fontSize: 10, color: '#94a3b8' }}>
              eph p{params.row.ephPercentile} · {params.row.ephWindow}
            </div>
          )}
        </div>
      ),
    },
    {
      field: 'headroom',
      headerName: 'Headroom',
      width: 110,
      sortable: false,
      renderCell: (params) => (
        <span className="num" style={{ fontSize: 12, color: '#475569' }}>
          +{params.row.cpuHeadroom}% / +{params.row.memHeadroom}%
        </span>
      ),
    },
    {
      field: 'window',
      headerName: 'Window',
      width: 90,
      sortable: false,
      renderCell: (params) => (
        <span className="num" style={{ fontSize: 12, color: '#475569' }}>
          {params.row.window}
        </span>
      ),
    },
    {
      field: 'strategy',
      headerName: 'Strategy',
      width: 120,
      sortable: false,
      renderCell: (params) => <span style={{ fontSize: 12, color: '#475569' }}>{params.row.strategy}</span>,
    },
    {
      field: 'features',
      headerName: 'Features',
      width: 220,
      sortable: false,
      renderCell: (params) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {featurePills(params.row).map((x) => (
            <span key={x} className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>
              {x}
            </span>
          ))}
        </div>
      ),
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 200,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => (
        <div style={{ whiteSpace: 'nowrap', fontSize: 13 }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              void duplicate(params.row.name);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: '#1e2536',
              fontWeight: 500,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 13,
            }}
          >
            <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
            Duplicate
          </button>
          {!params.row.builtin && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void del(params.row.name);
              }}
              style={{
                color: '#f43f5e',
                fontWeight: 600,
                marginLeft: 12,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 13,
              }}
            >
              Delete
            </button>
          )}
        </div>
      ),
    },
  ];

  const columnVisibilityModel: Record<string, boolean> = {
    used: cols.has('used'),
    percentile: cols.has('percentile'),
    headroom: cols.has('headroom'),
    window: cols.has('window'),
    strategy: cols.has('strategy'),
    features: cols.has('features'),
  };

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Main card */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 19, fontWeight: 700, color: '#1e2536', margin: 0 }}>Rightsize Policies Management</h1>
            <p style={{ fontSize: 13, color: '#475569', margin: '4px 0 0' }}>
              Manage your <b>Rightsize Policies</b> and <b>customize them to suit your needs</b>.
            </p>
            <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
              Define the number of days the recommendation should be based on, the request and limit headrooms
            </p>
            <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
              and the continuous automation strategy and much more.
            </p>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 8,
              padding: '8px 16px',
              border: '1px solid #c9cddc',
              color: '#1e2536',
              background: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Create new policy
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
          <div style={{ position: 'relative' }}>
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
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="search…"
              style={{
                background: '#fff',
                border: '1px solid #dfe2ec',
                borderRadius: 999,
                padding: '6px 12px 6px 36px',
                fontSize: 14,
                width: 256,
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setColsOpen((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 14,
                fontWeight: 600,
                color: '#fff',
                background: '#3d4254',
                borderRadius: 8,
                padding: '6px 12px',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
                <circle cx="12" cy="12" r="3" />
              </svg>{' '}
              Columns
            </button>
            <Dropdown open={colsOpen} onClose={() => setColsOpen(false)} style={{ right: 0, width: 192, padding: 6 }}>
              {POL_ALL_COLS.map(([k, l]) => (
                <label
                  key={k}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={cols.has(k)}
                    onChange={(e) => {
                      const n = new Set(cols);
                      if (e.target.checked) n.add(k);
                      else n.delete(k);
                      setCols(n);
                    }}
                  />{' '}
                  {l}
                </label>
              ))}
            </Dropdown>
          </div>
        </div>

        <div style={{ marginTop: 12, border: '1px solid #e9eaf0', borderRadius: 8, overflow: 'hidden' }}>
          <DataGrid
            rows={rows}
            columns={gridCols}
            getRowId={(r) => r.name}
            columnVisibilityModel={columnVisibilityModel}
            getRowHeight={() => 'auto'}
            autoHeight
            hideFooter
            disableColumnMenu
            disableRowSelectionOnClick
            onRowClick={(params) => setEditor({ name: params.row.name })}
            localeText={{ noRowsLabel: 'No policies.' }}
            sx={{
              border: 'none',
              fontFamily: 'inherit',
              fontSize: 12,
              '& .MuiDataGrid-columnHeaders': {
                background: '#eef0f5',
                borderBottom: '1px solid #e3e5ee',
                color: '#2b3147',
                fontWeight: 700,
                fontSize: 12,
                minHeight: '42px !important',
                maxHeight: '42px !important',
              },
              '& .MuiDataGrid-columnHeaderTitle': { fontWeight: 700 },
              '& .MuiDataGrid-columnSeparator': { display: 'none' },
              '& .MuiDataGrid-row': {
                background: '#f4fbf7',
                borderBottom: '1px solid #e9f5ee',
                cursor: 'pointer',
                '&:hover': { background: 'rgba(209,250,229,.5)' },
              },
              '& .MuiDataGrid-cell': { border: 'none', display: 'flex', alignItems: 'center', padding: '6px 12px' },
              '& .MuiDataGrid-cell:focus, & .MuiDataGrid-columnHeader:focus': { outline: 'none' },
              '& .MuiDataGrid-cell:focus-within': { outline: 'none' },
            }}
          />
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Policies are stored as Policy custom resources in the release namespace
      </footer>

      {/* Create-new-policy chooser */}
      {createOpen && (
        <CreatePolicyModal
          onClose={() => setCreateOpen(false)}
          onCreate={(nm, type) => setEditor({ name: nm, create: true, type })}
          toast={toast}
        />
      )}

      {/* Policy editor drawer */}
      <PolicyEditorDrawer
        open={!!editor}
        name={editor?.name ?? null}
        create={editor?.create}
        createType={editor?.type}
        policyNames={policyNames}
        onClose={() => {
          setEditor(null);
          void load();
        }}
        onDuplicated={(nn) => {
          void load().then(() => setEditor({ name: nn }));
        }}
      />

    </main>
  );
}

function CreatePolicyModal({
  onClose,
  onCreate,
  toast,
}: {
  onClose: () => void;
  onCreate: (name: string, type: string) => void;
  toast: (m: string, t?: 'ok' | 'warn' | 'error') => void;
}) {
  const [name, setName] = useState('');
  const pick = (type: string) => {
    const nm = name.trim();
    if (!nm || !POLICY_NAME_RE.test(nm)) {
      toast('Enter a valid lowercase name', 'warn');
      return;
    }
    onClose();
    onCreate(nm, type);
  };
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1350,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(26,32,54,.35)',
        backdropFilter: 'blur(1px)',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)',
          border: '1px solid #e9eaf0',
          padding: 24,
          width: 480,
          margin: '0 16px',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: '#1e2536', marginBottom: 12 }}>Create New Policy</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Name</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new-policy-1"
          style={{ ...selStyle, cursor: 'text', marginBottom: 4 }}
        />
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 16 }}>Lowercase letters, numbers and dashes.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <button
            onClick={() => pick('Optimize')}
            style={{
              textAlign: 'left',
              padding: 12,
              borderRadius: 12,
              border: '1px solid #e3e5ee',
              background: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>▥ Policy</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Defines workload configurations</div>
          </button>
          <button
            onClick={() => pick('Schedule')}
            style={{
              textAlign: 'left',
              padding: 12,
              borderRadius: 12,
              border: '1px solid #e3e5ee',
              background: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>🕒 Policy Schedule</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Schedules your configurations</div>
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 8,
              border: '1px solid #e3e5ee',
              color: '#475569',
              background: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
