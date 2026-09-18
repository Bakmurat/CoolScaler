package slogger

import (
	"context"
	"log/slog"
	"runtime"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	ctrlzap "sigs.k8s.io/controller-runtime/pkg/log/zap"
)

const TSLayout = "2006-01-02 15:04:05.000"

// The --zap-* flags (BindFlags) can override any of it.
func DefaultZapOptions() *ctrlzap.Options {
	opts := &ctrlzap.Options{
		// Set BEFORE BindFlags so --zap-time-encoding still overrides it.
		TimeEncoder: zapcore.TimeEncoderOfLayout(TSLayout),
	}
	opts.EncoderConfigOptions = append(opts.EncoderConfigOptions, func(ec *zapcore.EncoderConfig) {
		ec.LevelKey = "level"
		ec.EncodeLevel = zapcore.CapitalLevelEncoder // "ERROR", not "error"
		ec.TimeKey = "ts"
		ec.CallerKey = "caller"
		ec.EncodeCaller = zapcore.ShortCallerEncoder // pkg/file.go:NN
		ec.MessageKey = "msg"
	})
	opts.ZapOpts = append(opts.ZapOpts, zap.AddCaller())
	return opts
}

// NewZap builds the process *zap.Logger from (flag-populated) options.
func NewZap(opts *ctrlzap.Options) *zap.Logger {
	return ctrlzap.NewRaw(ctrlzap.UseFlagOptions(opts))
}

// slog -> zap bridge.

// ZapHandler is a slog.Handler writing into a zap core.
type ZapHandler struct {
	core   zapcore.Core
	fields []zapcore.Field
	groups []string
}

// NewZapHandler wraps zl's core as a slog.Handler.
func NewZapHandler(zl *zap.Logger) *ZapHandler {
	return &ZapHandler{core: zl.Core()}
}

func slogToZapLevel(l slog.Level) zapcore.Level {
	switch {
	case l >= slog.LevelError:
		return zapcore.ErrorLevel
	case l >= slog.LevelWarn:
		return zapcore.WarnLevel
	case l >= slog.LevelInfo:
		return zapcore.InfoLevel
	default:
		return zapcore.DebugLevel
	}
}

// Enabled implements slog.Handler.
func (h *ZapHandler) Enabled(_ context.Context, l slog.Level) bool {
	return h.core.Enabled(slogToZapLevel(l))
}

// WithAttrs implements slog.Handler.
func (h *ZapHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	n := *h
	n.fields = append(append([]zapcore.Field{}, h.fields...), h.convert(attrs)...)
	return &n
}

// WithGroup implements slog.Handler.
func (h *ZapHandler) WithGroup(name string) slog.Handler {
	n := *h
	n.groups = append(append([]string{}, h.groups...), name)
	return &n
}

// Handle implements slog.Handler: builds a zap Entry (with the caller taken
// from the slog record's PC, so engine call sites show up, not the bridge).
func (h *ZapHandler) Handle(_ context.Context, r slog.Record) error {
	t := r.Time
	if t.IsZero() {
		t = time.Now()
	}
	ent := zapcore.Entry{
		Level:   slogToZapLevel(r.Level),
		Time:    t,
		Message: r.Message,
		Caller:  callerFromPC(r.PC),
	}
	ce := h.core.Check(ent, nil)
	if ce == nil {
		return nil
	}
	fields := append([]zapcore.Field{}, h.fields...)
	var attrs []slog.Attr
	r.Attrs(func(a slog.Attr) bool {
		attrs = append(attrs, a)
		return true
	})
	fields = append(fields, h.convert(attrs)...)
	ce.Write(fields...)
	return nil
}

func callerFromPC(pc uintptr) zapcore.EntryCaller {
	if pc == 0 {
		return zapcore.EntryCaller{}
	}
	frames := runtime.CallersFrames([]uintptr{pc})
	f, _ := frames.Next()
	if f.File == "" {
		return zapcore.EntryCaller{}
	}
	return zapcore.EntryCaller{Defined: true, PC: pc, File: f.File, Line: f.Line, Function: f.Function}
}

func (h *ZapHandler) convert(attrs []slog.Attr) []zapcore.Field {
	prefix := ""
	for _, g := range h.groups {
		prefix += g + "."
	}
	out := make([]zapcore.Field, 0, len(attrs))
	for _, a := range attrs {
		if a.Equal(slog.Attr{}) {
			continue
		}
		key := prefix + a.Key
		v := a.Value.Resolve()
		switch v.Kind() {
		case slog.KindString:
			out = append(out, zap.String(key, v.String()))
		case slog.KindInt64:
			out = append(out, zap.Int64(key, v.Int64()))
		case slog.KindUint64:
			out = append(out, zap.Uint64(key, v.Uint64()))
		case slog.KindFloat64:
			out = append(out, zap.Float64(key, v.Float64()))
		case slog.KindBool:
			out = append(out, zap.Bool(key, v.Bool()))
		case slog.KindDuration:
			out = append(out, zap.String(key, v.Duration().String()))
		case slog.KindTime:
			out = append(out, zap.String(key, v.Time().String()))
		default:
			out = append(out, zap.Any(key, v.Any()))
		}
	}
	return out
}
