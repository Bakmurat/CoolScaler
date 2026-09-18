import { useEffect, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { PieChart, Pie, Cell } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { numSx } from './shared';
import { getJson, postJson } from '../../api/client';
import { useClusterData, automationCounts } from '../../providers/ClusterDataProvider';
import { useFeedback } from '../../providers/FeedbackProvider';
import { useGlobalSearchString } from '../../hooks/useUrlState';
import type {
  ActionResponse,
  PlacementResponse,
  PlacementTotals,
  SchedulingResponse,
  SchedulingTotals,
  Workload,
} from '../../api/types';

// The boxed CORE INFRA product-launcher panel

/* coreDonut() port */
function CoreDonut({ pct, has }: { pct: number; has: boolean }) {
  const v = has ? Math.max(0, Math.min(100, pct)) : 0;
  const track = has ? '#e8eaf3' : '#dce3fa';
  return (
    <Box sx={{ position: 'relative', height: 84, width: 84, flexShrink: 0 }}>
      <PieChart width={84} height={84}>
        {/* full track ring */}
        <Pie
          data={[{ value: 1 }]}
          dataKey="value"
          cx="50%"
          cy="50%"
          innerRadius={29.5}
          outerRadius={38.5}
          isAnimationActive={false}
          stroke="none"
          fill={track}
        />
        {/* green automation arc, clockwise from 12 o'clock, rounded caps */}
        {has && v > 0 && (
          <Pie
            data={[{ value: v }, { value: 100 - v }]}
            dataKey="value"
            cx="50%"
            cy="50%"
            innerRadius={29.5}
            outerRadius={38.5}
            startAngle={90}
            endAngle={-270}
            isAnimationActive={false}
            stroke="none"
            cornerRadius={4.5}
          >
            <Cell fill="#16a34a" />
            <Cell fill="transparent" />
          </Pie>
        )}
      </PieChart>
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          fontWeight: 700,
          ...numSx,
          ...(has ? { fontSize: 17, color: '#1e2536' } : { fontSize: 22, color: '#94a3b8' }),
        }}
      >
        {has && Math.round(v) > 0 ? Math.round(v) + '%' : '–'}
      </Box>
    </Box>
  );
}

const CORE_ICONS: Record<string, ReactNode> = {
  rs: (
    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="9" />
      <path d="M16 8l-5.5 5.5M16 8l-2 6-6 2z" />
    </svg>
  ),
  java: (
    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M8 18c0 1.5 2 2 4 2s4-.5 4-2M8 14c0 1.2 1.8 2 4 2s4-.8 4-2M12 3c2 2-1 3 0 5M9 6c1.5 1.5-.5 2.5 0 4" />
    </svg>
  ),
  pp: (
    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
      <path d="M11 7h6M7 11v6" />
    </svg>
  ),
  sc: (
    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  ),
  rep: (
    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  ),
};

interface CoreCard {
  name: string;
  icon: ReactNode;
  route: string;
  desc: string;
  count: number;
  automated: number;
  metric: string;
  waste: number | null;
  under?: number;
  automate: () => void;
}

/** underProvisioned() port — recommendation raises requests by >3%. */
function underProvisioned(workloads: Workload[]): number {
  return workloads.filter(
    (w) =>
      (w.recCpu != null && w.reqCpu != null && w.recCpu > w.reqCpu * 1.03) ||
      (w.recMem != null && w.reqMem != null && w.recMem > w.reqMem * 1.03),
  ).length;
}

