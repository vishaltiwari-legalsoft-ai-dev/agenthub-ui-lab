"use client";

/** The Blog Writer workspace: its brands in the work bar (a picker, past five,
 *  with each brand's draft count), Drafts and Write as its sections, the route
 *  as the only memory of where you were.
 *
 *  The desk underneath is still the pre-revamp screen, so it renders inside
 *  `.legacy` for the bridge's tokens. What changed is who decides what it
 *  shows: it used to reopen whichever run localStorage named, behind a back
 *  arrow the bridge hides. Now `#/w/blog/<brandId>/<view>` says, and the work
 *  bar is the way between brands and drafts.
 */

import { useEffect, useState } from "react";
import { bwBrands, bwRuns, type BwBrand, type BwRun, type BwRunSummary } from "@/lib/api";
import { loadPending, useLoadSession, type Load } from "@/lib/load";
import { useHeadline, useHub, useWorkNav, type WorkSection } from "../context";
import { initials } from "../model";
import { Blank, Oops, Wait } from "../ui";
import { workspaceBySlug } from "../workspaces";
import { BlogWriter } from "@/components/console/blogwriter/BlogWriter";
import { draftCountLabel, draftCounts, draftsFor, readRoute, sectionOf } from "./blog";

const SECTIONS = workspaceBySlug("blog")!.sections;

export function BlogWorkspace({ subject, section }: { subject: string; section: string }) {
  const { user, openWork, toast, revision } = useHub();
  const session = useLoadSession();
  const [brands, setBrands] = useState<Load<{ brands: BwBrand[] }>>(loadPending);
  const [runs, setRuns] = useState<Load<{ runs: BwRunSummary[] }>>(loadPending);
  // The run on screen, once read: places an old link whose run the list does
  // not carry, and names the topic before the list catches up with a new run.
  const [opened, setOpened] = useState<BwRun | null>(null);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    const opts = { keepStale: true };
    void session.run("bw-brands", () => bwBrands(), setBrands, "The brands could not be read.", opts);
    void session.run("bw-runs", () => bwRuns(), setRuns, "The drafts could not be read.", opts);
  }, [session, revision, beat]);

  const meId = user.id;
  const list = brands.data?.brands || [];
  const rows = runs.data?.runs || [];
  const known = opened && !rows.some((r) => r.id === opened.id) ? [...rows, opened] : rows;
  const { brandId, view } = readRoute(subject, section, list, known, meId);
  const brand = list.find((b) => b.id === brandId) || null;
  const drafts = draftsFor(rows, brandId, meId);
  const sec = sectionOf(view);
  const topic = view.kind === "run" ? known.find((r) => r.id === view.runId)?.topic : undefined;
  // Per brand, over the same rows the Drafts count reads; absent until the
  // runs are read, so the picker never shows a zero that means "not yet".
  const counts = runs.data ? draftCounts(rows) : null;

  useHeadline(brand ? `${brand.name} · ${topic || brand.domain}` : "reading the brands");

  useWorkNav({
    agentId: "a9",
    subjects: list.map((b) => ({
      id: b.id, ab: initials(b.name), name: b.name,
      note: counts ? draftCountLabel(counts.get(b.id) || 0) : undefined,
    })),
    subject: brandId,
    sections: SECTIONS.map((s): WorkSection => ({ ...s, count: s.id === "drafts" ? (runs.data ? drafts.length : null) : null })),
    section: sec,
    onSubject: (id) => openWork("blog", id, sec),
    onSection: (s) => openWork("blog", brandId, s),
  });

  const failed = (brands.phase === "failed" && !brands.data) || (runs.phase === "failed" && !runs.data);
  if (failed) {
    return (
      <Oops
        what="The Blog Writer could not be read."
        error={brands.error || runs.error || ""}
        onRetry={() => setBeat((b) => b + 1)}
      />
    );
  }
  if (!brands.data || !runs.data) return <Wait what="Reading the brands and drafts" rows={3} />;
  if (!brand) {
    return (
      <Blank title="No blog brands yet.">
        Add one in the SEO Analyst first — both specialists share the brand registry.
      </Blank>
    );
  }

  return (
    <div className="legacy">
      <BlogWriter
        onToast={toast}
        brands={list}
        drafts={drafts}
        brandId={brandId}
        view={view}
        meId={meId}
        onNavigate={(b, v) => openWork("blog", b, v)}
        onRunsChanged={() => setBeat((b) => b + 1)}
        onRunOpened={setOpened}
      />
    </div>
  );
}
