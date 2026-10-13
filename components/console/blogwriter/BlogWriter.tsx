"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ToastFn } from "@/components/console/ConsoleApp";
import {
  bwBuildDraft, bwCommentBlock, bwCreateRun, bwExport, bwPlanVisuals,
  bwResearchStep, bwRun, bwScanInventory, bwInventory, bwStudyVoice, bwVoice,
  type BwBlock, type BwBrand, type BwExportFormat, type BwInventory as BwInventoryDoc,
  type BwRun as BwRunDoc, type BwRunSummary, type BwVoice as BwVoiceDoc,
} from "@/lib/api";
import { Icon } from "@/lib/kit-ui";
import { describeFailure, useLoadSession } from "@/lib/load";
import { useReportWork } from "@/lib/work";
import {
  authorLabel, canEditRun, isOwnRun, rowStatus, shouldAutoResume, type BlogView,
} from "@/components/hub/work/blog";

/** Blog Writer (a9) — one brand's drafts → the writing desk → a deep-research run.
 *
 *  Which of the three is on screen is the route's decision, handed down by
 *  `BlogWorkspace`. The desk keeps no memory of its own about where you were
 *  and moves only by asking `onNavigate`, so a reload, a link and the work
 *  bar's brand chips all land on the same screen. */

const ANGLE_LABEL: Record<string, string> = {
  studies: "Studies & data",
  experts: "Expert guides",
  news: "News",
  anecdotes: "Anecdotes & forums",
  competitors: "Competing articles",
  gap: "Gap follow-up",
  targeted: "Targeted",
};

const STATUS_LABEL: Record<string, string> = {
  research: "Researching",
  saturated: "Saturated — nothing new found",
  capped: "Deep enough — go deeper if you want",
};

/** Where the desk used to remember the open run. It reopened that run on every
 *  mount — restarting paid research — and only a hidden back arrow cleared it.
 *  The route carries the open run now; the key is removed once on mount so a
 *  browser still holding one stops carrying it. */
const RETIRED_OPEN_RUN_KEY = "bw-open-run";

const READ_ONLY_NOTE = "Teammate's draft — view and export only";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

function renderInline(line: string, key: string) {
  const parts: ReactNode[] = [];
  const re = new RegExp(MD_LINK.source, "g");
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(
      <a key={`${key}-${i++}`} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a>,
    );
    last = m.index + m[0].length;
  }
  parts.push(line.slice(last));
  return parts;
}

/** Draft text renderer: markdown links become anchors, "### " lines become sub-headings. */
function BlockText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) =>
        line.startsWith("### ") ? (
          <span key={i} className="bw-block__sub">{line.slice(4)}{"\n"}</span>
        ) : (
          <span key={i}>{renderInline(line, String(i))}{"\n"}</span>
        ),
      )}
    </>
  );
}

/** Stable citation numbers: n = 1-based ledger order of the cited items (matches exports). */
function citeNumbers(run: BwRunDoc): Record<string, number> {
  const cited = new Set(run.draft?.blocks.flatMap((b) => b.cites) ?? []);
  const numbers: Record<string, number> = {};
  let n = 0;
  for (const item of run.ledger) if (cited.has(item.id)) numbers[item.id] = ++n;
  return numbers;
}

export interface BlogWriterProps {
  onToast: ToastFn;
  /** Every brand, from the workspace's one read. */
  brands: BwBrand[];
  /** This brand's runs, every one, the viewer's first (`draftsFor`). */
  drafts: BwRunSummary[];
  brandId: string;
  view: BlogView;
  meId: string;
  /** Move the route: `view` is `drafts`, `write` or a run id. */
  onNavigate: (brandId: string, view: string) => void;
  /** A run was created or its status moved — the workspace re-reads the list. */
  onRunsChanged: () => void;
  /** The run on screen, once read. */
  onRunOpened?: (run: BwRunDoc) => void;
}

