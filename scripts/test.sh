#!/usr/bin/env bash
# CoolScaler smoke/integration test suite.
# Usage: scripts/test.sh [kube-context] [namespace]
# Exercises every component + API endpoint on a LIVE cluster where CoolScaler is
# installed and asserts expected behaviour. Defaults to the current kubectl context.
set -uo pipefail
CTX="${1:-$(kubectl config current-context)}"
NS="${2:-coolscaler-system}"
K="kubectl --context $CTX -n $NS"
PASS=0; FAIL=0
ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
no(){ printf "  \033[31m✗ %s\033[0m\n" "$1"; FAIL=$((FAIL+1)); }
chk(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else no "$1 (got '$2' want '$3')"; fi; }

echo "═══ CoolScaler test suite · context=$CTX ns=$NS ═══"

echo "[1] Components Ready"
for d in admissions agent dashboards kube-state-metrics prometheus-server recommender updater; do
  r=$($K get deploy coolscaler-$d -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "${r:-0}" -ge 1 ] && ok "deploy/$d ready" || no "deploy/$d not ready"
done
dsr=$($K get ds coolscaler-network-monitor -o jsonpath='{.status.numberReady}' 2>/dev/null)
dsd=$($K get ds coolscaler-network-monitor -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null)
[ "${dsr:-0}" = "${dsd:-1}" ] && [ "${dsr:-0}" -ge 1 ] && ok "daemonset network-monitor ($dsr/$dsd)" || no "daemonset network-monitor ($dsr/$dsd)"

echo "[2] Recommender API"
GET(){ $K exec deploy/coolscaler-recommender -- wget -qO- "http://localhost:8080$1" 2>/dev/null; }
{ GET /healthz; echo '@@'; GET /api/overview; echo '@@'; GET /api/workloads; echo '@@'; GET '/api/comparison?windowHours=1'; } | python3 -c "
import json,sys
def P(n,c): print(('  \033[32m✓\033[0m ' if c else '  \033[31m✗ ')+n+('' if c else '\033[0m'))
try:
    h,o,w,cmp=[json.loads(x) for x in sys.stdin.read().split('@@')]
    P('healthz ok',h.get('ok')==True)
    P('overview ready',o.get('ready')==True)
    P('dataSource=prometheus',o.get('dataSource')=='prometheus')
    P('workloads>0',o.get('workloads',0)>0)
    P('sizable>0',o.get('sizable',0)>0)
    P('workloads list non-empty',len(w.get('workloads',[]))>0)
    P('comparison periodB has cpu',cmp['periodB']['cpu'].get('allocatable') is not None)
    top=[x for x in w['workloads'] if x['sizable'] and x['savings']>0.5]
    if top:
        t=top[0]
        print('TOP %s/%s/%s'%(t['namespace'],t['kind'],t['name']))
    else:
        P('top saver present',False)
except Exception as e:
    print('  \033[31m✗ recommender API error:',e,'\033[0m')
" | while IFS= read -r line; do
  case "$line" in
    TOP\ *) t="${line#TOP }"
      rec=$(GET "/api/recommend/$t"); cr=$(GET "/api/recommendation/$t")
      echo "$rec@@$cr" | python3 -c "
import json,sys
def P(n,c): print(('  \033[32m✓\033[0m ' if c else '  \033[31m✗ ')+n+('' if c else '\033[0m'))
rec,cr=[json.loads(x) for x in sys.stdin.read().split('@@')]
P('/api/recommend found',rec.get('found')==True)
P('/api/recommendation CR found',cr.get('found')==True)
P('CR has rightSize.containers',len(cr.get('status',{}).get('rightSize',{}).get('containers',[]))>0)
" ;;
    *) printf '%s\n' "$line" ;;
  esac
done

echo "[3] Apply validation"
msg=$($K exec deploy/coolscaler-recommender -- sh -c \
  "wget -qO- --post-data='{}' --header='Content-Type: application/json' http://localhost:8080/api/apply 2>&1 | grep -o '400' | head -1")
[ "$msg" = "400" ] && ok "empty apply rejected (400)" || no "empty apply not rejected (got '$msg')"

echo "[4] CRDs"
$K get crd policies.analysis.coolscaler.sh >/dev/null 2>&1 && ok "Policy CRD installed" || no "Policy CRD missing"
$K get crd recommendations.analysis.coolscaler.sh >/dev/null 2>&1 && ok "Recommendation CRD installed" || no "Recommendation CRD missing"
pol=$($K get policies.analysis.coolscaler.sh --no-headers 2>/dev/null | wc -l | tr -d ' ')
[ "${pol:-0}" -ge 1 ] && ok "default Policy present ($pol)" || no "no Policy"
rec=$(kubectl --context "$CTX" get recommendations.analysis.coolscaler.sh -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
[ "${rec:-0}" -ge 1 ] && ok "Recommendation CRs written ($rec)" || no "no Recommendation CRs"

echo "[5] Prometheus targets"
$K exec deploy/coolscaler-recommender -- wget -qO- http://coolscaler-prometheus-server/api/v1/targets 2>/dev/null | python3 -c "
import json,sys
t=json.load(sys.stdin)['data']['activeTargets']
up=sum(1 for x in t if x['health']=='up'); dn=sum(1 for x in t if x['health']!='up')
print(('  \033[32m✓\033[0m ' if up>0 and dn==0 else '  \033[31m✗ ')+'prometheus targets up=%d down=%d'%(up,dn)+('' if dn==0 else '\033[0m'))
"

echo "[6] Webhook"
fp=$(kubectl --context "$CTX" get mutatingwebhookconfiguration coolscaler-mutating-webhook -o jsonpath='{.webhooks[0].failurePolicy}' 2>/dev/null)
chk "webhook failurePolicy" "$fp" "Ignore"

echo "═══ RESULT: $PASS passed, $FAIL failed ═══"
[ "$FAIL" -eq 0 ]
