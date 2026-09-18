package engine

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Custom Owner Grouping matching + simulation and the COG POST endpoint
// bodies (do_POST 8382–8467).

func cogRegexSearch(pat, target string) bool {
	rx, err := regexp.Compile(pat)
	if err != nil {
		return strings.Contains(target, pat)
	}
	return rx.MatchString(target)
}

// images / key-only envs).
func cogRendered(k string, v any) string {
	if vs := pyStr(v); v != nil && v != "" && vs != k {
		return k + ": " + vs
	}
	return k
}

// cogSearchIndex is re.search with substring fallback on invalid patterns.
func cogSearchIndex(pat, target string) []int {
	rx, err := regexp.Compile(pat)
	if err != nil {
		if i := strings.Index(target, pat); i >= 0 {
			return []int{i, i + len(pat)}
		}
		return nil
	}
	return rx.FindStringIndex(target)
}

// cogPositiveMatch implements positiveRegexMatch=true: the regex match itself
// is the unique value — concatenated capture groups when the pattern has any,
// else the full match.
func cogPositiveMatch(pat, target string) (string, bool) {
	rx, err := regexp.Compile(pat)
	if err != nil {
		if strings.Contains(target, pat) {
			return pat, true
		}
		return "", false
	}
	m := rx.FindStringSubmatch(target)
	if m == nil {
		return "", false
	}
	if len(m) > 1 {
		var parts []string
		for _, g := range m[1:] {
			if g != "" {
				parts = append(parts, g)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "-"), true
		}
	}
	return m[0], true
}

// With positiveRegexMatch=false the REMAINDER after the match is the unique
// value (key-only pattern -> the value; "key: value-prefix" -> the value
// suffix); with positiveRegexMatch=true the regex match / capture groups are
// the value.
func cogMatchDim(patterns []any, mapping *pyjson.Obj, positive bool) (any, bool) {
	for _, pv := range patterns {
		pat := str(pv)
		for _, k := range mapping.Keys() {
			v := mapping.GetD(k, nil)
			rendered := cogRendered(k, v)
			if positive {
				if got, ok := cogPositiveMatch(pat, rendered); ok {
					return got, true
				}
				continue
			}
			loc := cogSearchIndex(pat, rendered)
			if loc == nil {
				continue
			}
			if rest := strings.TrimLeft(rendered[loc[1]:], ": "); rest != "" {
				return rest, true
			}
			if v != nil && v != "" {
				return v, true
			}
			return k, true
		}
	}
	return nil, false
}

// positiveRegexMatch=true excludes on any RE2 match; false excludes when a
// rendered "key: value" (or the key) starts with the pattern — regex-on-key
// kept as a back-compat fallback.
func cogExcluded(patterns []any, mapping *pyjson.Obj, positive bool) bool {
	for _, pv := range patterns {
		pat := str(pv)
		for _, k := range mapping.Keys() {
			rendered := cogRendered(k, mapping.GetD(k, nil))
			if positive {
				if cogRegexSearch(pat, rendered) {
					return true
				}
			} else if strings.HasPrefix(rendered, pat) || cogRegexSearch(pat, k) {
				return true
			}
		}
	}
	return false
}

func cogRegexHit(pat, value string) bool {
	rx, err := regexp.Compile(pat)
	if err != nil {
		return strings.Contains(value, pat)
	}
	return rx.MatchString(value)
}

type podIdent struct {
	labels, anns   *pyjson.Obj
	images, cnames []string
	envs           *pyjson.Obj
	ownerKind      string
	ownerName      string
	ownerApi       string
	nodeSize       string
}

