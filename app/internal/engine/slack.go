package engine

// slack.go

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

const slackCM = "coolscaler-slack-config"

func slackAlertTypes() []any {
	out := []any{
		"WorkloadRequestIncrease", "CpuThrottling", "OutOfMemory",
		"UnderProvisioned", "OverProvisioned", "NodeUtilization",
		"PodFailedCreateEvent",
	}
	for _, r := range []string{
		"count/replicasets.apps", "limits.cpu", "limits.memory", "pods",
		"replicationcontrollers", "requests.cpu", "requests.memory", "services",
	} {
		out = append(out, "ResourceQuota-"+r)
	}
	for _, c := range []string{
		"admissions", "dashboard", "recommender", "agent", "updater",
		"kube-state-metrics", "prometheus-server",
	} {
		out = append(out, "CoolScalerSystem: "+c)
	}
	return out
}

type slackConf struct {
	Token       string
	ChannelID   string
	ChannelName string
	Disabled    bool
	LastRun     int64 // unix seconds of last delivery
	IntervalMin int64
}

func (e *Engine) slackLoad(ctx context.Context) slackConf {
	c := slackConf{IntervalMin: 10}
	cm := e.getCM(ctx, slackCM)
	if cm == nil {
		return c
	}
	d := getObj(cm, "data")
	c.Token = getStr(d, "token")
	c.Disabled = getStr(d, "disabled") == "true"
	if v := getStr(d, "defaultChannel"); v != "" && v != "null" {
		if o, err := pyjson.Decode([]byte(v)); err == nil {
			ob := obj(o)
			c.ChannelID = getStr(ob, "id")
			c.ChannelName = getStr(ob, "name")
		}
	}
	if v := getStr(d, "lastRun"); v != "" && v != "null" {
		if n, err := pyInt(v); err == nil {
			c.LastRun = n
		}
	}
	if v := getStr(d, "runIntervalMinutes"); v != "" {
		if n, err := pyInt(v); err == nil && n > 0 {
			c.IntervalMin = n
		}
	}
	return c
}

func (e *Engine) slackPersist(ctx context.Context, c slackConf) {
	ch := "null"
	if c.ChannelID != "" || c.ChannelName != "" {
		ch = string(pyjson.Marshal(pyjson.NewObj().Set("id", c.ChannelID).Set("name", c.ChannelName)))
	}
	e.upsertCM(ctx, slackCM, nil, pyjson.NewObj().
		Set("token", c.Token).
		Set("defaultChannel", ch).
		Set("disabled", fmt.Sprintf("%t", c.Disabled)).
		Set("lastRun", fmt.Sprintf("%d", c.LastRun)).
		Set("runIntervalMinutes", fmt.Sprintf("%d", c.IntervalMin)).
		Set("typesToSend", "null").
		Set("typesToSendV2", "null"), nil)
}

var slackHTTP = &http.Client{Timeout: 10 * time.Second}

