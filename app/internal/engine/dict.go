package engine

import "coolscaler.sh/coolscaler/internal/pyjson"


// obj coerces v to *pyjson.Obj, returning an empty object for nil/non-
// objects.
func obj(v any) *pyjson.Obj {
	if o, ok := v.(*pyjson.Obj); ok && o != nil {
		return o
	}
	return pyjson.NewObj()
}

// getObj is d.get(key) coerced to an object.
func getObj(d *pyjson.Obj, key string) *pyjson.Obj {
	return obj(d.GetD(key, nil))
}

// getList is d.get(key, []) coerced to a list.
func getList(d *pyjson.Obj, key string) []any {
	if l, ok := d.GetD(key, nil).([]any); ok {
		return l
	}
	return nil
}

// items returns.get("items", []) of a k8s list response.
func items(d *pyjson.Obj) []any {
	return getList(d, "items")
}

// str coerces to string ("" for nil / non-strings).
func str(v any) string {
	s, _ := v.(string)
	return s
}

// getStr is d.get(key, "") as a string.
func getStr(d *pyjson.Obj, key string) string {
	return str(d.GetD(key, nil))
}

// f64 coerces JSON numbers (int64/float64/int) to float64.
func f64(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	case int:
		return float64(x), true
	}
	return 0, false
}

// f64d is f64 with a default.
func f64d(v any, def float64) float64 {
	if f, ok := f64(v); ok {
		return f
	}
	return def
}

// i64 coerces to int64 (0 when not a number).
func i64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	}
	return 0
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case int64:
		return x != 0
	case int:
		return x != 0
	case float64:
		return x != 0
	case []any:
		return len(x) > 0
	case *pyjson.Obj:
		return x.Len() > 0
	}
	return true
}

func getBool(d *pyjson.Obj, key string, def bool) bool {
	v, ok := d.Get(key)
	if !ok {
		return def
	}
	return truthy(v)
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sortStrings(out)
	return out
}

// strList renders a []string as a JSON list value ([]any keeps pyjson simple).
func strList(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
