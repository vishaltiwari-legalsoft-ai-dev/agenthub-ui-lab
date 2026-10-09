"use client";

/** One line per file going up: progress while it moves, then "Stored" or the
 *  reason in words, with a calm note for anything the server changed on the
 *  way in. Shared by the brand-kit sheet and the studio; every word it shows
 *  is decided in `lib/directUpload.ts`, where it is tested.
 *
 *  Colour means state and nothing else: the bar is the accent, a stored file
 *  takes the quiet "ok" ink, and only a file that did not upload takes the
 *  failure tone. A note is never coloured — it is information, not alarm.
 */

import { useState } from "react";
import { gdArtifactBlob } from "@/lib/api";
import { linkKind, rowPercent, rowStatus, type UploadRow } from "@/lib/directUpload";

export function UploadRows({
  rows,
  tone = "hub",
  label = "Uploads",
}: {
  rows: UploadRow[];
  /** `gd2` takes the studio's own token layer. */
  tone?: "hub" | "gd2";
  label?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className={`upl${tone === "gd2" ? " upl--gd2" : ""}`} aria-label={label}>
      {rows.map((row) => <Row key={row.id} row={row} />)}
    </ul>
  );
}

function Row({ row }: { row: UploadRow }) {
  const moving = row.phase === "preparing" || row.phase === "sending" || row.phase === "checking";
  // Only a direct PUT reports bytes; the rest is a step with no measure.
  const measured = row.phase === "sending" && row.route === "direct";
  const pct = rowPercent(row);
  const status = rowStatus(row);
  return (
    <li className={`upl__row is-${row.phase}`}>
      <div className="upl__head">
        <span className="upl__name" title={row.name}>{row.name}</span>
        <span className="upl__state" aria-live="polite">
          {row.phase === "failed" ? "Did not upload" : status}
        </span>
      </div>
      {moving && (
        <div
          className={`upl__bar${measured ? "" : " is-open"}`}
          role="progressbar"
          aria-label={`Uploading ${row.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={measured ? pct : undefined}
          aria-valuetext={status}
        >
          <i style={measured ? { width: `${pct}%` } : undefined} />
        </div>
      )}
      {row.phase === "failed" && row.reason && <p className="upl__why">{row.reason}</p>}
      {row.phase === "stored" && row.notes.map((note) => <p className="upl__note" key={note}>{note}</p>)}
      {row.phase === "stored" && row.downloadUrl && <OriginalLink url={row.downloadUrl} name={row.name} />}
    </li>
  );
}

/** The original as a download. An absolute `https://` link is a signed link
 *  to storage and opens as it is — it carries no app token, and storage sends
 *  it as an attachment. A relative `/api/...` path goes through the authed
 *  blob fetch, like every artifact. Anything else is not drawn. */
function OriginalLink({ url, name }: { url: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const kind = linkKind(url);
  if (kind === "direct") {
    return (
      <a className="upl__link" href={url} rel="noreferrer" download>
        Download the original
      </a>
    );
  }
  if (kind !== "authed") return null;
  const open = () => {
    setBusy(true);
    setFailed(false);
    gdArtifactBlob(url)
      .then((obj) => {
        const a = document.createElement("a");
        a.href = obj;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(obj), 5000);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button type="button" className="upl__link" onClick={open} disabled={busy}>
        Download the original
      </button>
      {failed && <p className="upl__note">The original could not be downloaded just now.</p>}
    </>
  );
}
