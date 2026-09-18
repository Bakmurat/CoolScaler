// Custom Workload (CustomOwnerGrouping) editor drawer
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Formik, useFormikContext, type FormikProps } from 'formik';
import * as Yup from 'yup';
import { postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import SlideOver, { DrawerHeader, HeaderBtn } from '../../components/SlideOver';
import { selStyle } from '../policies/fields';
import { useAttrCatalogs, DataList } from '../policies/RulesEditor';
import { cpuFmt, memFmt } from '../../lib/format';
import type {
  CogFilterItem,
  CogGroupType,
  CogRule,
  CogRuleItem,
  CogSimResponse,
  CustomWorkloadRow,
  CogGroupByItem,
} from './types';

const COG_GROUP_TYPES: { label: string; value: CogGroupType }[] = [
  { label: 'annotations key', value: 'annotationKey' },
  { label: 'annotations key and value', value: 'annotationKV' },
  { label: 'envs key', value: 'envKey' },
  { label: 'envs key and value', value: 'envKV' },
  { label: 'images', value: 'image' },
  { label: 'images values', value: 'imageValue' },
  { label: 'labels keys', value: 'labelKey' },
  { label: 'labels key and value', value: 'labelKV' },
  { label: 'owner kind', value: 'owner' },
  { label: 'node size', value: 'nodeSize' },
  { label: 'container names', value: 'containerName' },
];

const KV_TYPES = new Set<CogGroupType>(['annotationKV', 'envKV', 'labelKV']);

export interface CogFormValues {
  name: string;
  builtIn: boolean;
  enabled: boolean;
  weight: number;
  defaultPolicy: string;
  defaultAuto: boolean;
  rules: CogRule[];
}

export const gpuFmt = (v?: number | null) => (v == null || v === 0 ? '0' : String(Math.round(v * 100) / 100));

const splitKV = (s: string): [string, string | undefined] => {
  const i = s.indexOf('=');
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
};

function cogItemToRule(item: CogGroupByItem): CogRule {
  const g: CogRuleItem[] = [];
  const pushKv = (arr: string[] | undefined, keyType: CogGroupType, kvType: CogGroupType) => {
    (arr || []).forEach((v) => {
      const [k, val] = splitKV(v);
      if (val !== undefined) g.push({ type: kvType, value: k, kvValue: val });
      else g.push({ type: keyType, value: k });
    });
  };
  pushKv(item.labels, 'labelKey', 'labelKV');
  pushKv(item.annotations, 'annotationKey', 'annotationKV');
  pushKv(item.envs, 'envKey', 'envKV');
  (item.images || []).forEach((v) => g.push({ type: 'image', value: v }));
  (item.imagesValues || []).forEach((v) => g.push({ type: 'imageValue', value: v }));
  (item.containerNames || []).forEach((v) => g.push({ type: 'containerName', value: v }));
  if (item.nodeSize) g.push({ type: 'nodeSize', value: item.nodeSize === true ? '' : String(item.nodeSize) });
  if (item.topOwnerController?.kind) g.push({ type: 'owner', value: item.topOwnerController.kind });
  const filters: CogFilterItem[] = [];
  (item.exclude?.labels || []).forEach((v) => filters.push({ type: 'excludeLabel', value: v }));
  (item.exclude?.annotations || []).forEach((v) => filters.push({ type: 'excludeAnnotation', value: v }));
  return { grouping: g.length ? g : [{ type: 'labelKey', value: '' }], filters };
}

export function cogFromExisting(existing: CustomWorkloadRow | null): CogFormValues {
  if (!existing)
    return {
      name: '',
      builtIn: false,
      enabled: true,
      weight: 0,
      defaultPolicy: 'Auto detected',
      defaultAuto: false,
      rules: [{ grouping: [{ type: 'labelKey', value: '' }], filters: [] }],
    };
  return {
    name: existing.name,
    builtIn: !!existing.builtIn,
    enabled: existing.enabled !== false,
    weight: existing.weight || 0,
    defaultPolicy: existing.defaultPolicy || 'Auto detected',
    defaultAuto: !!existing.defaultAuto,
    rules:
      existing.groupBys && existing.groupBys.length
        ? existing.groupBys.map(cogItemToRule)
        : [{ grouping: [{ type: 'owner', value: existing.ownerKind || '' }], filters: [] }],
  };
}

export function cogBuildGroupBys(values: CogFormValues): Record<string, unknown>[] {
  return values.rules
    .map((r) => {
      const it: Record<string, unknown> = {};
      const push = (k: string, v: string) => {
        const arr = (it[k] as string[]) || [];
        arr.push(v);
        it[k] = arr;
      };
      r.grouping.forEach((g) => {
        const v = (g.value || '').trim();
        if (g.type === 'nodeSize') {
          it.nodeSize = v || true;
          return;
        }
        if (!v) return;
        const kv = KV_TYPES.has(g.type) && (g.kvValue || '').trim() !== '' ? v + '=' + (g.kvValue || '').trim() : v;
        switch (g.type) {
          case 'owner':
            it.topOwnerController = { kind: v };
            break;
          case 'labelKey':
          case 'labelKV':
            push('labels', kv);
            break;
          case 'annotationKey':
          case 'annotationKV':
            push('annotations', kv);
            break;
          case 'envKey':
          case 'envKV':
            push('envs', kv);
            break;
          case 'image':
            push('images', v);
            break;
          case 'imageValue':
            push('imagesValues', v);
            break;
          case 'containerName':
            push('containerNames', v);
            break;
        }
      });
      const exLabels = (r.filters || []).filter((f) => f.type === 'excludeLabel' && f.value.trim()).map((f) => f.value.trim());
      const exAnnos = (r.filters || []).filter((f) => f.type === 'excludeAnnotation' && f.value.trim()).map((f) => f.value.trim());
      if ((exLabels.length || exAnnos.length) && Object.keys(it).length) {
        it.exclude = {
          ...(exLabels.length ? { labels: exLabels } : {}),
          ...(exAnnos.length ? { annotations: exAnnos } : {}),
        };
      }
      return it;
    })
    .filter((it) => Object.keys(it).some((k) => k !== 'exclude'));
}

const schema = Yup.object({
  name: Yup.string()
    .required('Valid name required (no dashes)')
    .matches(/^[^-]+$/, 'Valid name required (no dashes)'),
});

export default function CogDrawer({
  open,
  existing,
  policyNames,
  onClose,
  onDuplicate,
  onViewSim,
}: {
  open: boolean;
  existing: CustomWorkloadRow | null;
  policyNames: string[];
  onClose: () => void;
  onDuplicate: (name: string) => void;
  onViewSim: (sim: CogSimResponse) => void;
}) {
  const { toast } = useFeedback();
  const initial = useMemo(() => cogFromExisting(existing), [existing]);

  const save = useCallback(
    async (values: CogFormValues) => {
      const name = (values.name || '').trim();
      if (!name || /-/.test(name)) {
        // Loud + explicit: a rejected save must not look like a save (the
        // drawer header echoes the typed name, which used to read as success).
        toast(
          !name
            ? 'Name is required — the rule was NOT saved.'
            : `"${name}" was NOT saved — dashes are not allowed in custom-workload names (try "${name.replace(/-/g, '')}").`,
          'error',
        );
        return;
      }
      const gbs = cogBuildGroupBys(values);
      if (!gbs.length) {
        toast('Add at least one grouping rule', 'warn');
        return;
      }
      try {
        const r = await postJson<{ ok?: boolean; message?: string }>('/api/cog/save', {
          name,
          groupBys: gbs,
          defaultPolicy: values.defaultPolicy,
          defaultAuto: values.defaultAuto,
          enabled: values.enabled,
          weight: values.weight || 0,
        });
        if (r.ok) {
          toast('Custom workload saved');
          onClose();
        } else toast(r.message || 'Save failed', 'error');
      } catch {
        toast('Save failed', 'error');
      }
    },
    [toast, onClose],
  );

  if (!open) return null;
  const ro = !!existing?.builtIn;

  return (
    <SlideOver open={open} onClose={onClose} maxWidth={620}>
      <Formik<CogFormValues> initialValues={initial} enableReinitialize validationSchema={schema} onSubmit={save}>
        {(fp: FormikProps<CogFormValues>) => (
          <>
            <DrawerHeader
              left={
                <>
                  {ro ? '🔒 ' : ''}
                  {fp.values.name || 'New custom workload'}
                  {ro && (
                    <span className="pill" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', marginLeft: 8 }}>
                      Built in
                    </span>
                  )}
                </>
              }
              right={
                <>
                  <HeaderBtn outline onClick={onClose}>
                    Cancel
                  </HeaderBtn>
                  {ro ? (
                    <HeaderBtn onClick={() => onDuplicate(fp.values.name)}>Duplicate to edit</HeaderBtn>
                  ) : (
                    <HeaderBtn onClick={() => void fp.submitForm()}>Save</HeaderBtn>
                  )}
                </>
              }
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '0 12px',
                borderBottom: '1px solid #e9eaf0',
                background: '#eef0f4',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  borderBottom: '2px solid #6366f1',
                  color: '#4f46e5',
                }}
              >
                Custom Workload
              </span>
            </div>
            <CogEditorBody ro={ro} policyNames={policyNames} />
            <CogSimFooter values={fp.values} onViewSim={onViewSim} />
          </>
        )}
      </Formik>
    </SlideOver>
  );
}

