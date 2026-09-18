package pyjson

import (
	"math"
	"strconv"
)

func Round(v float64, ndigits int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	s := strconv.FormatFloat(v, 'f', ndigits, 64)
	r, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return v
	}
	return r
}

func RoundInt(v float64) int {
	return int(math.RoundToEven(v))
}
