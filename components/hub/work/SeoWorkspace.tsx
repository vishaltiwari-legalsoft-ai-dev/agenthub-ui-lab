"use client";

/** The SEO workspace, led by the new per-brand dashboard.
 *
 *  The dashboard is the front door: every brand gets the same premium read —
 *  dials, the clicks trend, the fix queue — drawn fresh for the revamp (no
 *  component of the old console). The classic console survives whole as the
 *  second section, so nothing the team relies on is lost while the new
 *  surface grows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SeoOverview } from "@/lib/api";
import {
  canConnectGsc, consoleHeadline, gscReturnSentence, NO_GSC_RETURN, plainMessage, readGscReturn, returnNeedsOverview,
  subjectOpensInConsole, type GscReturnFlags,
} from "@/components/console/seo/seo";
import { loadSeoOverview, onSeoOverview } from "@/components/console/seo/overview";
import { loadPending, loadReady, useLoadSession, type Load } from "@/lib/load";
import { useHeadline, useHub, useWorkNav, type WorkSection } from "../context";
import { initials } from "../model";
import { Blank, Oops, Wait } from "../ui";
import { SeoAgent } from "@/components/console/seo/SeoAgent";
import { SeoDashboard } from "./seo/SeoDashboard";

const SECTIONS: WorkSection[] = [
  { id: "dashboard", label: "Dashboard", icon: "overview" },
  { id: "console", label: "Console", icon: "desk" },
];

export function SeoWorkspace({ subject, section }: { subject: string; section: string }) {
  const { openWork, closeWork, toast, revision } = useHub();
  const session = useLoadSession();
  const [ov, setOv] = useState<Load<SeoOverview>>(loadPending);
  const [beat, setBeat] = useState(0);
  /** What `/oauth/google` left on the hash after Connect Search Console. */
  const [ret, setRet] = useState<GscReturnFlags>(NO_GSC_RETURN);
  /** The brand the console opens on arrival — from that return, or from a
   *  dashboard link. Held here because this component stays mounted across
   *  sections; the console lets go of it once it has opened the brand. */
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const releaseFocus = useCallback(() => setFocus(undefined), []);
  const openInConsole = useCallback((id: string) => {
    setFocus(id);
    openWork("seo", id, "console");
  }, [openWork]);

  // Read the return once, then take it out of the address bar so a reload or
  // a bookmark does not replay the toast.
  useEffect(() => {
    const hash = window.location.hash;
    const flags = readGscReturn(hash);
    if (!flags.connected && flags.code === null) return;
    setRet(flags);
    if (subject) setFocus(subject);
    window.history.replaceState(null, "", hash.slice(0, hash.indexOf("?")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One overview read per page load: the console mounts at the same moment
  // and joins this read instead of issuing its own (`overview.ts`). A
  // revision bump or a retry asks for a fresh one.
  const firstRevision = useRef(revision);
  useEffect(() => {
    const fresh = beat > 0 || revision !== firstRevision.current;
    void session.run(
      "seo-overview",
      (s) => loadSeoOverview({ signal: s, fresh }),
      setOv,
      "The brands could not be read.",
      { keepStale: true },
    );
  }, [session, revision, beat]);
  // …and hears every newer read, so a brand the console adds or removes
  // reaches the header and the brand switcher.
  useEffect(() => onSeoOverview((next) => setOv(loadReady(next))), []);

  const brands = ov.data?.brands || [];
  const card = brands.find((b) => b.brand.id === subject) || brands[0] || null;
  const brandId = card?.brand.id || "";
  const sec = SECTIONS.some((s) => s.id === section) ? section : "dashboard";

  /** The brand the console is opening or showing (null: its list). */
  const [shown, setShown] = useState<string | null>(null);
  const shownRef = useRef<string | null>(null);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  // The console reports the brand it opens; the address bar — and with it
  // the header and the brand switcher — follows.
  const onBrandChange = useCallback((id: string | null) => {
    shownRef.current = id;
    setShown(id);
    if (id && id !== subjectRef.current) openWork("seo", id, "console");
  }, [openWork]);
  // A brand picked in the switcher while the console is open is opened there.
  const prev = useRef({ subject, section: sec });
  useEffect(() => {
    const was = prev.current;
    prev.current = { subject, section: sec };
    // The console unmounts with its section; it reopens on its list.
    if (sec !== "console" && shownRef.current !== null) {
      shownRef.current = null;
      setShown(null);
    }
    if (subjectOpensInConsole({
      prevSubject: was.subject, subject, prevSection: was.section, section: sec, shown: shownRef.current,
    })) setFocus(subject);
  }, [subject, sec]);

  useHeadline(sec === "console"
    ? consoleHeadline(shown, brands)
    : card ? `${card.brand.name} · ${card.brand.domain}` : "reading the brands");

  // The link carries a code, never a sentence: the words come from
  // `gscReturnSentence`. Most codes' sentences are fixed and are said at
  // once; the success line (the brand's name) and gsc_no_property (its
  // domain) wait for the overview read — or its failure.
  useEffect(() => {
    if (!ret.connected && ret.code === null) return;
    if (returnNeedsOverview(ret) && ov.phase === "loading") return;
    const known = brands.find((b) => b.brand.id === subject)?.brand;
    if (ret.code !== null) {
      toast(gscReturnSentence(ret.code, known?.domain), "error");
    } else {
      toast(`Search Console connected${known ? ` for ${known.name}` : ""}. Press Refresh data to pull clicks and impressions.`, "ok");
    }
    setRet(NO_GSC_RETURN);
  }, [ret, ov.phase, brands, subject, toast]);

  useWorkNav({
    agentId: "a2",
    subjects: brands.map((b) => ({ id: b.brand.id, ab: initials(b.brand.name), name: b.brand.name })),
    subject: brandId,
    sections: SECTIONS,
    section: sec,
    onSubject: (id) => openWork("seo", id, sec),
    onSection: (s) => openWork("seo", brandId, s),
  });

  if (sec === "console") {
    return (
      <div className="legacy">
        <SeoAgent onToast={toast} onBack={closeWork} focusBrand={focus} onFocused={releaseFocus}
                  onBrandChange={onBrandChange} />
      </div>
    );
  }

  if (ov.phase === "failed" && !ov.data) {
    return <Oops what="The brands could not be read." error={plainMessage(ov.error, "")} onRetry={() => setBeat((b) => b + 1)} />;
  }
  // A reply that succeeded with no brands is an answer, not a wait: the
  // skeleton would otherwise stand for ever on an account with nothing set up.
  if (ov.phase === "ready" && !brands.length) {
    return (
      <Blank title="No SEO brands yet.">
        Add the first one from the console and this dashboard draws itself.
      </Blank>
    );
  }
  if (!card) return <Wait what="Reading the brands" rows={3} />;

  return <SeoDashboard card={card} connectReady={canConnectGsc(ov.data?.sources)} onOpenConsole={openInConsole} />;
}