func podIdents(p *pyjson.Obj, rsIndex map[string]*ownerRef, nodeLbls map[string]*pyjson.Obj) *podIdent {
	md := getObj(p, "metadata")
	spec := getObj(p, "spec")
	containers := getList(spec, "containers")
	envs := pyjson.NewObj()
	var images, cnames []string
	for _, cv := range containers {
		c := obj(cv)
		images = append(images, getStr(c, "image"))
		cnames = append(cnames, getStr(c, "name"))
		for _, ev := range getList(c, "env") {
			en := obj(ev)
			nm := getStr(en, "name")
			if nm == "" || envs.Has(nm) {
				continue
			}
			v := en.GetD("value", nil)
			if v == nil || v == "" {
				envs.Set(nm, nm)
			} else {
				envs.Set(nm, v)
			}
		}
	}
	ownerApi := ""
	for _, ov := range getList(md, "ownerReferences") {
		or := obj(ov)
		if truthy(or.GetD("controller", nil)) {
			ownerApi = getStr(or, "apiVersion")
			break
		}
	}
	_, okind, oname := topOwner(p, rsIndex)
	nsize := ""
	if nodeLbls != nil {
		if nn := getStr(spec, "nodeName"); nn != "" {
			nsize = nodeSizeBucket(obj(nodeLbls[nn]))
		}
	}
	return &podIdent{
		labels: getObj(md, "labels"), anns: getObj(md, "annotations"),
		images: images, cnames: cnames, envs: envs,
		ownerKind: okind, ownerName: oname, ownerApi: ownerApi, nodeSize: nsize,
	}
}

// Returns (groupKey, matched).
func cogItemMatch(item *pyjson.Obj, ident *podIdent) (string, bool) {
	pos := truthy(item.GetD("positiveRegexMatch", nil))
	if cogExcluded(getList(item, "excludeLabels"), ident.labels, pos) {
		return "", false
	}
	if cogExcluded(getList(item, "excludeAnnotations"), ident.anns, pos) {
		return "", false
	}
	var parts []string
	anyDim := false
	for _, dim := range []struct {
		key     string
		mapping *pyjson.Obj
	}{{"labels", ident.labels}, {"annotations", ident.anns}, {"envs", ident.envs}} {
		if pats := getList(item, dim.key); len(pats) > 0 {
			anyDim = true
			v, ok := cogMatchDim(pats, dim.mapping, pos)
			if !ok {
				return "", false
			}
			parts = append(parts, pyStr(v))
		}
	}
	if pats := getList(item, "images"); len(pats) > 0 {
		anyDim = true
		m := pyjson.NewObj()
		for _, img := range ident.images {
			m.Set(img, img)
		}
		v, ok := cogMatchDim(pats, m, pos)
		if !ok {
			return "", false
		}
		s := pyStr(v)
		if i := strings.LastIndex(s, "/"); i >= 0 {
			s = s[i+1:]
		}
		s = strings.SplitN(s, ":", 2)[0]
		parts = append(parts, s)
	}
	if pats := getList(item, "containerNames"); len(pats) > 0 {
		anyDim = true
		// Matched containers are unified per pattern — no per-container-name
		// key part, so pods whose containers have dynamic generated names
		// still land in the same group; with positiveRegexMatch the regex
		// match groups become the key part.
		anyHit := false
		for _, pv := range pats {
			pat := str(pv)
			var matched []string
			for _, cn := range ident.cnames {
				if cogRegexHit(pat, cn) {
					matched = append(matched, cn)
				}
			}
			if len(matched) > 1 {
				return "", false
			}
			if len(matched) == 1 {
				anyHit = true
				if pos {
					if got, ok := cogPositiveMatch(pat, matched[0]); ok {
						parts = append(parts, got)
					}
				}
			}
		}
		if !anyHit {
			return "", false
		}
	}
	toc := getObj(item, "topOwnerController")
	if truthy(toc.GetD("kind", nil)) || truthy(toc.GetD("apiVersion", nil)) || truthy(toc.GetD("name", nil)) {
		anyDim = true
		if truthy(toc.GetD("kind", nil)) && ident.ownerKind != str(toc.GetD("kind", nil)) {
			return "", false
		}
		if truthy(toc.GetD("apiVersion", nil)) && !cogRegexHit(str(toc.GetD("apiVersion", nil)), ident.ownerApi) {
			return "", false
		}
		if truthy(toc.GetD("name", nil)) && !cogRegexHit(str(toc.GetD("name", nil)), ident.ownerName) {
			return "", false
		}
		parts = append(parts, ident.ownerName)
	}
	if truthy(item.GetD("nodeSize", nil)) {
		anyDim = true
		if ident.nodeSize == "" {
			return "", false
		}
		parts = append(parts, ident.nodeSize)
	}
	if !anyDim {
		return "", false
	}
	return strings.Join(parts, "-"), true
}

func cogMatch(groupBys []any, ident *podIdent) (string, bool) {
	for _, iv := range groupBys {
		if gk, ok := cogItemMatch(obj(iv), ident); ok {
			return gk, true
		}
	}
	return "", false
}

