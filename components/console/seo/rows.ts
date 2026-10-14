/** The SEO console's grounded-advice rows — the pieces the recommendations
 *  contract changed, kept presentational so `seo.test.ts` can render them.
 *
 *  Every decision is in `seo.ts`; these only draw it. Plain `.ts` with
 *  `createElement`, not `.tsx`, for the same reason as `mr/reportFrame.ts`:
 *  the suite cannot import a `.tsx` module, and these are exactly the rows
 *  whose rendered output the contract is about — a bare "Rule: ", "low" on a
 *  decorative image, an empty "This week" box.
 */

import { createElement as h, Fragment, type ReactNode } from "react";
import type {
  SeoAuditIssue, SeoBrief, SeoPageIntel, SeoPagesDoc, SeoPagesGrounding, SeoPlanItem, SeoReviewGrounding,
  SeoSiteReview, SeoTodo, SeoTopic,
} from "@/lib/api";
import {
  auditEvidence, auditTone, briefSchema, hiddenSuggestionsLine, missingTopics, morePagesLine, movedFixLinks, pageChips,
  pageRec, planHeading, planItemView, refreshHref, reviewDropped, todoPages, topicAngle, topicDifficulty, topicOrigin,
} from "./seo";

/** Jump to a Fix-list item by its to-do id: opens the list, scrolls to it. */
export type SeeFix = (todoId: string) => void;

/** An in-page link to a Fix-list item — a button, since it moves focus
 *  within the page rather than going anywhere. */
const fixLink = (todoId: string, text: string, onSeeFix?: SeeFix) =>
  h("button", { type: "button", className: "seo-ref", onClick: () => onSeeFix?.(todoId) }, text);

const fmt = (n: number) => n.toLocaleString("en-US");

/** One page in the Pages tab: its flags and `rec_chip` as chips (each label
 *  once), its advice as one line — or no line, when the chips are the whole
 *  message. */
