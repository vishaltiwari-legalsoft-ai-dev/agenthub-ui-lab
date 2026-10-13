/** The SEO console's grounded-advice rows — the pieces the recommendations
 *  contract changed, kept presentational so `seo.test.ts` can render them.
 *
 *  Every decision is in `seo.ts`; these only draw it. Plain `.ts` with
 *  `createElement`, not `.tsx`, for the same reason as `mr/reportFrame.ts`:
 *  the suite cannot import a `.tsx` module, and these are exactly the rows
 *  whose rendered output the contract is about — a bare "Rule: ", "low" on a
 *  decorative image, an empty "This week" box.
 */

import { createElement as h, type ReactNode } from "react";
import type { SeoAuditIssue, SeoBrief, SeoPageIntel, SeoPagesGrounding, SeoPlanItem, SeoReviewGrounding } from "@/lib/api";
import { auditEvidence, auditTone, briefSchema, flagChip, hiddenSuggestionsLine, pageRec, planHeading, reviewDropped } from "./seo";

const fmt = (n: number) => n.toLocaleString("en-US");

/** One page in the Pages tab: its flags as chips, its advice as one line —
 *  or no line, when the chips are the whole message. */
export function PageRow({ p }: { p: SeoPageIntel }): ReactNode {
  const rec = pageRec(p);
  const flags = Array.isArray(p.flags) ? p.flags : [];
  return h("div", { className: "seo-pages__row" },
    h("div", { className: "seo-pages__main" },
      h("div", { className: "seo-pages__head" },
        p.url
          ? h("a", { className: "seo-pages__path", href: p.url, target: "_blank", rel: "noreferrer" }, p.path)
          : h("span", { className: "seo-pages__path" }, p.path),
        h("span", { className: "seo-pages__title" }, p.title || "No title"),
      ),
      flags.length > 0 && h("div", { className: "seo-pages__flags" },
        flags.map((f) => {
          const chip = flagChip(f);
          return h("span", { key: f, className: `seo-chip ${chip.ok ? "seo-chip--on" : "seo-chip--sev-medium"}` }, chip.label);
        }),
      ),
      rec && h("div", { className: "seo-pages__rec" }, `${rec.label}: ${rec.text}`),
    ),
    h("div", { className: "seo-pages__nums" },
      h("span", null, `${fmt(p.views)} views`),
      h("span", null, `${fmt(p.sessions)} sessions`),
      h("span", null, `${Math.round(p.engagement_rate * 100)}% engaged`),
      h("span", null, `${fmt(p.clicks)} clicks`),
      h("span", null, `${fmt(p.impressions)} impressions`),
      h("span", null, p.position != null ? `pos ${p.position}` : "not ranked"),
      p.best_query && h("span", { className: "seo-pages__query", title: p.best_query }, p.best_query),
    ),
  );
}

/** "N suggestions hidden …" — quiet, and only when something was. */
export function HiddenSuggestions({ grounding }: { grounding?: SeoPagesGrounding | null }): ReactNode {
  const line = hiddenSuggestionsLine(grounding);
  return line ? h("p", { className: "seo-lab__meta" }, line) : null;
}

/** One audit finding, expandable: the fix, then what backs it. Decorative alt
 *  text is "info" — never a severity, never "missing". */
export function AuditIssueRow({ issue }: { issue: SeoAuditIssue }): ReactNode {
  const tone = auditTone(issue);
  const ev = auditEvidence(issue);
  const pages = Array.isArray(issue.pages) ? issue.pages : [];
  return h("details", { className: "seo-issue" },
    h("summary", null,
      h("span", { className: `seo-chip seo-chip--sev-${tone}` }, tone),
      h("span", { className: "seo-cluster__name" }, issue.issue),
      h("span", { className: "seo-cluster__nums" }, `${issue.count} page(s)`),
    ),
    h("div", { className: "seo-issue__fix" }, issue.fix),
    ev && h("div", { className: "seo-brief__block" },
      h("span", { className: "seo-stat__label" }, ev.label),
      ev.lines.map((l) => h("div", { key: l, className: "seo-brief__line" }, l)),
    ),
    !ev?.coversPages && pages.map((p) => h("div", { key: p, className: "seo-brief__line" }, p)),
  );
}

/** "This week" — up to three moves, or nothing at all for an empty plan. */
export function PlanStrip({ plan }: { plan: readonly SeoPlanItem[] }): ReactNode {
  const items = plan.slice(0, 3);
  const heading = planHeading(items.length);
  if (!heading) return null;
  return h("div", { className: "seo-hero" },
    h("div", { className: "seo-hero__title" }, heading),
    items.map((p, i) => h("div", { key: i, className: "seo-hero__item" },
      h("span", { className: "seo-hero__num" }, i + 1),
      h("div", { className: "seo-hero__body" },
        h("span", { className: "seo-hero__action" }, p.action),
        h("span", { className: "seo-hero__detail" }, p.detail),
      ),
    )),
  );
}

/** The site review's dropped findings: one quiet line, the list behind it. */
export function ReviewDropped({ grounding }: { grounding?: SeoReviewGrounding | null }): ReactNode {
  const dropped = reviewDropped(grounding);
  if (!dropped) return null;
  return h("details", { className: "seo-dropped" },
    h("summary", { className: "seo-lab__meta" }, dropped.line),
    h("ul", { className: "seo-dropped__list" },
      dropped.items.map((d, i) => h("li", { key: i },
        d.insight, " ", h("span", { className: "seo-dropped__why" }, `— ${d.reason}`),
      )),
    ),
  );
}

/** A brief's schema: the types with the reason, or the reason there are none. */
export function BriefSchema({ brief }: { brief: Pick<SeoBrief, "schema_recommended" | "schema_note"> }): ReactNode {
  const { types, note } = briefSchema(brief);
  return h("div", { className: "seo-brief__block" },
    h("span", { className: "seo-stat__label" }, "Structured data"),
    types.length > 0 && h("div", { className: "seo-cluster__kws" },
      types.map((t) => h("span", { key: t, className: "seo-chip" }, t)),
    ),
    note && h("div", { className: "seo-brief__line" }, note),
  );
}
