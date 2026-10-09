/** Client-side mirror of the backend's prompt-image rules so the entry screen
 *  can reject bad files instantly: the count is `MAX_PROMPT_IMAGES` in
 *  routers/graphics_designer.py; types and size are the direct upload's
 *  (`upload_intake.SURFACES["prompt"]`) — the files go straight to storage, so
 *  a 50 MB original is no longer refused here. Keep in sync with the backend.
 *  Runtime imports are relative so vitest can load it. */

import type { UploadRow } from "../../../lib/directUpload";

export const MAX_PROMPT_IMAGES = 3;
export const PROMPT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/tiff"];
/** Browsers report some types as "" (a TIFF on some systems); the extension
 *  then decides here, and the bytes decide on the server as always. */
const PROMPT_IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "tif", "tiff"];
export const PROMPT_IMAGE_MAX_BYTES = 50 * 1024 * 1024;

export type AttachReason = "limit" | "type" | "size";
export type AttachVerdict = { ok: true } | { ok: false; reason: AttachReason };

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

export function canAttach(
  current: number,
  file: { type: string; size: number; name?: string },
): AttachVerdict {
  if (current >= MAX_PROMPT_IMAGES) return { ok: false, reason: "limit" };
  const typeOk = PROMPT_IMAGE_TYPES.includes(file.type)
    || (file.type === "" && PROMPT_IMAGE_EXTS.includes(extOf(file.name ?? "")));
  if (!typeOk) return { ok: false, reason: "type" };
  if (file.size > PROMPT_IMAGE_MAX_BYTES) return { ok: false, reason: "size" };
  return { ok: true };
}

export function attachErrorMessage(name: string, reason: AttachReason): string {
  if (reason === "limit") return `Max ${MAX_PROMPT_IMAGES} images per creative.`;
  if (reason === "type") return `${name}: only PNG, JPEG, WebP or TIFF images.`;
  return `${name}: over 50 MB — please attach a smaller image.`;
}

/** What the studio says once the brief's images have gone up: one line per
 *  image that did not attach, with its reason, and one per note about one
 *  that did. The run goes on without a failed image — but never silently. */
export function attachReport(rows: UploadRow[]): { failed: string[]; notes: string[] } {
  const failed: string[] = [];
  const notes: string[] = [];
  for (const row of rows) {
    if (row.phase === "failed") failed.push(`“${row.name}” did not attach: ${row.reason ?? "it did not upload."}`);
    else if (row.phase === "stored") for (const note of row.notes) notes.push(`“${row.name}”: ${note}`);
  }
  return { failed, notes };
}