export function PageRow({ p }: { p: SeoPageIntel }): ReactNode {
  const rec = pageRec(p);
  const chips = pageChips(p);
  return h("div", { className: "seo-pages__row" },
    h("div", { className: "seo-pages__main" },
      h("div", { className: "seo-pages__head" },
        p.url
          ? h("a", { className: "seo-pages__path", href: p.url, target: "_blank", rel: "noreferrer" }, p.path)
          : h("span", { className: "seo-pages__path" }, p.path),
        h("span", { className: "seo-pages__title" }, p.title || "No title"),
      ),
      chips.length > 0 && h("div", { className: "seo-pages__flags" },
        chips.map((chip) =>
          h("span", { key: chip.key, className: `seo-chip ${chip.ok ? "seo-chip--on" : "seo-chip--sev-medium"}` }, chip.label)),
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

/** "N suggestions hidden … · M moved to your Fix list" — quiet, and only when
 *  something was; each moved category links to the Fix-list item it became. */
export function HiddenSuggestions({ grounding, fixItems, todos = [], onSeeFix }: {
  grounding?: SeoPagesGrounding | null;
  fixItems?: SeoPagesDoc["fix_items"] | null;
  todos?: readonly Pick<SeoTodo, "id" | "origin" | "category">[];
  onSeeFix?: SeeFix;
}): ReactNode {
  const line = hiddenSuggestionsLine(grounding);
  if (!line) return null;
  const links = movedFixLinks(fixItems, todos);
  return h("p", { className: "seo-lab__meta" },
    line,
    links.map((l, i) => h(Fragment, { key: i },
      " · ",
      l.todoId ? fixLink(l.todoId, l.label, onSeeFix) : l.label,
    )),
  );
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
      ev.note && h("div", { className: "seo-issue__fix" }, ev.note),
      ev.lines.map((l) => h("div", { key: l, className: "seo-brief__line" }, l)),
    ),
    !ev?.coversPages && pages.map((p) => h("div", { key: p, className: "seo-brief__line" }, p)),
    // the backend lists at most 15 of the pages it counts
    morePagesLine(issue) && h("div", { className: "seo-brief__line seo-brief__more" }, morePagesLine(issue)),
  );
}

/** "This week" — up to three moves, or nothing at all for an empty plan. A
 *  move that is a Fix-list item says "See Fix list #n · label" and links
 *  there; it does not repeat the item's text. */
export function PlanStrip({ plan, todos = [], onSeeFix }: {
  plan: readonly SeoPlanItem[];
  todos?: readonly Pick<SeoTodo, "id">[];
  onSeeFix?: SeeFix;
}): ReactNode {
  const items = plan.slice(0, 3);
  const heading = planHeading(items.length);
  if (!heading) return null;
  return h("div", { className: "seo-hero" },
    h("div", { className: "seo-hero__title" }, heading),
    items.map((p, i) => {
      const v = planItemView(p, todos);
      return h("div", { key: i, className: "seo-hero__item" },
        h("span", { className: "seo-hero__num" }, i + 1),
        v.kind === "fix"
          ? h("div", { className: "seo-hero__body" },
              h("span", { className: "seo-hero__action" },
                fixLink(v.todoId, `See Fix list #${v.index}`, onSeeFix),
                v.label ? ` · ${v.label}` : null,
              ))
          : h("div", { className: "seo-hero__body" },
              h("span", { className: "seo-hero__action" }, v.title),
              v.detail && h("span", { className: "seo-hero__detail" }, v.detail),
            ),
      );
    }),
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

/* ---------------------------------------------------------- topics -- */

const TREND_LABEL: Record<string, string> = { rising: "Rising", falling: "Cooling", flat: "Steady", new: "New" };

function TrendChip({ trend }: { trend: unknown }): ReactNode {
  const label = typeof trend === "string" ? TREND_LABEL[trend] : undefined;
  return label ? h("span", { className: `seo-chip seo-chip--trend-${trend}` }, label) : null;
}

/** "we rank #2" for a typed seed already in the top 3 — calm, in place of a
 *  red "hard" — otherwise the difficulty as before. */
function DifficultyChip({ t }: { t: SeoTopic }): ReactNode {
  const d = topicDifficulty(t);
  const cls = d.tone === "rank" ? " seo-chip--on" : d.tone === "none" ? "" : ` seo-chip--diff-${d.tone}`;
  return h("span", { className: `seo-chip${cls}` }, d.label);
}

/** One blog topic: where it came from, its chips, the why, and — only when
 *  there is one — a page to refresh instead and its impact line. A topic that
 *  is also a Fix-list item says so in its why; there is no second chip. */
export function TopicRow({ t, index, focused = false }: { t: SeoTopic; index: number; focused?: boolean }): ReactNode {
  const origin = topicOrigin(t);
  const angle = topicAngle(t.angle);
  const refresh = refreshHref(t.refresh_url);
  const impact = typeof t.impact === "string" && t.impact.trim() ? t.impact : null;
  const tier = t.priority === "high" ? "high" : t.priority === "medium" ? "medium" : "watch";
  // an anchor for "In your blog plan as #n"
  return h("div", { id: `seo-topic-${index}`, tabIndex: -1, className: `seo-topic${focused ? " seo-topic--focus" : ""}` },
    h("div", { className: "seo-topic__main" },
      h("span", { className: "seo-topic__kw" }, h("span", { className: "seo-topic__num" }, index), " ", t.keyword),
      h("div", { className: "seo-topic__chips" },
        h("span", { className: `seo-chip seo-chip--src seo-chip--src-${origin.key}` }, origin.label),
        origin.fromSeed && h("span", { className: "seo-topic__from" }, `from: ${origin.fromSeed}`),
        h("span", { className: `seo-chip seo-chip--tier-${tier}` }, `${t.priority} priority`),
        angle && h("span", { className: "seo-chip" }, angle),
        t.intent && h("span", { className: "seo-chip" }, t.intent),
        h(TrendChip, { trend: t.trend }),
        h(DifficultyChip, { t }),
      ),
      h("div", { className: "seo-topic__why" }, t.why),
      refresh && h("a", { className: "seo-topic__refresh", href: refresh, target: "_blank", rel: "noreferrer", title: refresh },
        "Refresh this page instead"),
      impact && h("div", { className: "seo-topic__impact" }, impact),
    ),
    h("div", { className: "seo-topic__nums" },
      h("span", { className: "seo-topic__vol" }, t.volume_label),
      t.est_monthly_clicks != null && h("span", { className: "seo-stat__num--good" }, `≈ +${fmt(t.est_monthly_clicks)} clicks/mo`),
    ),
  );
}

/* ---------------------------------------------------------- the Fix list -- */

/** "On N pages", opening to the list — for a fix that spans pages. */
export function TodoPages({ pages }: { pages: unknown }): ReactNode {
  const v = todoPages(pages);
  if (!v) return null;
  return h("details", { className: "seo-todo__pages" },
    h("summary", null, v.label),
    h("ul", null, v.items.map((p, i) => h("li", { key: i },
      p.href ? h("a", { href: p.href, target: "_blank", rel: "noreferrer" }, p.text) : p.text,
    ))),
  );
}

/* ---------------------------------------------- the site review's gaps -- */

/** Topics the site does not cover yet. One that is already in the blog plan
 *  points there — "In your blog plan as #n" — rather than standing as a second
 *  copy of it — and only while this plan has that place. */
export function MissingTopics({ list, planSize, onSeeTopic }: {
  list: SeoSiteReview["missing_topics"] | null | undefined;
  planSize: number;
  onSeeTopic?: (n: number) => void;
}): ReactNode {
  const items = missingTopics(list);
  if (!items.length) return null;
  return h("div", { className: "seo-cluster__kws" },
    items.map((t, i) => {
      // a position this plan does not have would be a false pointer
      if (t.inPlan === null || t.inPlan > planSize) {
        return h("span", { key: i, className: "seo-chip seo-chip--cov-gap" }, t.text);
      }
      const n = t.inPlan;
      return h("span", { key: i, className: "seo-chip seo-chip--src" },
        t.text, " · ",
        h("button", { type: "button", className: "seo-ref", onClick: () => onSeeTopic?.(n) }, `In your blog plan as #${n}`),
      );
    }),
  );
}
