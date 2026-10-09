import { describe, expect, it } from "vitest";

import { attachErrorMessage, attachReport, canAttach, MAX_PROMPT_IMAGES } from "./promptAttach";
import { newRow, rowFailed, rowStored } from "../../../lib/directUpload";

const MB = 1024 * 1024;
const png = { type: "image/png", size: 1024 };

describe("canAttach", () => {
  it("accepts a small png under the cap", () => {
    expect(canAttach(0, png)).toEqual({ ok: true });
  });
  it("rejects when the cap is reached", () => {
    expect(canAttach(MAX_PROMPT_IMAGES, png)).toEqual({ ok: false, reason: "limit" });
  });
  it("rejects non-image types", () => {
    expect(canAttach(0, { type: "application/pdf", size: 10 })).toEqual({ ok: false, reason: "type" });
  });
  it("takes a 50 MB original — the images go straight to storage, so the old 10 MB check is gone", () => {
    expect(canAttach(0, { type: "image/jpeg", size: 50 * MB })).toEqual({ ok: true });
    expect(canAttach(0, { type: "image/png", size: 50 * MB + 1 })).toEqual({ ok: false, reason: "size" });
  });
  it("takes a TIFF, including one the browser reports with no type", () => {
    expect(canAttach(0, { type: "image/tiff", size: MB })).toEqual({ ok: true });
    expect(canAttach(0, { type: "", size: MB, name: "shoot.TIF" })).toEqual({ ok: true });
    expect(canAttach(0, { type: "", size: MB, name: "photo.heic" })).toEqual({ ok: false, reason: "type" });
  });
});

describe("attachErrorMessage", () => {
  it("names the file for type/size problems", () => {
    expect(attachErrorMessage("a.pdf", "type")).toContain("a.pdf");
    expect(attachErrorMessage("big.png", "size")).toContain("big.png");
    expect(attachErrorMessage("big.png", "size")).toContain("50 MB");
  });
  it("states the cap for limit", () => {
    expect(attachErrorMessage("x.png", "limit")).toContain(String(MAX_PROMPT_IMAGES));
  });
});

describe("attachReport — what the studio says once the brief's images went up", () => {
  const file = (name: string) => ({ name, type: "image/png", size: 10 });

  it("names every image that did not attach, with its reason, and every note on one that did", () => {
    const rows = [
      rowStored(newRow("0", file("a.png")), {
        surface: "prompt", file: "a.png", status: "stored", already_finalized: false, kind: "png", content_id: "x",
        original: { bytes: 10, width: 1, height: 1, pages: null, download_url: null },
        working: null, pages_used: null, flags: ["alpha_flattened_to_white"],
      }, "direct"),
      rowFailed(newRow("1", file("b.heic")), "HEIC/HEIF and AVIF images are not supported — export as JPEG/PNG."),
      rowStored(newRow("2", file("c.png")), null, "multipart"),
    ];
    expect(attachReport(rows)).toEqual({
      failed: ["“b.heic” did not attach: HEIC/HEIF and AVIF images are not supported — export as JPEG/PNG."],
      notes: ["“a.png”: Transparent areas were filled with white."],
    });
  });

  it("says nothing when every image is stored without a note", () => {
    expect(attachReport([rowStored(newRow("0", file("a.png")), null, "direct")])).toEqual({ failed: [], notes: [] });
  });
});
