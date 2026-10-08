"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastFn } from "@/components/console/ConsoleApp";
import dynamic from "next/dynamic";
import type { DragMarker, TextNodeSpec } from "@/components/console/stage3/KonvaCanvas";
// Non-social types route to the existing Creative Agent rail — same engine
// contract the classic studio uses; V2 only supplies the entry point.
import { CreativeAgent } from "@/components/console/CreativeAgent";
import { runAutoPilot, type AutoAccept, type AutoPilotApi, type AutoStage, type StageOutcome } from "./autoPilot";
import { PlanReview } from "./PlanReview";
import { StyleGallery } from "./StyleGallery";
import { pickDefaultStyle } from "./styleChoice";
import { DEFAULT_PLAN_LAYOUT } from "./wireframe";
import { attachErrorMessage, canAttach, MAX_PROMPT_IMAGES } from "./promptAttach";
import { BrandKitSheet } from "./BrandKitSheet";
import {
  STILL_GENERATING,
  isStageStillRunning,
  stageMark,
  watchStageGenerate,
  type GdStageResult,
} from "./stageWatch";
import {
  brandRefreshDue,
  brandSummaryOf,
  forgetBrand,
  mergeBrandList,
  noteBrand,
  placeBrand,
  settleBrandPick,
  type BrandSightings,
} from "./brandKit";
import { useAuth } from "@/lib/auth";
import {
  creativeTypes,
  gdApprove,
  gdArtifactBlob,
  gdBack,
  gdBrandLogos,
  gdCreateRun,
  gdElements,
  gdFontBlob,
  gdGenerate,
  gdBrands,
  gdGetConfig,
  gdGetRun,
  gdPlan,
  gdStage4,
  gdSubjectUpload,
  gdSuggest,
  gdSuggestPlacement,
  gdTextPreview,
  gdTweak,
  gdUpdateConfig,
  isAbortError,
  type CreativeTypeMeta,
  type GdBrandLogoVariant,
  type GdBrandSummary,
  type GdAttempt,
  type GdChatMessage,
  type GdChatTurn,
  type GdConfig,
  type GdElement,
  type GdElementStyle,
  type GdGradientSuggestion,
  type GdPlacementSuggestion,
  type GdPlan,
  type GdRun,
  type GdSubheading,
} from "@/lib/api";

/* --------------------------------------------------------------------------
   Graphics Studio — the designer-friendly skin over the SAME 4-stage engine.
   Everything here talks to the existing /api/gd/* contracts.
   -------------------------------------------------------------------------- */

// react-konva touches the browser canvas at import time — client-only.
const KonvaCanvas = dynamic(() => import("@/components/console/stage3/KonvaCanvas"), { ssr: false });

const STEPS = [
  { n: 1, name: "Background", hue: "#D9930F" },
  { n: 2, name: "Main image", hue: "#E85C4A" },
  { n: 3, name: "Your words", hue: "#6D4DF2" },
  { n: 4, name: "Logo", hue: "#0E9A89" },
] as const;

const DEFAULT_LAYOUT_W = 0.42;

/* Visible build stamp on the setup screen — the fast answer to "we're seeing
   different things": two people reading different stamps are on different
   deployments, no matter what the URL bar says. Bump on notable releases. */
const STUDIO_BUILD = "2026-07-14.7";

/* Compact glyphs for the Step-3 placement segment — the shaded half of each
   square shows which zone of the image the text will occupy. */
const PLACEMENT_ICON: Record<string, string> = {
  left: "◧",
  right: "◨",
  center: "▣",
  top: "⬒",
  bottom: "⬓",
};

/* Collision-free defaults for un-dragged lines. X follows the element's
   placement preference; Y is STAGGERED per line so nothing ever starts on
   top of anything else. Every line gets pinned to exactly these coords (or
   wherever the user dragged it) before Generate — the engine's legacy
   zone-stacking heuristic is never mixed with pinned items in V2, which is
   what caused pinned/auto overlaps. */
function defaultPos(id: string, place?: string, subIndex = 0) {
  const x = place === "right" ? 0.73 : place === "left" ? 0.27 : 0.5;
  if (id === "headline") return { x, y: place === "top" ? 0.16 : 0.34 };
  if (id === "cta") return { x: place === "left" ? 0.27 : place === "right" ? 0.73 : 0.5, y: 0.84 };
  if (id === "venue") return { x: 0.06, y: 0.965 };
  if (id === "website") return { x: 0.94, y: 0.965 };
  // subheadings stack downward from the headline's band
  return { x, y: Math.min(0.78, (place === "top" ? 0.3 : 0.5) + subIndex * 0.09) };
}

function stageNum(state: string): number {
  if (state === "DONE") return 5;
  const m = /STAGE(\d)/.exec(state);
  return m ? Number(m[1]) : 1;
}

