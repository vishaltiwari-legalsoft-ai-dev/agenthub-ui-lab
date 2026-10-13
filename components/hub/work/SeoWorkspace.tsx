"use client";

/** The SEO workspace, led by the new per-brand dashboard.
 *
 *  The dashboard is the front door: every brand gets the same premium read —
 *  dials, the clicks trend, the fix queue — drawn fresh for the revamp (no
 *  component of the old console). The classic console survives whole as the
 *  second section, so nothing the team relies on is lost while the new
 *  surface grows.
 */

import { useEffect, useState } from "react";
import { seoOverview, type SeoOverview } from "@/lib/api";
import { canConnectGsc, NO_GSC_RETURN, readGscReturn, type GscReturnFlags } from "@/components/console/seo/seo";
import { loadPending, useLoadSession, type Load } from "@/lib/load";
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
  /** The brand the console opens on arrival from that return. */
  const [focus, setFocus] = useState<string | undefined>(undefined);

  // Read the return once, then take it out of the address bar so a reload or
  // a bookmark does not replay the toast.
  useEffect(() => {
    const hash = window.location.hash;
    const flags = readGscReturn(hash);
    if (!flags.connected && flags.error === null) return;
    setRet(flags);
    if (subject) setFocus(subject);
    window.history.replaceState(null, "", hash.slice(0, hash.indexOf("?")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void session.run(
      "seo-overview",
      (s) => seoOverview({ signal: s }),
      setOv,
      "The brands could not be read.",
      { keepStale: true },
    );
  }, [session, revision, beat]);

  const brands = ov.data?.brands || [];
  const card = brands.find((b) => b.brand.id === subject) || brands[0] || null;
  const brandId = card?.brand.id || "";
  const sec = SECTIONS.some((s) => s.id === section) ? section : "dashboard";

  useHeadline(card ? `${card.brand.name} · ${card.brand.domain}` : "reading the brands");

  // The failure needs nothing; the success names the brand, which only the
  // overview carries — so it waits for that read (or its failure).
  useEffect(() => {
    if (ret.error !== null) {
      toast(ret.error, "error");
      setRet(NO_GSC_RETURN);
      return;
    }
    if (ret.connected && ov.phase !== "loading") {
      const name = brands.find((b) => b.brand.id === subject)?.brand.name;
      toast(`Search Console connected${name ? ` for ${name}` : ""}. Press Refresh data to pull clicks and impressions.`, "ok");
      setRet(NO_GSC_RETURN);
    }
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
        <SeoAgent onToast={toast} onBack={closeWork} focusBrand={focus} />
      </div>
    );
  }

  if (ov.phase === "failed" && !ov.data) {
    return <Oops what="The brands could not be read." error={ov.error || ""} onRetry={() => setBeat((b) => b + 1)} />;
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

  return <SeoDashboard card={card} connectReady={canConnectGsc(ov.data?.sources)} />;
}
