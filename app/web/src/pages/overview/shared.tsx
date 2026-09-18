import type { SxProps } from '@mui/material/styles';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { useFeedback } from '../../providers/FeedbackProvider';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { postJson } from '../../api/client';
import type { ActionResponse, Workload } from '../../api/types';

// Shared styling + behaviors for the Overview page.

/**.card — white rounded-2xl bordered card with the soft shadow + hover lift. */
export const cardSx: SxProps = {
  background: '#fff',
  border: '1px solid #e9eaf0',
  borderRadius: '16px',
  boxShadow: '0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.04)',
  transition: 'box-shadow .25s ease,transform .25s ease,border-color .25s ease',
  '&:hover': {
    boxShadow: '0 6px 24px -8px rgba(31,38,77,.14),0 2px 6px rgba(16,24,40,.05)',
    borderColor: '#dfe2ee',
    transform: 'translateY(-2px)',
  },
  '@keyframes rise': {
    from: { opacity: 0, transform: 'translateY(10px)' },
    to: { opacity: 1, transform: 'none' },
  },
  animation: 'rise .5s cubic-bezier(.22,.61,.36,1) both',
};

/* .num — tabular figures in the app font. */
export const numSx: SxProps = {
  fontFamily: 'inherit',
  fontFeatureSettings: '"tnum" 1',
  letterSpacing: '-0.01em',
};

/** Bordered "View all" / "Explore" secondary button. */
export function OutlineButton({
  children,
  onClick,
  sx,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  sx?: SxProps;
}) {
  return (
    <ButtonBase
      onClick={onClick}
      sx={{
        fontSize: 13,
        fontWeight: 500,
        fontFamily: 'inherit',
        color: '#1e2536',
        border: '1px solid #cbd5e1',
        borderRadius: '6px',
        px: '14px',
        py: '6px',
        background: '#fff',
        '&:hover': { background: '#f8fafc' },
        ...sx,
      }}
    >
      {children}
    </ButtonBase>
  );
}

/** Green-gradient "Apply" button; disabled = slate pill (RO / HPA-managed). */
export function ApplyButton({
  disabled,
  title,
  onClick,
  children,
}: {
  disabled: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <ButtonBase
      disabled={disabled}
      title={title}
      onClick={onClick}
      sx={{
        fontSize: 12,
        fontWeight: 600,
        fontFamily: 'inherit',
        borderRadius: '6px',
        px: '14px',
        py: '6px',
        ...(disabled
          ? { background: '#f1f5f9', color: '#94a3b8', cursor: 'not-allowed' }
          : {
              color: '#fff',
              background: 'linear-gradient(180deg,#10b981,#059669)',
              boxShadow: '0 1px 2px rgba(16,24,40,.08)',
            }),
      }}
    >
      {children}
    </ButtonBase>
  );
}

/** Page footer (Copyright © CoolScaler 2026.) */
export function OverviewFooter() {
  return (
    <Box
      component="footer"
      sx={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', pt: 1, pb: 3 }}
    >
      Copyright ©{' '}
      <Box component="span" sx={{ textDecoration: 'underline', textDecorationColor: '#cbd5e1' }}>
        CoolScaler
      </Box>{' '}
      2026.
    </Box>
  );
}

/** applyWl() port — confirm + POST /api/apply + toast + refresh. */
export function useApplyWorkload() {
  const { ro, refresh } = useClusterData();
  const { toast, confirm } = useFeedback();

  return async (w: Workload) => {
    if (ro) {
      toast(
        'Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to apply recommendations.',
      );
      return;
    }
    const hpaNote = w.hpaManaged
      ? '\n\nIts HPA/KEDA utilization triggers will be converted to absolute targetAverageValue to preserve horizontal scaling.'
      : '';
    if (!(await confirm(`Apply recommendation to ${w.kind} ${w.namespace}/${w.name}?${hpaNote}`)))
      return;
    try {
      const j = await postJson<ActionResponse>('/api/apply', {
        namespace: w.namespace,
        kind: w.kind,
        name: w.name,
      });
      toast(
        j.ok
          ? 'Applied ✓\n' + (j.message || '')
          : 'Could not apply:\n' + (j.message || 'unknown error'),
      );
    } catch {
      toast('Request failed.');
    }
    refresh();
  };
}

/** Recommended actions derived from WORKLOADS (sizable, savings > $0.5). */
export function recommendedActions(workloads: Workload[]): Workload[] {
  return [...workloads].filter((w) => w.sizable && w.savings > 0.5).sort((a, b) => b.savings - a.savings);
}