function CogToggle({ label, field, ro }: { label: string; field: 'defaultAuto' | 'enabled'; ro: boolean }) {
  const { values, setFieldValue } = useFormikContext<CogFormValues>();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1e2536' }}>{label}</div>
      <label className="tog">
        <input
          type="checkbox"
          checked={!!values[field]}
          disabled={ro}
          onChange={(e) => void setFieldValue(field, e.target.checked)}
        />
        <span className="sl" />
      </label>
    </div>
  );
}

function CogEditorBody({ ro, policyNames }: { ro: boolean; policyNames: string[] }) {
  const { values, setFieldValue } = useFormikContext<CogFormValues>();
  const { cogOpts } = useAttrCatalogs();
  const polOpts = ['Auto detected', ...policyNames];
  const setRules = (rules: CogRule[]) => void setFieldValue('rules', rules);

  const valListFor = (t: CogGroupType): string[] => {
    switch (t) {
      case 'owner':
        return cogOpts.owners || [];
      case 'labelKey':
      case 'labelKV':
        return cogOpts.labelsKeys || [];
      case 'annotationKey':
      case 'annotationKV':
        return cogOpts.annotationsKey || [];
      case 'image':
      case 'imageValue':
        return cogOpts.images || [];
      case 'envKey':
      case 'envKV':
        return cogOpts.envsKeys || [];
      default:
        return [];
    }
  };

  const keyLabelFor = (t: CogGroupType): string => {
    switch (t) {
      case 'owner':
        return 'Owner Kind';
      case 'nodeSize':
        return 'Node size (optional)';
      case 'image':
      case 'imageValue':
        return 'Image (regex)';
      case 'containerName':
        return 'Container name';
      default:
        return 'Key';
    }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#1e2536' }}>
        {ro ? 'View custom workload' : values.name ? 'Edit custom workload' : 'Create custom workload'}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: -8 }}>
        {ro ? 'Built-in custom workloads are read-only — duplicate to edit.' : 'Create your custom workload by providing the necessary details below.'}
      </div>
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Name</div>
        <input
          disabled={ro}
          value={values.name}
          placeholder="Enter name"
          onChange={(e) => void setFieldValue('name', e.target.value)}
          style={{ ...selStyle, cursor: 'text' }}
        />
      </div>
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Default Policy ⓘ</div>
        <select
          disabled={ro}
          value={values.defaultPolicy}
          onChange={(e) => void setFieldValue('defaultPolicy', e.target.value)}
          style={selStyle}
        >
          {polOpts.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      <CogToggle label="Default Automation" field="defaultAuto" ro={ro} />
      <CogToggle label="Enabled" field="enabled" ro={ro} />
      <div style={{ borderTop: '1px solid #eef0f6', paddingTop: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Rules ⓘ</div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          Define the rules for your custom workload. You can add multiple rules with different labels, annotations,
          images, and owner kinds.
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
          ⇒ <b>Within</b> a rule: Conditions are combined using an <b>AND</b> operator.
          <br />⇒ Rules are combined using an <b>OR</b> operator.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {values.rules.map((r, i) => (
          <div key={i} className="card" style={{ padding: 12, background: '#fafbfd', border: '1px solid #eef0f6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1e2536' }}>Rule</div>
              {!ro && (
                <button
                  title="Remove rule"
                  onClick={() => {
                    const rules = values.rules.filter((_, j) => j !== i);
                    setRules(rules.length ? rules : [{ grouping: [{ type: 'labelKey', value: '' }], filters: [] }]);
                  }}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1' }}
                >
                  🗑
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginTop: 4 }}>Grouping Rules</div>
            {r.grouping.map((g, j) => {
              const listId = `dl-cog-${i}-${j}`;
              const kv = KV_TYPES.has(g.type);
              const setGrouping = (patch: Partial<CogRuleItem>) => {
                const rules = values.rules.slice();
                const grouping = r.grouping.slice();
                grouping[j] = { ...g, ...patch };
                rules[i] = { ...r, grouping };
                setRules(rules);
              };
              return (
                <div
                  key={j}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: kv ? '1fr 1fr 1fr' : '1fr 1fr',
                    gap: 12,
                    alignItems: 'end',
                    marginTop: 8,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Group by</div>
                    <select
                      disabled={ro}
                      value={g.type}
                      onChange={(e) => setGrouping({ type: e.target.value as CogGroupType })}
                      style={selStyle}
                    >
                      {COG_GROUP_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{keyLabelFor(g.type)}</div>
                      <input
                        disabled={ro}
                        value={g.value || ''}
                        list={listId}
                        placeholder={g.type === 'owner' ? 'CronJob' : g.type === 'nodeSize' ? '4core8gib' : 'app'}
                        onChange={(e) => setGrouping({ value: e.target.value })}
                        style={{ ...selStyle, cursor: 'text' }}
                      />
                      <DataList id={listId} values={valListFor(g.type)} />
                    </div>
                    {!kv && !ro && (
                      <button
                        onClick={() => {
                          const rules = values.rules.slice();
                          const grouping = r.grouping.filter((_, k) => k !== j);
                          rules[i] = { ...r, grouping: grouping.length ? grouping : [{ type: 'labelKey', value: '' }] };
                          setRules(rules);
                        }}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1', marginBottom: 4 }}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                  {kv && (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Value</div>
                        <input
                          disabled={ro}
                          value={g.kvValue || ''}
                          placeholder="value"
                          onChange={(e) => setGrouping({ kvValue: e.target.value })}
                          style={{ ...selStyle, cursor: 'text' }}
                        />
                      </div>
                      {!ro && (
                        <button
                          onClick={() => {
                            const rules = values.rules.slice();
                            const grouping = r.grouping.filter((_, k) => k !== j);
                            rules[i] = { ...r, grouping: grouping.length ? grouping : [{ type: 'labelKey', value: '' }] };
                            setRules(rules);
                          }}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1', marginBottom: 4 }}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!ro && (
              <button
                onClick={() => {
                  const rules = values.rules.slice();
                  rules[i] = { ...r, grouping: [...r.grouping, { type: 'labelKey', value: '' }] };
                  setRules(rules);
                }}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: '#6366f1',
                  fontSize: 12,
                  marginTop: 8,
                  fontFamily: 'inherit',
                  padding: 0,
                }}
              >
                ⊕ Add Grouping Rule
              </button>
            )}

            {/* Filters — exclude labels / annotations */}
            <div style={{ borderTop: '1px solid #eef0f6', marginTop: 12, paddingTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>Filters</div>
              {(r.filters || []).map((flt, k) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end', marginTop: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Filter</div>
                    <select
                      disabled={ro}
                      value={flt.type}
                      onChange={(e) => {
                        const rules = values.rules.slice();
                        const filters = (r.filters || []).slice();
                        filters[k] = { ...flt, type: e.target.value as CogFilterItem['type'] };
                        rules[i] = { ...r, filters };
                        setRules(rules);
                      }}
                      style={selStyle}
                    >
                      <option value="excludeLabel">exclude labels</option>
                      <option value="excludeAnnotation">exclude annotations</option>
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Key (or key=value)</div>
                    <input
                      disabled={ro}
                      value={flt.value}
                      placeholder="app=canary"
                      onChange={(e) => {
                        const rules = values.rules.slice();
                        const filters = (r.filters || []).slice();
                        filters[k] = { ...flt, value: e.target.value };
                        rules[i] = { ...r, filters };
                        setRules(rules);
                      }}
                      style={{ ...selStyle, cursor: 'text' }}
                    />
                  </div>
                  {!ro && (
                    <button
                      onClick={() => {
                        const rules = values.rules.slice();
                        rules[i] = { ...r, filters: (r.filters || []).filter((_, m) => m !== k) };
                        setRules(rules);
                      }}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1', marginBottom: 6 }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              ))}
              {!ro && (
                <button
                  onClick={() => {
                    const rules = values.rules.slice();
                    rules[i] = { ...r, filters: [...(r.filters || []), { type: 'excludeLabel', value: '' }] };
                    setRules(rules);
                  }}
                  style={{
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    color: '#6366f1',
                    fontSize: 12,
                    marginTop: 8,
                    fontFamily: 'inherit',
                    padding: 0,
                  }}
                >
                  ⊕ Add Filter
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {!ro && (
        <button
          onClick={() => setRules([...values.rules, { grouping: [{ type: 'labelKey', value: '' }], filters: [] }])}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            color: '#4f46e5',
            fontFamily: 'inherit',
            padding: 0,
          }}
        >
          ⊕ Add Rule
        </button>
      )}
    </div>
  );
}

// SIMULATION footer — debounced /api/cog/simulate on every groupBy change.
function CogSimFooter({ values, onViewSim }: { values: CogFormValues; onViewSim: (s: CogSimResponse) => void }) {
  const [sim, setSim] = useState<CogSimResponse | null>(null);
  const [state, setState] = useState<'empty' | 'ok' | 'failed'>('empty');
  const gbsJson = useMemo(() => JSON.stringify(cogBuildGroupBys(values)), [values]);

  useEffect(() => {
    const gbs = JSON.parse(gbsJson) as unknown[];
    if (!gbs.length) {
      setState('empty');
      setSim(null);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const r = await postJson<CogSimResponse>('/api/cog/simulate', { groupBys: gbs });
        setSim(r);
        setState('ok');
      } catch {
        setState('failed');
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [gbsJson]);

  return (
    <div
      style={{
        borderTop: '1px solid #eef0f6',
        padding: '12px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 8 }}>
        {state === 'empty' && (
          <>
            <span className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>
              SIMULATION
            </span>
            Add rules to see matches
          </>
        )}
        {state === 'failed' && (
          <>
            <span className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>
              SIMULATION
            </span>
            failed
          </>
        )}
        {state === 'ok' && sim && (
          <>
            <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>
              SIMULATION
            </span>
            {sim.matchedWorkloads
              ? `${sim.matchedWorkloads} workload(s), ${sim.matchedPods} pod(s) matched`
              : 'No workloads matched'}
            {!!sim.matchedWorkloads && (
              <button
                onClick={() => onViewSim(sim)}
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 4,
                  padding: '2px 8px',
                  background: '#6366f1',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                View simulation
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export { cpuFmt, memFmt };
