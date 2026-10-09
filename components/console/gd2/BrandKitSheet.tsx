"use client";

/** One sheet for a brand's kit — creating it and editing it are the same form.
 *
 *  Brands are company-wide: any signed-in member may add one or change its
 *  kit, and only an admin may archive one, so that is the one control gated
 *  here. The save is two steps in a fixed order — the JSON body first, then
 *  every file against the id that came back — and the decisions behind it
 *  (what a file may be, what a `detail` code means, what to do when one upload
 *  of five fails) live in `brandKit.ts`, where they are tested.
 *
 *  What can go wrong is shown where it happened: a refused file is named with
 *  its reason before anything is sent; a server refusal keeps the sheet open
 *  with the backend's own sentence; and a brand that was created but whose
 *  fonts did not land is shown as exactly that, never as a failed create.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastFn } from "@/components/console/ConsoleApp";
import type { Viewer } from "@/components/hub/model";
import {
  directUpload, gdArchiveBrand, gdBrand, gdCreateBrand, gdDeleteBrandReference, gdPatchBrand,
  type GdBrandDetail, type GdBrandReference, type GdBrandReferenceKind,
} from "@/lib/api";
import type { UploadRow } from "@/lib/directUpload";
import { loadPending, useLoadSession, type Load } from "@/lib/load";
import { Ic } from "@/components/hub/Sprite";
import {
  COLOR_ROLES, DEFAULT_REFERENCE_CAP, FILE_RULES, REFERENCE_CREATIVE_TYPES, REFERENCE_TYPE_OTHER,
  canArchiveBrand, checkFiles, describeBrandFailure, draftFrom, emptyDraft, emptyPending, formatMb,
  hasPending, normalizeHex, referenceCountLabel, referenceTypeLabel, referencesRemaining,
  saveBrandKit, validateDraft,
  type BrandDraft, type BrandKitApi, type ColorRole, type KitFileKind, type PendingUploads,
} from "./brandKit";
import { UploadRows } from "./UploadRows";

/** The sheet's uploads: every file straight to storage, one at a time each
 *  (`directUpload`), with the multipart route as its fallback. */
const KIT_API: BrandKitApi<File> = {
  create: gdCreateBrand,
  patch: gdPatchBrand,
  uploadAsset: (brandId, kind, file, hooks) => directUpload(kind, brandId, file, hooks),
  uploadReference: (brandId, file, meta, hooks) => directUpload("reference", brandId, file, { ...hooks, meta }),
};

const ROLE_LABEL: Record<ColorRole, string> = {
  primary: "Primary", secondary: "Secondary", accent: "Accent",
};

const ROLE_HINT: Record<ColorRole, string> = {
  primary: "The colours the brand is known by. At least one.",
  secondary: "Supporting colours, if the brand has them.",
  accent: "Highlights — a CTA, a rule, a badge.",
};

export interface BrandKitSheetProps {
  open: boolean;
  /** Null creates a brand; an id edits that brand's kit. */
  brandId: string | null;
  viewer: Viewer;
  onClose: () => void;
  /** The brand as saved. The host refetches its list and selects it. */
  onSaved: (brand: GdBrandDetail) => void;
  onArchived?: (brandId: string) => void;
  onToast: ToastFn;
}

