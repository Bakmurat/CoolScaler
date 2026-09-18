// Used inside the Policy drawer's Rules tab and in the standalone rules drawer.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { getJson, postJson } from '../../api/client';
import {
  IDENTIFIER_TYPE_OPTS,
  reverseIdentLabel,
  type AttrCatalogs,
  type CogOptions,
  type RuleBlock,
  type RuleIdent,
} from './model';
import { selStyle } from './fields';

let ATTR_CACHE: AttrCatalogs | null = null;
let COG_CACHE: CogOptions | null = null;

export function useAttrCatalogs(): { attrs: AttrCatalogs; cogOpts: CogOptions } {
  const [attrs, setAttrs] = useState<AttrCatalogs>(ATTR_CACHE || {});
  const [cogOpts, setCogOpts] = useState<CogOptions>(COG_CACHE || {});
  useEffect(() => {
    if (ATTR_CACHE && COG_CACHE) return;
    let dead = false;
    void Promise.all([
      getJson<AttrCatalogs>('/api/custom-rules-attributes').catch(() => ({}) as AttrCatalogs),
      getJson<CogOptions>('/api/cog/group-by-options').catch(() => ({}) as CogOptions),
    ]).then(([a, c]) => {
      ATTR_CACHE = a;
      COG_CACHE = c;
      if (!dead) {
        setAttrs(a);
        setCogOpts(c);
      }
    });
    return () => {
      dead = true;
    };
  }, []);
  return { attrs, cogOpts };
}

