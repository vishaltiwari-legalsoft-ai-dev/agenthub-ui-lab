"use client";

/** Integrations — what actually works today.
 *
 *  The page this replaces listed HubSpot, Slack, Sheets and Figma with a
 *  Connect button that flipped a `useState` and announced success without
 *  making a request. Somebody waiting on Slack notifications would have waited
 *  for ever. So the rule here is that a service appears only if something in
 *  this backend can report on it, and its status is that report — never a
 *  local flag.
 *
 *  Three reads, each the authority on its own row:
 *
 *  - `mrConnectors` — the six sources feeding Marketing Research, each already
 *    carrying `connected` / `needs_setup` / `available` and a sentence.
 *  - `seoOverview.sources` — whether Search Console and the SERP provider are
 *    reachable, which decides whether the SEO Analyst's figures are complete.
 *  - `geoConfig.engine_status` — and this one is the reason the page exists in
 *    this shape. Two of GEO's engines answer on their own APIs; two come
 *    through an OpenRouter stand-in. A page that drew both as a green tick
 *    would be claiming a measurement of the product your buyers use, from a
 *    model impersonating it.
 */

import { useEffect, useState } from "react";
import {
  geoConfig, mrConnectors, seoOverview,
  type GeoGlobalConfig, type MrConnector, type SeoOverview,
} from "@/lib/api";
import { loadPending, useLoadSession, type Load } from "@/lib/load";
import { isLive } from "@/components/console/geo/provenance";
import { gscIntegration } from "@/components/console/seo/seo";
import { useHeadline, useHub } from "../context";
import { n, word } from "../model";
import { Oops, PageHead, RuleHead, Wait } from "../ui";

type Status = "on" | "partial" | "off";

interface Hook {
  key: string;
  glyph: string;
  name: string;
  what: string;
  usedByLabel: string;
  usedBy: string;
  status: Status;
  note?: string;
  open?: () => void;
}

const TAG: Record<Status, { label: string; cls: string }> = {
  on: { label: "Connected", cls: "is-on" },
  partial: { label: "Similar model", cls: "" },
  off: { label: "Not connected", cls: "" },
};