function CoreCardView({ card, ro }: { card: CoreCard; ro: boolean }) {
  const navigate = useNavigate();
  const search = useGlobalSearchString();
  const has = card.count > 0;
  const apct = has ? Math.round(((card.automated || 0) / card.count) * 100) : 0;
  const un = Math.max(card.count - (card.automated || 0), 0);
  const dis = ro;
  const wasteVal =
    card.waste != null ? Math.max(0, Math.min(100, Math.round(card.waste))) : null;

  return (
    <Box
      sx={{
        background: '#fff',
        borderRadius: '12px',
        border: '1px solid #e3e6f0',
        boxShadow: '0 1px 2px rgba(16,24,40,.05)',
        p: 2,
        display: 'flex',
        gap: 2,
      }}
    >
      {/* left: title / desc / buttons */}
      <Box sx={{ width: '45%', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Box
            component="h3"
            sx={{
              m: 0,
              fontWeight: 700,
              fontSize: 15,
              color: '#1e2536',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {card.name}
          </Box>
          <Box component="span" sx={{ color: '#94a3b8', flexShrink: 0, display: 'inline-flex' }}>
            {card.icon}
          </Box>
        </Box>
        <Box component="p" sx={{ m: 0, fontSize: 12, color: '#64748b', mt: '6px', lineHeight: 1.375 }}>
          {card.desc}
        </Box>
        <Box sx={{ mt: 'auto', pt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <ButtonBase
            onClick={() => navigate({ pathname: card.route, search })}
            sx={{
              width: '100%',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              color: '#1e2536',
              border: '1px solid #cbd5e1',
              borderRadius: '8px',
              py: '8px',
              background: '#fff',
              '&:hover': { background: '#f8fafc' },
            }}
          >
            Explore automation
          </ButtonBase>
          <ButtonBase
            disabled={dis}
            onClick={card.automate}
            title={
              dis
                ? 'Read-only mode'
                : 'Click to Automate Cluster — applies to all current and future workloads.'
            }
            sx={{
              width: '100%',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: 'inherit',
              borderRadius: '8px',
              py: '8px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              color: '#fff',
              boxShadow: '0 1px 2px rgba(16,24,40,.08)',
              background: 'linear-gradient(180deg,#10b981,#059669)',
              ...(dis
                ? { opacity: 0.5, cursor: 'not-allowed' }
                : { '&:hover': { filter: 'brightness(1.05)' } }),
            }}
          >
            <svg
              style={{ width: 16, height: 16 }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none" />
            </svg>
            Automate All
          </ButtonBase>
        </Box>
      </Box>

      <Box sx={{ width: '1px', background: '#eef0f6', alignSelf: 'stretch', flexShrink: 0 }} />

      {/* right: donut + counts + legend + Waste / Under-provisioned */}
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <CoreDonut pct={apct} has={has} />
          <Box sx={{ minWidth: 0, fontSize: 12 }}>
            <Box sx={{ fontSize: 19, fontWeight: 700, color: '#1e2536', lineHeight: 1.25, ...numSx }}>
              {card.count}
            </Box>
            <Box sx={{ color: '#475569', lineHeight: 1.25 }}>{card.metric}</Box>
            <Box sx={{ mt: '6px', '& > *': { mb: '4px' } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Box
                  component="span"
                  sx={{
                    height: 8,
                    width: 16,
                    borderRadius: 999,
                    display: 'inline-block',
                    background: has ? '#22c55e' : '#a7f3d0',
                  }}
                />
                <Box component="span" sx={{ color: '#64748b' }}>
                  automated
                </Box>
                <Box component="span" sx={{ fontWeight: 600, color: '#1e2536', ...numSx }}>
                  {card.automated || 0}
                </Box>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Box
                  component="span"
                  sx={{
                    height: 8,
                    width: 16,
                    borderRadius: 999,
                    display: 'inline-block',
                    background: '#dce3fa',
                  }}
                />
                <Box component="span" sx={{ color: '#64748b' }}>
                  un-automated
                </Box>
                <Box component="span" sx={{ fontWeight: 600, color: '#1e2536', ...numSx }}>
                  {un}
                </Box>
              </Box>
            </Box>
          </Box>
        </Box>

        <Box
          sx={{
            borderTop: '1px solid #eef0f6',
            mt: '12px',
            pt: '12px',
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            gap: 3,
            flex: 1,
          }}
        >
          <Box sx={{ textAlign: 'center', alignSelf: 'center' }}>
            <Box sx={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Waste</Box>
            <Box
              sx={{
                fontSize: 17,
                fontWeight: 700,
                ...numSx,
                color: wasteVal != null ? '#f43f5e' : '#cbd5e1',
              }}
            >
              {wasteVal != null ? wasteVal + '%' : '–'}
            </Box>
            <Box
              sx={{
                position: 'relative',
                height: 4,
                width: 96,
                background: '#e8eaf3',
                borderRadius: 999,
                mt: '6px',
                overflow: 'hidden',
                mx: 'auto',
              }}
            >
              <Box
                sx={{
                  position: 'absolute',
                  insetBlock: 0,
                  left: 0,
                  background: '#fb7185',
                  borderRadius: 999,
                  width: `${wasteVal != null ? wasteVal : 0}%`,
                }}
              />
            </Box>
          </Box>
          {card.under != null && (
            <>
              <Box sx={{ width: '1px', background: '#eef0f6' }} />
              <Box sx={{ textAlign: 'center', alignSelf: 'center' }}>
                <Box sx={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
                  Under provisioned
                </Box>
                <Box sx={{ fontSize: 17, fontWeight: 700, color: '#f43f5e', ...numSx }}>
                  {card.under}
                </Box>
              </Box>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

export default function CoreInfraSection() {
  const { overview, workloads, ro, refresh } = useClusterData();
  const { toast, confirm } = useFeedback();
  const [ppT, setPpT] = useState<PlacementTotals>({});
  const [scT, setScT] = useState<SchedulingTotals>({});

  // renderCoreInfra(): pull honest totals from the placement/scheduling engines
  useEffect(() => {
    let cancelled = false;
    getJson<PlacementResponse>('/api/placement')
      .then((d) => !cancelled && setPpT(d.totals ?? {}))
      .catch(() => {});
    getJson<SchedulingResponse>('/api/scheduling')
      .then((d) => !cancelled && setScT(d.totals ?? {}))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [overview]);

  if (!overview) {
    return (
      <Box sx={{ color: '#94a3b8', fontSize: 14, py: '40px', textAlign: 'center' }}>
        Loading product data…
      </Box>
    );
  }

  const ov = overview;
  const P = ov.products ?? {};
  const rp = P.replicas ?? {};
  const jv = P.java ?? {};
  const ppCount =
    ppT.unevictablePods != null
      ? ppT.unevictablePods
      : ppT.unevictableWorkloads != null
        ? ppT.unevictableWorkloads
        : P.podPlacement?.workloads || 0;
  const ppAuto = ppT.automated != null ? ppT.automated : P.podPlacement?.automated || 0;

  const guardRO = (): boolean => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode.');
      return true;
    }
    return false;
  };

  // automateAll() port — cluster-scope rightsizing automation
  const automateRightsizing = async () => {
    if (ro) {
      toast(
        'Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to enable automation.',
      );
      return;
    }
    const targets = workloads.filter((w) => w.sizable && !w.automated && !w.excluded);
    if (!targets.length) {
      toast('All eligible workloads are already automated.');
      return;
    }
    if (
      !(await confirm(
        `Enable automation for the entire cluster (${targets.length} workload(s), current + future)?`,
      ))
    )
      return;
    await postJson('/api/automate-bulk', { scope: 'cluster', enabled: true }).catch(() => {});
    toast('Cluster automated successfully', 'ok');
    refresh();
  };

  // javaAutomateAllOverview() port
  const automateJava = async () => {
    if (guardRO()) return;
    if (
      !(await confirm(
        'Automate Java optimization for the entire cluster (current + future Java workloads)?',
      ))
    )
      return;
    try {
      const r = await postJson<ActionResponse>('/api/java/action', {
        scope: 'cluster',
        action: 'automate',
      });
      toast(
        r.ok === false
          ? 'Failed: ' + (r.message || '')
          : 'Java optimization automated for the cluster.',
        r.ok === false ? undefined : 'ok',
      );
    } catch {
      toast('Request failed.');
    }
    refresh();
  };

  // placementAutomateAll() port (no category → cluster scope)
  const automatePlacement = async () => {
    if (guardRO()) return;
    if (!(await confirm('Automate bin-packing for ALL un-evictable workloads (current + future)?')))
      return;
    await postJson('/api/placement-automate-all', { enabled: true }).catch(() => {});
    refresh();
  };

  // schedulingAutomateAll() port
  const automateScheduling = async () => {
    if (guardRO()) return;
    if (!(await confirm('Automate self anti-affinity relaxation for all eligible workloads?')))
      return;
    await postJson('/api/scheduling-automate-all', { enabled: true }).catch(() => {});
    refresh();
  };

  // replicasAutomateAll() port
  const automateReplicas = async () => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode. Set readOnly:false to automate replicas optimization.');
      return;
    }
    if (
      !(await confirm(
        'Automate min-replicas optimization for all HPA/KEDA workloads (current + future)?',
      ))
    )
      return;
    await postJson('/api/replicas-automate-all', { enabled: true }).catch(() => {});
    refresh();
  };

  const cards: CoreCard[] = [
    {
      name: 'Workload Rightsizing',
      icon: CORE_ICONS.rs,
      route: '/rightSizing/workloads',
      desc: 'Optimize your workloads by adjusting the resource allocation to ensure efficiency.',
      // Eligible-set counters (excludes kube-system etc.), not raw sizable/automated
      count: automationCounts(ov).total,
      automated: automationCounts(ov).auto,
      metric: 'Rightsize workloads',
      waste: Math.round(ov.savingsPct || 0),
      under: underProvisioned(workloads),
      automate: automateRightsizing,
    },
    {
      name: 'Java Optimization',
      icon: CORE_ICONS.java,
      route: '/java',
      desc: 'Optimize JVM memory allocation for Java workloads to reduce overprovisioning and costs.',
      count: jv.workloads || 0,
      automated: jv.automated || 0,
      metric: 'Java workloads',
      waste: null,
      automate: automateJava,
    },
    {
      name: 'Pod Placement',
      icon: CORE_ICONS.pp,
      route: '/pod-placement',
      desc: 'Optimize your bin-packing strategy to free up nodes for scale-down and cost savings.',
      count: ppCount,
      automated: ppAuto,
      metric: 'Unevictable pods',
      waste: ppCount && ppT.wastePct != null ? ppT.wastePct : null,
      automate: automatePlacement,
    },
    {
      name: 'Pod Scheduling',
      icon: CORE_ICONS.sc,
      route: '/scheduling',
      desc: 'Optimize your workloads scheduling constraints to free up nodes for scale-down and cost savings.',
      count: scT.workloads || 0,
      automated: scT.automated || 0,
      metric: 'Relaxable workloads',
      waste: scT.workloads && scT.wastePct != null ? scT.wastePct : null,
      automate: automateScheduling,
    },
    {
      name: 'Replicas Optimization',
      icon: CORE_ICONS.rep,
      route: '/replicas',
      desc: 'Optimize your Replicas optimization workloads by adjusting the number of replicas to ensure efficiency.',
      count: rp.workloads || 0,
      automated: rp.automated || 0,
      metric: 'Replicas optimization workloads',
      waste: null,
      automate: automateReplicas,
    },
  ];

  return (
    <Box
      sx={{
        display: 'grid',
        // Tailwind xl: breakpoint (1280px) — grid-cols-2
        gridTemplateColumns: '1fr',
        '@media (min-width:1280px)': { gridTemplateColumns: '1fr 1fr' },
        gap: 2,
      }}
    >
      {cards.map((card) => (
        <CoreCardView key={card.name} card={card} ro={ro} />
      ))}
    </Box>
  );
}