export function BrandKitSheet({
  open, brandId, viewer, onClose, onSaved, onArchived, onToast,
}: BrandKitSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const session = useLoadSession();

  // The id this sheet is working on. It starts as the prop and becomes the
  // new brand's id the moment a create lands, so a create whose uploads then
  // fail continues as an edit of the brand that now exists.
  const [id, setId] = useState<string | null>(brandId);
  const [detail, setDetail] = useState<Load<GdBrandDetail>>(loadPending);
  const [draft, setDraft] = useState<BrandDraft>(emptyDraft);
  const [pending, setPending] = useState<PendingUploads>(emptyPending);
  const [fontName, setFontName] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  // One row per file of the last save — progress, then stored or the reason.
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [beat, setBeat] = useState(0);

  // Object URLs for files not yet uploaded, revoked when the sheet closes.
  const previews = useRef(new Map<File, string>());
  const previewOf = useCallback((f: File): string => {
    let url = previews.current.get(f);
    if (!url) {
      url = URL.createObjectURL(f);
      previews.current.set(f, url);
    }
    return url;
  }, []);
  const dropPreviews = () => {
    for (const url of previews.current.values()) URL.revokeObjectURL(url);
    previews.current.clear();
  };

  /* ---------------------------------------------------- open / close ---- */

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      setId(brandId);
      setDetail(loadPending);
      setDraft(emptyDraft());
      setPending(emptyPending());
      setFontName("");
      setProblems([]);
      setUploads([]);
      setConfirmArchive(false);
      setRemoving(null);
      el.showModal();
      setTimeout(() => nameInput.current?.focus(), 40);
    } else if (!open && el.open) {
      el.close();
      dropPreviews();
    }
  }, [open, brandId]);

  useEffect(() => {
    if (!open || !id) return;
    void session.run(
      "brand-kit",
      (signal) => gdBrand(id, { signal }),
      setDetail,
      "The brand could not be read.",
    );
  }, [open, id, session, beat]);

  // The form follows what the backend holds — on first read and after every
  // save, which writes the returned brand back into `detail`.
  const loaded = detail.data;
  useEffect(() => {
    if (loaded) setDraft(draftFrom(loaded));
  }, [loaded]);

  // The rows sit under the whole form; bring them into view when a save
  // starts sending files and again when it ends — the pickers hidden while
  // it runs come back above them and would push the results out of sight.
  const rowsStage = uploads.length === 0 ? "none" : busy ? "sending" : "done";
  useEffect(() => {
    if (rowsStage !== "none") rowsRef.current?.scrollIntoView({ block: "nearest" });
  }, [rowsStage]);

  const creating = id === null;
  const brand = detail.data;
  const readOnly = !creating && !!brand && !brand.editable;
  const loading = !creating && detail.phase === "loading" && !brand;
  const cap = brand?.reference_cap ?? DEFAULT_REFERENCE_CAP;
  const existingRefs: GdBrandReference[] = brand?.references ?? [];
  const refCount = existingRefs.length + pending.reference.length;

  /* ---------------------------------------------------------- edits ---- */

  const patch = (fn: (d: BrandDraft) => BrandDraft) => setDraft((d) => fn(d));

  const setColor = (role: ColorRole, i: number, value: string) =>
    patch((d) => ({ ...d, colors: { ...d.colors, [role]: d.colors[role].map((c, j) => (j === i ? value : c)) } }));
  const addColor = (role: ColorRole) =>
    patch((d) => ({ ...d, colors: { ...d.colors, [role]: [...d.colors[role], ""] } }));
  const removeColor = (role: ColorRole, i: number) =>
    patch((d) => ({ ...d, colors: { ...d.colors, [role]: d.colors[role].filter((_, j) => j !== i) } }));

  const addFontName = () => {
    const name = fontName.trim();
    if (!name) return;
    patch((d) => (d.fonts.includes(name) ? d : { ...d, fonts: [...d.fonts, name] }));
    setFontName("");
  };
  const removeFontName = (name: string) => patch((d) => ({ ...d, fonts: d.fonts.filter((f) => f !== name) }));

  /** Sort a selection by the client-side rules and say which were refused. */
  const takeFiles = (kind: KitFileKind, list: FileList | File[] | null) => {
    if (!list) return;
    const files = Array.from(list);
    if (files.length === 0) return;
    const have = kind === "reference"
      ? 0
      : kind === "logo" ? (brand?.assets.logos.length ?? 0) + pending.logo.length
        : kind === "font" ? (brand?.assets.fonts.length ?? 0) + pending.font.length
          : 0;
    const check = checkFiles(kind, files, have);
    if (kind === "reference") {
      const room = referencesRemaining(refCount, cap);
      const over = check.accepted.splice(room);
      for (const f of over) check.rejected.push({ file: f, reason: `This brand can hold ${cap} references` });
    }
    if (check.accepted.length) {
      setPending((p) => ({
        ...p,
        [kind]: kind === "guidelines" ? check.accepted.slice(0, 1) : [...p[kind], ...check.accepted],
      }));
    }
    if (check.rejected.length) {
      setProblems(check.rejected.map((r) => `${r.file.name}: ${r.reason}`));
    }
  };

  const dropPending = (kind: KitFileKind, file: File) => {
    setPending((p) => ({ ...p, [kind]: p[kind].filter((f) => f !== file) }));
    const url = previews.current.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      previews.current.delete(file);
    }
  };

  /* ----------------------------------------------------------- save ---- */

  const save = async () => {
    const invalid = validateDraft(draft);
    if (invalid.length) {
      setProblems(invalid);
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setProblems([]);
    setUploads([]);
    try {
      const outcome = await saveBrandKit(KIT_API, id, draft, pending, setUploads);
      if (!outcome.brand) {
        setProblems(outcome.problems);
        return;
      }
      const saved = outcome.brand;
      setId(saved.brand_id);
      setDetail({ phase: "ready", data: saved, error: null });
      setDraft(draftFrom(saved));
      const failedCount = Object.values(outcome.failed).reduce((n, list) => n + list.length, 0);
      if (failedCount > 0) {
        // The brand is real; the sheet stays on it with each file's reason in
        // its row, keeping what did not land so a retry needs no re-pick.
        const { failed } = outcome;
        setPending((p) => ({
          ...p,
          logo: p.logo.filter((f) => failed.logo.includes(f)),
          font: p.font.filter((f) => failed.font.includes(f)),
          guidelines: p.guidelines.filter((f) => failed.guidelines.includes(f)),
          reference: p.reference.filter((f) => failed.reference.includes(f)),
        }));
        onToast(
          `${creating ? "Brand created" : "Brand saved"} — ${failedCount} file${failedCount === 1 ? "" : "s"} did not upload.`,
          "warn",
        );
        onSaved(saved);
        return;
      }
      setPending(emptyPending());
      dropPreviews();
      onToast(creating ? `${saved.name} is ready to design for.` : `${saved.name} saved.`, "ok");
      onSaved(saved);
      // A note about a stored file (colours converted, one page of three used)
      // is worth reading, so the sheet stays open on its rows; otherwise done.
      if (!outcome.rows.some((r) => r.notes.length > 0)) onClose();
    } finally {
      setBusy(false);
    }
  };

  const removeReference = async (ref: GdBrandReference) => {
    if (!id) return;
    setRemoving(ref.ref_id);
    try {
      await gdDeleteBrandReference(id, ref.ref_id);
      setDetail((prev) => prev.data
        ? {
          ...prev,
          data: {
            ...prev.data,
            references: prev.data.references.filter((r) => r.ref_id !== ref.ref_id),
            reference_count: Math.max(0, prev.data.reference_count - 1),
          },
        }
        : prev);
    } catch (e) {
      onToast(describeBrandFailure(e, "The reference could not be removed."), "error");
    } finally {
      setRemoving(null);
    }
  };

  const archive = async () => {
    if (!id || !brand) return;
    setBusy(true);
    try {
      await gdArchiveBrand(id);
      onToast(`${brand.name} archived.`, "ok");
      onArchived?.(id);
      onClose();
    } catch (e) {
      setProblems([describeBrandFailure(e, "The brand could not be archived.")]);
    } finally {
      setBusy(false);
      setConfirmArchive(false);
    }
  };

  /* --------------------------------------------------------- render ---- */

  const title = creating ? "New brand" : brand ? `${brand.name} — brand kit` : "Brand kit";
  const logoPending = pending.logo[0] ?? null;
  // A stored logo whose URL could not be signed is still on file: the count
  // comes from the assets, the picture only when there is one to show.
  const logoOnFile = (brand?.assets.logos.length ?? 0) > 0;
  const logoUrl = logoPending ? previewOf(logoPending) : (brand?.logo_url || null);
  const guidelinesOnFile = brand?.assets.guidelines[0] ?? null;
  const disabled = busy || readOnly || loading;

  return (
    <dialog
      className="dialog bk"
      ref={dialog}
      aria-labelledby="bk-title"
      onClose={() => { dropPreviews(); onClose(); }}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
    >
      {open && (
        <form
          className="bk__form"
          onSubmit={(e) => { e.preventDefault(); if (!disabled) void save(); }}
          // A file dropped outside the drop zone must not open in the tab.
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); }}
>
          <h2 id="bk-title">{title}</h2>
          <p>
            {creating
              ? "Shared with everyone here. Name and one primary colour are enough to start; the rest can come later."
              : readOnly
                ? "A built-in brand. Its kit is read here, not changed."
                : "Shared with everyone here. Changes apply to the next run for this brand."}
          </p>

          {loading && (
            <p className="wait" role="status" aria-live="polite">
              <i className="wait__spin" aria-hidden="true" />Reading the brand kit…
            </p>
          )}
          {detail.phase === "failed" && !brand && !creating && (
            <div className="oops" role="alert">
              <Ic name="x" />
              <div>
                <b>The brand could not be read.</b>
                <p>{detail.error}</p>
                <div className="oops__act">
                  <button type="button" className="btn btn--quiet btn--sm" onClick={() => setBeat((b) => b + 1)}>Try again</button>
                </div>
              </div>
            </div>
          )}

          {(creating || brand) && (
            <>
              {/* ------------------------------------------------ identity */}
              <div className="bk__two">
                <label className="field">
                  <span>Name</span>
                  <input
                    ref={nameInput}
                    className="inp"
                    value={draft.name}
                    disabled={disabled}
                    maxLength={80}
                    placeholder="Berry Virtual"
                    onChange={(e) => patch((d) => ({ ...d, name: e.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>Website <em className="bk__opt">optional</em></span>
                  <input
                    className="inp"
                    value={draft.website}
                    disabled={disabled}
                    placeholder="https://"
                    inputMode="url"
                    onChange={(e) => patch((d) => ({ ...d, website: e.target.value }))}
                  />
                </label>
              </div>

              {/* ------------------------------------------------- colours */}
              <fieldset className="bk__set">
                <legend>Colours</legend>
                {COLOR_ROLES.map((role) => (
                  <div className="bk__role" key={role}>
                    <div className="bk__rolehead">
                      <b>{ROLE_LABEL[role]}</b>
                      <span>{ROLE_HINT[role]}</span>
                    </div>
                    <div className="bk__chips">
                      {draft.colors[role].map((c, i) => {
                        const hex = normalizeHex(c);
                        return (
                          <span className="bk__chip" key={`${role}-${i}`}>
                            <input
                              type="color"
                              aria-label={`${ROLE_LABEL[role]} colour ${i + 1} picker`}
                              value={hex ?? "#000000"}
                              disabled={disabled}
                              onChange={(e) => setColor(role, i, e.target.value.toUpperCase())}
                            />
                            <input
                              className="inp bk__hex"
                              aria-label={`${ROLE_LABEL[role]} colour ${i + 1} hex`}
                              value={c}
                              disabled={disabled}
                              placeholder="#1746A2"
                              maxLength={7}
                              spellCheck={false}
                              onChange={(e) => setColor(role, i, e.target.value)}
                              onBlur={(e) => { const n = normalizeHex(e.target.value); if (n) setColor(role, i, n); }}
                            />
                            {!disabled && (
                              <button type="button" className="bk__x" aria-label={`Remove ${ROLE_LABEL[role]} colour ${i + 1}`} onClick={() => removeColor(role, i)}>
                                <Ic name="x" />
                              </button>
                            )}
                          </span>
                        );
                      })}
                      {!disabled && (
                        <button type="button" className="btn btn--quiet btn--sm" onClick={() => addColor(role)}>
                          <Ic name="plus" />Add colour
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </fieldset>

              {/* -------------------------------------------- typography */}
              <fieldset className="bk__set">
                <legend>Fonts</legend>
                <div className="bk__chips">
                  {draft.fonts.map((f) => (
                    <span className="bk__tag" key={f}>
                      {f}
                      {!disabled && (
                        <button type="button" className="bk__x" aria-label={`Remove font ${f}`} onClick={() => removeFontName(f)}><Ic name="x" /></button>
                      )}
                    </span>
                  ))}
                  {brand?.assets.fonts.map((a) => (
                    <span className="bk__tag bk__tag--file" key={a.path} title={a.path}>{a.name}</span>
                  ))}
                  {pending.font.map((f) => (
                    <span className="bk__tag bk__tag--new" key={`${f.name}-${f.size}`}>
                      {f.name}
                      <button type="button" className="bk__x" aria-label={`Remove ${f.name}`} onClick={() => dropPending("font", f)}><Ic name="x" /></button>
                    </span>
                  ))}
                  {draft.fonts.length + (brand?.assets.fonts.length ?? 0) + pending.font.length === 0 && (
                    <span className="bk__none">No fonts named yet.</span>
                  )}
                </div>
                {!disabled && (
                  <div className="bk__fontrow">
                    <input
                      className="inp"
                      value={fontName}
                      placeholder="Font family name, e.g. Archivo"
                      onChange={(e) => setFontName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFontName(); } }}
                    />
                    <button type="button" className="btn btn--quiet btn--sm" onClick={addFontName} disabled={!fontName.trim()}>Add name</button>
                    <FilePick kind="font" multiple label="Upload TTF / OTF" onFiles={(l) => takeFiles("font", l)} />
                  </div>
                )}
                <span className="hint">Fonts up to {formatMb(FILE_RULES.font.maxBytes)} each, {FILE_RULES.font.maxFiles} per brand.</span>
              </fieldset>

              {/* ------------------------------------- logo + guidelines */}
              <div className="bk__two">
                <fieldset className="bk__set">
                  <legend>Logo</legend>
                  <div className="bk__logo">
                    {logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logoUrl} alt={`${draft.name || "Brand"} logo`} />
                    ) : (
                      <span className="bk__mono" aria-hidden="true">{(draft.name.trim() || "?").slice(0, 1).toUpperCase()}</span>
                    )}
                    <div className="bk__logoside">
                      {logoPending ? (
                        <>
                          <b>{logoPending.name}</b>
                          <span>Uploads when you save.</span>
                          <button type="button" className="btn btn--quiet btn--sm" onClick={() => dropPending("logo", logoPending)}>Remove</button>
                        </>
                      ) : brand && logoOnFile ? (
                        <>
                          <b>Logo on file</b>
                          <span>{brand.assets.logos.length} file{brand.assets.logos.length === 1 ? "" : "s"}</span>
                        </>
                      ) : (
                        <>
                          <b>No logo yet</b>
                          <span>The designer places it at the last step; a run cannot finish without one.</span>
                        </>
                      )}
                      {!disabled && !logoPending && (
                        <FilePick kind="logo" label={logoOnFile ? "Add another" : "Upload logo"} onFiles={(l) => takeFiles("logo", l)} />
                      )}
                    </div>
                  </div>
                  <span className="hint">{FILE_RULES.logo.accepts}, up to {formatMb(FILE_RULES.logo.maxBytes)} (an SVG up to 5 MB).</span>
                </fieldset>

                <fieldset className="bk__set">
                  <legend>Guidelines</legend>
                  {pending.guidelines[0] ? (
                    <div className="bk__doc">
                      <b>{pending.guidelines[0].name}</b>
                      <span>Uploads when you save.</span>
                      <button type="button" className="btn btn--quiet btn--sm" onClick={() => dropPending("guidelines", pending.guidelines[0])}>Remove</button>
                    </div>
                  ) : guidelinesOnFile ? (
                    <div className="bk__doc">
                      <b>{guidelinesOnFile.name}</b>
                      {guidelinesOnFile.url
                        // A direct upload's PDF link is the original as an
                        // attachment, so it downloads rather than opens.
                        ? <a href={guidelinesOnFile.url} target="_blank" rel="noreferrer">{guidelinesOnFile.original ? "Download the PDF" : "Open the PDF"}</a>
                        : <span>On file; no preview link right now.</span>}
                      {!disabled && <FilePick kind="guidelines" label="Replace" onFiles={(l) => takeFiles("guidelines", l)} />}
                    </div>
                  ) : (
                    <div className="bk__doc">
                      <b>No guidelines PDF</b>
                      <span>Optional. The designer reads it for tone and layout rules.</span>
                      {!disabled && <FilePick kind="guidelines" label="Upload PDF" onFiles={(l) => takeFiles("guidelines", l)} />}
                    </div>
                  )}
                  <span className="hint">One PDF, up to {formatMb(FILE_RULES.guidelines.maxBytes)}.</span>
                </fieldset>
              </div>

              {/* ---------------------------------------------------- tone */}
              <label className="field">
                <span>Tone of voice <em className="bk__opt">optional</em></span>
                <textarea
                  rows={3}
                  value={draft.tone_of_voice}
                  disabled={disabled}
                  maxLength={2000}
                  placeholder="Plain, confident, no jargon. Speaks to a firm's managing partner, not to a developer."
                  onChange={(e) => patch((d) => ({ ...d, tone_of_voice: e.target.value }))}
                />
              </label>

              {/* ---------------------------------------------- references */}
              <fieldset className="bk__set">
                <legend>
                  References &amp; past creatives
                  <span className="bk__count" aria-label={`${refCount} of ${cap} references`}>{referenceCountLabel(refCount, cap)}</span>
                </legend>
                <p className="bk__lede">
                  Past creatives and anything the designer should take its cues from. It reads these for layout, palette and mood.
                </p>

                {!disabled && (
                  <div
                    className={`bk__drop${dropping ? " is-over" : ""}`}
                    onDragEnter={(e) => { e.preventDefault(); setDropping(true); }}
                    onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
                    onDragLeave={() => setDropping(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropping(false);
                      takeFiles("reference", e.dataTransfer.files);
                    }}
                  >
                    <Ic name="up" />
                    <b>Drop images here</b>
                    <span>
                      {FILE_RULES.reference.accepts}, up to {formatMb(FILE_RULES.reference.maxBytes)} each.
                      {" "}{referencesRemaining(refCount, cap)} more can be added.
                    </span>
                    <FilePick kind="reference" multiple label="Choose files" onFiles={(l) => takeFiles("reference", l)} />
                  </div>
                )}

                {(existingRefs.length > 0 || pending.reference.length > 0) ? (
                  <ul className="bk__refs">
                    {existingRefs.map((r) => (
                      <li className="bk__ref" key={r.ref_id}>
                        {r.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.url} alt={r.note || `${r.kind} reference`} loading="lazy" />
                        ) : (
                          // No signed URL for this object — it is on file, just not previewable.
                          <span className="bk__refblank" role="img" aria-label={r.note || `${r.kind} reference, no preview`}>
                            <Ic name="library" />
                            <span>No preview</span>
                          </span>
                        )}
                        <span className="bk__refcap">{referenceTypeLabel(r.creative_type) ?? (r.kind === "creative" ? "creative" : "reference")}</span>
                        {!readOnly && (
                          <button
                            type="button"
                            className="bk__refx"
                            aria-label={`Remove reference${r.note ? ` "${r.note}"` : ""}`}
                            disabled={removing === r.ref_id || busy}
                            onClick={() => void removeReference(r)}
                          >
                            <Ic name="x" />
                          </button>
                        )}
                      </li>
                    ))}
                    {pending.reference.map((f) => (
                      <li className="bk__ref is-new" key={`${f.name}-${f.size}-${f.lastModified}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={previewOf(f)} alt={f.name} />
                        <span className="bk__refcap">new</span>
                        <button type="button" className="bk__refx" aria-label={`Remove ${f.name}`} onClick={() => dropPending("reference", f)}>
                          <Ic name="x" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : disabled ? (
                  <p className="bk__none">No references on file.</p>
                ) : null}

                {pending.reference.length > 0 && (
                  <div className="bk__refmeta">
                    <label className="field">
                      <span>These are</span>
                      <select
                        className="sel"
                        value={pending.reference_kind}
                        onChange={(e) => setPending((p) => ({ ...p, reference_kind: e.target.value as GdBrandReferenceKind }))}
                      >
                        <option value="creative">Past creatives — made for this brand</option>
                        <option value="reference">References — inspiration, not ours</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Type <em className="bk__opt">optional</em></span>
                      <select
                        className="sel"
                        value={pending.reference_creative_type}
                        onChange={(e) => setPending((p) => ({ ...p, reference_creative_type: e.target.value }))}
                      >
                        <option value={REFERENCE_TYPE_OTHER.value}>{REFERENCE_TYPE_OTHER.label}</option>
                        {REFERENCE_CREATIVE_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <span className="hint">A hint only — the designer draws on every reference you upload, whatever its type.</span>
                    </label>
                    <label className="field">
                      <span>Note <em className="bk__opt">optional</em></span>
                      <input
                        className="inp"
                        value={pending.reference_note}
                        maxLength={200}
                        placeholder="What to take from these — the layout, the palette, the mood"
                        onChange={(e) => setPending((p) => ({ ...p, reference_note: e.target.value }))}
                      />
                    </label>
                  </div>
                )}
              </fieldset>
            </>
          )}

          <div ref={rowsRef}>
            <UploadRows rows={uploads} label="Files in this save" />
          </div>

          {problems.length > 0 && (
            <ul className="bk__problems" role="alert">
              {problems.map((p, i) => <li key={`${i}-${p}`}>{p}</li>)}
            </ul>
          )}

          <div className="dialog__actions bk__actions">
            {!creating && brand && canArchiveBrand(viewer) && !readOnly && (
              confirmArchive ? (
                <span className="bk__confirm">
                  <span>Archive {brand.name}? It leaves every picker; its runs stay on file.</span>
                  <button type="button" className="btn btn--quiet btn--sm" disabled={busy} onClick={() => setConfirmArchive(false)}>Keep</button>
                  <button type="button" className="btn btn--solid btn--sm" disabled={busy} onClick={() => void archive()}>Archive</button>
                </span>
              ) : (
                <button type="button" className="bk__archive" disabled={busy} onClick={() => setConfirmArchive(true)}>
                  Archive brand
                </button>
              )
            )}
            <span className="bk__spacer" />
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={onClose}>
              {readOnly || (uploads.length > 0 && !hasPending(pending)) ? "Close" : "Cancel"}
            </button>
            {!readOnly && (creating || brand) && (
              <button type="submit" className="btn btn--mark" disabled={disabled}>
                <Ic name="check" />
                {busy
                  ? (hasPending(pending) ? "Saving and uploading…" : "Saving…")
                  : creating ? "Create brand" : "Save kit"}
              </button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}

/** A file picker drawn as a quiet button: the input stays hidden and the
 *  button is what the keyboard reaches. */
function FilePick({
  kind, label, multiple, onFiles,
}: { kind: KitFileKind; label: string; multiple?: boolean; onFiles: (list: FileList | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        accept={FILE_RULES[kind].accept}
        multiple={multiple}
        onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
      />
      <button type="button" className="btn btn--quiet btn--sm" onClick={() => input.current?.click()}>
        <Ic name="up" />{label}
      </button>
    </>
  );
}