func (e *Engine) CogSimulate(ctx context.Context, groupBys []any) (*pyjson.Obj, error) {
	pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods")
	if err != nil {
		return nil, err
	}
	rsResp, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/replicasets")
	if err != nil {
		return nil, err
	}
	rsIndex := buildOwnerIndex(rsResp)
	nodeLbls := map[string]*pyjson.Obj{}
	if nodes, nerr := e.Kube.GetJSON(ctx, "/api/v1/nodes"); nerr == nil {
		for _, nv := range items(nodes) {
			n := obj(nv)
			nodeLbls[getStr(getObj(n, "metadata"), "name")] = getObj(getObj(n, "metadata"), "labels")
		}
	}
	type agg struct {
		pods                  int
		cpu, mem, gpu, gpuMem float64
		namespaces            map[string]bool
	}
	groups := map[string]*agg{}
	var order []string
	for _, pv := range items(pods) {
		p := obj(pv)
		gk, ok := cogMatch(groupBys, podIdents(p, rsIndex, nodeLbls))
		if !ok {
			continue
		}
		g, exists := groups[gk]
		if !exists {
			g = &agg{namespaces: map[string]bool{}}
			groups[gk] = g
			order = append(order, gk)
		}
		g.pods++
		for _, cv := range getList(getObj(p, "spec"), "containers") {
			req := getObj(getObj(obj(cv), "resources"), "requests")
			g.cpu += ParseCPU(req.GetD("cpu", nil))
			g.mem += ParseMem(req.GetD("memory", nil))
			g.gpu += gpuReq(req)
		}
		g.namespaces[getStr(getObj(p, "metadata"), "namespace")] = true
	}
	type row struct {
		obj  *pyjson.Obj
		pods int
	}
	var rows []row
	totalPods := 0
	for _, gk := range order {
		g := groups[gk]
		totalPods += g.pods
		rows = append(rows, row{pyjson.NewObj().
			Set("name", gk).
			Set("pods", g.pods).
			Set("cpu", g.cpu).
			Set("mem", g.mem).
			Set("gpu", g.gpu).
			Set("gpuMem", g.gpuMem).
			Set("namespaces", strList(sortedKeys(g.namespaces))), g.pods})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].pods > rows[j].pods })
	out := []any{}
	for _, r := range rows {
		out = append(out, r.obj)
	}
	return pyjson.NewObj().
		Set("groups", out).
		Set("matchedWorkloads", len(out)).
		Set("matchedPods", totalPods), nil
}

// COG POST endpoint bodies.

// CogSave is /api/cog/save.
func (e *Engine) CogSave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	nm := strings.TrimSpace(str(body.GetD("name", "")))
	gbs := getList(body, "groupBys")
	if nm == "" || strings.Contains(nm, "-") {
		return 400, pyjson.NewObj().Set("ok", false).
			Set("message", "name required, no dashes allowed")
	}
	valid := false
	for _, iv := range gbs {
		i := obj(iv)
		hasOther := truthy(i.GetD("nodeSize", nil))
		for _, d := range []string{"labels", "annotations", "images", "envs"} {
			if truthy(i.GetD(d, nil)) {
				hasOther = true
			}
		}
		toc := getObj(i, "topOwnerController")
		for _, k := range []string{"kind", "name", "apiVersion"} {
			if truthy(toc.GetD(k, nil)) {
				hasOther = true
			}
		}
		if truthy(i.GetD("containerNames", nil)) && !hasOther {
			return 400, pyjson.NewObj().Set("ok", false).
				Set("message", "containerNames cannot be the sole group-by element in a rule")
		}
		if hasOther || truthy(i.GetD("containerNames", nil)) ||
			truthy(i.GetD("excludeLabels", nil)) || truthy(i.GetD("excludeAnnotations", nil)) {
			valid = true
		}
	}
	if !valid {
		return 400, pyjson.NewObj().Set("ok", false).
			Set("message", "each rule needs a label, annotation, env, image, container name, owner, or node-size match")
	}
	weight := 0
	if f, ok := toFloatLoose(body.GetD("weight", 0)); ok {
		weight = int(f)
	}
	entry := pyjson.NewObj().
		Set("name", nm).
		Set("groupBys", gbs).
		Set("defaultPolicy", body.GetD("defaultPolicy", "Auto detected")).
		Set("defaultAuto", truthy(body.GetD("defaultAuto", false))).
		Set("enabled", truthy(body.GetD("enabled", true))).
		Set("weight", weight).
		Set("hideSuffix", truthy(body.GetD("hideSuffix", true)))
	e.mu.Lock()
	kept := e.customOwnerGroupings[:0]
	for _, c := range e.customOwnerGroupings {
		if str(c.GetD("name", "")) != nm {
			kept = append(kept, c)
		}
	}
	e.customOwnerGroupings = append(kept, entry)
	e.mu.Unlock()
	e.writeCogCR(ctx, entry, false)
	e.audit("CustomWorkloadSave", nm, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", nm)
}

