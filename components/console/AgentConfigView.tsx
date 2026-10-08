"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getAgentConfig,
  updateAgentConfig,
  getNews,
  updateNews,
  type AgentConfigResponse,
  type AgentConfigItem,
  type AgentModelField,
  type ModelOption,
} from "@/lib/api";
import { Icon, Button } from "@/lib/kit-ui";
import { describeFailure, useLoadSession } from "@/lib/load";
import { NEWS_UPDATED_EVENT } from "@/components/console/Chrome";
import { GlyphTile, CATEGORY_GLYPH } from "@/lib/glyph";
import { useAuth } from "@/lib/auth";

/** Friendly labels + display order for the per-agent model fields. */
const FIELD_LABEL: Record<AgentModelField, string> = {
  openrouter_image_model: "Image model",
  gd_gradient_image_model: "Gradient image model (Stage 1)",
  gd_polish_image_model: "Polish model",
  openrouter_model: "Reasoning model",
  openrouter_fast_model: "Fast / parsing model",
  openrouter_vision_model: "Vision model",
  gd_planner_model: "Planner model",
};
/** A field missing from this list is filtered out below and never renders,
 *  however happily the backend serves it. Add new AgentModelField values here
 *  as well as to the union. */
const FIELD_ORDER = [
  "openrouter_image_model",
  "gd_gradient_image_model",
  "gd_polish_image_model",
  "openrouter_model",
  "openrouter_fast_model",
  "openrouter_vision_model",
  "gd_planner_model",
] as const satisfies readonly AgentModelField[];
/** Compile-time guard for the comment above: a field added to the union but
 *  not to FIELD_ORDER fails `tsc` here instead of silently never rendering. */
type UnorderedField = Exclude<AgentModelField, (typeof FIELD_ORDER)[number]>;
const _everyFieldOrdered: [UnorderedField] extends [never] ? true : UnorderedField = true;
void _everyFieldOrdered;
/** Per-agent label overrides where the generic field name would mislead. */
const AGENT_FIELD_LABEL: Record<string, Partial<Record<AgentModelField, string>>> = {};

function modelName(options: ModelOption[], id: string): string {
  return options.find((m) => m.id === id)?.name ?? id ?? "—";
}

/** Dropdown grouping order + fallback labels for the model quality tiers. */
const TIER_SEQUENCE = ["flagship", "balanced", "fast"];
const TIER_FALLBACK_LABEL: Record<string, string> = {
  flagship: "Flagship — top quality",
  balanced: "Balanced — strong, cheaper",
  fast: "Fast — cheapest",
  other: "Other models",
};

/** Options grouped by tier in display order; unknown/missing tiers group last. */
function tierGroups(options: ModelOption[]): [string, ModelOption[]][] {
  const groups = new Map<string, ModelOption[]>();
  for (const option of options) {
    const tier = option.tier ?? "other";
    const bucket = groups.get(tier) ?? [];
    bucket.push(option);
    groups.set(tier, bucket);
  }
  const ordered = [
    ...TIER_SEQUENCE.filter((t) => groups.has(t)),
    ...[...groups.keys()].filter((t) => !TIER_SEQUENCE.includes(t)),
  ];
  return ordered.map((t) => [t, groups.get(t)!]);
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 5,
  padding: "8px 11px",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-primary)",
  fontSize: 12.5,
};

/** Creator-only editor for the single news bulletin shown to every user in the
 *  top strip. Empty text clears the announcement. */