export function DataList({ id, values }: { id: string; values?: string[] }) {
  return (
    <datalist id={id}>
      {(values || []).slice(0, 300).map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
}

export interface RulesEditorHandle {
  dirty: boolean;
  save: () => Promise<boolean>;
}

interface RulesApiRow {
  policyName: string;
  tag: string;
  rules?: { type: string; key?: string; value?: string }[][];
}

const RulesEditor = forwardRef<RulesEditorHandle, { policyNames: string[]; scopePolicy?: string }>(function RulesEditor(
  { policyNames, scopePolicy },
  ref,
) {
  const { attrs } = useAttrCatalogs();
  const [rules, setRules] = useState<RuleBlock[] | null>(null);
  const dirtyRef = useRef(false);
  const rulesRef = useRef<RuleBlock[]>([]);
  // rules attached to OTHER policies (kept invisible when scoped, merged on save
  // so a scoped save never wipes them)
  const othersRef = useRef<RuleBlock[]>([]);
  rulesRef.current = rules || [];

  useEffect(() => {
    let dead = false;
    getJson<{ rules?: RulesApiRow[] }>('/api/policy-rules')
      .then((d) => {
        if (dead) return;
        const flat: RuleBlock[] = (d.rules || []).flatMap((r) =>
          (r.rules || []).map((g) => ({
            policyName: r.policyName,
            tag: r.tag,
            rules: [g.map((x) => ({ type: reverseIdentLabel(x.type), key: x.key || '', value: x.value || '' }))],
          })),
        );
        if (scopePolicy) {
          othersRef.current = flat.filter((r) => r.policyName !== scopePolicy);
          setRules(flat.filter((r) => r.policyName === scopePolicy));
        } else {
          othersRef.current = [];
          setRules(flat);
        }
      })
      .catch(() => setRules([]));
    return () => {
      dead = true;
    };
  }, [scopePolicy]);

  useImperativeHandle(ref, () => ({
    get dirty() {
      return dirtyRef.current;
    },
    save: async () => {
      const payload = {
        rules: [...othersRef.current, ...rulesRef.current].map((r) => ({
          policyName: r.policyName,
          tag: r.tag,
          rules: [
            (r.rules[0] || [])
              .filter((x) => x.type && x.key)
              .map((x) => ({ type: x.type, key: x.key, value: x.value })),
          ],
        })),
      };
      const res = await postJson<{ ok?: boolean }>('/api/policy-rules/save', payload).catch(() => null);
      return !!res?.ok;
    },
  }));

  if (rules === null) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;

  const upd = (next: RuleBlock[]) => {
    dirtyRef.current = true;
    setRules(next);
  };
  const polOpts = policyNames.filter((n) => n !== 'default');

  const identKeyOptions = (t: string): string[] =>
    Object.keys(
      (t || '').startsWith('annotation') ? attrs.annotations || {} : (t || '').startsWith('env') ? attrs.envs || {} : attrs.labels || {},
    );
  const identValOptions = (it: RuleIdent): string[] => {
    const fam = (it.type || '').startsWith('annotation')
      ? attrs.annotations
      : (it.type || '').startsWith('env')
        ? attrs.envs
        : attrs.labels;
    return (fam || {})[it.key] || [];
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        Create rules to automatically associate a policy to workloads. Use environment variables, labels, and
        annotations to identify the target workload. Identifiers within a rule are AND-ed; rules are OR-ed. A
        manual UI policy assignment always overrides a rule.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {rules.length === 0 && (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            {scopePolicy ? `No rules attached to \u201c${scopePolicy}\u201d yet.` : 'No rules.'}
          </div>
        )}
        {rules.map((r, ri) => (
          <div key={ri} className="card" style={{ padding: 16, background: '#fafbfd', border: '1px solid #eef0f6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 1 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Attach policy</div>
                  <select
                    value={r.policyName}
                    onChange={(e) => {
                      const n = rules.slice();
                      n[ri] = { ...r, policyName: e.target.value };
                      upd(n);
                    }}
                    style={selStyle}
                  >
                    {polOpts.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Detected Workload Tag</div>
                  <input
                    value={r.tag || ''}
                    placeholder="team-a"
                    onChange={(e) => {
                      const n = rules.slice();
                      n[ri] = { ...r, tag: e.target.value };
                      upd(n);
                    }}
                    style={{ ...selStyle, cursor: 'text' }}
                  />
                </div>
              </div>
              <button
                title="Remove rule"
                onClick={() => upd(rules.filter((_, j) => j !== ri))}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1', marginLeft: 12, marginTop: 4 }}
              >
                🗑
              </button>
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#1e2536', marginTop: 12 }}>
              Define Detected Workload Identifiers
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {(r.rules[0] || []).map((it, ii) => {
                const kv = it.type === 'labelKV' || it.type === 'annotationKV' || it.type === 'envKV';
                const setIdent = (patch: Partial<RuleIdent>) => {
                  const n = rules.slice();
                  const g = (r.rules[0] || []).slice();
                  g[ii] = { ...it, ...patch };
                  n[ri] = { ...r, rules: [g] };
                  upd(n);
                };
                const keyListId = `dl-keys-${ri}-${ii}`;
                const valListId = `dl-vals-${ri}-${ii}`;
                return (
                  <div key={ii} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, alignItems: 'end' }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Type</div>
                      <select value={it.type} onChange={(e) => setIdent({ type: e.target.value })} style={selStyle}>
                        {IDENTIFIER_TYPE_OPTS.map((o) => (
                          <option key={String(o.value)} value={String(o.value)}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Key</div>
                      <input
                        value={it.key || ''}
                        list={keyListId}
                        placeholder="key"
                        onChange={(e) => setIdent({ key: e.target.value })}
                        style={{ ...selStyle, cursor: 'text' }}
                      />
                      <DataList id={keyListId} values={identKeyOptions(it.type)} />
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{kv ? 'Value' : '—'}</div>
                        <input
                          disabled={!kv}
                          value={it.value || ''}
                          list={valListId}
                          placeholder={kv ? 'value' : ''}
                          onChange={(e) => setIdent({ value: e.target.value })}
                          style={{ ...selStyle, cursor: 'text' }}
                        />
                        <DataList id={valListId} values={identValOptions(it)} />
                      </div>
                      <button
                        title="Remove"
                        onClick={() => {
                          const n = rules.slice();
                          n[ri] = { ...r, rules: [(r.rules[0] || []).filter((_, k) => k !== ii)] };
                          upd(n);
                        }}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1', marginBottom: 4 }}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                title="Add identifier (AND)"
                onClick={() => {
                  const n = rules.slice();
                  n[ri] = { ...r, rules: [[...(r.rules[0] || []), { type: 'labelKeys', key: '', value: '' }]] };
                  upd(n);
                }}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#6366f1', fontSize: 18 }}
              >
                ⊕
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() =>
          upd([
            ...rules,
            {
              policyName: scopePolicy || policyNames[1] || 'production',
              tag: '',
              rules: [[{ type: 'labelKeys', key: '', value: '' }]],
            },
          ])
        }
        style={{
          marginTop: 16,
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
        ＋ Create new policy rule
      </button>
    </div>
  );
});

export default RulesEditor;