// CogDelete is /api/cog/delete.
func (e *Engine) CogDelete(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	nm := str(body.GetD("name", ""))
	e.mu.Lock()
	kept := e.customOwnerGroupings[:0]
	for _, c := range e.customOwnerGroupings {
		if str(c.GetD("name", "")) != nm {
			kept = append(kept, c)
		}
	}
	e.customOwnerGroupings = kept
	e.mu.Unlock()
	e.deleteCogCR(ctx, nm, false)
	return 200, pyjson.NewObj().Set("ok", true).Set("name", nm)
}

// findCogLocked returns the user COG entry (caller holds e.mu).
func (e *Engine) findCogLocked(nm string) *pyjson.Obj {
	for _, c := range e.customOwnerGroupings {
		if str(c.GetD("name", "")) == nm {
			return c
		}
	}
	return nil
}

// CogToggle is /api/cog/toggle.
func (e *Engine) CogToggle(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	nm := str(body.GetD("name", ""))
	en := truthy(body.GetD("enabled", true))
	e.mu.Lock()
	u := e.findCogLocked(nm)
	if u != nil {
		u.Set("enabled", en)
	} else {
		st := e.builtinCogState[nm]
		if st == nil {
			st = pyjson.NewObj()
			e.builtinCogState[nm] = st
		}
		st.Set("enabled", en)
	}
	var toWrite *pyjson.Obj
	builtin := false
	if u != nil {
		toWrite = u
	} else {
		toWrite = e.builtinCogState[nm].Clone()
		toWrite.Set("name", nm)
		builtin = true
	}
	e.mu.Unlock()
	e.writeCogCR(ctx, toWrite, builtin)
	val := "off"
	if en {
		val = "on"
	}
	e.audit("CustomWorkloadToggle", nm, "", val, "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", nm).Set("enabled", en)
}

// CogPolicy is POST /api/cog/policy (inline default-policy / automation change).
func (e *Engine) CogPolicy(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	nm := str(body.GetD("name", ""))
	e.mu.Lock()
	u := e.findCogLocked(nm)
	tgt := u
	if tgt == nil {
		tgt = e.builtinCogState[nm]
		if tgt == nil {
			tgt = pyjson.NewObj()
			e.builtinCogState[nm] = tgt
		}
	}
	if v, ok := body.Get("defaultPolicy"); ok {
		tgt.Set("defaultPolicy", v)
	}
	if v, ok := body.Get("defaultAuto"); ok {
		tgt.Set("defaultAuto", truthy(v))
	}
	var toWrite *pyjson.Obj
	builtin := false
	if u != nil {
		toWrite = u
	} else {
		toWrite = e.builtinCogState[nm].Clone()
		toWrite.Set("name", nm)
		builtin = true
	}
	e.mu.Unlock()
	e.writeCogCR(ctx, toWrite, builtin)
	return 200, pyjson.NewObj().Set("ok", true).Set("name", nm)
}

// CogPolicyGet is GET /api/cog/policy.
func (e *Engine) CogPolicyGet(nm string) *pyjson.Obj {
	e.mu.Lock()
	u := e.findCogLocked(nm)
	src := u
	if src == nil {
		src = e.builtinCogState[nm]
	}
	if src == nil {
		src = pyjson.NewObj()
	}
	out := pyjson.NewObj().
		Set("name", nm).
		Set("defaultPolicy", src.GetD("defaultPolicy", "Auto detected")).
		Set("defaultAuto", truthy(src.GetD("defaultAuto", false))).
		Set("enabled", src.GetD("enabled", true)).
		Set("builtIn", u == nil)
	e.mu.Unlock()
	return out
}