function NewsEditor() {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const session = useLoadSession();

  /** This was the most expensive false empty in the tree. `.catch(() => …)`
   *  followed by `setLoaded(true)` left the textarea empty and the Publish
   *  button live, so a failed read of the current bulletin looked exactly like
   *  "there is no bulletin" — and one Publish would have cleared the real one
   *  for every signed-in user. A failed read now stays unsaveable. */
  useEffect(() => {
    const attempt = session.begin("news");
    getNews()
      .then((n) => {
        if (!attempt.current()) return;
        setText(n.text);
        setSaved(n.text);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        const message = attempt.failure(err, "Couldn't read the current bulletin");
        if (!message) return;
        setMsg({ kind: "err", text: `${message} — not editable until it loads.` });
      });
  }, [session]);

  const dirty = text.trim() !== saved.trim();

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const next = await updateNews(text.trim());
      setText(next.text);
      setSaved(next.text);
      // Tell any mounted NewsBar to re-fetch so the strip updates immediately.
      window.dispatchEvent(new Event(NEWS_UPDATED_EVENT));
      setMsg({ kind: "ok", text: next.text ? "Published." : "Cleared." });
    } catch (err) {
      setMsg({ kind: "err", text: describeFailure(err, "Save failed") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      style={{
        background: "var(--glass)",
        backdropFilter: "var(--glass-blur)",
        WebkitBackdropFilter: "var(--glass-blur)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-2xl)",
        padding: 22,
        boxShadow: "var(--shadow-xs), var(--glass-edge)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Icon name="megaphone" />
        <span style={{ fontSize: 15, fontWeight: 600 }}>News bulletin</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginBottom: 14, maxWidth: 620 }}>
        This message scrolls across the top bar for <b>every signed-in user</b>. Leave it empty to
        remove the announcement.
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. 🎉 New Graphic Designer Studio is live — try the 4-stage pipeline today!"
        rows={3}
        maxLength={400}
        style={{
          ...inputStyle,
          marginTop: 0,
          resize: "vertical",
          minHeight: 72,
          fontFamily: "inherit",
          lineHeight: 1.5,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
        <Button size="sm" onClick={save} disabled={!loaded || saving || !dirty}>
          {saving ? "Saving…" : text.trim() ? "Publish" : "Clear"}
        </Button>
        {dirty && !saving && (
          <Button size="sm" variant="secondary" onClick={() => setText(saved)}>
            Reset
          </Button>
        )}
        {msg && (
          <span style={{ fontSize: 12.5, color: msg.kind === "ok" ? "var(--success, #16a34a)" : "var(--danger, #dc2626)" }}>
            {msg.text}
          </span>
        )}
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginLeft: "auto" }}>
          {text.trim().length}/400
        </span>
      </div>
    </section>
  );
}

function AgentCard({
  agent,
  catalog,
  tierLabels,
  globalDefaults,
  onSaved,
}: {
  agent: AgentConfigItem;
  catalog: AgentConfigResponse["catalog"];
  tierLabels: AgentConfigResponse["tier_labels"];
  globalDefaults: AgentConfigResponse["global_defaults"];
  onSaved: (next: AgentConfigResponse) => void;
}) {
  // The dropdowns this agent gets — only the model fields its engine consumes.
  // `fields` may be absent during the deploy-skew window where an older backend
  // serves the payload — fall back to showing every field rather than crashing.
  const agentFields = useMemo(
    () => FIELD_ORDER.filter((f) => (agent.fields ?? FIELD_ORDER).includes(f)),
    [agent.fields],
  );

  // Local draft of this agent's overrides ("" = inherit global default).
  const [draft, setDraft] = useState<Partial<Record<AgentModelField, string>>>(agent.overrides);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Reset the draft whenever the server state for this agent changes.
  useEffect(() => setDraft(agent.overrides), [agent.overrides]);

  const dirty = useMemo(
    () => agentFields.some((f) => (draft[f] ?? "") !== (agent.overrides[f] ?? "")),
    [agentFields, draft, agent.overrides],
  );

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const next = await updateAgentConfig(agent.id, draft);
      onSaved(next);
      setMsg({ kind: "ok", text: "Saved." });
    } catch (err) {
      setMsg({ kind: "err", text: describeFailure(err, "Save failed") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      style={{
        background: "var(--glass)",
        backdropFilter: "var(--glass-blur)",
        WebkitBackdropFilter: "var(--glass-blur)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-2xl)",
        padding: 22,
        boxShadow: "var(--shadow-xs), var(--glass-edge)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
        <GlyphTile glyph={CATEGORY_GLYPH[agent.category] ?? "design"} tint={agent.category} size={44} glyphSize={22} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{agent.name}</span>
            {agent.live ? (
              <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", background: "var(--success-bg, #dcfce7)", color: "var(--success, #16a34a)" }}>
                LIVE
              </span>
            ) : (
              <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", background: "var(--gray-100)", color: "var(--text-tertiary)" }}>
                COMING SOON
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginTop: 2 }}>{agent.role}</div>
        </div>
      </div>

      {!agent.live && (
        <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", background: "var(--gray-50, rgba(0,0,0,0.03))", border: "1px dashed var(--border-subtle)", borderRadius: "var(--radius-lg)", padding: "8px 11px", marginBottom: 14 }}>
          This agent isn’t wired to the backend yet — settings are saved and will apply once it goes live.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {agentFields.map((field) => {
          const options = catalog[field] ?? [];
          const globalName = modelName(options, globalDefaults[field]);
          const value = draft[field] ?? "";
          const inheriting = value === "";
          return (
            <label key={field} style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              {AGENT_FIELD_LABEL[agent.id]?.[field] ?? FIELD_LABEL[field]}
              <select
                value={value}
                onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                style={inputStyle}
              >
                <option value="">Inherit global · {globalName}</option>
                {tierGroups(options).map(([tier, group]) => (
                  <optgroup
                    key={tier}
                    label={tierLabels?.[tier] ?? TIER_FALLBACK_LABEL[tier] ?? tier}
                  >
                    {group.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.recommended ? " ★" : ""} — {m.provider}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span style={{ display: "block", fontSize: 11, fontWeight: 500, color: "var(--text-tertiary)", marginTop: 4 }}>
                {inheriting ? `Using global default (${globalName})` : `Override → ${modelName(options, value)}`}
              </span>
            </label>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {dirty && !saving && (
          <Button size="sm" variant="secondary" onClick={() => setDraft(agent.overrides)}>
            Reset
          </Button>
        )}
        {msg && (
          <span style={{ fontSize: 12.5, color: msg.kind === "ok" ? "var(--success, #16a34a)" : "var(--danger, #dc2626)" }}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

export function AgentConfigView({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [data, setData] = useState<AgentConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const session = useLoadSession();

  useEffect(() => {
    const attempt = session.begin("agent-config");
    getAgentConfig()
      .then((d) => { if (attempt.current()) setData(d); })
      .catch((err: unknown) => {
        const message = attempt.failure(err, "Couldn't load the agent configuration");
        if (message) setError(message);
      });
  }, [session]);

  // Defensive: this view is only routed for creators, but guard anyway.
  if (!user?.is_creator) {
    return (
      <div className="cview" style={{ maxWidth: "100%" }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Agent configuration is available to the creator account only.
        </div>
      </div>
    );
  }

  return (
    <div className="cview" style={{ maxWidth: "100%" }}>
      <div className="csechead">
        <div>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="sliders-horizontal" /> Agent Configuration
            <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", background: "var(--grad-brand)", color: "#fff" }}>
              CREATOR
            </span>
          </h3>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, maxWidth: 680 }}>
            Choose which model each agent uses. Leave a field on <b>Inherit global</b> to follow the
            platform default set in Admin → Secrets. These controls are visible to the creator only —
            no other user can see or change them.
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onBack}>
          Back
        </Button>
      </div>

      <NewsEditor />

      {error && (
        <div style={{ background: "var(--danger-bg)", color: "var(--danger)", padding: 14, borderRadius: "var(--radius-lg)", fontSize: 13 }}>
          {error}
        </div>
      )}

      {!data && !error && (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Loading agents…</div>
      )}

      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {data.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              catalog={data.catalog}
              tierLabels={data.tier_labels}
              globalDefaults={data.global_defaults}
              onSaved={setData}
            />
          ))}
        </div>
      )}
    </div>
  );
}
