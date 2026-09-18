package pyjson

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"testing"
)

// Set PYJSON_FLOAT_CASES to a JSON file of [hexLE, pyRepr] pairs for an
// exhaustive randomized check.
func TestFloatRepr(t *testing.T) {
	cases := map[float64]string{
		0.0:                    "0.0",
		1.0:                    "1.0",
		-1.5:                   "-1.5",
		100.0:                  "100.0",
		123456789.0:            "123456789.0",
		25165824.0:             "25165824.0",
		1e15:                   "1000000000000000.0",
		9999999999999998.0:     "9999999999999998.0",
		1e16:                   "1e+16",
		1.5e16:                 "1.5e+16",
		0.0001:                 "0.0001",
		1e-05:                  "1e-05",
		2.5e-05:                "2.5e-05",
		3.746185375778029e-05:  "3.746185375778029e-05",
		10.170626974487304:     "10.170626974487304",
		1e100:                  "1e+100",
		5e-324:                 "5e-324",
		1.7976931348623157e308: "1.7976931348623157e+308",
	}
	for f, want := range cases {
		if got := FloatRepr(f); got != want {
			t.Errorf("FloatRepr(%v) = %q, want %q", f, got, want)
		}
	}
	if got := FloatRepr(math.Copysign(0, -1)); got != "-0.0" {
		t.Errorf("FloatRepr(-0.0) = %q, want -0.0", got)
	}

	if path := os.Getenv("PYJSON_FLOAT_CASES"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var pairs [][2]string
		if err := json.Unmarshal(data, &pairs); err != nil {
			t.Fatal(err)
		}
		for _, c := range pairs {
			raw, err := hex.DecodeString(c[0])
			if err != nil {
				t.Fatal(err)
			}
			f := math.Float64frombits(binary.LittleEndian.Uint64(raw))
			if got := FloatRepr(f); got != c[1] {
				t.Errorf("FloatRepr(bits %s) = %q, want %q", c[0], got, c[1])
			}
		}
	}
}

func TestMarshalPythonSeparators(t *testing.T) {
	o := NewObj().
		Set("a", 1).
		Set("b", 1.0).
		Set("c", []any{"x", nil, true}).
		Set("d", NewObj().Set("k", "v"))
	want := `{"a": 1, "b": 1.0, "c": ["x", null, true], "d": {"k": "v"}}`
	if got := string(Marshal(o)); got != want {
		t.Errorf("Marshal = %s, want %s", got, want)
	}
	// overwrite keeps position
	o.Set("b", 2)
	if got := o.Keys()[1]; got != "b" {
		t.Errorf("overwrite moved key: %v", o.Keys())
	}
	// ensure_ascii escaping (\u00e9 for e-acute, \u0001 for the control char)
	if got := string(Marshal("h\u00e9llo\n\x01")); got != "\"h\\u00e9llo\\n\\u0001\"" {
		t.Errorf("escape = %s", got)
	}
}

func TestRound(t *testing.T) {
	cases := []struct {
		v    float64
		n    int
		want float64
	}{
		{2.675, 2, 2.67}, {0.125, 2, 0.12}, {1.005, 2, 1.0},
		{10.170626974487304, 2, 10.17}, {0.0316164383, 6, 0.031616},
	}
	for _, c := range cases {
		if got := Round(c.v, c.n); got != c.want {
			t.Errorf("Round(%v,%d) = %v, want %v", c.v, c.n, got, c.want)
		}
	}
	if RoundInt(2.5) != 2 || RoundInt(3.5) != 4 || RoundInt(-2.5) != -2 {
		t.Error("RoundInt is not banker's rounding")
	}
}