// CogDuplicate is /api/cog/duplicate.
func (e *Engine) CogDuplicate(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	src := str(body.GetD("source", ""))
	newName := strings.TrimSpace(str(body.GetD("name", "")))
	if newName == "" || strings.Contains(newName, "-") {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "valid new name required (no dashes)")
	}
	e.mu.Lock()
	if e.findCogLocked(newName) != nil {
		e.mu.Unlock()
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "name already in use")
	}
	u := e.findCogLocked(src)
	var gbs any
	var pol any = "Auto detected"
	var auto any = false
	if u != nil {
		cp, _ := pyjson.Decode(pyjson.Marshal(u.GetD("groupBys", []any{})))
		gbs = cp
		pol = u.GetD("defaultPolicy", "Auto detected")
		auto = u.GetD("defaultAuto", false)
	} else {
		gbs = []any{}
		for _, bw := range builtinCustomWorkloads {
			if bw[0] == src {
				gbs = []any{pyjson.NewObj().Set("topOwnerController",
					pyjson.NewObj().Set("kind", bw[1]))}
				break
			}
		}
	}
	dup := pyjson.NewObj().
		Set("name", newName).
		Set("groupBys", gbs).
		Set("defaultPolicy", pol).
		Set("defaultAuto", auto).
		Set("enabled", true).
		Set("hideSuffix", true)
	e.customOwnerGroupings = append(e.customOwnerGroupings, dup)
	e.mu.Unlock()
	e.writeCogCR(ctx, dup, false)
	e.audit("CustomWorkloadDuplicate", newName, src, "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", newName)
}

// Downscaler / scheduling policy CRUD.

func (e *Engine) DownscalePolicySave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	isNew := truthy(body.GetD("isNew", nil))
	if name == "" || !reRFC1123.MatchString(name) {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "a valid lowercase name is required")
	}
	if name == "nights" || name == "nights-and-weekends" || name == "weekends" {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "built-in schedules are read-only — use a new name")
	}
	schedule := []any{}
	for _, pv := range getList(body, "schedule") {
		p := obj(pv)
		dv := p.GetD("days", nil)
		days := []any{}
		if dv == nil || dv == "all" {
			days = []any{int64(0), int64(1), int64(2), int64(3), int64(4), int64(5), int64(6)}
		} else if l, ok := dv.([]any); ok {
			for _, x := range l {
				if f, okF := toFloatLoose(x); okF {
					days = append(days, int64(f))
				}
			}
		}
		schedule = append(schedule, pyjson.NewObj().Set("weeklyConfig", pyjson.NewObj().
			Set("days", days).
			Set("beginTime", p.GetD("beginTime", "00:00")).
			Set("endTime", p.GetD("endTime", "23:59"))))
	}
	minRep, _ := toFloatLoose(body.GetD("minReplicas", int64(1)))
	rep, _ := toFloatLoose(body.GetD("replicas", int64(1)))
	sleep := truthy(body.GetD("sleep", false))
	if sleep {
		rep = 0
	}
	spec := pyjson.NewObj().
		Set("name", name).
		Set("minReplicas", int(minRep)).
		Set("replicas", int(rep)).
		Set("sleep", sleep).
		Set("nonHpaEnabled", truthy(body.GetD("nonHpaEnabled", true))).
		Set("hpaEnabled", truthy(body.GetD("hpaEnabled", true))).
		Set("schedule", schedule)
	if e.Cfg.WriteRecommendationCRs {
		path := crdBase("downscalerpolicies", e.Cfg.Namespace)
		cr := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "DownscalerPolicy").
			Set("metadata", pyjson.NewObj().
				Set("name", name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", pyjson.NewObj().Set("app.kubernetes.io/part-of", "coolscaler"))).
			Set("spec", spec)
		var err error
		if isNew {
			_, err = e.k8sReq(ctx, "POST", path, cr, "application/json")
		} else {
			_, err = e.k8sReq(ctx, "PATCH", path+"/"+name,
				pyjson.NewObj().Set("spec", spec), "application/merge-patch+json")
		}
		if err != nil {
			if code, ok := isHTTPError(err); ok {
				if isNew && code == 409 {
					if _, err2 := e.k8sReq(ctx, "PATCH", path+"/"+name,
						pyjson.NewObj().Set("spec", spec), "application/merge-patch+json"); err2 != nil {
						return 400, pyjson.NewObj().Set("ok", false).Set("message", "save failed: "+err2.Error())
					}
				} else {
					return 400, pyjson.NewObj().Set("ok", false).
						Set("message", fmt2("save failed: HTTP %d", code))
				}
			} else {
				return 400, pyjson.NewObj().Set("ok", false).Set("message", "save failed: "+err.Error())
			}
		}
	}
	verb := "updated"
	if isNew {
		verb = "created"
	}
	e.audit("DownscalePolicySave", name, "", verb, "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name)
}

func (e *Engine) DownscalePolicyDelete(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	if name == "nights" || name == "nights-and-weekends" || name == "weekends" {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "built-in schedules cannot be deleted")
	}
	if e.Cfg.WriteRecommendationCRs {
		if _, err := e.k8sReq(ctx, "DELETE", crdBase("downscalerpolicies", e.Cfg.Namespace)+"/"+name, nil, "application/json"); err != nil {
			e.Log.Info("downscale_policy_delete failed", "name", name, "err", err)
		}
	}
	e.mu.Lock()
	for k, v := range e.downscaleAssign {
		if v == name {
			e.downscaleAssign[k] = "nights"
		}
	}
	e.mu.Unlock()
	e.audit("DownscalePolicyDelete", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name)
}

