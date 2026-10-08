"use client";

/** Models — each specialist can run on a different model.
 *
 *  A change here saves the moment it is made and applies to the next run that
 *  specialist starts. Runs already stored keep the model they were made with.
 *
 *  The prototype put a 30-day **spend per specialist** on each card. That figure
 *  does not exist: the activity trail records who ran what, and OpenRouter bills
 *  the account rather than the agent, so there is no join between them. Dividing
 *  an account total by run counts would look like a measurement and be
 *  arithmetic on a guess. So the header carries the account's real 30-day
 *  figures once, said as what they are, and each card carries the run counts it
 *  can actually stand behind.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getAgentConfig, updateAgentConfig,
  type AgentConfigItem, type AgentConfigPatch, type AgentConfigResponse, type AgentModelField, type ModelOption,
} from "@/lib/api";
import { loadPending, useLoadSession, type Load } from "@/lib/load";
import { useHeadline, useHub } from "../context";
import { LIVE_AGENTS, agentById, n } from "../model";
import { Mono, Oops, PageHead, RuleHead, Wait } from "../ui";
import { useRuns } from "../useRuns";

/** What each slot is for. A model name means nothing without this, and the
 *  backend's field ids (`openrouter_fast_model`) mean less. */
const SLOT_JOB: Record<AgentModelField, string> = {
  openrouter_model:
    "The thinking model. Reads the material, decides what matters, and writes what the run hands back.",
  openrouter_fast_model:
    "Bulk work — fetching, normalising, summarising before the long model reads. Thousands of calls, so cost matters more than depth here.",
  openrouter_image_model:
    "Draws the picture. This is the one that decides how the work looks.",
  gd_gradient_image_model:
    "Paints the brand gradient behind each design in Stage 1 — chosen for how faithfully it holds the brand's colours.",
  openrouter_vision_model:
    "Looks at the finished file and checks it against the brief before you see it.",
  gd_planner_model:
    "Reads your brief and plans the four stages before anything is drawn.",
  gd_polish_image_model:
    "Cleans up edges and re-renders text that came out wrong.",
};

const SLOT_LABEL: Record<AgentModelField, string> = {
  openrouter_model: "Reasoning",
  openrouter_fast_model: "Fast",
  openrouter_image_model: "Image",
  gd_gradient_image_model: "Gradient (Stage 1)",
  openrouter_vision_model: "Vision",
  gd_planner_model: "Planner",
  gd_polish_image_model: "Polish",
};

