package pyjson

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Obj is an insertion-ordered JSON object. Setting an existing key overwrites
// the value but keeps the key's original position
type Obj struct {
	keys []string
	vals map[string]any
}

// NewObj returns an empty ordered object.
func NewObj() *Obj {
	return &Obj{vals: map[string]any{}}
}

// Set stores key=v, preserving the first-insertion position on overwrite.
func (o *Obj) Set(key string, v any) *Obj {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
	return o
}

// Get returns the value and whether the key exists.
func (o *Obj) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// GetD returns the value or def when absent.
func (o *Obj) GetD(key string, def any) any {
	if v, ok := o.Get(key); ok {
		return v
	}
	return def
}

// Has reports key presence.
func (o *Obj) Has(key string) bool {
	_, ok := o.Get(key)
	return ok
}

// Del removes a key if present.
func (o *Obj) Del(key string) {
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Keys returns the keys in insertion order (a copy).
func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	out := make([]string, len(o.keys))
	copy(out, o.keys)
	return out
}

// Len is the number of keys.
func (o *Obj) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

func (o *Obj) Clone() *Obj {
	n := NewObj()
	if o == nil {
		return n
	}
	for _, k := range o.keys {
		n.Set(k, o.vals[k])
	}
	return n
}

// Update merges src into o: overwrite keeps position, new keys append in
// src order.
func (o *Obj) Update(src *Obj) {
	if src == nil {
		return
	}
	for _, k := range src.keys {
		o.Set(k, src.vals[k])
	}
}

func Marshal(v any) []byte {
	var b strings.Builder
	writeValue(&b, v)
	return []byte(b.String())
}

func writeValue(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeString(b, x)
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case float64:
		b.WriteString(FloatRepr(x))
	case *Obj:
		if x == nil {
			b.WriteString("{}")
			return
		}
		b.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				b.WriteString(", ")
			}
			writeString(b, k)
			b.WriteString(": ")
			writeValue(b, x.vals[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			writeValue(b, e)
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			writeString(b, e)
		}
		b.WriteByte(']')
	case []*Obj:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			writeValue(b, e)
		}
		b.WriteByte(']')
	default:
		// A type slipping through here is a porting bug; fail loudly in the
		// payload (never panic a serving goroutine).
		writeString(b, fmt.Sprintf("!!unsupported type %T", v))
	}
}

func writeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20 || (r > 0x7e && r <= 0xffff):
				fmt.Fprintf(b, `\u%04x`, r)
			case r > 0xffff:
				r -= 0x10000
				fmt.Fprintf(b, `\u%04x\u%04x`, 0xd800+(r>>10), 0xdc00+(r&0x3ff))
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

func FloatRepr(f float64) string {
	if math.IsNaN(f) {
		return "NaN" // json.dumps default allow_nan=True spelling
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	// Shortest scientific form: [-]d[.ddd]e±dd
	s := strconv.FormatFloat(f, 'e', -1, 64)
	neg := false
	if s[0] == '-' {
		neg = true
		s = s[1:]
	}
	ePos := strings.IndexByte(s, 'e')
	mant := s[:ePos]
	exp, _ := strconv.Atoi(s[ePos+1:])
	digits := strings.Replace(mant, ".", "", 1)
	decpt := exp + 1 // value = 0.digits * 10^decpt

	var out string
	if -4 < decpt && decpt <= 16 {
		switch {
		case decpt <= 0:
			out = "0." + strings.Repeat("0", -decpt) + digits
		case decpt >= len(digits):
			out = digits + strings.Repeat("0", decpt-len(digits)) + ".0"
		default:
			out = digits[:decpt] + "." + digits[decpt:]
		}
	} else {
		m := digits[:1]
		if len(digits) > 1 {
			m += "." + digits[1:]
		}
		if exp < 0 {
			out = fmt.Sprintf("%se-%02d", m, -exp)
		} else {
			out = fmt.Sprintf("%se+%02d", m, exp)
		}
	}
	if neg {
		out = "-" + out
	}
	return out
}