func (e *Engine) SchedulingPolicySave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	if name == "" || !reRFC1123.MatchString(name) {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "a valid name is required")
	}
	e.mu.Lock()
	_, isKnown := e.schedulingPolicyKnobs[name]
	_, isUser := e.schedulingUser[name]
	e.mu.Unlock()
	if isKnown && !isUser {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "name collides with a built-in policy")
	}
	spread := 2
	if f, ok := toFloatLoose(body.GetD("minimumNodesSpread", int64(2))); ok && int(f) != 0 {
		spread = int(f)
	}
	if spread < 1 {
		spread = 1
	}
	kb := pyjson.NewObj().
		Set("enabled", true).
		Set("minimumNodesSpread", spread).
		Set("enhanceAvailabilityOnDifferentZones", truthy(body.GetD("zones", false)))
	desc := str(body.GetD("description", ""))
	if desc == "" {
		desc = "User-defined scheduling policy."
	}
	if e.Cfg.WriteRecommendationCRs {
		path := crdBase("podschedulingpolicies", e.Cfg.Namespace)
		spec := pyjson.NewObj().Set("selfAntiAffinityOptimization", kb)
		if _, err := e.k8sReq(ctx, "PATCH", path+"/"+name,
			pyjson.NewObj().Set("spec", spec), "application/merge-patch+json"); err != nil {
			if _, ok := isHTTPError(err); ok {
				cr := pyjson.NewObj().
					Set("apiVersion", crdGroup+"/"+crdVer).
					Set("kind", "PodSchedulingPolicy").
					Set("metadata", pyjson.NewObj().
						Set("name", name).
						Set("namespace", e.Cfg.Namespace).
						Set("labels", pyjson.NewObj().Set("app.kubernetes.io/part-of", "coolscaler")).
						Set("annotations", pyjson.NewObj().Set("coolscaler.sh/description", desc))).
					Set("spec", spec)
				if _, perr := e.k8sReq(ctx, "POST", path, cr, "application/json"); perr != nil {
					e.Log.Info("scheduling_policy_save failed", "name", name, "err", perr)
				}
			} else {
				e.Log.Info("scheduling_policy_save failed", "name", name, "err", err)
			}
		}
	}
	e.mu.Lock()
	e.schedulingPolicyKnobs[name] = kb
	e.schedulingUser[name] = pyjson.NewObj().Set("knobs", kb).Set("desc", desc)
	e.mu.Unlock()
	e.audit("SchedulingPolicySave", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name)
}

func (e *Engine) SchedulingPolicyDelete(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	e.mu.Lock()
	_, isUser := e.schedulingUser[name]
	e.mu.Unlock()
	if !isUser {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "only user-created policies can be deleted")
	}
	_, _ = e.k8sReq(ctx, "DELETE", crdBase("podschedulingpolicies", e.Cfg.Namespace)+"/"+name, nil, "application/json")
	e.mu.Lock()
	delete(e.schedulingUser, name)
	delete(e.schedulingPolicyKnobs, name)
	e.mu.Unlock()
	e.audit("SchedulingPolicyDelete", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name)
}

func fmt2(format string, a ...any) string {
	return fmt.Sprintf(format, a...)
}
