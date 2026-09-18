package engine

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

func parseFloatPy(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

func anyQuantity(v any) (string, bool) {
	switch x := v.(type) {
	case nil:
		return "", false
	case string:
		return x, true
	case int64:
		return strconv.FormatInt(x, 10), true
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64), true
	}
	return "", false
}

// 0 on error.
func ParseCPU(v any) float64 {
	q, ok := anyQuantity(v)
	if !ok {
		return 0.0
	}
	switch {
	case strings.HasSuffix(q, "n"):
		if f, ok := parseFloatPy(q[:len(q)-1]); ok {
			return f * 1e-9
		}
	case strings.HasSuffix(q, "u"):
		if f, ok := parseFloatPy(q[:len(q)-1]); ok {
			return f * 1e-6
		}
	case strings.HasSuffix(q, "m"):
		if f, ok := parseFloatPy(q[:len(q)-1]); ok {
			return f * 1e-3
		}
	default:
		if f, ok := parseFloatPy(q); ok {
			return f
		}
	}
	return 0.0
}

var binSuffixes = []struct {
	suf string
	mul float64
}{
	{"Ki", 1 << 10}, {"Mi", 1 << 20}, {"Gi", 1 << 30}, {"Ti", 1 << 40}, {"Pi", 1 << 50},
}

var decSuffixes = []struct {
	suf string
	mul float64
}{
	{"k", 1e3}, {"M", 1e6}, {"G", 1e9}, {"T", 1e12},
}

// 0 on error.
func ParseMem(v any) float64 {
	q, ok := anyQuantity(v)
	if !ok {
		return 0.0
	}
	for _, b := range binSuffixes {
		if strings.HasSuffix(q, b.suf) {
			if f, ok := parseFloatPy(q[:len(q)-2]); ok {
				return f * b.mul
			}
			return 0.0
		}
	}
	if strings.HasSuffix(q, "m") {
		if f, ok := parseFloatPy(q[:len(q)-1]); ok {
			return f * 1e-3
		}
		return 0.0
	}
	for _, d := range decSuffixes {
		if strings.HasSuffix(q, d.suf) {
			if f, ok := parseFloatPy(q[:len(q)-1]); ok {
				return f * d.mul
			}
			return 0.0
		}
	}
	if f, ok := parseFloatPy(q); ok {
		return f
	}
	return 0.0
}

func FmtCPU(cores float64) string {
	if cores <= 0 {
		return "0"
	}
	if cores < 1 {
		return fmt.Sprintf("%dm", int(math.RoundToEven(cores*1000)))
	}
	return fmt.Sprintf("%.2f", cores)
}

func FmtMem(b float64) string {
	if b <= 0 {
		return "0"
	}
	gi := b / (1 << 30)
	if gi >= 1 {
		return fmt.Sprintf("%.2fGi", gi)
	}
	return fmt.Sprintf("%dMi", int(math.RoundToEven(b/(1<<20))))
}

func Percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0.0
	}
	s := append([]float64(nil), values...)
	sort.Float64s(s)
	if len(s) == 1 {
		return s[0]
	}
	k := float64(len(s)-1) * (p / 100.0)
	lo, hi := math.Floor(k), math.Ceil(k)
	if lo == hi {
		return s[int(k)]
	}
	return s[int(lo)]*(hi-k) + s[int(hi)]*(k-lo)
}

func sortStrings(ss []string) {
	sort.Strings(ss)
}