export function BlogWriter({
  onToast, brands, drafts, brandId, view, meId, onNavigate, onRunsChanged, onRunOpened,
}: BlogWriterProps) {
  const brand = brands.find((b) => b.id === brandId) ?? null;
  const runId = view.kind === "run" ? view.runId : "";

  /** `undefined` while the brand's inventory is still being read. */
  const [inventory, setInventory] = useState<BwInventoryDoc | null | undefined>(undefined);
  const [voiceDoc, setVoiceDoc] = useState<BwVoiceDoc | null>(null);
  /** The brand desk's own work: a scan, a voice study, a run being created. */
  const [deskBusy, setDeskBusy] = useState<"scan" | "voice-study" | "create" | null>(null);
  const [run, setRun] = useState<BwRunDoc | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  /** The open run's work: research, a draft, a revision, the visual plan. */
  const [busy, setBusy] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});
  // What is on screen, for replies that land after the reader has moved on:
  // a reply for another brand or run writes nothing.
  const brandRef = useRef(brandId);
  const openRef = useRef<string | null>(null);
  /** The one research loop allowed to keep going. Replacing or clearing it
   *  disowns the old loop: it finishes the round in flight and writes nothing. */
  const loopRef = useRef<{ stop: boolean } | null>(null);
  useReportWork(!!busy || !!deskBusy);

  const session = useLoadSession();

  /** Was a fourth private copy of the same two lines. The shared classifier
   *  keeps `RequestTimeoutError`'s own sentence, which none of the copies did. */
  const fail = useCallback(
    (e: unknown, fallback: string) => onToast(describeFailure(e, fallback), "error"),
    [onToast],
  );

  useEffect(() => {
    try {
      localStorage.removeItem(RETIRED_OPEN_RUN_KEY);
    } catch {
      /* storage off — nothing was stored either */
    }
  }, []);

  // The brand's published-blog inventory and studied voice, for the desk.
  useEffect(() => {
    brandRef.current = brandId;
    setInventory(undefined);
    setVoiceDoc(null);
    setDeskBusy(null);
    if (!brandId) return;
    const attempt = session.begin("brand");
    bwInventory(brandId).then(
      (inv) => { if (attempt.current()) setInventory(inv); },
      () => { if (attempt.current()) setInventory(null); }, // 404 = not scanned yet
    );
    bwVoice(brandId).then(
      (v) => { if (attempt.current()) setVoiceDoc(v); },
      () => undefined, // 404 = voice not studied yet
    );
  }, [session, brandId]);

  // The run the route names. Research picks back up on open only for the
  // viewer's own run: every round is paid search and model calls.
  useEffect(() => {
    openRef.current = runId || null;
    setRun(null);
    setRunErr(null);
    setComments({});
    setOpenHistory({});
    if (!runId) return;
    const attempt = session.begin("run");
    bwRun(runId).then(
      (full) => {
        if (!attempt.current() || openRef.current !== runId) return;
        setRun(full);
        onRunOpened?.(full);
        if (shouldAutoResume(full, meId)) {
          setBusy("research");
          void researchLoop(full);
        }
      },
      (e: unknown) => {
        const message = attempt.failure(e, "This draft could not be opened.");
        if (message && openRef.current === runId) setRunErr(message);
      },
    );
    return () => {
      openRef.current = null;
      loopRef.current = null;
      setBusy(null);
    };
    // `researchLoop` and `onRunOpened` are rebuilt every render; only the run
    // the route names decides whether this has to run again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runId, meId]);

  /** Lands a reply on screen only while its run is still the one open. */
  function land(next: BwRunDoc): boolean {
    if (openRef.current !== next.id) return false;
    setRun(next);
    return true;
  }

  async function studyVoice() {
    if (!brand || deskBusy) return;
    const id = brand.id;
    setDeskBusy("voice-study");
    try {
      const v = await bwStudyVoice(id);
      if (brandRef.current === id) setVoiceDoc(v);
    } catch (e) {
      fail(e, "Voice study failed");
    } finally {
      if (brandRef.current === id) setDeskBusy(null);
    }
  }

  async function scan() {
    if (!brand || deskBusy) return;
    const id = brand.id;
    setDeskBusy("scan");
    try {
      const inv = await bwScanInventory(id);
      if (brandRef.current === id) setInventory(inv);
    } catch (e) {
      fail(e, "Scan failed");
    } finally {
      if (brandRef.current === id) setDeskBusy(null);
    }
  }

  /** Research rounds back-to-back until the engine says saturated/capped, the
   *  reader stops, or the reader leaves the run. `force` takes one round even
   *  on a run that is already saturated or capped — that is "Go deeper". */
  async function researchLoop(start: BwRunDoc, force = false) {
    const me = { stop: false };
    loopRef.current = me;
    const owns = () => loopRef.current === me;
    let current = start;
    let extra = force;
    try {
      while (owns() && !me.stop && (extra || current.status === "research")) {
        extra = false;
        current = await bwResearchStep(current.id);
        if (owns()) land(current);
      }
    } catch (e) {
      if (owns()) fail(e, "Research failed");
    } finally {
      if (owns()) {
        loopRef.current = null;
        setBusy(null);
      }
      onRunsChanged();
    }
  }

  function stopResearch() {
    if (loopRef.current) loopRef.current.stop = true;
  }

  /** Creates the run and opens it; the run view picks the research up,
   *  because the run is the viewer's own. */
  async function startRun() {
    if (!brand || !topic.trim() || deskBusy) return;
    const { id, name } = brand;
    setDeskBusy("create");
    try {
      const created = await bwCreateRun({ brand_id: id, topic: topic.trim(), notes: notes.trim() || undefined });
      onRunsChanged();
      if (brandRef.current !== id) {
        onToast(`The draft for ${name} is saved in its drafts. Open it there to start the research.`, "ok");
        return;
      }
      setTopic("");
      setNotes("");
      onNavigate(id, created.id);
    } catch (e) {
      fail(e, "Could not start the run");
    } finally {
      if (brandRef.current === id) setDeskBusy(null);
    }
  }

  const shown = run && run.id === runId ? run : null;
  const editable = shown ? canEditRun(shown, meId) : false;

  function goDeeper() {
    if (!shown || busy || !editable) return;
    setBusy("research");
    void researchLoop(shown, true);
  }

  async function writeDraft() {
    if (!shown || busy || !editable) return;
    const id = shown.id;
    setBusy("draft");
    try {
      land(await bwBuildDraft(id));
      onRunsChanged();
    } catch (e) {
      if (openRef.current === id) fail(e, "Drafting failed");
    } finally {
      if (openRef.current === id) setBusy(null);
    }
  }

  async function sendComment(block: BwBlock) {
    const comment = (comments[block.id] ?? "").trim();
    if (!shown || !comment || busy || !editable) return;
    const id = shown.id;
    setBusy(`comment-${block.id}`);
    try {
      if (land(await bwCommentBlock(id, block.id, comment))) {
        setComments((c) => ({ ...c, [block.id]: "" }));
      }
    } catch (e) {
      if (openRef.current === id) fail(e, "Revision failed");
    } finally {
      if (openRef.current === id) setBusy(null);
    }
  }

  async function planVisuals() {
    if (!shown || busy || !editable) return;
    const id = shown.id;
    setBusy("visuals");
    try {
      land(await bwPlanVisuals(id));
    } catch (e) {
      if (openRef.current === id) fail(e, "Visual planning failed");
    } finally {
      if (openRef.current === id) setBusy(null);
    }
  }

  async function exportRun(format: BwExportFormat) {
    if (!shown) return;
    try {
      const slug = shown.draft?.meta.slug || shown.id;
      const names: Record<BwExportFormat, string> = {
        md: `${slug}.md`, html: `${slug}.html`, txt: `${slug}.txt`,
        "visuals-md": `${slug}-visual-prompts.md`, "visuals-txt": `${slug}-visual-prompts.txt`,
      };
      download(await bwExport(shown.id, format), names[format]);
    } catch (e) {
      fail(e, "Export failed");
    }
  }

  const numbers = shown ? citeNumbers(shown) : {};
  const researching = busy === "research";
  const mineCount = drafts.filter((r) => isOwnRun(r, meId)).length;
  const split = mineCount > 0 && mineCount < drafts.length;

  return (
    <div className="mr-app bw-app">
      {shown && (
        <header className="mr-top">
          <span className={`bw-status bw-status--${shown.status}`}>
            {researching && <Icon name="loader-circle" size={13} className="bw-spin" />}
            {/* A run left mid-research is paused until a loop is actually
                running on it — "Researching" over an idle run is a claim. */}
            {shown.status === "research" && !researching
              ? "Research paused"
              : STATUS_LABEL[shown.status] ?? shown.status}
          </span>
        </header>
      )}

      <div className="mr-body">
        {/* ------------------------------------------------ the brand's drafts */}
        {view.kind === "drafts" && brand && (
          <div className="mr-panel">
            <div className="mr-panel__head bw-head">
              <div className="bw-head__text">
                <h2 className="mr-panel__title">Drafts for {brand.name}</h2>
                <span className="mr-panel__sub">
                  {drafts.length === 0
                    ? "Nothing written for this brand yet."
                    : `${drafts.length} draft${drafts.length === 1 ? "" : "s"}${split ? ", yours first" : ""}. Open one to read, export or carry on.`}
                </span>
              </div>
              <button type="button" className="bw-btn bw-btn--primary" onClick={() => onNavigate(brand.id, "write")}>
                <Icon name="pen-line" size={14} /> Write a new draft
              </button>
            </div>
            {drafts.length === 0 ? (
              <div className="bw-empty">
                No drafts for {brand.name} yet. Open Write, give it a topic, and the agent researches it and drafts the post with its sources.
              </div>
            ) : (
              <div className="bw-runs">
                {drafts.map((r, i) => (
                  <Fragment key={r.id}>
                    {split && i === 0 && <span className="bw-runs__label">Yours</span>}
                    {split && i === mineCount && <span className="bw-runs__label">Teammates</span>}
                    <button type="button" className="bw-runrow" onClick={() => onNavigate(brand.id, r.id)}>
                      <span className="bw-runrow__main">
                        <span className="bw-runrow__topic">{r.topic}</span>
                        <span className="bw-runrow__meta">{authorLabel(r, meId)} · {fmtDate(r.created)}</span>
                      </span>
                      <span className={`bw-runrow__state${r.status === "research" ? " bw-runrow__state--paused" : ""}`}>
                        {rowStatus(r, meId)}
                      </span>
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------ brand panel + desk */}
        {view.kind === "write" && brand && (
          <div className="bw-desk">
            <div className="mr-panel bw-desk__inventory">
              <div className="mr-panel__head">
                <h2 className="mr-panel__title">Published on {brand.domain}</h2>
                <button className="bw-btn" disabled={!!deskBusy || inventory === undefined} onClick={() => void scan()}>
                  <Icon name="refresh-cw" size={14} className={deskBusy === "scan" ? "bw-spin" : undefined} />
                  {inventory ? "Rescan" : "Scan the site"}
                </button>
              </div>
              {inventory === undefined && <div className="bw-empty">Reading what {brand.name} has published…</div>}
              {inventory === null && <div className="bw-empty">Not scanned yet — scan the site to list every published blog. The desk avoids topics the brand already covers.</div>}
              {inventory && (
                <>
                  <div className="bw-inv__counts">
                    {inventory.counts.blog_urls} posts found · {inventory.counts.sitemap_urls} URLs sitemapped · scanned {fmtDate(inventory.scanned)}
                  </div>
                  {inventory.notes.map((n) => (
                    <div key={n} className="bw-note">{n}</div>
                  ))}
                  <ul className="bw-inv__list">
                    {inventory.posts.map((p) => (
                      <li key={p.url}>
                        <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="bw-voice">
                <div className="bw-voice__head">
                  <span className="bw-desk__past-label">Brand voice</span>
                  <button className="bw-btn" disabled={!!deskBusy || !inventory} onClick={() => void studyVoice()}>
                    {deskBusy === "voice-study" ? <Icon name="loader-circle" size={14} className="bw-spin" /> : <Icon name="book-open" size={14} />}
                    {voiceDoc ? "Restudy" : "Study the blog's voice"}
                  </button>
                </div>
                {!voiceDoc && (
                  <div className="bw-hint">
                    {inventory
                      ? `Reads up to 12 published posts and stores how ${brand.name} writes. Every draft and revision then matches that voice.`
                      : "Scan the site first, then study the voice."}
                  </div>
                )}
                {voiceDoc && (
                  <div className="bw-voice__body">
                    <div className="bw-voice__meta">{voiceDoc.count} posts studied · {fmtDate(voiceDoc.studied)}</div>
                    {typeof voiceDoc.profile.summary === "string" && (
                      <p className="bw-voice__summary">{voiceDoc.profile.summary}</p>
                    )}
                    {typeof voiceDoc.profile.tone === "string" && (
                      <div className="bw-voice__row">Tone: {voiceDoc.profile.tone}</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="mr-panel bw-desk__writing">
              <div className="mr-panel__head">
                <h2 className="mr-panel__title">Writing desk</h2>
                <span className="mr-panel__sub">Paste the topic — the agent does the rest.</span>
              </div>
              <textarea
                className="bw-topic"
                aria-label="Topic"
                placeholder={`What should ${brand.name} publish next?`}
                value={topic}
                rows={3}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void startRun();
                }}
              />
              <button className="bw-collapse" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
                <Icon name={notesOpen ? "chevron-down" : "chevron-right"} size={14} />
                Optional notes for the writer
              </button>
              {notesOpen && (
                <textarea
                  className="bw-topic bw-topic--notes"
                  aria-label="Notes for the writer"
                  placeholder="Angle, audience, must-mention points… (optional)"
                  value={notes}
                  rows={2}
                  onChange={(e) => setNotes(e.target.value)}
                />
              )}
              <button className="bw-btn bw-btn--primary" disabled={!topic.trim() || !!deskBusy} onClick={() => void startRun()}>
                {deskBusy === "create" ? <Icon name="loader-circle" size={15} className="bw-spin" /> : <Icon name="telescope" size={15} />}
                Start deep research
              </button>
              <div className="bw-hint">
                Multi-round research across studies, expert guides, news, forums & competing articles — every claim lands in an evidence ledger you can trace.
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------ run: research + draft */}
        {view.kind === "run" && !shown && (
          <div className="mr-panel">
            {runErr ? (
              <div className="bw-empty" role="alert">
                {runErr}{" "}
                <button type="button" className="bw-btn" onClick={() => onNavigate(brandId, "drafts")}>
                  Back to the drafts
                </button>
              </div>
            ) : (
              <div className="bw-empty" role="status">
                <Icon name="loader-circle" size={14} className="bw-spin" /> Opening the draft…
              </div>
            )}
          </div>
        )}

        {shown && (
          <>
            <div className="mr-panel">
              <div className="mr-panel__head">
                <h2 className="mr-panel__title">Deep research</h2>
                <span className="mr-panel__sub">
                  {shown.ledger.length} evidence item{shown.ledger.length === 1 ? "" : "s"} banked · {shown.rounds.length} round{shown.rounds.length === 1 ? "" : "s"}
                </span>
                {!editable && <span className="bw-hint">{READ_ONLY_NOTE}.</span>}
                <div className="bw-actions">
                  {researching ? (
                    <button className="bw-btn" onClick={stopResearch}>
                      <Icon name="pause" size={14} /> Stop after this round
                    </button>
                  ) : (
                    <button className="bw-btn" disabled={!!busy || !editable} onClick={goDeeper}>
                      <Icon name="telescope" size={14} /> {shown.rounds.length ? "Go deeper" : "Research"}
                    </button>
                  )}
                  <button className="bw-btn bw-btn--primary" disabled={!!busy || !editable || shown.ledger.length === 0} onClick={() => void writeDraft()}>
                    <Icon name="pen-line" size={14} /> {shown.draft ? "Redraft" : "Write the draft"}
                  </button>
                </div>
              </div>

              {shown.rounds.length === 0 && !researching && (
                <div className="bw-empty">
                  {editable
                    ? "No research yet — hit Research to fan out across the five source angles."
                    : "No research yet."}
                </div>
              )}
              <div className="bw-rounds">
                {shown.rounds.map((round) => (
                  <div key={round.n} className="bw-round">
                    <div className="bw-round__head">
                      <span className="bw-round__n">Round {round.n}</span>
                      <span className="bw-round__added">+{round.added} evidence</span>
                    </div>
                    <div className="bw-round__queries">
                      {round.queries.map((q) => (
                        <span key={q.q} className="bw-chip" title={q.q}>
                          {ANGLE_LABEL[q.angle] ?? q.angle} · {q.hits}
                        </span>
                      ))}
                    </div>
                    {round.gaps.length > 0 && (
                      <div className="bw-round__gaps">Still missing: {round.gaps.join(" · ")}</div>
                    )}
                  </div>
                ))}
                {researching && (
                  <div className="bw-round bw-round--live">
                    <Icon name="loader-circle" size={14} className="bw-spin" /> Reading sources…
                  </div>
                )}
              </div>

              {shown.ledger.length > 0 && (
                <details className="bw-ledger">
                  <summary>Evidence ledger ({shown.ledger.length})</summary>
                  <ul>
                    {shown.ledger.map((ev) => (
                      <li key={ev.id}>
                        <span className="bw-chip bw-chip--src">{ev.source_class}</span>
                        <span className="bw-ledger__claim">{ev.claim}</span>{" "}
                        <a href={ev.url} target="_blank" rel="noreferrer" className="bw-ledger__src">
                          {ev.source_name || ev.url}
                        </a>
                        <span className="bw-ledger__cred"> — {ev.credibility}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>

            {shown.draft && (
              <div className="mr-panel">
                <div className="mr-panel__head">
                  <h2 className="mr-panel__title">{shown.draft.meta.title}</h2>
                  {shown.draft.guidelines_applied && (
                    <span className="bw-chip bw-chip--ok" title="Every block was line-edited against the company writing guidelines before you saw it.">
                      House style applied
                    </span>
                  )}
                  <span className="mr-panel__sub">
                    {editable
                      ? "Comment on any block — the agent rewrites it, or researches first when you ask for facts."
                      : "Read-only here. The downloads below work as usual."}
                  </span>
                </div>
                {shown.draft.notes.map((n) => (
                  <div key={n} className="bw-note">{n}</div>
                ))}
                <div className="bw-blocks">
                  {shown.draft.blocks.map((block) => (
                    <div key={block.id} className="bw-block">
                      {block.heading && <h3 className="bw-block__heading">{block.heading}</h3>}
                      <p className="bw-block__text">
                        <BlockText text={block.text} />
                        {block.cites.map((c) =>
                          numbers[c] ? (
                            <sup key={c} className="bw-cite" title={shown.ledger.find((e) => e.id === c)?.claim}>
                              [{numbers[c]}]
                            </sup>
                          ) : null,
                        )}
                      </p>
                      {block.history.length > 0 && (
                        <button className="bw-collapse" aria-expanded={!!openHistory[block.id]} onClick={() => setOpenHistory((h) => ({ ...h, [block.id]: !h[block.id] }))}>
                          <Icon name={openHistory[block.id] ? "chevron-down" : "chevron-right"} size={13} />
                          {block.history.length} earlier version{block.history.length === 1 ? "" : "s"}
                        </button>
                      )}
                      {openHistory[block.id] &&
                        block.history.map((old, i) => (
                          <p key={i} className="bw-block__old">{old}</p>
                        ))}
                      {editable && (
                        <div className="bw-block__commentrow">
                          <input
                            className="bw-comment"
                            aria-label={`Comment on ${block.heading || "this block"}`}
                            placeholder="Change the direction, ask for numbers, tighten a line…"
                            value={comments[block.id] ?? ""}
                            onChange={(e) => setComments((c) => ({ ...c, [block.id]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && void sendComment(block)}
                          />
                          <button
                            className="bw-btn"
                            disabled={!!busy || !(comments[block.id] ?? "").trim()}
                            onClick={() => void sendComment(block)}
                          >
                            {busy === `comment-${block.id}` ? <Icon name="loader-circle" size={14} className="bw-spin" /> : <Icon name="corner-down-left" size={14} />}
                            Revise
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="bw-downloads">
                  <button className="bw-btn" onClick={() => void exportRun("md")}>
                    <Icon name="download" size={14} /> Markdown
                  </button>
                  <button className="bw-btn" onClick={() => void exportRun("html")}>
                    <Icon name="download" size={14} /> HTML
                  </button>
                  <button className="bw-btn" onClick={() => void exportRun("txt")}>
                    <Icon name="download" size={14} /> Plain text
                  </button>
                  {shown.visuals ? (
                    <button className="bw-btn" onClick={() => void exportRun("visuals-md")}>
                      <Icon name="download" size={14} /> Visual prompts
                    </button>
                  ) : editable ? (
                    <button className="bw-btn" disabled={!!busy} onClick={() => void planVisuals()}>
                      {busy === "visuals" ? <Icon name="loader-circle" size={14} className="bw-spin" /> : <Icon name="image" size={14} />}
                      Plan the visuals
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            {shown.visuals && (
              <div className="mr-panel">
                <div className="mr-panel__head">
                  <h2 className="mr-panel__title">Visual plan</h2>
                  <span className="mr-panel__sub">The agent's call: {shown.visuals.items.length} visual{shown.visuals.items.length === 1 ? "" : "s"} for this post. Download the prompt doc above.</span>
                </div>
                <div className="bw-visuals">
                  {shown.visuals.items.map((v) => (
                    <div key={v.n} className="bw-visual">
                      <div className="bw-visual__head">
                        <span className="bw-chip">{v.type}</span>
                        <span className="bw-visual__where">{v.section}</span>
                      </div>
                      <div className="bw-visual__theme">{v.theme}</div>
                      <div className="bw-visual__prompt">{v.prompt}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