/* Artifacts need the Bearer header — fetch as blob, render as object URL. */
function AuthImg({ path, alt }: { path: string | null; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setSrc(null);
      return;
    }
    let alive = true;
    let url: string | null = null;
    gdArtifactBlob(path)
      .then((u) => {
        if (alive) {
          url = u;
          setSrc(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} />;
}

function previewPath(run: GdRun, cur: number): string | null {
  if (cur >= 5) return run.stages["4"]?.approved?.url ?? null;
  const s = run.stages[String(cur)];
  if (s && s.attempts.length) return s.attempts[s.attempts.length - 1].url;
  for (let n = cur - 1; n >= 1; n -= 1) {
    const prev = run.stages[String(n)]?.approved;
    if (prev) return prev.url;
  }
  return null;
}

const STAGE_HINTS: Record<number, string> = {
  1: "Pick a background on the right, then hit Generate preview.",
  2: "Choose a concept and where it sits, then Generate preview.",
  3: "Edit your words, pick an arrangement, then Generate preview.",
  4: "Pick your logo and its corner, then Generate composite.",
};

export function GraphicsStudioV2({
  onToast,
  onBack,
}: {
  onToast: ToastFn;
  onBack?: () => void;
}) {
  /* ---------------- state ---------------- */
  const [phase, setPhase] = useState<"setup" | "studio">("setup");
  const [brands, setBrands] = useState<GdBrandSummary[]>([]);
  const [brandId, setBrandId] = useState<string>("");
  // Every brand seen recently (list reads and this member's own saves) — a
  // read from a Cloud Run instance whose list cache is behind must not drop
  // one. `brandNames` outlives the list, so a brand that leaves it can still
  // be named when the screen says it is gone.
  const brandSightings = useRef<BrandSightings>({});
  const brandsReadAt = useRef<number | null>(null);
  const [brandNames, setBrandNames] = useState<Record<string, string>>({});
  // The brand-kit sheet: closed, creating, or editing one brand. `kitRev`
  // ticks after a save so the picker and the config re-read the kit.
  const [kitSheet, setKitSheet] = useState<{ open: boolean; brandId: string | null }>({ open: false, brandId: null });
  const [kitRev, setKitRev] = useState(0);
  const { user } = useAuth();
  const [cfg, setCfg] = useState<GdConfig | null>(null);
  const [aspect, setAspect] = useState<string>("");
  const [brief, setBrief] = useState("");
  const [attached, setAttached] = useState<{ file: File; url: string }[]>([]);
  const attachInput = useRef<HTMLInputElement | null>(null);
  const [run, setRun] = useState<GdRun | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  const [plan, setPlan] = useState<GdPlan | null>(null);
  const [autoAccept, setAutoAccept] = useState<AutoAccept | null>(null);
  const [pausedStage, setPausedStage] = useState<AutoStage | null>(null);
  const autoStopped = useRef(false);

  // Creative-type routing: "social" stays in this 4-step studio; any other
  // key opens the dedicated Creative Agent (brochure / carousel / PPTX / blog).
  const [creaTypes, setCreaTypes] = useState<CreativeTypeMeta[]>([]);
  const [creaType, setCreaType] = useState<string>("social");
  const [launchedCreative, setLaunchedCreative] = useState(false);

  const [sel1, setSel1] = useState<string | null>(null);
  const [aiSteer, setAiSteer] = useState("");
  // Every AI-gradient cid seen this session (duplicates kept — the backend
  // rotates by count), so "Dream up another" never repeats itself.
  const [gradExclude, setGradExclude] = useState<string[]>([]);
  const [sel2, setSel2] = useState<string | null>(null);
  const [tok, setTok] = useState<Record<string, string>>({});
  const [logos, setLogos] = useState<GdBrandLogoVariant[]>([]);
  const [logoId, setLogoId] = useState<string | null>(null);
  const [chat, setChat] = useState<GdChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");

  // Step-3 toolbar: which line is being styled ("headline" | "highlight" |
  // "cta" | "sub-<idx>"), a curated emoji strip, and the live text preview.
  const [activeLine, setActiveLine] = useState("headline");
  const [selEl, setSelEl] = useState<string | null>(null);
  const [emojiQuick, setEmojiQuick] = useState<string[]>([]);
  const [maxElements, setMaxElements] = useState(8);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewTimer = useRef<number | null>(null);
  // Step-3 editing surface: false = direct-manipulation mode (drag the real
  // text over the Stage-2 image), true = the engine's exact render.
  const [exactPreview, setExactPreview] = useState(false);
  const [bg2Url, setBg2Url] = useState<string | null>(null);
  const [editPop, setEditPop] = useState<{ id: string; x: number; y: number; value: string } | null>(null);
  const [, setFontsLoaded] = useState(0); // re-render tick as brand faces arrive
  const fontsRequested = useRef<Set<string>>(new Set());
  const [bg3Url, setBg3Url] = useState<string | null>(null); // Stage-4 edit background
  const [logoDim, setLogoDim] = useState<{ w: number; h: number } | null>(null);

  // Text Optimizer (Stage 3): the latest 3-style generate set + the user's pick,
  // and the optional free-text notes woven into the polish prompts.
  const [styleSet, setStyleSet] = useState<GdAttempt[] | null>(null);
  const [styleSel, setStyleSel] = useState<number | null>(null);
  const [polishNotes, setPolishNotes] = useState("");

  // Step 5 · final tweak (optional): pending instruction + un-kept result.
  const [tweakText, setTweakText] = useState("");
  const [tweakPreview, setTweakPreview] = useState<GdAttempt | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      // A stage watch the studio walked away from — nothing to say.
      if (isAbortError(e)) return;
      // A stage still running at the watch's cap is not a failure.
      onToast(e instanceof Error ? e.message : String(e), isStageStillRunning(e) ? "warn" : "error");
    },
    [onToast],
  );

  const guard = useCallback(
    async (msg: string, fn: () => Promise<void>) => {
      setBusy(msg);
      try {
        await fn();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [fail],
  );

  /* A stage generate (1-3, and the Stage-4 composite) that outlives the
     relay's 300 s cut is read back from the run until its NEW attempt is
     there, instead of failing on the 504 — see stageWatch.ts. The overlay
     says "Still generating…" meanwhile, and the guard's own label returns
     once the attempt lands. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const busyRef = useRef<string | null>(null);
  busyRef.current = busy;
  // A run whose last stage watch stopped at the cap: that attempt may have
  // landed since, so the next mark is taken from a fresh read, or the late
  // attempt would be taken for the new call's answer.
  const unsettledRun = useRef<string | null>(null);
  const generateStage = async (
    runId: string,
    stage: number,
    fire: () => Promise<GdStageResult>,
  ): Promise<GdStageResult> => {
    let base = runRef.current;
    if (unsettledRun.current === runId) {
      base = await gdGetRun(runId);
      setRun(base);
      unsettledRun.current = null;
    }
    let label: string | null = null;
    try {
      const result = await watchStageGenerate({
        stage,
        mark: stageMark(base?.id === runId ? base : null, stage),
        fire,
        read: () => gdGetRun(runId),
        current: () => alive.current && runRef.current?.id === runId,
        onCut: () => {
          label = busyRef.current;
          setBusy(STILL_GENERATING);
        },
      });
      if (label) setBusy(label);
      return result;
    } catch (e) {
      if (isStageStillRunning(e)) unsettledRun.current = runId;
      throw e;
    }
  };

  /* ---------------- data loads ---------------- */
  // Brands are shared and any member may add one. Each read is merged with
  // what this screen has seen within the backend's cache window, and a brand
  // the member chose is never swapped for another: if it is genuinely gone it
  // stays chosen, the screen says so, and Generate waits for a new pick.
  const loadBrands = useCallback(async () => {
    brandsReadAt.current = Date.now();
    const r = await gdBrands();
    const merged = mergeBrandList(r.brands, brandSightings.current, Date.now());
    brandSightings.current = merged.sightings;
    setBrands(merged.brands);
    setBrandNames((n) => ({ ...n, ...Object.fromEntries(merged.brands.map((b) => [b.brand_id, b.name])) }));
    setBrandId((b) => settleBrandPick(b, merged.brands, r.default).brandId);
  }, []);

  useEffect(() => {
    loadBrands().catch(fail);
  }, [loadBrands, fail, kitRev]);

  // An open studio picks up brands other members add: the picker reads the
  // list again when it is focused or opened, at most once per refresh gap.
  // A failed background read leaves the list on screen as it was read.
  const refreshBrands = useCallback(() => {
    if (!brandRefreshDue(brandsReadAt.current, Date.now())) return;
    loadBrands().catch(() => undefined);
  }, [loadBrands]);

  const brandMissing = settleBrandPick(brandId, brands, "").missing;
  const missingBrandName = brandNames[brandId] || "The brand you picked";

  // Creative-Agent types for the setup picker (additive; failure is silent so
  // the social studio still works if the rail isn't reachable).
  useEffect(() => {
    creativeTypes()
      .then((d) => setCreaTypes(d.types))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!brandId) return;
    gdGetConfig(brandId)
      .then((c) => {
        setCfg(c);
        const def = c.aspect_ratios.find((a) => a.default) ?? c.aspect_ratios[0];
        setAspect((a) => a || (def ? def.ar : ""));
      })
      .catch(fail);
  }, [brandId, fail, kitRev]);

  const cur = run ? stageNum(run.state) : 1;

  // keep local token drafts in sync per run
  const runId = run?.id ?? null;
  useEffect(() => {
    if (run) setTok(run.config.tokens ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // brand-logo library loads when we reach stage 4
  useEffect(() => {
    if (!run || cur !== 4 || logos.length) return;
    gdBrandLogos(run.id)
      .then((r) => {
        setLogos(r.logos);
        setLogoId((v) => v ?? (r.logos[0]?.id ?? null));
      })
      .catch(fail);
  }, [run, cur, logos.length, fail]);

  // Curated emoji strip for the Step-3 toolbar (catalogue is codepoint-ordered,
  // so cherry-pick the useful ones by name).
  useEffect(() => {
    if (cur !== 3 || emojiQuick.length) return;
    gdElements()
      .then((r) => {
        setMaxElements(r.max_elements);
        const wanted = ["sparkles", "star", "fire", "rocket", "check mark button", "briefcase", "balance scale", "chart increasing", "party popper", "light bulb"];
        const picks: string[] = [];
        for (const w of wanted) {
          const hit = r.emoji.find((e) => e.name.toLowerCase() === w) ?? r.emoji.find((e) => e.name.toLowerCase().includes(w));
          if (hit && !picks.includes(hit.char)) picks.push(hit.char);
        }
        // Cap at 5 so the strip fits the single-line toolbar.
        setEmojiQuick(picks.length ? picks.slice(0, 5) : r.emoji.slice(0, 5).map((e) => e.char));
      })
      .catch(() => setEmojiQuick([]));
  }, [cur, emojiQuick.length]);

  // Load the REAL brand font files into the browser (FontFace per variant,
  // registered under the variant's own name) so the editor canvas shows true
  // brand typography and the font menu visibly changes the face.
  useEffect(() => {
    if (!cfg || typeof window === "undefined" || !("FontFace" in window)) return;
    cfg.font_variants.forEach((v) => {
      if (fontsRequested.current.has(v.name)) return;
      fontsRequested.current.add(v.name);
      gdFontBlob(v.name, cfg.brand_id)
        .then(async (url) => {
          try {
            const face = new FontFace(v.name, `url(${url})`);
            await face.load();
            document.fonts.add(face);
            setFontsLoaded((n) => n + 1);
          } finally {
            URL.revokeObjectURL(url);
          }
        })
        .catch(() => undefined); // editing falls back to system faces
    });
  }, [cfg]);

  // Stage-3 approved image = the Stage-4 logo-placement background; measure
  // the selected logo's natural ratio from its thumbnail.
  const stage3Ref = run?.stages["3"]?.approved?.url ?? null;
  useEffect(() => {
    if (!stage3Ref || cur !== 4) {
      setBg3Url((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      return;
    }
    let alive = true;
    gdArtifactBlob(stage3Ref)
      .then((u) => {
        if (!alive) return URL.revokeObjectURL(u);
        setBg3Url((old) => {
          if (old) URL.revokeObjectURL(old);
          return u;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [stage3Ref, cur]);

  const curLogoThumb = logos.find((l) => l.id === logoId)?.thumb ?? null;
  useEffect(() => {
    if (!curLogoThumb) {
      setLogoDim(null);
      return;
    }
    const img = new Image();
    img.onload = () => setLogoDim({ w: img.width, h: img.height });
    img.src = curLogoThumb;
  }, [curLogoThumb]);

  // Arriving at Stage 4: show the composite if one exists, else the editor.
  useEffect(() => {
    if (cur === 4 && run) setExactPreview(!!run.stages["4"]?.attempts.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  // Stage-2 approved image = the editing-mode canvas background.
  const stage2Ref = run?.stages["2"]?.approved?.url ?? null;
  useEffect(() => {
    if (!stage2Ref || cur !== 3) {
      setBg2Url((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      return;
    }
    let alive = true;
    gdArtifactBlob(stage2Ref)
      .then((u) => {
        if (!alive) {
          URL.revokeObjectURL(u);
          return;
        }
        setBg2Url((old) => {
          if (old) URL.revokeObjectURL(old);
          return u;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [stage2Ref, cur]);

  // Exact-render preview: the REAL deterministic text engine (debounced).
  // Only fetched while the user is in exact mode — editing mode is fully
  // client-side and instant.
  const subheadings = run?.config.subheadings ?? [];
  useEffect(() => {
    if (!run || cur !== 3 || !exactPreview) {
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      return;
    }
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      gdTextPreview(run.id, {
        tokens: { ...run.config.tokens, ...tok },
        subheading_texts: subheadings.map((s) => s.text),
      })
        .then((url) =>
          setPreviewUrl((old) => {
            if (old) URL.revokeObjectURL(old);
            return url;
          }),
        )
        .catch(() => undefined); // preview is best-effort; Generate still works
    }, 550);
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, cur, tok]);

  /* ---------------- actions ---------------- */
  const patch = useCallback(
    (body: Parameters<typeof gdUpdateConfig>[1]) => {
      if (!run) return;
      gdUpdateConfig(run.id, body).then(setRun).catch(fail);
    },
    [run, fail],
  );

  /* ---------------- step-3 toolbar helpers ---------------- */
  const lineRef = useCallback((): { kind: "el"; key: string } | { kind: "sub"; idx: number } => {
    if (activeLine.startsWith("sub-")) return { kind: "sub", idx: Number(activeLine.slice(4)) };
    return { kind: "el", key: activeLine };
  }, [activeLine]);

  const lineStyle = (): GdSubheading | GdElementStyle => {
    const L = lineRef();
    if (!run) return {} as GdElementStyle;
    if (L.kind === "sub") return run.config.subheadings?.[L.idx] ?? ({ text: "" } as GdSubheading);
    return run.config.element_styles?.[L.key] ?? ({} as GdElementStyle);
  };

  const setLineField = (field: "font" | "color" | "size_pct" | "placement" | "align", value: string | number | null) => {
    if (!run) return;
    const L = lineRef();
    if (L.kind === "el") {
      if (value === null) return; // element styles are merge-only
      patch({ element_styles: { [L.key]: { [field]: value } as unknown as GdElementStyle } });
    } else {
      const list = (run.config.subheadings ?? []).map((s, i) => {
        if (i !== L.idx) return s;
        const next = { ...s } as Record<string, unknown>;
        if (value === null) delete next[field];
        else next[field] = value;
        return next as unknown as GdSubheading;
      });
      patch({ subheadings: list });
    }
  };

  const addTextBox = () => {
    if (!run) return;
    const list = [...(run.config.subheadings ?? [])];
    if (list.length >= 5) {
      onToast("Text-box limit reached (5 lines).", "warn");
      return;
    }
    list.push({ text: "New text" });
    // Drop the new box mid-canvas so it lands under the cursor's world,
    // instantly draggable — not buried in a form.
    patch({
      subheadings: list,
      layout: { [`subheading-${list.length - 1}`]: { x: 0.5, y: 0.5, w: DEFAULT_LAYOUT_W, anchor: "mc" } },
    });
    setActiveLine(`sub-${list.length - 1}`);
  };

  const commitEditPop = () => {
    setEditPop((pop) => {
      if (!pop || !run) return null;
      const value = pop.value;
      if (pop.id.startsWith("subheading-")) {
        setSubText(Number(pop.id.split("-")[1]), value);
      } else {
        setTok((t) => ({ ...t, [pop.id]: value }));
        patch({ tokens: { ...run.config.tokens, ...tok, [pop.id]: value } });
      }
      return null;
    });
  };

  const removeTextBox = (idx: number) => {
    if (!run) return;
    const list = (run.config.subheadings ?? []).filter((_, i) => i !== idx);
    if (!list.length) {
      onToast("At least one sub-heading line must remain.", "warn");
      return;
    }
    patch({ subheadings: list });
    setActiveLine("headline");
  };

  const setSubText = (idx: number, text: string) => {
    if (!run) return;
    const cur = run.config.subheadings ?? [];
    // Emptying a box deletes it (Canva behavior) — unless it's the last one,
    // which the engine requires to exist (it skips empty text anyway).
    if (!text.trim() && cur.length > 1) {
      patch({ subheadings: cur.filter((_, i) => i !== idx) });
      setActiveLine("headline");
      return;
    }
    patch({ subheadings: cur.map((s, i) => (i === idx ? { ...s, text } : s)) });
  };

  const addEmoji = (char: string) => {
    if (!run) return;
    const els = run.config.elements ?? [];
    if (els.length >= maxElements) {
      onToast(`Element limit reached (${maxElements}).`, "warn");
      return;
    }
    const el: GdElement = {
      id: `el-${Math.random().toString(36).slice(2, 10)}`,
      kind: "emoji", x: 0.5, y: 0.3, w: 0.15, h: 0.15,
      anchor: "mc", z: 5, rotation: 0, opacity: 1, ref: char, fill: "#1746A2",
    };
    patch({ elements: [...els, el] });
  };

  const removeElement = (id: string) => {
    if (!run) return;
    patch({ elements: (run.config.elements ?? []).filter((e) => e.id !== id) });
  };

  // Italic cuts may be labeled "italic" OR "oblique" (Causten uses oblique).
  const isItalicStyle = (s?: string) => !!s && s !== "normal";
  /* Pin EVERY visible text line to explicit coords (dragged position or the
     staggered default the edit canvas shows). Sent before Generate so the
     engine renders exactly what the user saw — never the zone-stack path. */
  const pinAllLayout = useCallback(() => {
    if (!run) return {};
    const lay = run.config.layout ?? {};
    const es = run.config.element_styles ?? {};
    const tokens = { ...run.config.tokens, ...tok };
    const out: Record<string, { x: number; y: number; w: number; anchor: string }> = {};
    const pin = (id: string, place?: string, i = 0) => {
      const prev = lay[id];
      const p = prev ?? defaultPos(id, place, i);
      out[id] = { x: p.x, y: p.y, w: prev?.w ?? DEFAULT_LAYOUT_W, anchor: "mc" };
    };
    if ((tokens.headline ?? "").trim()) pin("headline", es.headline?.placement);
    (run.config.subheadings ?? []).forEach((s, i) => {
      if ((s.text ?? "").trim()) pin(`subheading-${i}`, s.placement, i);
    });
    if ((tokens.cta ?? "").trim()) pin("cta", es.cta?.placement);
    (["venue", "website"] as const).forEach((f) => {
      if ((tokens[f] ?? "").trim()) pin(f);
    });
    return out;
  }, [run, tok]);

  /* Stage-4 logo placement box, mirroring compositor.logo_placement exactly:
     position grid + margin + size_pct (or auto ratio) + pixel offsets. */
  const logoBox = useCallback(() => {
    if (!run || !cfg) return null;
    const ar = cfg.aspect_ratios.find((a) => a.ar === run.config.aspect_ratio);
    if (!ar) return null;
    const lw = logoDim?.w ?? 340;
    const lh = logoDim?.h ?? 84;
    const L = run.config.logo_layout ?? { position: "top-left", size_pct: null, margin_pct: 4, offset_x: 0, offset_y: 0 };
    const shape = lh ? lw / lh : 1;
    const autoRatio = shape > 3 ? 0.25 : shape < 0.5 ? 0.15 : 0.2;
    const ratio = L.size_pct ? L.size_pct / 100 : autoRatio;
    const w = Math.max(1, Math.round(ar.w * ratio));
    const h = Math.max(1, Math.round(w * (lh / (lw || 1))));
    const margin = Math.round(ar.w * ((L.margin_pct ?? 4) / 100));
    const [v, hp] = (L.position || "top-left").split("-");
    const x0 = hp === "right" ? ar.w - w - margin : hp === "center" ? Math.round((ar.w - w) / 2) : margin;
    const y0 = v === "bottom" ? ar.h - h - margin : v === "middle" ? Math.round((ar.h - h) / 2) : margin;
    const x = Math.min(Math.max(x0 + (L.offset_x || 0), 0), Math.max(0, ar.w - w));
    const y = Math.min(Math.max(y0 + (L.offset_y || 0), 0), Math.max(0, ar.h - h));
    return { fx: x / ar.w, fy: y / ar.h, fw: w / ar.w, fh: h / ar.h, baseW: ar.w, baseH: ar.h, lw, lh, margin, pos: L.position || "top-left" };
  }, [run, cfg, logoDim]);

  /* Drag/resize commit: convert the new box back into size_pct + pixel
     offsets relative to the grid anchor (recomputed for the new width). */
  const commitLogoBox = useCallback(
    (box: { x: number; y: number; w: number }) => {
      const b = logoBox();
      if (!run || !cfg || !b) return;
      const sizePct = Math.min(cfg.logo_size_pct_max, Math.max(cfg.logo_size_pct_min, box.w * 100));
      const w = Math.max(1, Math.round(b.baseW * (sizePct / 100)));
      const h = Math.max(1, Math.round(w * (b.lh / (b.lw || 1))));
      const [v, hp] = b.pos.split("-");
      const x0 = hp === "right" ? b.baseW - w - b.margin : hp === "center" ? Math.round((b.baseW - w) / 2) : b.margin;
      const y0 = v === "bottom" ? b.baseH - h - b.margin : v === "middle" ? Math.round((b.baseH - h) / 2) : b.margin;
      patch({
        logo_layout: {
          size_pct: Math.round(sizePct * 10) / 10,
          offset_x: Math.round(box.x * b.baseW - x0),
          offset_y: Math.round(box.y * b.baseH - y0),
        },
      });
      setExactPreview(false);
    },
    [logoBox, run, cfg, patch],
  );

  const variantFor = (bold: boolean, italic: boolean) =>
    cfg?.font_variants.find(
      (v) => (v.weight >= 600) === bold && isItalicStyle(v.style) === italic,
    )?.name ?? null;

  const onAttachFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    // Snapshot NOW — e.target.files is a LIVE FileList and we clear the input
    // below, which would empty it before React runs any deferred updater.
    const files = Array.from(list);
    if (attachInput.current) attachInput.current.value = "";
    const additions: { file: File; url: string }[] = [];
    for (const file of files) {
      const verdict = canAttach(attached.length + additions.length, file);
      if (!verdict.ok) {
        onToast(attachErrorMessage(file.name, verdict.reason), "warn");
        if (verdict.reason === "limit") break;
        continue;
      }
      additions.push({ file, url: URL.createObjectURL(file) });
    }
    if (additions.length) setAttached((prev) => [...prev, ...additions]);
  };

  const removeAttached = (i: number) => {
    const hit = attached[i];
    if (hit) URL.revokeObjectURL(hit.url);
    setAttached((prev) => prev.filter((_, j) => j !== i));
  };

  const start = () => {
    if (brandMissing) {
      onToast(`${missingBrandName} is no longer in the brand list — choose a brand first.`, "warn");
      return;
    }
    if (autoMode && !brief.trim()) {
      onToast("Auto mode needs a brief — tell the studio what this is about.", "warn");
      return;
    }
    return guard("Studio is getting your brand kit ready…", async () => {
      const created = await gdCreateRun(brandId || null, {
        ...(aspect ? { aspect_ratio: aspect } : {}),
        creative_type: "social",
        remix_enabled: true,
        ...(brief.trim() ? { creative_brief: { goal: brief.trim() } } : {}),
      });
      // Brief-attached images go up before anything generates (or plans) so
      // Stage-1/2 AI generation sees them; a failed upload never blocks the run.
      for (const a of attached) {
        try {
          await gdSubjectUpload(created.id, a.file, "prompt");
        } catch {
          onToast(`Couldn't attach ${a.file.name} — continuing without it.`, "error");
        }
      }
      setRun(created);
      setSel1(null);
      setSel2(null);
      setLogos([]);
      setLogoId(null);
      setPlan(null);
      setAutoAccept(null);
      setPausedStage(null);
      autoStopped.current = false;
      setChat([
        {
          role: "agent",
          text: brief.trim()
            ? `Working from your brief: “${brief.trim()}”. Pick a background to start — I'll chip in at every step.`
            : "Pick a background to start — I'll chip in with suggestions at every step.",
        },
      ]);
      setPhase("studio");
      if (autoMode) {
        try {
          const res = await gdPlan(created.id, brief.trim());
          setPlan(res.plan);
          setRun(res.run);
        } catch (e) {
          fail(e);
          onToast("Auto mode couldn’t plan — continuing in manual mode.", "error");
        }
      }
    });
  };

  const generate = () => {
    if (!run) return;
    const variant = cur === 1 ? sel1 : cur === 2 ? sel2 : undefined;
    if (cur <= 2 && !variant) return;
    if (cur === 4) {
      void guard("Compositing your real logo…", async () => {
        const res = await generateStage(run.id, 4, () =>
          gdStage4(run.id, null, run.config.use_ai_compositor ?? false, logoId),
        );
        setRun(res.run);
        setExactPreview(true); // show the engine's composite
      });
      return;
    }
    void guard(
      cur === 1 ? "Painting your brand background…" : cur === 2 ? "Creating your main image…" : "Placing your words, then polishing 3 styles…",
      async () => {
        if (cur === 3) await signAndPin();
        const res = await generateStage(run.id, cur, () => gdGenerate(run.id, cur, variant ?? undefined));
        setRun(res.run);
        if (cur === 3) {
          // Text Optimizer set → show the 3-up gallery (brand_strict preselected).
          if (res.attempts && res.attempts.length > 1) {
            setStyleSet(res.attempts);
            setStyleSel(pickDefaultStyle(res.attempts));
            setExactPreview(true);
          } else {
            setStyleSet(null);
            setStyleSel(null);
          }
        }
      },
    );
  };

  /* V2 has no per-token checkmarks — the user's Generate/Approve click IS the
     human sign-off. One call signs every token + text line and pins every
     visible line to the coords the edit canvas shows. */
  const signAndPin = useCallback(async () => {
    if (!run) return;
    const sign = { approved: true, source: "user" as const };
    await gdUpdateConfig(run.id, {
      tokens: { ...run.config.tokens, ...tok },
      token_approvals: { headline: sign, highlight: sign, cta: sign },
      subheadings: (run.config.subheadings ?? []).map((s) => ({ ...s, approved: true })),
      layout: pinAllLayout(),
      polish_notes: polishNotes,
    });
  }, [run, tok, pinAllLayout, polishNotes]);

  /* Auto mode drives the EXISTING per-stage endpoints; each stage's pick is
     applied, generated, then approved — no new execution rail. */
  const autoApi: AutoPilotApi = {
    runStage: async (stage, p): Promise<StageOutcome | void> => {
      const r0 = runRef.current;
      if (!r0) throw new Error("Run not available");
      if (stage === 1) {
        setSel1(p.gradient.cid);
        await generateStage(r0.id, 1, () => gdGenerate(r0.id, 1, p.gradient.cid));
        setRun(await gdApprove(r0.id, 1));
      } else if (stage === 2) {
        setSel2(p.element.cid);
        // The wireframe's subject cell steers the Stage-2 prompt placement.
        if (p.layout) await gdUpdateConfig(r0.id, { element_placement: p.layout.subject_cell });
        await generateStage(r0.id, 2, () => gdGenerate(r0.id, 2, p.element.cid));
        setRun(await gdApprove(r0.id, 2));
      } else if (stage === 3) {
        const sign = { approved: true, source: "user" as const };
        const tokens = {
          ...r0.config.tokens,
          headline: p.text.headline,
          highlight: p.text.highlight,
          cta: p.text.cta,
        };
        setTok(tokens);
        const first = (r0.config.subheadings ?? [])[0] ?? { text: "" };
        const subText = p.text.subline.trim() || first.text || " ";
        const wire = p.layout ?? DEFAULT_PLAN_LAYOUT;
        const r1 = await gdUpdateConfig(r0.id, {
          tokens,
          token_approvals: { headline: sign, highlight: sign, cta: sign },
          // The wireframe's zones map to the engine's zone-stack PLACEMENTS
          // (not pinned coords): the renderer stacks blocks with real font
          // metrics, so a long wrapped headline can never overlap the sub text.
          subheadings: [{ ...first, text: subText, placement: wire.sub_zone, approved: true }],
          element_styles: {
            headline: { placement: wire.headline_zone },
            cta: { placement: wire.cta_zone },
          },
          // Pre-seed the logo gate with the planned corner + variant.
          logo_layout: { position: wire.logo_corner },
        });
        setRun(r1);
        if (p.logo.logo_id) setLogoId(p.logo.logo_id);
        const g = await generateStage(r0.id, 3, () => gdGenerate(r0.id, 3));
        setRun(g.run);
        if (g.attempts && g.attempts.length > 1) {
          // Text Optimizer styles ready → mandatory style gate: show the
          // gallery and hand control back; the user's Approve resumes auto.
          setStyleSet(g.attempts);
          setStyleSel(pickDefaultStyle(g.attempts));
          setExactPreview(true);
          return "gate";
        }
        setRun(await gdApprove(r0.id, 3, g.attempt.attempt));
      } else {
        // Stage 4 is user-gated in auto mode — the machine pauses before it.
        throw new Error("stage 4 is user-gated");
      }
    },
    pause: (stage) => setPausedStage(stage),
  };

  const AUTO_STAGE_MSG: Record<AutoStage, string> = {
    1: "Auto: painting your background…",
    2: "Auto: creating your main image…",
    3: "Auto: placing your words…",
    4: "Auto: compositing your logo…",
  };

  const driveAuto = (accept: AutoAccept, p: GdPlan, from: AutoStage) =>
    guard(AUTO_STAGE_MSG[from], async () => {
      const out = await runAutoPilot(p, accept, from, autoApi, () => autoStopped.current);
      if (out.status === "done") onToast("Auto plan complete — tweak anything, then download.");
      else if (out.status === "gated")
        onToast(out.stage === 3
          ? "3 polished styles are ready — pick one, then Approve to continue."
          : "Your turn: choose the logo and where it goes, then Generate composite.");
      else if (out.status === "paused")
        onToast(`Auto paused — choose your own ${STEPS[out.stage - 1].name.toLowerCase()}, approve it, and it resumes.`);
      else if (out.status === "error") throw out.error;
    });

  const approve = () => {
    if (!run) return;
    void guard("Locking this layer in…", async () => {
      if (cur === 3) {
        // Text Optimizer flow: a style was generated and picked → approve exactly
        // that attempt. The backend rejects it (409) if the arrangement changed
        // after the render, instead of silently re-billing 3 polish calls.
        if (styleSet && styleSel != null) {
          try {
            setRun(await gdApprove(run.id, 3, styleSel));
            setStyleSet(null);
            setStyleSel(null);
          } catch (e) {
            onToast("Your layout changed since these styles — hit Generate again, then approve.", "error");
            throw e;
          }
          return;
        }
        // No styled set yet: render the CURRENT arrangement first (legacy
        // deterministic path renders free; the optimizer path instead returns a
        // 3-style set the user must pick from).
        await signAndPin();
        const g = await generateStage(run.id, 3, () => gdGenerate(run.id, 3));
        setRun(g.run);
        if (g.attempts && g.attempts.length > 1) {
          setStyleSet(g.attempts);
          setStyleSel(pickDefaultStyle(g.attempts));
          setExactPreview(true);
          onToast("3 polished styles are ready — pick one, then Approve.");
          return;
        }
        setRun((await gdApprove(run.id, 3, g.attempt.attempt)) as GdRun);
        return;
      }
      if (cur === 4) {
        // Same no-stale rule for the logo: composite the CURRENT placement,
        // then approve exactly that attempt.
        const res = await generateStage(run.id, 4, () =>
          gdStage4(run.id, null, run.config.use_ai_compositor ?? false, logoId),
        );
        setRun(await gdApprove(run.id, 4, res.attempt.attempt));
        return;
      }
      const r = await gdApprove(run.id, cur);
      setRun(r);
    });
  };

  // Step 5: guardrailed retouch of the approved final. Server rejections (a
  // guardrail was violated, or the model is offline) surface via guard's toast.
  const applyTweak = () => {
    if (!run || tweakText.trim().length < 3) return;
    void guard("Retouching your final…", async () => {
      const res = await gdTweak(run.id, tweakText.trim());
      setRun(res.run);
      setTweakPreview(res.attempt);
      if (res.attempt.qa === "skipped")
        onToast("Tweak ready — QA check was unavailable, review it yourself.", "warn");
    });
  };

  const keepTweak = () => {
    if (!run || !tweakPreview) return;
    void guard("Locking in your tweak…", async () => {
      setRun(await gdApprove(run.id, 4, tweakPreview.attempt));
      setTweakPreview(null);
      setTweakText("");
      onToast("Tweak applied — this is your new final.");
    });
  };

  const gotoStage = (n: number) => {
    if (!run || n >= cur) return;
    if (!window.confirm(`Go back to “${STEPS[n - 1].name}”? Later layers will be regenerated after your change.`)) return;
    setStyleSet(null);
    setStyleSel(null);
    void guard("Rewinding to that layer…", async () => {
      const r = await gdBack(run.id, n);
      setRun(r);
    });
  };

  const dreamGradient = () =>
    guard("Dreaming up a fresh on-brand gradient…", async () => {
      if (!run) return;
      // Accumulate every seen cid (duplicates included) — the backend rotates
      // compositions/curated picks by the exclude count, so a single-element
      // exclude made "Dream up another" return the SAME design every time.
      const exclude = [...gradExclude, ...(run.config.custom_gradient?.cid ? [run.config.custom_gradient.cid] : [])];
      const res = (await gdSuggest(run.id, {
        kind: "gradient",
        ...(aiSteer.trim() ? { steer: aiSteer.trim() } : {}),
        ...(exclude.length ? { exclude } : {}),
      })) as unknown as GdGradientSuggestion;
      if (res.gradient.cid) setGradExclude([...exclude, res.gradient.cid]);
      // Never pass a curated preset off as an AI result — say what happened.
      if (!res.ai) onToast(res.fallback_reason ?? "AI unavailable — showing a curated brand preset instead.", "warn");
      const r = await gdUpdateConfig(run.id, { custom_gradient: res.gradient });
      setRun(r);
      setSel1("AI");
    });

  // Latest run, readable from async callbacks (the background vision suggestion
  // resolves after renders, so its guards must see the CURRENT config).
  const runRef = useRef<GdRun | null>(null);
  runRef.current = run;

  // Apply an AI placement proposal in one config patch: layout + (when the
  // vision brain judged the image) headline colour/size and the matching
  // sub-heading colour, so the whole copy stack stays legible together.
  const applyPlacement = async (res: GdPlacementSuggestion) => {
    const r0 = runRef.current;
    if (!r0) return;
    const body: Parameters<typeof gdUpdateConfig>[1] = {
      layout: res.layout,
      ...(res.shapes ? { shapes: res.shapes } : {}),
      ...(res.element_styles ? { element_styles: res.element_styles } : {}),
    };
    if (res.text_color && (r0.config.subheadings ?? []).length) {
      body.subheadings = (r0.config.subheadings ?? []).map((s) => ({ ...s, color: res.text_color! }));
    }
    setRun(await gdUpdateConfig(r0.id, body));
  };

  const aiPlacement = () =>
    guard("Finding a cleaner arrangement…", async () => {
      if (!run) return;
      const res = await gdSuggestPlacement(run.id);
      await applyPlacement(res);
      onToast(
        res.source === "vision" && res.reason
          ? `Arranged — ${res.reason}`
          : "Arranged — Generate preview to see it.",
      );
    });

  // Vision auto-arrange: the placement micro-subagent looks at the approved
  // image the moment Step 3 opens and proposes the starting layout in the
  // background. Non-blocking, and manual intent wins — if the user pinned
  // anything before the response lands, the suggestion is dropped (still
  // available behind the arrange button).
  const autoArrangedRun = useRef<string | null>(null);
  useEffect(() => {
    if (!run || run.state !== "STAGE3_CONFIG") return;
    if (autoArrangedRun.current === run.id) return;
    autoArrangedRun.current = run.id;
    if (Object.keys(run.config.layout ?? {}).length) return; // already placed (e.g. back-nav)
    let alive = true;
    gdSuggestPlacement(run.id)
      .then(async (res) => {
        // Only a VISION-sourced arrangement earns auto-apply: the deterministic
        // fallback never looked at the image, so force-pinning it on open would
        // be worse than the renderer's own defaults. It stays available behind
        // the arrange button, where the user asks for it.
        if (res.source !== "vision") return;
        const latest = runRef.current;
        if (!alive || !latest || latest.state !== "STAGE3_CONFIG") return;
        if (Object.keys(latest.config.layout ?? {}).length) return; // user dragged meanwhile
        await applyPlacement(res);
        onToast(res.reason ? `AI arranged your text — ${res.reason}` : "AI arranged your text from the image.");
      })
      .catch(() => undefined); // advisory only — never surface an error
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state]);

  // Auto-mode resume: when the user finishes the manual step Auto paused on,
  // the run advances past it — continue the remaining accepted stages.
  useEffect(() => {
    if (!plan || !autoAccept || pausedStage === null || autoStopped.current) return;
    if (cur > pausedStage && cur <= 4) {
      const resumeFrom = cur as AutoStage;
      setPausedStage(null);
      void driveAuto(autoAccept, plan, resumeFrom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text || !run) return;
    const hist: GdChatMessage[] = [...chat, { role: "user", text }];
    setChat(hist);
    setChatInput("");
    gdSuggest(run.id, { kind: "chat", history: hist })
      .then((res) => {
        const turn = res as unknown as GdChatTurn;
        if (turn.reply) setChat((c) => [...c, { role: "agent", text: turn.reply }]);
      })
      .catch(fail);
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!run) {
      onToast("Start a design first, then upload your photo.", "warn");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      onToast("That image is over 10 MB — please use a smaller file.", "warn");
      return;
    }
    const role = cur === 1 ? "background" : "subject";
    void guard(`Uploading “${file.name}”…`, async () => {
      const { ref } = await gdSubjectUpload(run.id, file, role);
      if (role === "background") {
        await gdUpdateConfig(run.id, { background_asset_ref: ref });
        setSel1("UPLOAD");
        // Cover-fit immediately — deterministic and free — so the photo IS
        // the background the moment the upload lands. No dead clicks.
        const res = await gdGenerate(run.id, 1, "UPLOAD");
        setRun(res.run);
        onToast("Your photo is the background — Approve it, or pick a preset card to switch back.");
        setChat((c) => [
          ...c,
          { role: "agent", text: `“${file.name}” is your background now. Approve it, or pick any preset card to switch back.` },
        ]);
        return;
      }
      const r = await gdUpdateConfig(run.id, { subject_asset_ref: ref });
      setRun(r);
      setSel2("UPLOAD");
      if (stageNum(r.state) === 2) {
        const res = await gdGenerate(r.id, 2, "UPLOAD");
        setRun(res.run);
        onToast("Your photo is on the design — move it with the Position grid, then Approve.");
      } else {
        onToast(`“${file.name}” saved — it becomes your main image in Step 2.`);
      }
      setChat((c) => [
        ...c,
        {
          role: "agent",
          text:
            stageNum(r.state) === 2
              ? `“${file.name}” is composited onto your background. Nudge it with the Position grid and Regenerate, or Approve if it looks right.`
              : `Got it — “${file.name}” is saved. Once the background is approved, it appears in Step 2 as “Your upload”.`,
        },
      ]);
    });
  };

  const download = () => {
    const p = run?.stages["4"]?.approved?.url;
    if (!p) return;
    gdArtifactBlob(p)
      .then((obj) => {
        const a = document.createElement("a");
        a.href = obj;
        a.download = "creative.png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(obj), 5000);
      })
      .catch(fail);
  };

  const resetAll = () => {
    setPhase("setup");
    setRun(null);
    setSel1(null);
    setSel2(null);
    setLogos([]);
    setLogoId(null);
    setChat([]);
    setAiSteer("");
    setPlan(null);
    setAutoAccept(null);
    setPausedStage(null);
    autoStopped.current = false;
  };

  /* ------------- Creative Agent route (non-social types) ------------- */
  if (launchedCreative && creaType !== "social") {
    return (
      <CreativeAgent
        brandId={brandId || null}
        brandName={brands.find((b) => b.brand_id === brandId)?.name}
        creativeType={creaType}
        onToast={onToast}
        onBack={() => setLaunchedCreative(false)}
      />
    );
  }

  /* ---------------- setup screen ---------------- */
  if (phase === "setup" || !run || !cfg) {
    const isSocial = creaType === "social";
    const briefMax = 10000;
    const overBrief = brief.length >= briefMax;
    return (
      <>
      <div className="gd2">
        <div className="gdx-scroll">
          <div className="gdx-wrap">
            {/* hero */}
            <div className="gdx-hero">
              <span className="gdx-badge">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5c.5 4.6 4.4 8.5 9 9-4.6.9-8.5 4.4-9 9-.5-4.6-4.4-8.5-9-9 4.6-.9 8.5-4.4 9-9z" /></svg>
                AI-Powered Creative Studio
              </span>
              <h1 className="gdx-h1">
                Create branded content<br />
                that’s <span className="gdx-accent">unmistakably yours</span>
              </h1>
              <p className="gdx-sub">
                Describe your idea in simple words.<br className="gdx-subbr" />
                Our AI crafts the design, the copy, and the visuals — in seconds.
              </p>
            </div>

            {/* form + side card */}
            <div className="gdx-layout">
              <form
                className="gdx-card gdx-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (isSocial) start();
                  else if (!brandMissing) setLaunchedCreative(true);
                }}
              >
                <div className="gdx-field">
                  <label className="gdx-label" htmlFor="gd2brand">Brand</label>
                  <div className="gdx-control">
                    <span className="gdx-lead gdx-ic--violet" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="12" height="18" rx="1.5" /><path d="M16 8h4v13H4M8 7h2M12 7h.01M8 11h2M12 11h.01M8 15h2M12 15h.01" /></svg>
                    </span>
                    <select
                      id="gd2brand"
                      value={brandId}
                      aria-invalid={brandMissing || undefined}
                      aria-describedby={brandMissing ? "gd2brand-note" : undefined}
                      onFocus={refreshBrands}
                      onPointerDown={refreshBrands}
                      onChange={(e) => setBrandId(e.target.value)}
                    >
                      {/* A chosen brand that left the list stays shown as
                          chosen — never quietly drawn as the first row. */}
                      {brandMissing ? (
                        <option value={brandId} disabled>{missingBrandName} — no longer listed</option>
                      ) : null}
                      {brands.map((b) => (
                        <option key={b.brand_id} value={b.brand_id}>{b.name}</option>
                      ))}
                    </select>
                    <svg className="gdx-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </div>
                  {brandMissing ? (
                    <p id="gd2brand-note" className="gdx-brandnote" role="alert">
                      {missingBrandName} is no longer in the brand list — it may have been archived. Choose a brand to keep going.
                    </p>
                  ) : null}
                  {/* Brands are shared: anyone here may add one or change its kit.
                      A built-in pack has no "Edit kit" because a PATCH to it 409s. */}
                  <div className="gdx-kitrow">
                    <button
                      type="button"
                      className="gdx-attachbtn"
                      onClick={() => setKitSheet({ open: true, brandId: null })}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                      New brand
                    </button>
                    {brands.find((b) => b.brand_id === brandId)?.editable ? (
                      <button
                        type="button"
                        className="gdx-attachbtn"
                        onClick={() => setKitSheet({ open: true, brandId })}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16.5 3.5l4 4L8 20l-4.5 1L4.5 16.5 16.5 3.5z" /></svg>
                        Edit kit
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="gdx-field">
                  <div className={isSocial ? "gdx-row" : undefined}>
                    <div>
                      <label className="gdx-label" htmlFor="gd2type">Type of creative</label>
                      <div className="gdx-control">
                        <span className="gdx-lead gdx-ic--violet" aria-hidden="true">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M16.5 3.5l4 4L8 20l-4.5 1L4.5 16.5 16.5 3.5z" /><path d="M14 6l4 4" /></svg>
                        </span>
                        <select id="gd2type" value={creaType} onChange={(e) => setCreaType(e.target.value)}>
                          <option value="social">Social Post</option>
                          {creaTypes.map((t) => (
                            <option key={t.key} value={t.key}>{t.label}</option>
                          ))}
                        </select>
                        <svg className="gdx-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                      </div>
                    </div>
                    {isSocial ? (
                      <div>
                        <label className="gdx-label" htmlFor="gd2aspect">Aspect ratio</label>
                        <div className="gdx-control">
                          <span className="gdx-lead gdx-ic--blue" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><circle cx="9" cy="9.5" r="1.6" /><path d="M20 15l-4.5-4L6 20" /></svg>
                          </span>
                          <select id="gd2aspect" value={aspect} onChange={(e) => setAspect(e.target.value)}>
                            {cfg?.aspect_ratios.map((a) => (
                              <option key={a.ar} value={a.ar}>{a.label} · {a.dimensions}</option>
                            ))}
                          </select>
                          <svg className="gdx-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {isSocial ? (
                  <div className="gdx-field">
                    <label className="gdx-label" htmlFor="gd2brief">
                      What’s this about? <span className="gdx-opt">(optional)</span>
                    </label>
                    <div className="gdx-briefwrap">
                      <textarea
                        id="gd2brief"
                        rows={2}
                        maxLength={briefMax}
                        value={brief}
                        placeholder="e.g. Diwali offer — 20% off contract review for new clients"
                        onChange={(e) => setBrief(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                            e.preventDefault();
                            start();
                          }
                        }}
                      />
                      <span className={`gdx-counter${overBrief ? " gdx-counter--max" : brief.length >= briefMax - 150 ? " gdx-counter--warn" : ""}`}>
                        {brief.length} / {briefMax}
                      </span>
                    </div>
                    <div className="gdx-attach">
                      <input
                        ref={attachInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        multiple
                        hidden
                        onChange={(e) => onAttachFiles(e.target.files)}
                      />
                      <button
                        type="button"
                        className="gdx-attachbtn"
                        disabled={attached.length >= MAX_PROMPT_IMAGES}
                        onClick={() => attachInput.current?.click()}
                        title="Attach up to 3 images — the studio works them into the design as your brief directs"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                        Attach images <span className="gdx-opt">(optional, up to {MAX_PROMPT_IMAGES})</span>
                      </button>
                      {attached.length > 0 ? (
                        <div className="gdx-attachrow">
                          {attached.map((a, i) => (
                            <span key={a.url} className="gdx-attachchip" title={a.file.name}>
                              <img src={a.url} alt="" />
                              <span className="gdx-attachname">{a.file.name}</span>
                              <button type="button" aria-label={`Remove ${a.file.name}`} onClick={() => removeAttached(i)}>×</button>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {isSocial ? (
                  <label className="gdx-auto" title="The studio plans all four steps from your brief; you review before anything runs">
                    <input type="checkbox" checked={autoMode} onChange={(e) => setAutoMode(e.target.checked)} />
                    <span className="gdx-auto-txt"><b>✦ Auto mode</b> — plan the whole creative from my brief</span>
                  </label>
                ) : null}

                {isSocial ? (
                  <button className="gdx-generate" type="submit" disabled={busy !== null || !cfg || brandMissing}>
                    {busy ? (
                      <><span className="gdx-spin" aria-hidden="true" />{busy}</>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5c.5 4.6 4.4 8.5 9 9-4.6.9-8.5 4.4-9 9-.5-4.6-4.4-8.5-9-9 4.6-.9 8.5-4.4 9-9z" /></svg>
                        Generate Design
                        <svg className="gdx-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" /></svg>
                      </>
                    )}
                  </button>
                ) : (
                  <button className="gdx-generate" type="submit" disabled={brandMissing}>
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5c.5 4.6 4.4 8.5 9 9-4.6.9-8.5 4.4-9 9-.5-4.6-4.4-8.5-9-9 4.6-.9 8.5-4.4 9-9z" /></svg>
                    Open the Creative Agent
                    <svg className="gdx-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" /></svg>
                  </button>
                )}

                {isSocial ? (
                  <p className="gdx-hint"><kbd>Ctrl + Enter</kbd> to generate instantly</p>
                ) : null}
                <p className="gdx-hint" style={{ opacity: 0.45 }} title="Which frontend build this browser is running">
                  build {STUDIO_BUILD}
                </p>
              </form>

              {/* side card */}
              <aside className="gdx-card gdx-side" aria-label="What the AI will generate">
                <p className="gdx-side-title">AI will generate</p>
                <div className="gdx-promise">
                  <span className="gdx-ic gdx-ic--violet" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
                  </span>
                  <b>Eye-catching<br />Layout</b>
                </div>
                <div className="gdx-promise">
                  <span className="gdx-ic gdx-ic--blue" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5V4.5h16v2M12 4.5v15M8.5 19.5h7" /></svg>
                  </span>
                  <b>Engaging<br />Copy</b>
                </div>
                <div className="gdx-promise">
                  <span className="gdx-ic gdx-ic--green" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.7" /><path d="M20 16l-5-4.5L5.5 19.5" /></svg>
                  </span>
                  <b>Stunning<br />Images</b>
                </div>
                <div className="gdx-promise">
                  <span className="gdx-ic gdx-ic--peach" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.4-1.3-1.5-1.3-3 0-1 .8-1.5 2-1.5H17a4 4 0 0 0 4-4c0-4.4-4-7.5-9-7.5z" /><circle cx="7.5" cy="11.5" r="1" /><circle cx="10" cy="7.5" r="1" /><circle cx="15" cy="7.5" r="1" /></svg>
                  </span>
                  <b>On-brand<br />Colors</b>
                </div>
                <div className="gdx-side-div" />
                <div className="gdx-side-foot">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2.5l7.5 3v5.5c0 5-3.4 8.6-7.5 10-4.1-1.4-7.5-5-7.5-10V5.5L12 2.5z" /><path d="M9 12l2 2 4-4.5" /></svg>
                  100% on-brand. Always.
                </div>
              </aside>
            </div>

            {onBack ? (
              <div className="gdx-subnav">
                <button type="button" onClick={onBack}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3.5h4a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-4M9 8l4 4-4 4M13 12H3" /></svg>
                  Exit to console
                </button>
              </div>
            ) : null}

            {/* trust strip */}
            <div className="gdx-features">
              <div className="gdx-feature">
                <span className="gdx-ic gdx-ic--violet" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.5l7.5 3v5.5c0 5-3.4 8.6-7.5 10-4.1-1.4-7.5-5-7.5-10V5.5L12 2.5z" /></svg>
                </span>
                <div><h4>Your brand, always</h4><p>Consistent fonts, colors and messaging</p></div>
              </div>
              <div className="gdx-feature">
                <span className="gdx-ic gdx-ic--peach" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z" /></svg>
                </span>
                <div><h4>Blazing fast</h4><p>From idea to finished in under 30 seconds</p></div>
              </div>
              <div className="gdx-feature">
                <span className="gdx-ic gdx-ic--green" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /><circle cx="12" cy="15.5" r="1.4" /></svg>
                </span>
                <div><h4>Secure &amp; private</h4><p>Your data is encrypted and never shared</p></div>
              </div>
              <div className="gdx-feature">
                <span className="gdx-ic gdx-ic--peach" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9.5" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></svg>
                </span>
                <div><h4>Loved by creators</h4><p>Trusted by 10,000+ brands worldwide</p></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Outside `.gd2` on purpose: the sheet is the console's dialog, drawn
          with the console's controls, and `.gd2`'s own button/input resets
          would restyle it. */}
      <BrandKitSheet
        open={kitSheet.open}
        brandId={kitSheet.brandId}
        viewer={user ?? {}}
        onToast={onToast}
        onClose={() => setKitSheet((s) => ({ ...s, open: false }))}
        onSaved={(b) => {
          // The save reply is proof the brand exists: hold it in the picker
          // and keep it chosen, even when the refetch below lands on an
          // instance whose list cache predates it.
          const row = brandSummaryOf(b);
          brandSightings.current = noteBrand(brandSightings.current, row, Date.now());
          setBrands((list) => placeBrand(list, row));
          setBrandNames((n) => ({ ...n, [row.brand_id]: row.name }));
          setBrandId(row.brand_id);
          setKitRev((r) => r + 1);
        }}
        onArchived={(archivedId) => {
          brandSightings.current = forgetBrand(brandSightings.current, archivedId);
          setBrands((list) => list.filter((b) => b.brand_id !== archivedId));
          if (brandId === archivedId) setBrandId("");
          setKitRev((r) => r + 1);
        }}
      />
      </>
    );
  }

  /* ---------------- studio ---------------- */
  const arInfo = cfg.aspect_ratios.find((a) => a.ar === run.config.aspect_ratio);
  // With a style set on screen, the exact preview follows the SELECTED style.
  const selectedStyle = styleSet?.find((a) => a.attempt === styleSel) ?? null;
  const canvasPath = (cur === 3 && selectedStyle?.url) || previewPath(run, cur);
  const curStage = run.stages[String(Math.min(cur, 4))];
  const hasAttempt = !!curStage && curStage.attempts.length > 0;
  const done = cur >= 5;
  const hue = done ? "#0E9A89" : STEPS[cur - 1].hue;

  const remixControls = () => {
    const last = curStage?.attempts[curStage.attempts.length - 1];
    return (
      <>
        <label className="gd2-remixtog" title="Rewrites the preset's prompt a little differently on every Generate">
          <input
            type="checkbox"
            checked={run.config.remix_enabled ?? false}
            onChange={(e) => patch({ remix_enabled: e.target.checked })}
          />
          Variety remix — every Generate comes out a little different
        </label>
        {last?.remix ? (
          <p className="gd2-note">
            {last.remix.ai
              ? `✦ Remixed for variety — axis: ${last.remix.axis}`
              : (last.remix.fallback_reason ?? "Deterministic variation applied (AI remix unavailable).")}
          </p>
        ) : null}
      </>
    );
  };

  const stepPanel = () => {
    if (done) {
      const recap: [string, string][] = [
        ["#D9930F", `Background · ${run.stages["1"]?.approved?.variant ?? "—"}`],
        ["#E85C4A", `Main image · ${run.stages["2"]?.approved?.variant ?? "—"}`],
        ["#6D4DF2", `Words · ${run.config.text_placement ?? "auto"}`],
        ["#0E9A89", `Logo · ${run.config.logo_layout?.position ?? "auto"}`],
      ];
      return (
        <>
          <span className="gd2-step-eyebrow">All four layers approved</span>
          <h2 className="gd2-donetitle">Ready to ship.</h2>
          <p className="gd2-help">On-brand from background to logo. Download it, or click an earlier step above to keep tweaking.</p>
          <ul className="gd2-recap">
            {recap.map(([h, label]) => (
              <li key={label}>
                <span className="gd2-check" style={{ ["--hue" as never]: h } as React.CSSProperties}>✓</span>
                {label}
              </li>
            ))}
          </ul>
          <div className="gd2-tweakcard">
            <span className="gd2-step-eyebrow">Step 5 · Final tweak (optional)</span>
            {tweakPreview ? (
              <>
                <AuthImg path={tweakPreview.url} alt="Tweaked final" />
                <p className="gd2-note">
                  “{tweakPreview.tweak_instruction}”
                  {tweakPreview.qa === "skipped" ? " · QA check unavailable" : ""}
                </p>
                <div className="gd2-actionrow">
                  <button className="gd2-btn" onClick={keepTweak} disabled={busy !== null}>
                    Keep it ✓
                  </button>
                  <button
                    className="gd2-btn gd2-btn--soft"
                    onClick={() => setTweakPreview(null)}
                    disabled={busy !== null}
                  >
                    Discard
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  className="gd2-polishnotes"
                  placeholder="Describe a small change — e.g. soften the shadow, make the plant smaller…"
                  maxLength={500}
                  value={tweakText}
                  onChange={(e) => setTweakText(e.target.value)}
                />
                <button
                  className="gd2-btn gd2-btn--soft"
                  onClick={applyTweak}
                  disabled={busy !== null || tweakText.trim().length < 3}
                >
                  ✨ Apply tweak
                </button>
                <p className="gd2-note">
                  Fonts, logo and the colour gradient are protected — the agent refuses any
                  result that touches them.
                </p>
              </>
            )}
          </div>
          <div className="gd2-actionrow" style={{ gridTemplateColumns: "1fr" }}>
            <button className="gd2-btn" onClick={download}>Download PNG ↓</button>
            <button className="gd2-btn gd2-btn--soft" onClick={resetAll}>Make another</button>
          </div>
          <p className="gd2-note">The classic Studio stays available any time from the button up top.</p>
        </>
      );
    }

    if (cur === 1) {
      const custom = run.config.custom_gradient;
      return (
        <>
          <span className="gd2-step-eyebrow">Step 1 of 4</span>
          <h2 className="gd2-paneltitle">Pick a background</h2>
          <p className="gd2-help">Start from a brand preset — or ask the studio to dream up a gradient nobody’s used yet. Either way it can’t leave your palette.</p>
          <div>
            <p className="gd2-lbl">From your brand kit</p>
            <div className="gd2-grid2">
              {run.config.background_asset_ref ? (
                <button
                  className={`gd2-tile ${sel1 === "UPLOAD" ? "gd2-tile--on" : ""}`}
                  onClick={() => setSel1("UPLOAD")}
                >
                  <span className="gd2-tileart gd2-tileart--img">
                    <AuthImg
                      path={`/api/gd/runs/${run.id}/artifact/${encodeURI(run.config.background_asset_ref)}`}
                      alt="Your photo"
                    />
                  </span>
                  <span className="gd2-tilelabel">Your photo — used as-is as the background</span>
                </button>
              ) : null}
              {cfg.stage1_variants.map((v) => (
                <button
                  key={v.id}
                  className={`gd2-tile ${sel1 === v.id ? "gd2-tile--on" : ""}`}
                  onClick={() => setSel1(v.id)}
                >
                  <span className="gd2-tileart" style={{ background: v.css_gradient || "#142A5C" }} />
                  <span className="gd2-tiletxt"><b>{v.title}</b></span>
                  <span className="gd2-tiledesc">{v.desc}</span>
                </button>
              ))}
              {custom ? (
                <button
                  className={`gd2-tile ${sel1 === "AI" ? "gd2-tile--on" : ""}`}
                  onClick={() => setSel1("AI")}
                >
                  <span className="gd2-tileart" style={{ background: custom.css_gradient }}>
                    <span className="gd2-aichip">{custom.cid === "llm" ? "✦ AI" : "Preset"}</span>
                  </span>
                  <span className="gd2-tiletxt"><b>{custom.title}</b></span>
                  <span className="gd2-tiledesc">{custom.desc}</span>
                </button>
              ) : null}
            </div>
          </div>
          <div>
            <p className="gd2-lbl">✦ Dream up something new</p>
            <input
              type="text"
              value={aiSteer}
              placeholder="Describe it — e.g. diagonal aurora waves, soft grain"
              onChange={(e) => setAiSteer(e.target.value)}
            />
            <button className="gd2-btn gd2-btn--ai" style={{ width: "100%", marginTop: 8 }} onClick={dreamGradient} disabled={busy !== null}>
              ✦ {custom ? "Dream up another" : "Generate AI gradient"}
            </button>
          </div>
          {remixControls()}
        </>
      );
    }

    if (cur === 2) {
      return (
        <>
          <span className="gd2-step-eyebrow">Step 2 of 4</span>
          <h2 className="gd2-paneltitle">Choose your main image</h2>
          <p className="gd2-help">Pick the concept that fits your message, and where it should sit. Words and logo go on top next.</p>
          <div>
            <p className="gd2-lbl">Concepts</p>
            <div className="gd2-grid2">
              {run.config.subject_asset_ref ? (
                <button
                  className={`gd2-tile ${sel2 === "UPLOAD" ? "gd2-tile--on" : ""}`}
                  onClick={() => setSel2("UPLOAD")}
                >
                  <span className="gd2-tileart gd2-tileart--img">
                    <AuthImg
                      path={`/api/gd/runs/${run.id}/artifact/${encodeURI(run.config.subject_asset_ref)}`}
                      alt="Your upload"
                    />
                  </span>
                  <span className="gd2-tilelabel">Your upload — placed as-is, no AI drawing</span>
                </button>
              ) : null}
              {cfg.stage2_variants.map((v) => (
                <button
                  key={v.id}
                  className={`gd2-tile ${sel2 === v.id ? "gd2-tile--on" : ""}`}
                  onClick={() => setSel2(v.id)}
                >
                  <span className="gd2-tiletxt"><b>{v.title}</b></span>
                  <span className="gd2-tiledesc">{v.desc}</span>
                </button>
              ))}
            </div>
          </div>
          {cfg.stage2_placements.length ? (
            <div>
              <p className="gd2-lbl">Position</p>
              <div className="gd2-posgrid" style={{ ["--hue" as never]: "#E85C4A" } as React.CSSProperties}>
                {cfg.stage2_placements
                  .filter((p) => p.row >= 0)
                  .map((p) => (
                    <button
                      key={p.key}
                      title={p.label}
                      className={run.config.element_placement === p.key ? "on" : ""}
                      onClick={() => patch({ element_placement: p.key })}
                    />
                  ))}
              </div>
            </div>
          ) : null}
          {remixControls()}
        </>
      );
    }

    if (cur === 3) {
      const fields: [string, string][] = [
        ["headline", "Headline"],
        ["highlight", "Highlight word"],
        ["cta", "Button text"],
      ];
      return (
        <>
          <span className="gd2-step-eyebrow">Step 3 of 4</span>
          <h2 className="gd2-paneltitle">Say it in your words</h2>
          <p className="gd2-help">
            Type your lines here; style the selected line with the toolbar above the canvas —
            brand fonts only, so it always looks like you. The canvas preview updates live.
          </p>
          {fields.map(([key, label]) => (
            <div className="gd2-tokfld" key={key}>
              <span>{label}</span>
              <input
                type="text"
                value={tok[key] ?? ""}
                onFocus={() => setActiveLine(key)}
                onChange={(e) => setTok((t) => ({ ...t, [key]: e.target.value }))}
                onBlur={() => patch({ tokens: { ...run.config.tokens, ...tok } })}
              />
            </div>
          ))}
          {subheadings.map((s, i) => (
            <div className="gd2-tokfld" key={`sub-${i}-${subheadings.length}`}>
              <span>
                Text {i + 1}
                {subheadings.length > 1 ? (
                  <button className="gd2-subdel" title="Remove this text box" onClick={() => removeTextBox(i)}>×</button>
                ) : null}
              </span>
              <input
                type="text"
                defaultValue={s.text}
                maxLength={120}
                onFocus={() => setActiveLine(`sub-${i}`)}
                onBlur={(e) => {
                  if (e.target.value !== s.text) setSubText(i, e.target.value);
                }}
              />
            </div>
          ))}
          <div>
            <p className="gd2-lbl">Arrangement</p>
            <div className="gd2-seg">
              {cfg.text_placements.map((p) => (
                <button
                  key={p.key}
                  className={run.config.text_placement === p.key ? "on" : ""}
                  onClick={() => patch({ text_placement: p.key })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </>
      );
    }

    // stage 4
    return (
      <>
        <span className="gd2-step-eyebrow">Step 4 of 4</span>
        <h2 className="gd2-paneltitle">Place your logo</h2>
        <p className="gd2-help">Drag the logo on the design, resize from its corners — or use the sliders for a pixel-perfect nudge. Real logo files, never redrawn by AI.</p>
        {logos.length ? (
          <div>
            <p className="gd2-lbl">From your brand library</p>
            <div className="gd2-grid2">
              {logos.map((l) => (
                <button
                  key={l.id}
                  className={`gd2-tile ${logoId === l.id ? "gd2-tile--on" : ""}`}
                  onClick={() => {
                    setLogoId(l.id);
                    setExactPreview(false);
                  }}
                >
                  <span className="gd2-logotile-art">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={l.thumb} alt={l.name} />
                  </span>
                  <span className="gd2-tilelabel">{l.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="gd2-help">Loading your logo library…</p>
        )}
        <div>
          <p className="gd2-lbl">Position</p>
          <div className="gd2-posgrid" style={{ ["--hue" as never]: "#0E9A89" } as React.CSSProperties}>
            {cfg.logo_positions.map((p) => (
              <button
                key={p.key}
                title={p.label}
                className={(run.config.logo_layout?.position ?? "top-left") === p.key ? "on" : ""}
                onClick={() => {
                  // A new corner resets the manual nudge — least surprising.
                  patch({ logo_layout: { position: p.key, offset_x: 0, offset_y: 0 } });
                  setExactPreview(false);
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <p className="gd2-lbl">Size &amp; position — fine-tune</p>
          <div className="gd2-finegrid">
            <label>
              <span>Size (% of width) — blank = Auto</span>
              <input
                className="gd2-tt-num"
                type="number"
                min={cfg.logo_size_pct_min}
                max={cfg.logo_size_pct_max}
                step={0.5}
                placeholder="Auto"
                value={run.config.logo_layout?.size_pct ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  const v = raw === "" ? null : Math.min(cfg.logo_size_pct_max, Math.max(cfg.logo_size_pct_min, parseFloat(raw)));
                  if (raw !== "" && !Number.isFinite(v)) return;
                  patch({ logo_layout: { size_pct: v } });
                  setExactPreview(false);
                }}
              />
            </label>
            <label>
              <span>X nudge · {run.config.logo_layout?.offset_x ?? 0}px</span>
              <input
                type="range"
                min={-cfg.logo_offset_px_range}
                max={cfg.logo_offset_px_range}
                value={run.config.logo_layout?.offset_x ?? 0}
                onChange={(e) => {
                  patch({ logo_layout: { offset_x: Number(e.target.value) } });
                  setExactPreview(false);
                }}
              />
            </label>
            <label>
              <span>Y nudge · {run.config.logo_layout?.offset_y ?? 0}px</span>
              <input
                type="range"
                min={-cfg.logo_offset_px_range}
                max={cfg.logo_offset_px_range}
                value={run.config.logo_layout?.offset_y ?? 0}
                onChange={(e) => {
                  patch({ logo_layout: { offset_y: Number(e.target.value) } });
                  setExactPreview(false);
                }}
              />
            </label>
          </div>
        </div>
        {run.stages["4"]?.attempts.length ? (
          <button className="gd2-btn gd2-btn--soft" onClick={() => setExactPreview((v) => !v)}>
            {exactPreview ? "✎ Adjust placement" : "👁 View composite"}
          </button>
        ) : null}
      </>
    );
  };

  return (
    <div className="gd2">
      {/* top bar */}
      <header className="gd2-top">
        {onBack ? (
          <button className="gd2-ghost" onClick={onBack}>← Console</button>
        ) : null}
        <span className="gd2-brand">
          <span className="gd2-brandmark">{(cfg.brand_name || "B").slice(0, 1)}</span>
          {cfg.brand_name}
        </span>
        <div className="gd2-chips">
          {STEPS.map((s) => {
            const isDone = !!run.stages[String(s.n)]?.approved;
            const isNow = cur === s.n;
            const locked = s.n > cur;
            return (
              <button
                key={s.n}
                disabled={locked}
                onClick={() => gotoStage(s.n)}
                className={`gd2-chip ${isNow ? "gd2-chip--now" : locked ? "gd2-chip--todo" : "gd2-chip--done"}`}
                style={{ ["--hue" as never]: s.hue } as React.CSSProperties}
              >
                {isDone && !isNow ? <span className="gd2-check">✓</span> : <span className="gd2-dot" style={{ background: isNow ? s.hue : "#97a3b0" }} />}
                <span>{s.n}. {s.name}</span>
              </button>
            );
          })}
        </div>
        <div className="gd2-topright">
          <button
            className="gd2-ghost"
            onClick={() => {
              if (window.confirm("Start this design over from step 1?")) resetAll();
            }}
          >
            Start over
          </button>
          {done ? (
            <button className="gd2-btn" onClick={download}>Download ↓</button>
          ) : null}
        </div>
      </header>

      <div className="gd2-body">
        {/* left rail — assistant chat + brand kit */}
        <aside className="gd2-rail">
          <div className="gd2-chatcard">
            <p className="gd2-chattitle"><span>✦</span> Studio assistant</p>
            <div className="gd2-chatlog">
              {chat.map((m, i) => (
                <div key={i} className={`gd2-msg gd2-msg--${m.role === "agent" ? "agent" : "user"}`}>
                  {m.text}
                </div>
              ))}
            </div>
            <div className="gd2-chatin">
              <input
                type="text"
                value={chatInput}
                placeholder="Ask anything…"
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendChat();
                }}
              />
              <button onClick={sendChat} aria-label="Send">➤</button>
            </div>
          </div>
          <label
            className="gd2-upload gd2-upload--live"
            title={cur === 1 ? "Use your own photo as the background" : "Use your own photo as the main image"}
          >
            ⬆ {cur === 1 ? "Upload a background photo" : run.config.subject_asset_ref ? "Replace your photo" : "Upload your own photo"}
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg"
              hidden
              onChange={onUpload}
              disabled={busy !== null}
            />
          </label>
          {run.config.background_asset_ref ? (
            <div className="gd2-uploadprev">
              <AuthImg
                path={`/api/gd/runs/${run.id}/artifact/${encodeURI(run.config.background_asset_ref)}`}
                alt="Your background photo"
              />
              <div className="gd2-uploadprev-body">
                <b>Background photo ✓</b>
                <span>{cur === 1 ? "Select “Your photo” and Generate — or it’s already on the canvas." : "Used in Step 1."}</span>
                {cur > 1 ? (
                  <button className="gd2-uploadprev-go" onClick={() => gotoStage(1)}>
                    ← Back to Step 1
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {run.config.subject_asset_ref ? (
            <div className="gd2-uploadprev">
              <AuthImg
                path={`/api/gd/runs/${run.id}/artifact/${encodeURI(run.config.subject_asset_ref)}`}
                alt="Your subject photo"
              />
              <div className="gd2-uploadprev-body">
                <b>Subject photo ✓</b>
                <span>
                  {cur === 2
                    ? "It’s on your design →"
                    : cur < 2
                      ? "Approve the background first — then it drops into Step 2."
                      : "Placed as your main image."}
                </span>
                {cur > 2 ? (
                  <button className="gd2-uploadprev-go" onClick={() => gotoStage(2)}>
                    ← Back to Step 2
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="gd2-kitcard">
            <b>Brand kit — {cfg.brand_name}</b>
            <p>Colors, fonts and the logo are locked to brand — nothing goes off-brand here.</p>
          </div>
        </aside>

        {/* center stage */}
        <section className="gd2-stage">
          {cur === 3 ? (() => {
            const st = lineStyle();
            const L = lineRef();
            const meta = L.kind === "el" ? cfg.stage3_elements.find((e) => e.key === L.key) : null;
            const canColor = L.kind === "sub" || !!meta?.colorable;
            const canSize = L.kind === "sub" || !!meta?.sizable;
            const canPlace = L.kind === "sub" || !!meta?.placeable;
            const fontName = st.font ?? run.config.font;
            const fv = cfg.font_variants.find((v) => v.name === fontName);
            const isBold = (fv?.weight ?? 400) >= 600;
            const isItal = isItalicStyle(fv?.style);
            const boldTarget = variantFor(!isBold, isItal);
            const italTarget = variantFor(isBold, !isItal);
            const sizeState =
              st.size_pct === cfg.text_size_pct_min ? "S" : st.size_pct === cfg.text_size_pct_max ? "L" : "M";
            const hex = typeof st.color === "string" && st.color.startsWith("#") ? st.color : "#FFFFFF";
            return (
              <div className="gd2-tt">
                <div className="gd2-tt-row gd2-tt-row--top">
                  <div className="gd2-tt-tabs">
                    {cfg.stage3_elements.map((e) => (
                      <button key={e.key} className={activeLine === e.key ? "on" : ""} onClick={() => setActiveLine(e.key)}>
                        {e.label}
                      </button>
                    ))}
                    {subheadings.map((_, i) => (
                      <button key={`sub-${i}`} className={activeLine === `sub-${i}` ? "on" : ""} onClick={() => setActiveLine(`sub-${i}`)}>
                        Text {i + 1}
                      </button>
                    ))}
                    <button
                      className="gd2-tt-add"
                      onClick={addTextBox}
                      disabled={subheadings.length >= 5}
                      title={subheadings.length >= 5 ? "Up to 5 extra text boxes" : "Add another text box"}
                    >
                      + Text box
                    </button>
                  </div>
                  <div className="gd2-tt-actions">
                    <div className="gd2-tt-emojis" title="Tap to drop an emoji on the design">
                      {emojiQuick.map((c) => (
                        <button key={c} className="gd2-emoji" title={`Add ${c} to the design`} onClick={() => addEmoji(c)}>
                          {c}
                        </button>
                      ))}
                    </div>
                    {(run.config.elements ?? []).map((e2) => (
                      <span key={e2.id} className="gd2-elchip">
                        {e2.kind === "emoji" ? e2.ref : e2.kind}
                        <button onClick={() => removeElement(e2.id)} title="Remove">×</button>
                      </span>
                    ))}
                    <span className="gd2-tt-sep" />
                    <button
                      className={`gd2-tt-btn ${exactPreview ? "gd2-tt-btn--on" : ""}`}
                      title={exactPreview ? "Back to drag-and-edit mode" : "Preview the final pixel-perfect render"}
                      onClick={() => {
                        // Pin everything first so the exact render matches the
                        // edit canvas 1:1 (no zone-stack surprises).
                        if (!exactPreview) patch({ layout: pinAllLayout() });
                        setExactPreview((v) => !v);
                      }}
                    >
                      {exactPreview ? "✎ Edit mode" : "👁 Preview"}
                    </button>
                    <button
                      className="gd2-tt-btn gd2-tt-ai"
                      title="Let AI arrange the text on the image"
                      onClick={aiPlacement}
                      disabled={busy !== null}
                    >
                      ✦ AI placement
                    </button>
                  </div>
                </div>
                <div className="gd2-tt-row gd2-tt-row--tools">
                  <select
                    className="gd2-tt-select"
                    title="Brand fonts only"
                    value={fontName}
                    onChange={(e) => setLineField("font", e.target.value)}
                  >
                    <option value="auto">Auto — agent picks</option>
                    {cfg.fonts.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                  {canSize ? (
                    <>
                      <div className="gd2-seg gd2-seg--tt">
                        {(["S", "M", "L"] as const).map((sz) => (
                          <button
                            key={sz}
                            className={sizeState === sz ? "on" : ""}
                            onClick={() =>
                              setLineField(
                                "size_pct",
                                sz === "S" ? cfg.text_size_pct_min
                                  : sz === "L" ? cfg.text_size_pct_max
                                  : L.kind === "sub" ? null
                                  : cfg.default_text_size_pct[L.kind === "el" ? L.key : ""] ?? cfg.text_size_pct_min,
                              )
                            }
                          >
                            {sz}
                          </button>
                        ))}
                      </div>
                      <input
                        className="gd2-tt-num"
                        type="number"
                        title="Font size (% of canvas height)"
                        min={cfg.text_size_pct_min}
                        max={cfg.text_size_pct_max}
                        step={0.5}
                        value={st.size_pct ?? cfg.default_text_size_pct[L.kind === "el" ? L.key : "subheading"] ?? ""}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isFinite(v)) return;
                          setLineField("size_pct", Math.min(cfg.text_size_pct_max, Math.max(cfg.text_size_pct_min, v)));
                        }}
                      />
                    </>
                  ) : null}
                  <button
                    className={`gd2-tog ${isBold ? "on" : ""}`}
                    title={boldTarget ? "Bold" : "No bold cut in this brand family"}
                    disabled={!boldTarget}
                    onClick={() => boldTarget && setLineField("font", boldTarget)}
                  >
                    <b>B</b>
                  </button>
                  <button
                    className={`gd2-tog ${isItal ? "on" : ""}`}
                    title={italTarget ? "Italic" : "No italic cut in this brand family"}
                    disabled={!italTarget}
                    onClick={() => italTarget && setLineField("font", italTarget)}
                  >
                    <i>I</i>
                  </button>
                  {canPlace ? (
                    <>
                      <span className="gd2-tt-sep" />
                      <div className="gd2-seg gd2-seg--tt gd2-seg--place" title="Where this text sits on the image">
                        {cfg.text_placements.map((p) => (
                          <button
                            key={p.key}
                            title={`Place on the ${p.label.toLowerCase()}`}
                            className={st.placement === p.key ? "on" : ""}
                            onClick={() => setLineField("placement", p.key)}
                          >
                            {PLACEMENT_ICON[p.key] ?? p.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {activeLine === "headline" || activeLine.startsWith("sub-") ? (
                    <div className="gd2-seg gd2-seg--tt">
                      {([["left", "⇤"], ["center", "≡"], ["right", "⇥"]] as const).map(([a, icon]) => (
                        <button
                          key={a}
                          title={`Align text ${a}`}
                          className={((st as { align?: string }).align ?? "left") === a ? "on" : ""}
                          onClick={() => setLineField("align", a)}
                        >
                          {icon}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {canColor ? (
                    <>
                      <span className="gd2-tt-sep" />
                      <div className="gd2-swatches gd2-swatches--tt">
                        {cfg.text_colors.map((c) => (
                          <button
                            key={c.key}
                            title={c.label}
                            className={`gd2-swatch ${st.color === c.key ? "on" : ""}`}
                            style={{ background: c.swatch }}
                            onClick={() => setLineField("color", c.key)}
                          />
                        ))}
                        <label className="gd2-swatch gd2-swatch--custom" title="Pick a custom color">
                          <input type="color" value={hex} onChange={(e) => setLineField("color", e.target.value.toUpperCase())} />
                        </label>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })() : null}
          <div
            className="gd2-canvasbox"
            style={{
              aspectRatio: arInfo ? `${arInfo.w} / ${arInfo.h}` : "1 / 1",
              ...(arInfo && arInfo.h >= arInfo.w ? { height: "100%", maxWidth: "100%" } : { width: "min(100%, 860px)" }),
            }}
          >
            {cur === 3 ? (() => {
              // Direct manipulation: the REAL text lines are Konva nodes over
              // the approved Stage-2 image — instant 60fps drag, dblclick to
              // edit in place. "Exact render" flips to the engine's output.
              const lay = run.config.layout ?? {};
              const es = run.config.element_styles ?? {};
              const tokens = { ...run.config.tokens, ...tok };
              // Per-variant family: each brand cut is registered under its own
              // name via FontFace, so picking a font visibly changes the face.
              const famFor = (fontName?: string) => {
                // "auto" = the agent picks at generate time — edit canvas shows
                // the run's base font as the stand-in.
                const name = fontName && fontName !== "auto" ? fontName : run.config.font;
                return `"${name}", "${cfg.font_family}", Inter, sans-serif`;
              };
              const faceLoaded = (fontName?: string) => {
                try {
                  return document.fonts.check(`12px "${fontName ?? run.config.font}"`);
                } catch {
                  return false;
                }
              };
              // If the true cut is loaded, don't synthesize bold/italic on top.
              const styleFor = (fontName?: string) => (faceLoaded(fontName) ? "normal" : styleOf(fontName));
              const gradStops = (c?: string): [string, string] | undefined => {
                if (c !== "gradient") return undefined;
                const sw = cfg.text_colors.find((tc) => tc.key === "gradient")?.swatch ?? "";
                const hexes = sw.match(/#[0-9a-fA-F]{6}/g);
                return hexes && hexes.length >= 2 ? [hexes[0], hexes[1]] : ["#E8B45A", "#C8912F"];
              };
              // Canvas fills must be flat colors. Brand tokens whose swatch is a
              // CSS gradient (e.g. the "gradient" key) get a solid stand-in here;
              // the Exact render shows the true gradient from the engine.
              const colorOf = (c?: string, fallback = "#F4F7FF") => {
                if (!c) return fallback;
                if (c.startsWith("#") || c.startsWith("rgb")) return c;
                const sw = cfg.text_colors.find((tc) => tc.key === c)?.swatch ?? "";
                if (sw.startsWith("#") || sw.startsWith("rgb")) return sw;
                if (c === "gradient" || sw.includes("gradient")) return "#E8B45A";
                return fallback;
              };
              const isLight = (hex: string) => {
                const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
                if (!m) return false;
                const n = parseInt(m[1], 16);
                return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
              };
              const styleOf = (fontName?: string) => {
                const fv = cfg.font_variants.find((v) => v.name === (fontName ?? run.config.font));
                const b = (fv?.weight ?? 400) >= 600;
                const i = (fv?.style || "normal") === "italic";
                return b && i ? "bold italic" : b ? "bold" : i ? "italic" : "normal";
              };
              const sizeOf = (key: string, pct?: number, fallback = 5) =>
                (pct ?? cfg.default_text_size_pct[key] ?? fallback) / 100;

              const texts: TextNodeSpec[] = [];
              const pos = (id: string, place?: string, i = 0) => lay[id] ?? defaultPos(id, place, i);
              if ((tokens.headline ?? "").trim())
                texts.push({
                  id: "headline", text: tokens.headline, ...pos("headline", es.headline?.placement),
                  maxW: lay.headline?.w ?? DEFAULT_LAYOUT_W,
                  fontSize: sizeOf("headline", es.headline?.size_pct, 6.5),
                  fontFamily: famFor(es.headline?.font),
                  fontStyle: faceLoaded(es.headline?.font) ? "normal" : "bold",
                  fill: colorOf(es.headline?.color),
                  align: (es.headline?.align as TextNodeSpec["align"]) ?? "left",
                  gradient: gradStops(es.headline?.color),
                  lineFactor: 1.15,
                });
              subheadings.forEach((s, i) => {
                if (!(s.text ?? "").trim()) return;
                const id = `subheading-${i}`;
                texts.push({
                  id, text: s.text, ...pos(id, s.placement, i),
                  maxW: lay[id]?.w ?? DEFAULT_LAYOUT_W,
                  fontSize: sizeOf("subheading", s.size_pct, 3.4),
                  fontFamily: famFor(s.font), fontStyle: styleFor(s.font),
                  fill: colorOf(s.color),
                  align: (s.align as TextNodeSpec["align"]) ?? "left",
                  gradient: gradStops(s.color),
                  lineFactor: 1.4,
                });
              });
              if ((tokens.cta ?? "").trim()) {
                const pillBg = colorOf(es.cta?.color, "#D9A441");
                texts.push({
                  id: "cta", text: tokens.cta, ...pos("cta", es.cta?.placement),
                  maxW: lay.cta?.w ?? DEFAULT_LAYOUT_W,
                  fontSize: sizeOf("cta", es.cta?.size_pct, 3),
                  fontFamily: famFor(es.cta?.font),
                  fontStyle: faceLoaded(es.cta?.font) ? "normal" : "bold",
                  fill: isLight(pillBg) ? "#1D2A50" : "#FFFFFF",
                  pill: true, pillFill: pillBg,
                });
              }
              (["venue", "website"] as const).forEach((fid) => {
                if ((tokens[fid] ?? "").trim())
                  texts.push({
                    id: fid, text: tokens[fid], ...(lay[fid] ?? (fid === "venue" ? { x: 0.06, y: 0.965 } : { x: 0.94, y: 0.965 })),
                    maxW: lay[fid]?.w ?? 0.4,
                    fontSize: sizeOf(fid, undefined, 2.2),
                    fontFamily: famFor(undefined), fontStyle: styleFor(undefined),
                    fill: colorOf(undefined),
                  });
              });

              const shapeMarkers: DragMarker[] = (run.config.shapes ?? []).map((sp) => ({
                id: sp.id, label: sp.kind === "icon" ? (sp.icon ?? "icon") : sp.kind,
                x: sp.x, y: sp.y, w: sp.w, h: sp.h,
              }));

              const moveAnything = (id: string, x: number, y: number) => {
                if (id.startsWith("shape-")) {
                  patch({ shapes: (run.config.shapes ?? []).map((s) => (s.id === id ? { ...s, x, y, anchor: "mc" } : s)) });
                } else {
                  const prev = lay[id];
                  patch({ layout: { [id]: { x, y, w: prev?.w ?? DEFAULT_LAYOUT_W, anchor: "mc" } } });
                }
              };

              // Canva-style resize: side handles reflow the box, corners scale
              // the font. One combined patch so nothing races.
              const resizeText = (id: string, wFrac: number, fontFrac: number) => {
                const prev = lay[id] ?? defaultPos(id, undefined, id.startsWith("subheading-") ? Number(id.split("-")[1]) : 0);
                const sizePct = Math.round(
                  Math.min(cfg.text_size_pct_max, Math.max(cfg.text_size_pct_min, fontFrac * 100)) * 10,
                ) / 10;
                const body: Parameters<typeof gdUpdateConfig>[1] = {
                  layout: { [id]: { x: prev.x, y: prev.y, w: wFrac, anchor: "mc" } },
                };
                if (id.startsWith("subheading-")) {
                  const idx = Number(id.split("-")[1]);
                  body.subheadings = subheadings.map((s, i) => (i === idx ? { ...s, size_pct: sizePct } : s));
                } else if (id === "headline" || id === "cta") {
                  body.element_styles = { [id]: { size_pct: sizePct } };
                }
                patch(body);
              };

              const selectAnything = (id: string | null) => {
                setSelEl(id);
                if (!id) return;
                if (id === "headline" || id === "cta" || id === "venue" || id === "website") setActiveLine(id);
                else if (id.startsWith("subheading-")) setActiveLine(`sub-${id.split("-")[1]}`);
              };

              return (
                <KonvaCanvas
                  previewSrc={exactPreview ? (previewUrl ?? bg2Url ?? undefined) : (bg2Url ?? undefined)}
                  aspect={arInfo ? arInfo.h / arInfo.w : 1}
                  markers={exactPreview ? [] : shapeMarkers}
                  onMove={moveAnything}
                  elements={exactPreview ? [] : (run.config.elements ?? [])}
                  onElementsChange={(els) => patch({ elements: els })}
                  selectedId={selEl}
                  onSelect={selectAnything}
                  texts={exactPreview ? [] : texts}
                  onTextMove={moveAnything}
                  onTextResize={resizeText}
                  onTextDblClick={(id, cx, cy) => {
                    const value = id.startsWith("subheading-")
                      ? (subheadings[Number(id.split("-")[1])]?.text ?? "")
                      : (tokens[id] ?? "");
                    setActiveLine(id.startsWith("subheading-") ? `sub-${id.split("-")[1]}` : id);
                    setEditPop({ id, x: cx, y: cy, value });
                  }}
                />
              );
            })() : cur === 4 && !exactPreview && bg3Url && curLogoThumb ? (() => {
              const b = logoBox();
              if (!b) return <AuthImg path={canvasPath} alt="Design preview" />;
              return (
                <KonvaCanvas
                  previewSrc={bg3Url}
                  aspect={arInfo ? arInfo.h / arInfo.w : 1}
                  markers={[]}
                  onMove={() => undefined}
                  elements={[]}
                  onElementsChange={() => undefined}
                  selectedId={selEl}
                  onSelect={setSelEl}
                  overlay={{ src: curLogoThumb, x: b.fx, y: b.fy, w: b.fw, h: b.fh }}
                  onOverlayCommit={commitLogoBox}
                />
              );
            })() : (
              <AuthImg path={canvasPath} alt="Design preview" />
            )}
            {!canvasPath && cur !== 3 && !(cur === 4 && bg3Url) ? (
              <div className="gd2-canvashint">{STAGE_HINTS[cur] ?? ""}</div>
            ) : null}
            {busy ? (
              <div className="gd2-veil">
                <div className="gd2-veilcard">
                  <span className="gd2-spin" />
                  {busy}
                </div>
              </div>
            ) : null}
          </div>
          <p className="gd2-meta">
            {arInfo ? `${arInfo.dimensions} · ${arInfo.label}` : run.config.aspect_ratio}
          </p>
        </section>

        {/* on-canvas double-click text editor */}
        {editPop ? (
          <div
            className="gd2-editpop"
            style={{
              left: Math.max(12, Math.min(editPop.x - 130, (typeof window !== "undefined" ? window.innerWidth : 1200) - 290)),
              top: Math.max(12, editPop.y - 54),
            }}
          >
            <input
              autoFocus
              value={editPop.value}
              maxLength={140}
              onChange={(e) => setEditPop((p) => (p ? { ...p, value: e.target.value } : p))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEditPop();
                if (e.key === "Escape") setEditPop(null);
              }}
              onBlur={commitEditPop}
            />
          </div>
        ) : null}

        {/* right panel */}
        <aside className="gd2-panel" style={{ ["--hue" as never]: hue } as React.CSSProperties}>
          {plan && !autoAccept && !done ? (
            <PlanReview
              plan={plan}
              stage1={cfg.stage1_variants}
              stage2={cfg.stage2_variants}
              busy={busy !== null}
              onRun={(accept, text, layout) => {
                const merged = { ...plan, text, layout };
                setPlan(merged);
                setAutoAccept(accept);
                autoStopped.current = false;
                void driveAuto(accept, merged, cur as AutoStage);
              }}
              onSkip={() => {
                setPlan(null);
                onToast("Plan dismissed — you’re in the normal studio.");
              }}
            />
          ) : (
            stepPanel()
          )}
          {!done ? (
            <>
              {autoAccept && !done ? (
                <div className="gd2-autobar">
                  {pausedStage === 3 && styleSet ? (
                    <span>✦ Pick one of the 3 styles below, then Approve — auto continues.</span>
                  ) : pausedStage === 4 ? (
                    <span>✦ Choose your logo and its corner, then Generate composite to finish.</span>
                  ) : pausedStage !== null ? (
                    <span>⏸ Auto paused — pick your own {STEPS[pausedStage - 1].name.toLowerCase()}, then Approve to resume.</span>
                  ) : (
                    <span>✦ Auto mode is driving the approved steps.</span>
                  )}
                  <button
                    className="gd2-ghost"
                    onClick={() => {
                      autoStopped.current = true;
                      setAutoAccept(null);
                      setPausedStage(null);
                      setPlan(null);
                      onToast("Auto mode stopped — you’re in full manual control.");
                    }}
                  >
                    Stop auto
                  </button>
                </div>
              ) : null}
              {cur === 3 ? (
                <>
                  {styleSet ? (
                    <StyleGallery attempts={styleSet} selected={styleSel} onSelect={setStyleSel} />
                  ) : null}
                  <label className="gd2-lbl" htmlFor="gd2polishnotes">Polish notes (optional)</label>
                  <textarea
                    id="gd2polishnotes"
                    className="gd2-polishnotes"
                    placeholder="e.g. keep the headline airy, extra pop on the CTA"
                    maxLength={500}
                    value={polishNotes}
                    onChange={(e) => setPolishNotes(e.target.value)}
                  />
                </>
              ) : null}
              <div className="gd2-actionrow">
                <button className="gd2-btn gd2-btn--soft" onClick={generate} disabled={busy !== null || (cur <= 2 && !(cur === 1 ? sel1 : sel2))}>
                  {hasAttempt ? "↻ Regenerate" : cur === 4 ? "Generate composite" : "Generate preview"}
                </button>
                <button
                  className="gd2-btn"
                  onClick={approve}
                  disabled={busy !== null || (!hasAttempt && cur !== 3 && cur !== 4)}
                  title={cur >= 3 ? "Renders your current arrangement and approves exactly that" : undefined}
                >
                  Approve ✓
                </button>
              </div>
              {cur > 1 ? (
                <button className="gd2-backlink" onClick={() => gotoStage(cur - 1)}>
                  ← Back to {STEPS[cur - 2].name.toLowerCase()}
                </button>
              ) : null}
              <p className="gd2-note">
                {cur <= 2
                  ? "Approve locks this layer and moves to the next one. You can come back any time."
                  : cur === 3
                    ? "Generate renders your words with real brand fonts, then the Text Optimizer polishes 3 styles. Your text, gradient and photo are never redrawn."
                    : "Auto style picks the logo treatment with the best contrast against your background."}
              </p>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
