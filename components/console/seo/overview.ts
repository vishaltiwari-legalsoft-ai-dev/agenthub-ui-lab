/** One SEO overview read per page load, shared by everything that needs it.
 *
 *  The SEO workspace and its console both read `/api/seo-geo/overview` on
 *  mount. Each used to issue its own request, and the backend answers them
 *  one after another behind the brand detail and pages reads — so the
 *  workspace, which shows the Search Console return toast, waited for the
 *  last of them (about seven seconds on staging).
 *
 *  Now a read that is already in flight is joined rather than repeated. One
 *  caller giving up (a superseded load, a React strict-mode remount) detaches
 *  only that caller; the request itself runs on for the others. A `fresh`
 *  read — after a write that changes the brands — starts a new request, and
 *  its answer is published to every subscriber so the workspace's header and
 *  brand switcher see what the console just changed. Nothing is cached once a
 *  read settles: the next mount reads again, so no answer outlives its page
 *  or crosses a sign-out.
 */

import type { SeoOverview } from "@/lib/api";
// Values by relative path: the test suite runs without the `@/` alias.
import { seoOverview } from "../../../lib/api";

type Listener = (overview: SeoOverview) => void;

let seq = 0;
let inflight: { seq: number; promise: Promise<SeoOverview> } | null = null;
const listeners = new Set<Listener>();

const abortError = () => Object.assign(new Error("The overview read was superseded."), { name: "AbortError" });

/** `promise` for this caller, rejecting with an AbortError the moment its own
 *  signal fires — without touching the shared request. */
function forCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** The overview: the read already in flight, or a new one. `fresh` always
 *  starts a new read (and only the newest read publishes). */
export function loadSeoOverview(opts: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<SeoOverview> {
  // a caller that has already given up starts nothing
  if (opts.signal?.aborted) return Promise.reject(abortError());
  if (!inflight || opts.fresh) {
    const mine = ++seq;
    const promise = seoOverview();
    const settle = () => { if (inflight?.seq === mine) inflight = null; };
    promise.then((value) => {
      settle();
      if (mine === seq) listeners.forEach((fn) => fn(value));
    }, settle);
    inflight = { seq: mine, promise };
  }
  return forCaller(inflight.promise, opts.signal);
}

/** Hear every overview the newest read returns. Returns the unsubscribe. */
export function onSeoOverview(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tell every subscriber about an overview this page already knows to be
 *  newer — a brand just removed — without waiting for a read. It also
 *  retires any read still in flight, whose answer predates the change; the
 *  fresh read the caller starts next confirms it. */
export function publishSeoOverview(value: SeoOverview): void {
  seq += 1;
  inflight = null;
  listeners.forEach((fn) => fn(value));
}