export function ModelsView() {
  const { revision, toast } = useHub();
  const session = useLoadSession();
  const [cfg, setCfg] = useState<Load<AgentConfigResponse>>(loadPending);
  const [beat, setBeat] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);

  const { state: feed } = useRuns({ limit: 1 }, revision, { live: false });
  const runs = feed.data;

  useEffect(() => {
    void session.run(
      "agent-config",
      (signal) => getAgentConfig({ signal }),
      setCfg,
      "The model settings could not be read.",
      { keepStale: true },
    );
  }, [session, beat]);

  useHeadline(
    cfg.data ? `${cfg.data.agents.filter((a) => a.live).length} with a model slot · creator only` : "creator only",
  );

  const save = useCallback(async (agent: AgentConfigItem, field: AgentModelField, value: string) => {
    const slot = `${agent.id}:${field}`;
    setSaving(slot);
    try {
      const next = await updateAgentConfig(agent.id, { [field]: value } as AgentConfigPatch);
      setCfg({ phase: "ready", data: next, error: null });
      const model = value
        ? (cfg.data?.catalog[field] || []).find((m) => m.id === value)?.name || value
        : "the global default";
      toast(`${agent.name} will use ${model} from its next run.`, "ok");
    } catch (e: unknown) {
      // A setting that did not save must not be left looking saved.
      toast(e instanceof Error ? e.message : "That change did not save. Nothing was altered.", "error");
      setBeat((b) => b + 1);
    } finally {
      setSaving(null);
    }
  }, [cfg.data, toast]);

  if (cfg.phase === "loading" && !cfg.data) {
    return (
      <>
        <PageHead
          statement={<>Each specialist can run on <b>a different model</b>.</>}
          lede="Reading what each one is set to."
        />
        <Wait what="Reading the model settings" rows={4} />
      </>
    );
  }

  if (cfg.phase === "failed" && !cfg.data) {
    return <Oops what="The model settings could not be read." error={cfg.error || ""} onRetry={() => setBeat((b) => b + 1)} />;
  }

  const data = cfg.data!;
  const live = data.agents.filter((a) => a.live);

  // A live specialist with no card here is not a bug and must not read as one.
  // The backend lists an agent on this page only as a claim that its engine
  // passes its own id through to the model layer; one that runs on shared
  // credentials has nothing to choose, so it is named below instead of being
  // given a card full of dropdowns that would save nothing.
  const withoutSlots = LIVE_AGENTS.filter((a) => !live.some((x) => x.id === a.id));

  return (
    <>
      <PageHead
        statement={<>Each specialist can run on <b>a different model</b>.</>}
        lede={
          <>
            A change here saves the moment you make it and applies to the next run that specialist
            starts. Runs already stored keep the model they were made with. A slot left on{" "}
            <b>the global default</b> follows whatever the deployment is set to, so one change moves
            every specialist that has not been given its own.
          </>
        }
      />

      {live.map((a) => {
        const known = agentById(a.id);
        const stored = runs?.facets.agents.find((x) => x.id === a.id)?.count ?? null;
        const week = runs?.week.by_agent.find((x) => x.id === a.id)?.count ?? 0;
        return (
          <section className="band" key={a.id}>
            <div className="mhead">
              <Mono agent={{ mono: known?.mono || a.name.slice(0, 2).toUpperCase() }} size="sm" />
              <h2>{a.name}</h2>
              <div className="mhead__n">
                <div><b>{stored === null ? "—" : n(stored)}</b><em>Runs stored</em></div>
                <div><b>{n(week)}</b><em>This week</em></div>
                <div><b>{a.fields.length}</b><em>Model slots</em></div>
              </div>
            </div>

            <div className="rows">
              {a.fields.map((f) => {
                const options: ModelOption[] = data.catalog[f] || [];
                const chosen = a.overrides[f] ?? "";
                const effective = a.effective[f] || data.global_defaults[f] || "";
                const effName = options.find((m) => m.id === effective)?.name || effective || "not set";
                const slot = `${a.id}:${f}`;
                return (
                  <div className="srow" key={f}>
                    <div className="srow__t">
                      <b>{SLOT_LABEL[f]}</b>
                      <span>{SLOT_JOB[f]}</span>
                    </div>
                    <div className="srow__c">
                      <select
                        className="sel"
                        value={chosen}
                        disabled={saving === slot}
                        aria-label={`${SLOT_LABEL[f]} model for ${a.name}`}
                        onChange={(e) => void save(a, f, e.target.value)}
                      >
                        <option value="">Global default — {effName}</option>
                        {options.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}{m.provider ? ` — ${m.provider}` : ""}{m.recommended ? " · recommended" : ""}
                          </option>
                        ))}
                      </select>
                      <span className="srow__eff">
                        {saving === slot ? "Saving…" : chosen ? "Set for this specialist" : `Following the default — ${effName}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {withoutSlots.length > 0 && (
        <section className="band">
          <RuleHead
            title="Nothing to choose here"
            note="Live specialists whose model is not theirs to set."
          />
          <div className="rows">
            {withoutSlots.map((a) => (
              <div className="srow" key={a.id}>
                <div className="srow__t">
                  <b>{a.name}</b>
                  <span>
                    It runs on shared credentials rather than its own model slot, so there is no
                    dropdown to give it. Changing what it uses is a deployment change.
                  </span>
                </div>
                <div className="srow__c is-auto"><span className="tag">No model slots</span></div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="band">
        <RuleHead
          title="What this page cannot tell you"
          note="Said here rather than shown as a figure nobody can stand behind."
        />
        <p className="lede" style={{ maxWidth: "72ch" }}>
          There is no spend-per-specialist column. OpenRouter bills the account, not the agent, and
          the run record carries no cost, so any per-agent figure would be an account total split by
          run count — a guess wearing the clothes of a measurement. The real 30-day tokens, credits
          and spend are in the header of every page, straight from OpenRouter.
        </p>
      </section>
    </>
  );
}
