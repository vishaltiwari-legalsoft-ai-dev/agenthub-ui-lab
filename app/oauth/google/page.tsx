"use client";

/** Where Google sends the browser back after a consent screen — for two
 *  specialists: Inbox Triage (Gmail) and the SEO Analyst (Search Console).
 *
 *  Google's redirect lands on the console, not the backend, because the code
 *  it carries has to be exchanged by the account that asked for it — and that
 *  account's bearer lives in this browser. So this page does exactly one
 *  thing: hands `code` and `state` to the right backend with the stored
 *  session, then sends the reader back to the workspace with one flag in the
 *  hash for the workspace to say out loud. It never shows the code, never
 *  keeps it, and runs the exchange once even when React mounts it twice in
 *  development.
 *
 *  Which specialist is decided by the state: `gsc.` is Search Console's, and
 *  everything else runs the Inbox Triage path exactly as before
 *  (`components/console/seo/seo.ts`, `googleReturn`). A Google refusal on the
 *  Search Console side has no code, so it goes straight back without a call.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { inboxOauthComplete, seoOauthComplete } from "@/lib/api";
import { finishGoogleReturn, googleReturn, type GoogleReturn } from "@/components/console/seo/seo";

const WORKSPACE = "/#/w/inbox";

const back = (query: string) => window.location.replace(`${WORKSPACE}?${query}`);
const failed = (why: string) => back(`error=${encodeURIComponent(why)}`);

/** The Inbox Triage exchange, unchanged. */
function inboxReturn() {
  const q = new URLSearchParams(window.location.search);
  const error = q.get("error");
  if (error) {
    failed(error);
    return;
  }
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) {
    failed("Google sent the browser back without a code");
    return;
  }
  inboxOauthComplete(code, state)
    .then(() => back("connected=1"))
    .catch((e: unknown) => failed(e instanceof Error && e.message ? e.message : "the connection could not be finished"));
}

export default function GoogleOAuthReturn() {
  const { user, ready } = useAuth();
  const started = useRef(false);
  // Read after mount: the page is prerendered, and the server has no URL.
  const [ret, setRet] = useState<GoogleReturn | null>(null);

  useEffect(() => {
    setRet(googleReturn(window.location.search));
  }, []);

  useEffect(() => {
    if (!ret || !ready || started.current) return;
    // A refused Search Console sign-in carries nothing to exchange, so it
    // does not need a session to go back.
    if (!user && ret.kind !== "gsc-refused") return;
    started.current = true;
    void finishGoogleReturn(ret, {
      completeGsc: seoOauthComplete,
      inbox: inboxReturn,
      go: (path) => window.location.replace(path),
    });
  }, [ret, ready, user]);

  const gsc = ret !== null && ret.kind !== "inbox";

  if (ready && !user && ret && ret.kind !== "gsc-refused") {
    return (
      <main className="boot">
        <p className="calm">
          Sign in to the console first, then press {gsc ? "Connect Search Console" : "Connect Gmail"} again.{" "}
          <a href="/">Open the console</a>
        </p>
      </main>
    );
  }

  return (
    <main className="boot" aria-busy="true">
      <span className="boot__spin" aria-hidden="true" />
      <span className="sr">{gsc ? "Finishing the Search Console connection" : "Finishing the Gmail connection"}</span>
    </main>
  );
}