export function IntegrationsView() {
  const { openWork } = useHub();
  const session = useLoadSession();
  const [mr, setMr] = useState<Load<MrConnector[]>>(loadPending);
  const [seo, setSeo] = useState<Load<SeoOverview>>(loadPending);
  const [geo, setGeo] = useState<Load<GeoGlobalConfig>>(loadPending);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    void session.run("mr-connectors", (s) => mrConnectors({ signal: s }), setMr,
      "The Marketing Research sources could not be read.", { keepStale: true });
    void session.run("seo-sources", (s) => seoOverview({ signal: s }), setSeo,
      "The SEO sources could not be read.", { keepStale: true });
    void session.run("geo-config", (s) => geoConfig({ signal: s }), setGeo,
      "The GEO engines could not be read.", { keepStale: true });
  }, [session, beat]);

  const hooks: Hook[] = [];

  // "available" is the manual CSV/Excel upload path the backend lists beside
  // the connectors; it is neither connected nor missing, so it is not a hook.
  (mr.data || []).filter((c) => c.status !== "available").forEach((c) => {
    hooks.push({
      key: `mr-${c.key}`,
      glyph: (c.label || "?").slice(0, 2).toUpperCase(),
      name: c.label,
      what: c.detail,
      usedByLabel: "Read by",
      usedBy: "Marketing Research",
      status: c.status === "connected" ? "on" : "off",
      note: c.status === "needs_setup" ? "Set up, but not reporting" : undefined,
      open: () => openWork("mr", "", "data"),
    });
  });

  if (seo.data) {
    // Connected only on the backend's word that some brand really has Search
    // Console behind it — a configured server is not a connected brand.
    const gsc = gscIntegration(seo.data.sources);
    const gscSection = gsc.open;
    hooks.push({
      key: "gsc",
      glyph: "GS",
      name: "Google Search Console",
      what: "Real impressions, clicks and positions for every page and query. Without it the SEO Analyst measures live ranks only, which is a much thinner picture.",
      usedByLabel: "Read by",
      usedBy: "SEO Analyst",
      status: gsc.status,
      note: gsc.note,
      open: gscSection ? () => openWork("seo", "", gscSection) : undefined,
    });
    hooks.push({
      key: "serp",
      glyph: "SR",
      name: "SERP provider",
      what: "Live search results — what ranks today, and who else is on the page. Feeds competitor tracking and the keyword gaps.",
      usedByLabel: "Read by",
      usedBy: "SEO Analyst · Blog Writer",
      status: seo.data.sources.serp ? "on" : "off",
      open: () => openWork("seo", "", "rivals"),
    });
  }

  const engineStatus = geo.data?.engine_status || {};
  Object.entries(engineStatus).forEach(([id, st]) => {
    hooks.push({
      key: `geo-${id}`,
      glyph: id.slice(0, 2).toUpperCase(),
      name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
      what: st.means,
      usedByLabel: "Answers for",
      usedBy: "GEO",
      status: !st.connected ? "off" : isLive(st) ? "on" : "partial",
      note: st.model ? `via ${st.model}` : undefined,
      open: () => openWork("geo", "", "overview"),
    });
  });

  const on = hooks.filter((h) => h.status === "on");
  const partial = hooks.filter((h) => h.status === "partial");
  const off = hooks.filter((h) => h.status === "off");

  useHeadline(
    hooks.length
      ? `${n(on.length)} connected · ${n(partial.length + off.length)} not`
      : "reading what is connected",
  );

  const loading = !mr.data && !seo.data && !geo.data
    && [mr, seo, geo].some((x) => x.phase === "loading");
  const allFailed = [mr, seo, geo].every((x) => x.phase === "failed");

  if (allFailed) {
    return (
      <Oops
        what="Nothing could be read about what is connected."
        error={mr.error || seo.error || geo.error || ""}
        onRetry={() => setBeat((b) => b + 1)}
      />
    );
  }

  return (
    <>
      <PageHead
        statement={
          loading
            ? <>Reading what is connected.</>
            : partial.length > 0
              ? <>{Cap(word(on.length))} connected. <b>{word(partial.length)} answer{partial.length === 1 ? "s" : ""} through {partial.length === 1 ? "a similar model" : "similar models"}</b>.</>
              : <>{Cap(word(on.length))} service{on.length === 1 ? "" : "s"} connected. <b>{word(off.length)} not</b>.</>
        }
        lede="This page lists what actually works today. A service that is not built yet is not shown here as a button that does nothing, and a source that is set up but not reporting says so rather than passing for connected."
      />

      {loading && <Wait what="Asking each specialist what it can reach" rows={4} />}

      {[mr, seo, geo].some((x) => x.phase === "failed") && !allFailed && (
        <Oops
          what="One of the three reads failed."
          error={`${mr.error || seo.error || geo.error} The rows below are the ones that answered.`}
          onRetry={() => setBeat((b) => b + 1)}
        />
      )}

      {on.length > 0 && (
        <section className="band">
          <RuleHead
            title="Connected"
            note="What each one gives, and which specialist reads it."
            aside={<span className="aside">{on.length} service{on.length === 1 ? "" : "s"}</span>}
          />
          <div className="hooks">{on.map((h) => <HookRow key={h.key} hook={h} />)}</div>
        </section>
      )}

      {partial.length > 0 && (
        <section className="band">
          <RuleHead
            title="Answering through a similar model"
            note="Reachable, measured with a similar AI model rather than its own API."
            aside={<span className="aside">{partial.length}</span>}
          />
          <div className="hooks">{partial.map((h) => <HookRow key={h.key} hook={h} />)}</div>
          <p className="soon-note">
            An engine on a similar model is an OpenRouter model answering in its place. The rates
            it gives back are real measurements of that model, and GEO labels every answer with the
            surface it was measured on so the two kinds are never ranked against each other. Add
            the official API key in Settings → Secrets for exact readings.
          </p>
        </section>
      )}

      {off.length > 0 && (
        <section className="band">
          <RuleHead
            title="Not connected"
            note="Nothing is drawing on these, and the figures that would use them say so."
            aside={<span className="aside">{off.length}</span>}
          />
          <div className="hooks">{off.map((h) => <HookRow key={h.key} hook={h} />)}</div>
        </section>
      )}
    </>
  );
}

function HookRow({ hook }: { hook: Hook }) {
  const tag = TAG[hook.status];
  return (
    <div className="hook">
      <span className={`hook__g ${hook.status === "on" ? "" : "off"}`} aria-hidden="true">{hook.glyph}</span>
      <div className="hook__id">
        <b>{hook.name}</b>
        <span>{hook.what}</span>
      </div>
      <div className="hook__use">
        <b>{hook.usedByLabel}</b>
        {hook.usedBy}
      </div>
      <span className="hook__st">
        <span className={`tag ${tag.cls}`}>{tag.label}</span>
        {hook.note && <span style={{ display: "block", fontSize: 11, color: "var(--fg-3)" }}>{hook.note}</span>}
      </span>
      <span className="hook__act">
        {hook.open && (
          <button type="button" className="btn btn--quiet btn--sm" onClick={hook.open}>
            {hook.status === "on" ? "See it in use" : "Set it up"}
          </button>
        )}
      </span>
    </div>
  );
}

const Cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