// slackCall POSTs a Slack Web-API method with a bearer token; returns the
// decoded body (Slack always answers 200 with {"ok":bool,...}).
func slackCall(token, method string, form url.Values) (map[string]any, error) {
	req, err := http.NewRequest("POST", "https://slack.com/api/"+method,
		bytes.NewBufferString(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := slackHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SlackConfData is GET /api/slack/conf.
func (e *Engine) SlackConfData(ctx context.Context) *pyjson.Obj {
	c := e.slackLoad(ctx)
	cfg := pyjson.NewObj()
	if c.Token != "" {
		cfg.Set("token", maskToken(c.Token)).
			Set("defaultChannel", pyjson.NewObj().Set("id", c.ChannelID).Set("name", c.ChannelName)).
			Set("disabled", c.Disabled)
	}
	return pyjson.NewObj().
		Set("config", cfg).
		Set("availableAlertTypes", slackAlertTypes())
}

func maskToken(t string) string {
	if len(t) <= 8 {
		return "****"
	}
	return t[:4] + strings.Repeat("*", 8) + t[len(t)-4:]
}

// SlackVerifyToken is GET /api/slack/verify/token
func (e *Engine) SlackVerifyToken(token string) *pyjson.Obj {
	if token == "" {
		return pyjson.NewObj().Set("valid", false).Set("error", "Slack token is missing.")
	}
	r, err := slackCall(token, "auth.test", url.Values{})
	if err != nil {
		return pyjson.NewObj().Set("valid", false).Set("error", err.Error())
	}
	ok, _ := r["ok"].(bool)
	out := pyjson.NewObj().Set("valid", ok)
	if !ok {
		out.Set("error", fmt.Sprintf("%v", r["error"]))
	}
	return out
}

// SlackVerifyChannel is GET /api/slack/verify/channel — resolves the channel
// name to an id via conversations.list (paginated, public+private).
func (e *Engine) SlackVerifyChannel(token, channel string) *pyjson.Obj {
	if channel == "" {
		return pyjson.NewObj().Set("valid", false).Set("error", "Default channel is missing.")
	}
	channel = strings.TrimPrefix(channel, "#")
	cursor := ""
	for i := 0; i < 5; i++ {
		form := url.Values{"limit": {"200"}, "types": {"public_channel,private_channel"}}
		if cursor != "" {
			form.Set("cursor", cursor)
		}
		r, err := slackCall(token, "conversations.list", form)
		if err != nil {
			return pyjson.NewObj().Set("valid", false).Set("error", err.Error())
		}
		if ok, _ := r["ok"].(bool); !ok {
			return pyjson.NewObj().Set("valid", false).Set("error", fmt.Sprintf("%v", r["error"]))
		}
		chans, _ := r["channels"].([]any)
		for _, cv := range chans {
			cm, _ := cv.(map[string]any)
			if cm == nil {
				continue
			}
			if name, _ := cm["name"].(string); name == channel {
				id, _ := cm["id"].(string)
				return pyjson.NewObj().Set("valid", true).Set("id", id).Set("name", name)
			}
		}
		meta, _ := r["response_metadata"].(map[string]any)
		if meta == nil {
			break
		}
		cursor, _ = meta["next_cursor"].(string)
		if cursor == "" {
			break
		}
	}
	return pyjson.NewObj().Set("valid", false).Set("error", "Default channel is invalid.")
}

// SlackSettingsSave is POST /api/alerts/slack/multicluster/settings
func (e *Engine) SlackSettingsSave(ctx context.Context, body *pyjson.Obj) *pyjson.Obj {
	c := e.slackLoad(ctx)
	if v, ok := body.Get("token"); ok {
		c.Token = str(v)
	}
	if v, ok := body.Get("defaultChannel"); ok {
		ch := obj(v)
		c.ChannelID = getStr(ch, "id")
		c.ChannelName = getStr(ch, "name")
	}
	if v, ok := body.Get("disabled"); ok {
		c.Disabled = truthy(v)
	}
	e.slackPersist(ctx, c)
	e.audit("SlackSettings", "slack integration", "", "", "user")
	return pyjson.NewObj().Set("ok", true)
}

// SlackEnabledData is GET /api/alerts/slack/multicluster/settings/slackenabled.
func (e *Engine) SlackEnabledData(ctx context.Context) *pyjson.Obj {
	c := e.slackLoad(ctx)
	enabled := c.Token != "" && !c.Disabled
	return pyjson.NewObj().
		Set("clusters", []any{e.Cfg.ClusterName}).
		Set("slackEnabled", []any{pyjson.NewObj().
			Set("clusterName", e.Cfg.ClusterName).
			Set("enabled", enabled)})
}

// SlackSendTest is POST /api/alerts/slack/test
func (e *Engine) SlackSendTest(ctx context.Context) *pyjson.Obj {
	c := e.slackLoad(ctx)
	if c.Token == "" {
		return pyjson.NewObj().Set("ok", false).Set("error", "Slack token is missing.")
	}
	target := c.ChannelID
	if target == "" {
		target = c.ChannelName
	}
	if target == "" {
		return pyjson.NewObj().Set("ok", false).Set("error", "Default channel is missing.")
	}
	r, err := slackCall(c.Token, "chat.postMessage", url.Values{
		"channel": {target},
		"text":    {fmt.Sprintf(":white_check_mark: CoolScaler test alert from cluster *%s* — the Slack integration works.", e.Cfg.ClusterName)},
	})
	if err != nil {
		return pyjson.NewObj().Set("ok", false).Set("error", err.Error())
	}
	if ok, _ := r["ok"].(bool); !ok {
		return pyjson.NewObj().Set("ok", false).Set("error", fmt.Sprintf("%v", r["error"]))
	}
	return pyjson.NewObj().Set("ok", true)
}

// SlackDeliverAlerts posts currently-firing alerts to the configured channel,
// gated by runIntervalMinutes. Called from the refresh loop; a no-op without
// a token/channel or while disabled.
func (e *Engine) SlackDeliverAlerts(ctx context.Context) {
	c := e.slackLoad(ctx)
	if c.Token == "" || c.Disabled || (c.ChannelID == "" && c.ChannelName == "") {
		return
	}
	now := time.Now().Unix()
	if c.LastRun > 0 && now-c.LastRun < c.IntervalMin*60 {
		return
	}
	alerts := e.evaluateAlerts()
	if len(alerts) == 0 {
		return
	}
	var lines []string
	for i, av := range alerts {
		if i >= 10 {
			lines = append(lines, fmt.Sprintf("…and %d more", len(alerts)-10))
			break
		}
		a := obj(av)
		lines = append(lines, fmt.Sprintf("• *%s* [%s] %s",
			getStr(a, "type"), getStr(a, "severity"), getStr(a, "message")))
	}
	target := c.ChannelID
	if target == "" {
		target = c.ChannelName
	}
	_, err := slackCall(c.Token, "chat.postMessage", url.Values{
		"channel": {target},
		"text": {fmt.Sprintf(":rotating_light: *CoolScaler alerts* — cluster *%s* (%d firing)\n%s",
			e.Cfg.ClusterName, len(alerts), strings.Join(lines, "\n"))},
	})
	if err != nil {
		e.Log.Info("slack alert delivery failed", "err", err)
		return
	}
	c.LastRun = now
	e.slackPersist(ctx, c)
}
