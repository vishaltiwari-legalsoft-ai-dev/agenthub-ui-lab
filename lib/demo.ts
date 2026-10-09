/** Demo data for the UI lab.
 *
 *  This repository exists to prototype the revamp, and a console whose every
 *  panel answers "Failed to fetch" cannot be judged. In preview mode
 *  (NEXT_PUBLIC_PREVIEW_NO_AUTH=1 — the lab's build flag) the API client asks
 *  this module before it asks the network: a GET whose path is known here is
 *  answered locally with believable fixtures typed against the real API
 *  shapes, and everything else falls through to the network exactly as
 *  before. Writes are never faked — a POST in the lab still fails honestly.
 *
 *  The live repository never sets the flag, so none of this exists there.
 */

import type {
  AdminSettings, AgentConfigResponse, Analytics,
  BwInventory, BwRun, BwRunSummary, BwVoice,
  CronJobsPayload, DbCollectionsResponse,
  GeoBrandConfig, GeoComparison, GeoGlobalConfig, GeoHistory,
  GeoMetricBlock, GeoPollStatus, GeoPromptUniverse, GeoReport, GeoStrategyDoc,
  InboxStatus, IssuesPayload, LibraryBrand,
  MrConfig, MrConnector, MrLeadAnalysis, MrOverview, MrPortfolio,
  MrReportPeriods, MrRunSummary, MrSheetSources, MrTargets, MrTrends,
  HumansDay, RunsPage, SeoBrand, SeoOverview, SeoRun, TeamUsage,
} from "./api";

const NOW = "2026-10-01T09:30:00Z";

/* ------------------------------------------------------------ helpers ---- */

/** A placeholder creative: a warm gradient with label text, as a data URI the
 *  browser can render without any store behind it. */
const art = (label: string, a: string, b: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><rect x="24" y="30" width="200" height="22" rx="8" fill="rgba(255,255,255,.92)"/><rect x="24" y="64" width="140" height="22" rx="8" fill="rgba(255,255,255,.8)"/><rect x="24" y="330" width="120" height="36" rx="18" fill="#14161C"/><text x="24" y="310" font-family="sans-serif" font-size="18" fill="rgba(0,0,0,.45)">${label}</text></svg>`,
  )}`;

/** Sixty days of runs by people ending on NOW's date, oldest first, every day
 *  present: quiet weekends, a slow climb, and today only a morning's worth. */
const humansDaily = (): HumansDay[] => {
  const end = Date.UTC(2026, 9, 1);
  return Array.from({ length: 60 }, (_, i) => {
    const t = new Date(end - (59 - i) * 86_400_000);
    const dow = t.getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const base = weekend ? 1 + (i % 3) : 6 + Math.round(i / 6) + ((i * 7) % 5);
    const runs = i === 59 ? 3 : base;
    return { day: t.toISOString().slice(0, 10), runs, people: Math.min(runs, weekend ? 1 : 2 + (i % 3)) };
  });
};

const mention = (rate: number | null, n = 70) => ({
  rate, stdev: rate === null ? null : 0.06, n_prompts: 14, n_answers: n,
});

const metricBlock = (rate: number, cited: number, n = 70): GeoMetricBlock => ({
  mention: mention(rate, n),
  sov: { share: { self: rate * 0.8, clio: 0.22, mycase: 0.11 }, credit: { self: 34, clio: 15, mycase: 8 }, unclaimed_answers: 13, n_answers: n },
  citation: { rate: cited, n_answers_with_citations: Math.round(n * 0.7), cited_answers: Math.round(n * 0.7 * cited) },
  source_mix: [
    { domain: "legalsoft.com", count: 18, share: 0.26 },
    { domain: "clio.com", count: 12, share: 0.17 },
    { domain: "g2.com", count: 9, share: 0.13 },
    { domain: "reddit.com", count: 7, share: 0.1 },
  ],
  n_answers: n, n_measured: n - 4, n_errors: 2, n_expected: 70, via_mix: { native: n - 10, serpapi: 10 },
});

const SEO_BRANDS: SeoBrand[] = [
  { id: "ls", name: "LegalSoft", domain: "legalsoft.com", gsc_property: "sc-domain:legalsoft.com", seeds: ["legal virtual assistants", "law firm intake"], enabled: true },
  { id: "ac", name: "Acme Health", domain: "acmehealth.com", gsc_property: "sc-domain:acmehealth.com", seeds: ["medical billing support"], enabled: true },
];

/* ------------------------------------------------------------- fixtures -- */

const runs = (): RunsPage => ({
  runs: [
    { id: "r1", run_id: "r1", agent_id: "a1", agent_name: "Graphic Designer", brand: "LegalSoft", brand_id: "ls", action: "creative", title: "Festive sale hero banner", state: "done", status_raw: "COMPLETED", created_at: "2026-10-01T09:20:00Z", updated_at: "2026-10-01T09:26:04Z", day: "2026-10-01", took_seconds: 364, image: null, user: "vishal@legalsoft.com" },
    { id: "r2", run_id: "r2", agent_id: "a6", agent_name: "Marketing Research", brand: "LegalSoft", brand_id: "ls", action: "report", title: "Weekly summary — all channels", state: "running", status_raw: "RUNNING", created_at: "2026-10-01T09:05:00Z", updated_at: "2026-10-01T09:05:00Z", day: "2026-10-01", took_seconds: null, image: null, user: "vishal@legalsoft.com" },
    { id: "r3", run_id: "r3", agent_id: "a9", agent_name: "Blog Writer", brand: "Acme Health", brand_id: "ac", action: "draft", title: "AI triage for legal inboxes — cited post", state: "queued", status_raw: "QUEUED", created_at: "2026-10-01T08:58:00Z", updated_at: "2026-10-01T08:58:00Z", day: "2026-10-01", took_seconds: null, image: null, user: "priya@legalsoft.com" },
    { id: "r4", run_id: "r4", agent_id: "a10", agent_name: "GEO", brand: "LegalSoft", brand_id: "ls", action: "check", title: "Question check across five engines", state: "done", status_raw: "COMPLETED", created_at: "2026-09-30T16:44:00Z", updated_at: "2026-09-30T16:52:00Z", day: "2026-09-30", took_seconds: 478, image: null, user: "vishal@legalsoft.com" },
    { id: "r5", run_id: "r5", agent_id: "a1", agent_name: "Graphic Designer", brand: "Acme Health", brand_id: "ac", action: "creative", title: "Ad set — four placements", state: "done", status_raw: "COMPLETED", created_at: "2026-09-30T14:10:00Z", updated_at: "2026-09-30T14:19:00Z", day: "2026-09-30", took_seconds: 540, image: null, user: "rahul@legalsoft.com" },
    { id: "r6", run_id: "r6", agent_id: "a2", agent_name: "SEO Analyst", brand: "LegalSoft", brand_id: "ls", action: "crawl", title: "Full crawl — legalsoft.com", state: "failed", status_raw: "FAILED: fetch timeout on /resources", created_at: "2026-09-30T11:02:00Z", updated_at: "2026-09-30T11:31:00Z", day: "2026-09-30", took_seconds: 1740, image: null, user: "vishal@legalsoft.com" },
    { id: "r7", run_id: "r7", agent_id: "a6", agent_name: "Marketing Research", brand: "LegalSoft", brand_id: "ls", action: "report", title: "Competitor digest — September", state: "done", status_raw: "COMPLETED", created_at: "2026-09-30T09:12:00Z", updated_at: "2026-09-30T09:24:00Z", day: "2026-09-30", took_seconds: 712, image: null, user: "priya@legalsoft.com" },
  ],
  total: 218, scanned: 7, scan_limit: 200, window_complete: true,
  facets: {
    agents: [
      { id: "a1", name: "Graphic Designer", count: 2 }, { id: "a6", name: "Marketing Research", count: 2 },
      { id: "a2", name: "SEO Analyst", count: 1 }, { id: "a9", name: "Blog Writer", count: 1 },
      { id: "a10", name: "GEO", count: 1 }, { id: "a12", name: "Inbox Triage", count: 0 },
    ],
    brands: [{ name: "LegalSoft", count: 5 }, { name: "Acme Health", count: 2 }],
    states: { done: 4, running: 1, queued: 1, failed: 1 },
  },
  week: {
    from: "2026-09-24", done: 23, running: 1, queued: 1, failed: 1, total: 26,
    by_agent: [
      { id: "a1", name: "Graphic Designer", count: 9 }, { id: "a6", name: "Marketing Research", count: 7 },
      { id: "a9", name: "Blog Writer", count: 5 }, { id: "a10", name: "GEO", count: 5 },
    ],
  },
  live: { running: 1, queued: 1 },
});

const issues = (): IssuesPayload => ({
  issues: [
    { id: "i1", severity: "high", area: "seo", brand_id: "ls", brand: "LegalSoft", code: "gsc_token", title: "Search Console connection expired", detail: "The crawl and fix list cannot refresh until the Google connection is renewed.", fix: { label: "Reconnect", workspace: "seo", subject: "ls", section: "fixes" }, since: "2026-09-29T10:00:00Z" },
    { id: "i2", severity: "medium", area: "geo", brand_id: "ac", brand: "Acme Health", code: "stale_questions", title: "GEO question set is 30 days old", detail: "Engines are being asked last month's questions; refresh the set to keep the scores honest.", fix: { label: "Refresh questions", workspace: "geo", subject: "ac", section: "questions" }, since: "2026-09-01T00:00:00Z" },
    { id: "i3", severity: "low", area: "runs", brand_id: "", brand: "", code: "failed_run", title: "One run failed this week", detail: "SEO Analyst stopped on a fetch timeout during the full crawl. The run is kept with the exact step it stopped on.", fix: null, since: "2026-09-30T11:31:00Z" },
  ],
  counts: { high: 1, medium: 1, low: 1 },
  generated_at: NOW,
});

const library = (): { brands: LibraryBrand[] } => ({
  brands: [
    {
      id: "ls", brand_name: "LegalSoft", creative_count: 24,
      creatives: [
        { file_name: "festive-hero.png", file_type: "png", view_url: art("Festive hero", "#C7D2FE", "#4F46E5"), is_image: true },
        { file_name: "webinar-promo.png", file_type: "png", view_url: art("Webinar promo", "#C7CDFF", "#3B4FE0"), is_image: true },
        { file_name: "intake-guide.png", file_type: "png", view_url: art("Intake guide", "#9BDFC6", "#0E8A63"), is_image: true },
        { file_name: "q4-offer.png", file_type: "png", view_url: art("Q4 offer", "#F08FA4", "#A33B57"), is_image: true },
      ],
    },
    {
      id: "ac", brand_name: "Acme Health", creative_count: 11,
      creatives: [
        { file_name: "billing-banner.png", file_type: "png", view_url: art("Billing banner", "#B5A4EE", "#54409F"), is_image: true },
        { file_name: "hiring-post.png", file_type: "png", view_url: art("Hiring post", "#3FA7D6", "#145C8E"), is_image: true },
      ],
    },
  ],
});

const seoOverview = (): SeoOverview => ({
  sources: { gsc: true, serp: true },
  brands: [
    {
      brand: SEO_BRANDS[0], gsc_connected: true,
      headline: "Clicks up 12% over the last 28 days; nine fixes still open.",
      last_run: { at: "2026-09-30T07:00:00Z", summary: { mode: "search-console", clicks_28d: 3480, clicks_prev_28d: 3104, impressions_28d: 148200, avg_position: 11.4, est_potential_clicks: 920 }, degraded: [], todo_count: 9, topic_count: 7 },
    },
    {
      brand: SEO_BRANDS[1], gsc_connected: true,
      headline: "Position holding steady; three fixes worth the week.",
      last_run: { at: "2026-09-30T07:10:00Z", summary: { mode: "search-console", clicks_28d: 1210, clicks_prev_28d: 1246, impressions_28d: 60400, avg_position: 14.2, est_potential_clicks: 410 }, degraded: [], todo_count: 3, topic_count: 5 },
    },
  ],
});

const seoRun = (): SeoRun => ({
  brand_id: "ls", at: "2026-09-30T07:00:00Z", trigger: "cron", degraded: [],
  summary: { mode: "search-console", clicks_28d: 3480, clicks_prev_28d: 3104, impressions_28d: 148200, avg_position: 11.4, est_potential_clicks: 920 },
  insights: [
    "The intake-checklist page gained 240 clicks after the rewrite — the pattern is worth repeating on the pricing page.",
    "Eleven queries sit at positions 8–12 where one content pass usually moves them to page one.",
    "Competitors are publishing weekly on paralegal staffing; our last post on it is five months old.",
  ],
  todos: [
    { id: "t1", kind: "rewrite", page: "/pricing", query: "legal virtual assistant cost", action: "Rewrite the title and lead to match the money query.", why: "Position 9 with 8,400 impressions — the click-through is the gap, not the ranking.", est_monthly_clicks: 210, position: 9.2, impressions: 8400, status: "todo" },
    { id: "t2", kind: "internal-link", page: "/services/intake", query: "law firm intake service", action: "Link from the three highest-traffic posts.", why: "The page ranks 11 with almost no internal links pointing at it.", est_monthly_clicks: 140, position: 11.0, impressions: 5200, status: "assigned" },
    { id: "t3", kind: "new-page", page: "/compare/clio-alternatives", query: "clio alternatives", action: "Publish the comparison the SERP already rewards.", why: "Rivals own this query; we have no page for it at all.", est_monthly_clicks: 180, position: 38.0, impressions: 2900, status: "todo" },
    { id: "t4", kind: "fix", page: "/blog/remote-paralegal", query: "remote paralegal services", action: "Restore the missing H1 and meta description.", why: "The crawl found the template dropped both in the last deploy.", est_monthly_clicks: 90, position: 13.5, impressions: 3600, status: "todo" },
    { id: "t5", kind: "refresh", page: "/guides/intake-checklist", query: "client intake checklist law firm", action: "Refresh the 2024 figures and screenshots.", why: "Top-3 position worth defending; freshness is the cheapest insurance.", est_monthly_clicks: 60, position: 2.8, impressions: 9100, status: "done" },
  ],
  topics: [
    { keyword: "ai intake for law firms", source: "gap", priority: "high", impact: "new page", angle: "What AI intake actually automates, with the staffing math.", volume_est: 1900, volume_label: "1.9k/mo", trend: "rising", difficulty: "medium", est_monthly_clicks: 160, why: "Rising query, no page, and the engines already cite two rivals.", score: 86, intent: "commercial" },
    { keyword: "legal va vs in-house paralegal", source: "serp", priority: "high", impact: "comparison", angle: "An honest cost table both sides would sign.", volume_est: 880, volume_label: "880/mo", trend: "flat", difficulty: "low", est_monthly_clicks: 120, why: "Mid-funnel query where comparisons win the click.", score: 79, intent: "commercial" },
    { keyword: "law firm intake scripts", source: "questions", priority: "medium", impact: "guide", angle: "Scripts as downloads, annotated line by line.", volume_est: 720, volume_label: "720/mo", trend: "rising", difficulty: "low", est_monthly_clicks: 95, why: "People-also-ask is full of it and nobody answers well.", score: 71, intent: "informational" },
    { keyword: "after hours answering legal", source: "gap", priority: "medium", impact: "service page", angle: "What after-hours coverage costs and catches.", volume_est: 540, volume_label: "540/mo", trend: "new", difficulty: "medium", est_monthly_clicks: 70, why: "New query cluster this quarter; first mover keeps it.", score: 64, intent: "commercial" },
  ],
  ga: null,
});

const mrOverview = (): MrOverview => {
  const ch = (spend: number, leads: number, ql: number, booked: number, done: number): import("./api").MrChannelAgg => ({
    spend, leads, qualified_leads: ql, demos_booked: booked, demos_completed: done,
    cost_per_lead: +(spend / leads).toFixed(2), cost_per_qualified_lead: +(spend / ql).toFixed(2),
    cost_per_demo_booked: +(spend / booked).toFixed(2), cost_per_demo_completed: +(spend / done).toFixed(2),
    cac: null,
    goal: { cpd_booked_low: 250, cpd_booked_high: 400, cpd_completed_low: 400, cpd_completed_high: 650 },
    status: { cost_per_demo_booked: "good", cost_per_demo_completed: "warn", cost_per_qualified_lead: "good" },
  });
  return {
    has_data: true, month: "2026-09",
    totals: ch(48200, 612, 294, 151, 96),
    channels: { google_ads: ch(26400, 310, 162, 84, 55), meta: ch(15800, 244, 98, 47, 28), hubspot: ch(6000, 58, 34, 20, 13) },
    flag_summary: [
      { metric: "cost_per_demo_completed", level: "warn", count: 1, text: "Meta's completed-demo cost ran 18% over goal this month." },
      { metric: null, level: "good", count: 1, text: "Google Ads is pacing under budget with QL ratio above target." },
    ],
    lead_quality: null,
    sources: [
      { platform: "google_ads", generated_at: "2026-09-30T23:10:00Z", metrics: 1240, leads: 310 },
      { platform: "meta", generated_at: "2026-09-30T23:10:00Z", metrics: 1180, leads: 244 },
    ],
  };
};

const mrPortfolio = (): MrPortfolio => ({
  date: "2026-09-30", month: "2026-09", vendors: 4,
  total_budget: 60000, total_spend: 48200, budget_utilized_pct: 80.3,
  leads: 612, qualified_leads: 294, cost_per_qualified_lead: 163.9,
  qual_demos_booked: 151, cost_per_qual_demo_booked: 319.2,
  demos_completed: 96, cost_per_demo_completed: 502.1,
  show_rate_pct: 63.6, services_sold: 21,
  pacing: { day: 30, days_in_month: 30, expected_pct: 100 },
  benchmarks: { cpqdb_max: 400, ql_ratio_min: 40, show_rate_min: 60, cac_target: 2300, cpql_red: 220 },
});

const geoConfig = (): GeoGlobalConfig => ({
  engines: { perplexity: true, gemini: true, chatgpt: true, aio: true, ai_mode: true },
  engine_status: {
    perplexity: { connected: true, mode: "native", model: "sonar", means: "Asked directly through Perplexity's own API." },
    gemini: { connected: true, mode: "native", model: "gemini-2.5-flash", means: "Asked directly through Google's Gemini API." },
    chatgpt: { connected: true, mode: "proxy", model: "gpt-5-mini", means: "An OpenRouter stand-in answers; not the consumer ChatGPT surface." },
    aio: { connected: true, mode: "serpapi", model: "google-ai-overview", means: "The real Google AI Overview, fetched per query — billed." },
    ai_mode: { connected: true, mode: "serpapi", model: "google-ai-mode", means: "The real Google AI Mode surface, fetched per query — billed." },
  },
  engine_labels: { perplexity: "Perplexity", gemini: "Gemini", chatgpt: "ChatGPT", aio: "AI Overviews", ai_mode: "AI Mode" },
  default_runs: 3, default_daily_cap: 400, default_aio_monthly_cap: 600,
});

const geoReport = (): GeoReport => ({
  brand_id: "ls", days: 7,
  blended: metricBlock(0.46, 0.31, 310),
  engines: {
    perplexity: metricBlock(0.58, 0.44), gemini: metricBlock(0.51, 0.36), chatgpt: metricBlock(0.42, 0.22),
    aio: metricBlock(0.33, 0.28, 48), ai_mode: metricBlock(0.37, 0.3, 48),
  },
  source_gap: [
    { domain: "g2.com", count: 14, example_prompt_ids: ["p2", "p4"] },
    { domain: "reddit.com", count: 9, example_prompt_ids: ["p3"] },
  ],
  competitors: { clio: mention(0.61, 310), mycase: mention(0.38, 310) },
  competitor_names: { clio: "Clio", mycase: "MyCase" },
  n_sweeps: 3,
  prompt_rollup: [
    { prompt_id: "p1", text: "Best virtual assistant services for law firms?", intent: "category", n: 15, self_rate: 0.67, cited_rate: 0.4, rivals: [{ key: "clio", count: 9 }], engines_hit: ["perplexity", "gemini", "chatgpt"] },
    { prompt_id: "p2", text: "How do law firms handle client intake after hours?", intent: "problem", n: 15, self_rate: 0.33, cited_rate: 0.2, rivals: [{ key: "clio", count: 11 }], engines_hit: ["perplexity", "gemini"] },
    { prompt_id: "p3", text: "Is outsourcing paralegal work worth it?", intent: "problem", n: 15, self_rate: 0.27, cited_rate: 0.13, rivals: [{ key: "mycase", count: 6 }], engines_hit: ["chatgpt", "gemini"] },
  ],
});

const geoComparison = (): GeoComparison => ({
  brand_id: "ls", days: 7,
  entities: ["self", "clio", "mycase"],
  names: { self: "LegalSoft", clio: "Clio", mycase: "MyCase" },
  domains: { self: "legalsoft.com", clio: "clio.com", mycase: "mycase.com" },
  rows: [
    { key: "self", name: "LegalSoft", is_self: true, domain: "legalsoft.com", mention: mention(0.46, 310), citation: { rate: 0.31, n_answers_with_citations: 220, cited_answers: 68 }, sov_share: 0.41, sov_credit: 34, avg_position: 1.8, per_engine: { perplexity: 0.58, gemini: 0.51, chatgpt: 0.42, aio: 0.33, ai_mode: 0.37 }, vs_self: null, match_names: ["LegalSoft", "legalsoft.com"] },
    { key: "clio", name: "Clio", is_self: false, domain: "clio.com", mention: mention(0.61, 310), citation: { rate: 0.47, n_answers_with_citations: 220, cited_answers: 103 }, sov_share: 0.49, sov_credit: 41, avg_position: 1.4, per_engine: { perplexity: 0.7, gemini: 0.64, chatgpt: 0.55, aio: 0.52, ai_mode: 0.49 }, vs_self: { n_prompts: 14, ahead: 4, behind: 8, tied: 1, both_absent: 1, behind_prompt_ids: ["p2", "p3"] }, match_names: ["Clio", "clio.com"] },
    { key: "mycase", name: "MyCase", is_self: false, domain: "mycase.com", mention: mention(0.38, 310), citation: { rate: 0.24, n_answers_with_citations: 220, cited_answers: 52 }, sov_share: 0.3, sov_credit: 25, avg_position: 2.4, per_engine: { perplexity: 0.44, gemini: 0.4, chatgpt: 0.35, aio: 0.3, ai_mode: 0.31 }, vs_self: { n_prompts: 14, ahead: 8, behind: 4, tied: 1, both_absent: 1, behind_prompt_ids: ["p1"] }, match_names: ["MyCase", "mycase.com"] },
  ],
  questions: [
    { prompt_id: "p1", text: "Best virtual assistant services for law firms?", intent: "category", n: 15, rates: { self: 0.67, clio: 0.53, mycase: 0.33 }, self_rate: 0.67, rivals_ahead: [], leader: "self", engines: ["perplexity", "gemini", "chatgpt"] },
    { prompt_id: "p2", text: "How do law firms handle client intake after hours?", intent: "problem", n: 15, rates: { self: 0.33, clio: 0.73, mycase: 0.27 }, self_rate: 0.33, rivals_ahead: [{ key: "clio", name: "Clio", rate: 0.73 }], leader: "clio", engines: ["perplexity", "gemini"] },
    { prompt_id: "p3", text: "Is outsourcing paralegal work worth it?", intent: "problem", n: 15, rates: { self: 0.27, clio: 0.6, mycase: 0.2 }, self_rate: 0.27, rivals_ahead: [{ key: "clio", name: "Clio", rate: 0.6 }], leader: "clio", engines: ["chatgpt", "gemini"] },
    { prompt_id: "p4", text: "What does a legal intake specialist cost?", intent: "category", n: 15, rates: { self: 0.47, clio: 0.47, mycase: 0.13 }, self_rate: 0.47, rivals_ahead: [], leader: "tie", engines: ["perplexity", "aio"] },
  ],
  untracked_domains: [
    { domain: "upwork.com", count: 11, answers_you_absent: 8, n_questions: 5, example_prompt_ids: ["p3"] },
    { domain: "lawyerist.com", count: 7, answers_you_absent: 5, n_questions: 4, example_prompt_ids: ["p2"] },
  ],
  n_answers: 310, n_measured: 306, tracked_competitors: 2,
});

const geoHistory = (): GeoHistory => {
  const pt = (date: string, at: string, score: number, mentionRate: number): import("./api").GeoHistoryPoint => ({
    date, at, source: "sweep", score, components: { mention: score * 0.5, citation: score * 0.3, sov: score * 0.2 },
    weights: { mention: 0.5, citation: 0.3, sov: 0.2 }, missing: [],
    mention_rate: mentionRate, citation_rate: mentionRate * 0.65, sov_self: 0.41,
    n_measured: 300, n_named: Math.round(300 * mentionRate), n_named_cited: Math.round(300 * mentionRate * 0.6),
    n_answers: 310, n_prompts: 14,
    engines: { perplexity: mentionRate + 0.1, gemini: mentionRate + 0.04, chatgpt: mentionRate - 0.04 },
    competitors: { clio: 0.6, mycase: 0.38 },
  });
  const points = [
    pt("20260903", "2026-09-03T07:00:00Z", 38, 0.34),
    pt("20260910", "2026-09-10T07:00:00Z", 41, 0.37),
    pt("20260917", "2026-09-17T07:00:00Z", 45, 0.41),
    pt("20260924", "2026-09-24T07:00:00Z", 47, 0.44),
    pt("20260930", "2026-09-30T07:00:00Z", 51, 0.46),
  ];
  return {
    brand_id: "ls", days: 90, points,
    trend: {
      current: points[4], previous: points[3], first: points[0],
      since_last: { change: 4, direction: "up" }, since_start: { change: 13, direction: "up" }, n_points: 5,
    },
    component_labels: { mention: "Named", citation: "Cited", sov: "Share of voice" },
    min_point_answers: 20, names: { clio: "Clio", mycase: "MyCase" }, backfill_days: 0,
  };
};

const bwRun = (): BwRun => ({
  id: "bw1", brand_id: "ls", brand_name: "LegalSoft", domain: "legalsoft.com",
  topic: "What AI triage saves a legal team every week",
  notes: "", created: "2026-09-29T12:00:00Z", status: "saturated",
  rounds: [
    { n: 1, at: "2026-09-29T12:05:00Z", queries: [{ angle: "studies", q: "email triage time cost knowledge workers study", hits: 8 }, { angle: "experts", q: "law firm operations email overload", hits: 6 }, { angle: "news", q: "AI email triage legal 2026", hits: 5 }], read: ["mckinsey.com", "abajournal.com", "hbr.org"], added: 7, gaps: ["No firm-size breakdown yet"] },
    { n: 2, at: "2026-09-29T12:18:00Z", queries: [{ angle: "anecdotes", q: "paralegal inbox workflow reddit", hits: 9 }, { angle: "competitors", q: "legal inbox tools comparison", hits: 4 }], read: ["reddit.com", "clio.com"], added: 5, gaps: [] },
  ],
  ledger: [
    { id: "e1", claim: "Knowledge workers spend 28% of the week on email.", quote: "…28 percent of the average workweek reading and answering e-mail…", url: "https://www.mckinsey.com/", source_name: "McKinsey Global Institute", source_class: "studies", date: "2023-07-01", credibility: "primary research" },
    { id: "e2", claim: "Small firms lose intake leads to slow response.", quote: "…firms responding after an hour saw conversion fall by more than half…", url: "https://www.abajournal.com/", source_name: "ABA Journal", source_class: "news", date: "2025-11-12", credibility: "trade press" },
    { id: "e3", claim: "Triage rules misfile urgent client mail.", quote: "…static rules routed a third of urgent client emails to the wrong queue…", url: "https://hbr.org/", source_name: "Harvard Business Review", source_class: "experts", date: "2024-03-08", credibility: "practitioner analysis" },
    { id: "e4", claim: "Paralegals describe inbox time as the day's biggest sink.", quote: "…I block two hours just to sort what came in overnight…", url: "https://www.reddit.com/r/paralegal/", source_name: "r/paralegal", source_class: "anecdotes", date: "2026-05-20", credibility: "first-hand, unverified" },
    { id: "e5", claim: "Deadline-bearing mail is the riskiest to miss.", quote: "…missed court-date notices remain a leading malpractice trigger…", url: "https://www.americanbar.org/", source_name: "American Bar Association", source_class: "studies", date: "2024-09-01", credibility: "primary research" },
    { id: "e6", claim: "Rivals pitch triage as replacement, not assistance.", quote: "…fully autonomous inbox that answers for you…", url: "https://www.clio.com/", source_name: "Competitor marketing", source_class: "competitors", date: "2026-02-10", credibility: "vendor claim" },
  ],
  gaps: [],
  draft: {
    meta: { title: "What AI triage saves a legal team every week", description: "The measured cost of the inbox, and what read-only triage gives back.", slug: "ai-triage-legal-team-week" },
    blocks: [
      { id: "b1", kind: "intro", heading: "", text: "A legal team's inbox is a quiet payroll line. Add up the sorting, the forwarding and the deadline-hunting, and email costs more hours than any matter on the board [e1].", cites: ["e1"], history: [] },
      { id: "b2", kind: "section", heading: "The hour that loses the client", text: "Intake is won in minutes. When a firm answers inside the hour, the lead converts; after that, conversion falls off a cliff [e2]. Triage that surfaces intake mail first is worth more than any autoresponder.", cites: ["e2"], history: [] },
      { id: "b3", kind: "section", heading: "Why static rules fail", text: "Folder rules feel safe until the day an urgent client email lands in the wrong queue — which practitioner studies say happens to a third of them [e3]. The fix is reading content, not matching senders.", cites: ["e3"], history: [] },
      { id: "b4", kind: "conclusion", heading: "Assistance, not replacement", text: "The honest pitch is read-only: one row per message in a sheet the team owns, deadlines gathered where they cannot be missed [e5]. Nothing sends, nothing deletes — the inbox stays yours [e4].", cites: ["e4", "e5"], history: [] },
    ],
    internal_links: [{ url: "https://legalsoft.com/services/intake", title: "Intake service" }],
    notes: ["Voice check passed against the studied profile."],
    guidelines_applied: true,
  },
  visuals: null,
});

/* --------------------------------------------------------------- router -- */

type Fix = () => unknown;

const STATIC: Record<string, Fix> = {
  "/api/runs": runs,
  "/api/issues": issues,
  "/api/news": () => ({ text: "Festive campaign assets are due Friday — brief the Graphic Designer early.", updated_at: "2026-09-30T08:00:00Z" }),
  "/api/usage/team": (): TeamUsage => ({
    generated_at: NOW,
    viewer: { manager: true, admin: true, matched_as: "Vishal Tiwari" },
    team: {
      manager: { name: "Vishal Tiwari", title: "Head of Growth" },
      today: "2026-10-01", week_from: "2026-09-25", month: "2026-10",
      reportees: [
        { name: "Priya Nair", title: "Content Lead", email: "priya@legalsoft.com", user_id: "u-priya", match: "email", last_login: "2026-10-01T08:10:00Z", today: 3, week: 14, month: 14, by_agent: { a9: 8, a2: 4, a1: 2 }, last_run_at: "2026-10-01T09:02:00Z", read_ok: true },
        { name: "Arjun Mehta", title: "Performance Marketer", email: "arjun@legalsoft.com", user_id: "u-arjun", match: "name", last_login: "2026-09-30T17:40:00Z", today: 0, week: 6, month: 6, by_agent: { a6: 5, a10: 1 }, last_run_at: "2026-09-30T17:55:00Z", read_ok: true },
        { name: "Sana Khan", title: "Designer", email: null, user_id: null, match: "none", last_login: null, today: 0, week: 0, month: 0, by_agent: {}, last_run_at: null, read_ok: true },
        { name: "Rohit Verma", title: "SEO Specialist", email: null, user_id: null, match: "ambiguous", last_login: null, today: 0, week: 0, month: 0, by_agent: {}, last_run_at: null, read_ok: true },
        { name: "Meera Iyer", title: "Analyst", email: "meera@legalsoft.com", user_id: "u-meera", match: "email", last_login: "2026-09-29T11:00:00Z", today: 0, week: 0, month: 0, by_agent: {}, last_run_at: null, read_ok: false },
      ],
      totals: { today: 3, week: 20, month: 20 },
    },
    humans: {
      months: [
        { year_month: "2026-09", runs: 61, users: 4, by_user: [
          { user_id: "u-priya", email: "priya@legalsoft.com", name: "Priya Nair", runs: 27 },
          { user_id: "u-arjun", email: "arjun@legalsoft.com", name: "Arjun Mehta", runs: 18 },
          { user_id: "u-vishal", email: "vishal@legalsoft.com", name: "Vishal Tiwari", runs: 12 },
          { user_id: "u-meera", email: "meera@legalsoft.com", name: "Meera Iyer", runs: 4 },
        ] },
        { year_month: "2026-10", runs: 3, users: 1, by_user: [
          { user_id: "u-priya", email: "priya@legalsoft.com", name: "Priya Nair", runs: 3 },
        ] },
        { year_month: "2026-08", runs: 0, users: 0, by_user: [] },
      ],
      excluded: "Scheduled runs (the cron user) are not counted.",
      daily: humansDaily(),
    },
  }),
  "/api/library": library,
  "/api/seo-geo/overview": seoOverview,

  "/api/mr/overview": mrOverview,
  "/api/mr/snapshots/portfolio": mrPortfolio,
  "/api/mr/snapshots/deltas": () => [] ,
  "/api/mr/snapshots": () => [],
  "/api/mr/config": (): MrConfig => ({ spreadsheet_id: "1AbCdemo", spreadsheet_url: "https://docs.google.com/spreadsheets/d/demo", year: 2026, competitors: [{ name: "Clio", url: "https://clio.com" }, { name: "MyCase", url: "https://mycase.com" }], schedule: [{ report: "weekly_summary", cadence: "Mondays 08:00" }, { report: "competitor_digest", cadence: "1st of month" }], thresholds: { cpql_red: 220, show_rate_min: 60 } }),
  "/api/mr/targets": (): MrTargets => ({ thresholds: { cpql_red: 220, show_rate_min: 60 }, channel_goals: { google_ads: { cpd_booked_low: 250, cpd_booked_high: 400, cpd_completed_low: 400, cpd_completed_high: 650, completed_demo_pct: 60 }, meta: { cpd_booked_low: 280, cpd_booked_high: 450, cpd_completed_low: 450, cpd_completed_high: 700, completed_demo_pct: 55 } }, edited: false }),
  "/api/mr/connectors": (): MrConnector[] => ([
    { key: "sheets", label: "Google Sheets tracker", logo: null, category: "data", status: "connected", detail: "The team workbook, pulled hourly." },
    { key: "google_ads", label: "Google Ads", logo: null, category: "ads", status: "connected", detail: "CSV export, last pulled last night." },
    { key: "meta", label: "Meta Ads", logo: null, category: "ads", status: "connected", detail: "CSV export, last pulled last night." },
    { key: "hubspot", label: "HubSpot", logo: null, category: "crm", status: "needs_setup", detail: "Connect to pull the lead funnel automatically." },
  ]),
  "/api/mr/runs": (): MrRunSummary[] => ([
    { id: "mr1", kind: "weekly_summary", generated_at: "2026-09-29T08:00:00Z", period: "2026-W39" },
    { id: "mr2", kind: "competitor_digest", generated_at: "2026-09-25T08:00:00Z", period: "2026-09" },
    { id: "mr3", kind: "board_report", generated_at: "2026-09-20T10:00:00Z", period: "2026-Q3" },
  ]),
  "/api/mr/report-periods": (): MrReportPeriods => ({ months: [{ period: "2026-09", label: "September 2026", current: true }, { period: "2026-08", label: "August 2026", current: false }], quarters: [{ period: "2026-Q3", label: "Q3 2026", current: true }] }),
  "/api/mr/lead-analysis": (): MrLeadAnalysis => ({ has_data: false, hint: "Connect the lead sheet to see per-vendor meeting outcomes here." }),
  "/api/mr/datasets": () => [],
  "/api/mr/sources": (): MrSheetSources => ({ enabled: true, service_account: "mr-reader@agentos.iam.gserviceaccount.com", sources: [{ id: "s1", label: "Team performance tracker", primary: true, include_in_dashboard: true, added_at: "2026-06-01T00:00:00Z", added_by: "vishal@legalsoft.com" }] }),
  "/api/mr/workbook": () => ({ tabs: [], count: 0 }),
  "/api/mr/trends": (): MrTrends => ({
    has_data: true, month: "2026-09",
    monthly: [
      { month: "2026-06", spend: 39500, leads: 480, qualified_leads: 210, demos_booked: 110, demos_completed: 66, cpql: 188.1 },
      { month: "2026-07", spend: 42800, leads: 530, qualified_leads: 241, demos_booked: 126, demos_completed: 78, cpql: 177.6 },
      { month: "2026-08", spend: 45100, leads: 568, qualified_leads: 262, demos_booked: 139, demos_completed: 87, cpql: 172.1 },
      { month: "2026-09", spend: 48200, leads: 612, qualified_leads: 294, demos_booked: 151, demos_completed: 96, cpql: 163.9 },
    ],
    channels: { google_ads: [{ month: "2026-09", spend: 26400, leads: 310, qualified_leads: 162 }], meta: [{ month: "2026-09", spend: 15800, leads: 244, qualified_leads: 98 }] },
    vendors: [{ vendor: "Northstar Media", spend_mtd: 18200, leads: 240, qualified_leads: 118, cpql: 154.2, spend_series: [{ month: "2026-08", spend: 17100 }, { month: "2026-09", spend: 18200 }] }],
    insights: [{ kind: "pace", level: "good", text: "Qualified leads are pacing 9% ahead of last month at the same spend." }, { kind: "efficiency", level: "warn", text: "Meta's completed-demo cost drifted 18% over goal." }],
  }),

  "/api/geo/config": geoConfig,
  "/api/geo/brands": () => ({
    brands: [
      { id: "ls", name: "LegalSoft", domain: "legalsoft.com", prompts: 14, recent_answers: 310, calls_used_today: 120, competitors: 2, auto_poll: true, poll_interval_days: 7, next_due_at: "2026-10-07T07:00:00Z" },
      { id: "ac", name: "Acme Health", domain: "acmehealth.com", prompts: 10, recent_answers: 180, calls_used_today: 0, competitors: 1, auto_poll: false, poll_interval_days: 7, next_due_at: null },
    ],
  }),

  "/api/cron/jobs": (): CronJobsPayload => ({
    generated_at: NOW, scheduler_ok: true, scheduler_error: null,
    jobs: [
      { id: "c1", name: "GEO weekly sweep", agent_id: "a10", agent_label: "GEO", endpoint: "POST /api/geo/cron/poll", purpose: "Asks every engine the brand questions and stores the answers.", why_time: "Early, before the team reads the scores.", schedule: { cron: "0 7 * * 1", timezone: "UTC" }, state: "ENABLED", last_attempt: { time: "2026-09-30T07:00:04Z", ok: true }, next_time: "2026-10-07T07:00:00Z", origin: "live_registered" },
      { id: "c2", name: "Tracker pull", agent_id: "a6", agent_label: "Marketing Research", endpoint: "POST /api/mr/ingest-sheet", purpose: "Pulls the team workbook so the boards stay current.", why_time: "Hourly during working hours.", schedule: { cron: "0 * * * *", timezone: "UTC" }, state: "ENABLED", last_attempt: { time: "2026-10-01T09:00:02Z", ok: true }, next_time: "2026-10-01T10:00:00Z", origin: "live_registered" },
      { id: "c3", name: "SEO weekly crawl", agent_id: "a2", agent_label: "SEO Analyst", endpoint: "POST /api/seo-geo/cron/run", purpose: "Re-crawls each brand and refreshes the fix list.", why_time: "Sunday night, so Monday opens with fresh lists.", schedule: { cron: "0 22 * * 0", timezone: "UTC" }, state: "ENABLED", last_attempt: { time: "2026-09-28T22:00:11Z", ok: true }, next_time: "2026-10-05T22:00:00Z", origin: "live_registered" },
      { id: "c4", name: "Inbox poll", agent_id: "a12", agent_label: "Inbox Triage", endpoint: "POST /api/inbox/cron/poll", purpose: "Reads new mail and writes the sheet rows.", why_time: "Every five minutes; the sheet should never be stale.", schedule: { cron: "*/5 * * * *", timezone: "UTC" }, state: "ENABLED", last_attempt: { time: "2026-10-01T09:25:00Z", ok: true }, next_time: "2026-10-01T09:30:00Z", origin: "live_registered" },
    ],
  }),

  "/api/inbox/status": (): InboxStatus => ({
    enabled: true,
    service_account_email: "inbox-writer@agentos.iam.gserviceaccount.com",
    gmail: { connected: true, address: "vishal@legalsoft.com", connected_at: "2026-09-12T10:00:00Z" },
    sheet: { id: "demo-sheet", url: "https://docs.google.com/spreadsheets/d/demo-sheet", title: "Vishal — Inbox triage", check: "ok", checked_at: "2026-10-01T09:25:00Z" },
    backfill: { state: "done", done: 1380, total: 1380 },
    last_poll: { at: "2026-10-01T09:25:00Z", ok: true, messages_read: 4, error: null },
    next_poll_at: "2026-10-01T09:30:00Z",
    rows_24h: 47, needs_review: 3, generated_at: NOW,
  }),

  "/api/blog/runs": () => ({
    runs: [
      { id: "bw1", brand_id: "ls", brand_name: "LegalSoft", topic: "What AI triage saves a legal team every week", created: "2026-09-29T12:00:00Z", status: "saturated" },
      { id: "bw2", brand_id: "ac", brand_name: "Acme Health", topic: "Medical billing backlogs: the honest fix list", created: "2026-09-26T15:00:00Z", status: "research" },
    ] satisfies BwRunSummary[],
  }),
  "/api/blog/brands": () => ({
    brands: [
      { id: "ls", name: "LegalSoft", domain: "legalsoft.com", inventory: { counts: { sitemap_urls: 184, blog_urls: 62, titled: 60 }, scanned: "2026-09-20T10:00:00Z" }, voice: { studied: "2026-09-20T10:20:00Z", count: 12 } },
      { id: "ac", name: "Acme Health", domain: "acmehealth.com", inventory: null, voice: null },
    ],
  }),

  "/api/admin/users": () => ({
    users: [
      { id: "u1", email: "vishal@legalsoft.com", name: "Vishal Tiwari", picture: "", provider: "google", created_at: "2026-05-02T09:00:00Z", last_login: "2026-10-01T08:40:00Z" },
      { id: "u2", email: "priya@legalsoft.com", name: "Priya Nair", picture: "", provider: "google", created_at: "2026-05-10T09:00:00Z", last_login: "2026-09-30T17:05:00Z" },
      { id: "u3", email: "rahul@legalsoft.com", name: "Rahul Mehta", picture: "", provider: "google", created_at: "2026-06-01T09:00:00Z", last_login: "2026-09-29T12:12:00Z" },
      { id: "u4", email: "sana@legalsoft.com", name: "Sana Khan", picture: "", provider: "google", created_at: "2026-07-15T09:00:00Z", last_login: "2026-09-25T10:30:00Z" },
    ],
    total: 4,
  }),
  "/api/admin/analytics": (): Analytics => ({
    total_requests: 1824,
    monthly: [
      { month: "2026-06", count: 310, by_brand: { LegalSoft: 240, "Acme Health": 70 } },
      { month: "2026-07", count: 420, by_brand: { LegalSoft: 310, "Acme Health": 110 } },
      { month: "2026-08", count: 512, by_brand: { LegalSoft: 370, "Acme Health": 142 } },
      { month: "2026-09", count: 582, by_brand: { LegalSoft: 433, "Acme Health": 149 } },
    ],
    by_brand: { LegalSoft: 1353, "Acme Health": 471 },
    by_category: { creatives: 760, reports: 420, drafts: 280, checks: 364 },
  }),
  "/api/admin/settings": (): AdminSettings => {
    const cat = [{ id: "claude-sonnet-5-5", name: "Claude Sonnet", provider: "anthropic", recommended: true, tier: "balanced" }, { id: "claude-opus-5-5", name: "Claude Opus", provider: "anthropic", tier: "flagship" }];
    return {
      openrouter: { api_key_set: true, api_key_hint: "sk-or-…9f2a", api_key_source: "override", model: "claude-sonnet-5-5", fast_model: "claude-haiku-4-5", image_model: "gemini-2.5-flash-image", vision_model: "claude-sonnet-5-5" },
      sources: { openrouter_api_key: "override" },
      keys: { openrouter: { set: true, hint: "sk-or-…9f2a", source: "override" }, perplexity: { set: true, hint: "pplx-…11c0", source: "env" }, gemini: { set: true, hint: "AIza…77d1", source: "env" }, openai: { set: false, hint: "", source: "unset" } },
      catalog: { openrouter_model: cat, openrouter_fast_model: cat, openrouter_image_model: cat, openrouter_vision_model: cat, gd_planner_model: cat, gd_polish_image_model: cat, gd_gradient_image_model: cat },
    };
  },
  "/api/admin/agents": (): AgentConfigResponse => {
    const cat = [{ id: "claude-sonnet-5-5", name: "Claude Sonnet", provider: "anthropic", recommended: true, tier: "balanced" }, { id: "claude-opus-5-5", name: "Claude Opus", provider: "anthropic", tier: "flagship" }, { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic", tier: "fast" }];
    const fields = ["openrouter_model", "openrouter_fast_model", "openrouter_image_model", "openrouter_vision_model", "gd_planner_model", "gd_polish_image_model", "gd_gradient_image_model"] as const;
    return {
      agents: [
        { id: "a1", name: "Graphic Designer", role: "Brand & visual assets", category: "creative", live: true, fields: ["openrouter_model", "openrouter_image_model", "gd_planner_model", "gd_polish_image_model", "gd_gradient_image_model"], overrides: {}, effective: { openrouter_model: "claude-sonnet-5-5", openrouter_image_model: "gemini-2.5-flash-image" } },
        { id: "a2", name: "SEO Analyst", role: "Search & rankings", category: "search", live: true, fields: ["openrouter_model", "openrouter_fast_model"], overrides: {}, effective: { openrouter_model: "claude-sonnet-5-5" } },
        { id: "a6", name: "Marketing Research", role: "Campaigns & funnel", category: "research", live: true, fields: ["openrouter_model"], overrides: {}, effective: { openrouter_model: "claude-sonnet-5-5" } },
        { id: "a9", name: "Blog Writer", role: "Deep-research drafts", category: "content", live: true, fields: ["openrouter_model"], overrides: { openrouter_model: "claude-opus-5-5" }, effective: { openrouter_model: "claude-opus-5-5" } },
      ],
      fields: [...fields],
      catalog: { openrouter_model: cat, openrouter_fast_model: cat, openrouter_image_model: cat, openrouter_vision_model: cat, gd_planner_model: cat, gd_polish_image_model: cat, gd_gradient_image_model: cat },
      tier_labels: { flagship: "Flagship", balanced: "Balanced", fast: "Fast" },
      global_defaults: { openrouter_model: "claude-sonnet-5-5", openrouter_fast_model: "claude-haiku-4-5", openrouter_image_model: "gemini-2.5-flash-image", openrouter_vision_model: "claude-sonnet-5-5", gd_planner_model: "claude-sonnet-5-5", gd_polish_image_model: "gemini-2.5-flash-image", gd_gradient_image_model: "google/gemini-3-pro-image" },
    };
  },
  "/api/admin/db/collections": (): DbCollectionsResponse => ({
    collections: [
      { name: "runs", label: "Runs", description: "Every run every specialist has filed.", count: 218 },
      { name: "brands", label: "Brands", description: "The shared brand registry.", count: 2 },
      { name: "geo_answers", label: "GEO answers", description: "Engine answers, scored.", count: 4260 },
      { name: "inbox_rows", label: "Inbox rows", description: "Triage rows mirrored to sheets.", count: 1380 },
    ],
    connected: true, database: "agentos", project: "legalsoft-prod",
  }),
  "/api/admin/image-library": () => ({ items: [], total: 0 }),

  "/api/gd/brands": () => ({
    brands: [
      { brand_id: "ls", name: "LegalSoft", slug: "legalsoft", source: "user", editable: true, logo_url: null, primary_colors: ["#14161C", "#4F46E5"], has_kit: true, reference_count: 12 },
      { brand_id: "ac", name: "Acme Health", slug: "acme-health", source: "user", editable: true, logo_url: null, primary_colors: ["#145C8E", "#3FA7D6"], has_kit: true, reference_count: 6 },
    ],
    default: "ls",
  }),
  "/api/gd/config": () => ({
    brand_id: "ls", brand_name: "LegalSoft",
    stage1_variants: [
      { id: "g1", title: "Indigo sweep", desc: "Cool gradient, left-lit.", css_gradient: "linear-gradient(120deg,#C7D2FE,#4F46E5)", prompt_file: "g1.txt" },
      { id: "g2", title: "Ink fade", desc: "Deep neutral, quiet.", css_gradient: "linear-gradient(120deg,#3E4756,#14161C)", prompt_file: "g2.txt" },
      { id: "g3", title: "Counsel blue", desc: "Steady, institutional.", css_gradient: "linear-gradient(120deg,#3FA7D6,#145C8E)", prompt_file: "g3.txt" },
    ],
    stage2_variants: [
      { id: "e1", title: "Scales of justice", desc: "Classic mark, modern cut.", subject: "scales of justice", category: "icon" },
      { id: "e2", title: "Signing hands", desc: "A deal closing.", subject: "hands signing a contract", category: "photo" },
      { id: "e3", title: "Gavel", desc: "Authority, sparingly.", subject: "wooden gavel", category: "icon" },
    ],
    stage2_categories: ["icon", "photo"],
    stage2_placements: [
      { key: "left", label: "Left", row: 1, col: 1 }, { key: "center", label: "Center", row: 1, col: 2 }, { key: "right", label: "Right", row: 1, col: 3 },
    ],
    fonts: ["Inter", "Archivo"], font_family: "Inter",
    font_variants: [{ name: "Inter", weight: 600, style: "normal", file: "inter-600.woff2" }],
    text_placements: [{ key: "top-left", label: "Top left", phrase: "top left" }, { key: "center", label: "Center", phrase: "centered" }],
    cta_placements: [{ key: "bottom-left", label: "Bottom left", phrase: "bottom left" }],
    text_colors: [
      { key: "ink", label: "Ink", swatch: "#0D0F12", phrase: "near-black ink" },
      { key: "white", label: "White", swatch: "#FFFFFF", phrase: "white" },
    ],
    stage3_elements: [
      { key: "headline", label: "Headline", token: "{HEADLINE}", placeable: true, colorable: true, sizable: true, placement_kind: "text" },
      { key: "cta", label: "CTA", token: "{CTA}", placeable: true, colorable: false, sizable: true, placement_kind: "cta" },
    ],
    text_size_pct_min: 3, text_size_pct_max: 14,
    default_text_size_pct: { headline: 8, cta: 4 },
    text_offset_px_range: 60, subheading_min: 0, subheading_max: 5,
    anchors: ["top-left", "center", "bottom-right"],
    shape_kinds: ["rect", "circle", "arrow"],
    icon_keys: ["star", "check", "shield"],
    logo_positions: [{ key: "br", label: "Bottom right", row: 3, col: 3 }],
    logo_size_pct_min: 4, logo_size_pct_max: 18, logo_offset_px_range: 40,
    aspect_ratios: [
      { ar: "1:1", label: "Square", dimensions: "1080\u00d71080", w: 1080, h: 1080, orientation: "square", default: true },
      { ar: "3:2", label: "Banner", dimensions: "1620\u00d71080", w: 1620, h: 1080, orientation: "landscape", default: false },
      { ar: "9:16", label: "Story", dimensions: "1080\u00d71920", w: 1080, h: 1920, orientation: "portrait", default: false },
    ],
    brand_kit_block: "LegalSoft \u2014 ink & marigold; Inter; speak plainly.",
    locked_colors: {
      gradient: ["#C7D2FE", "#818CF8"], text: "#0D0F12", accent: "#4F46E5",
      headline_highlight: { from: "#C7D2FE", to: "#A5B4FC", direction: "90deg" },
      cta: { from: "#14161C", to: "#14161C", direction: "90deg", shadow: "0 10px 24px -12px rgba(13,15,18,.5)" },
    },
    stage1_source_note: "Backgrounds come from the brand kit\u2019s gradient library.",
    onboarding_questions: [],
    discovery_questions: [],
    content_tokens: ["{HEADLINE}", "{SUBTEXT}", "{CTA}"],
  }),
  "/api/gd/ingested-brands": () => ({
    brands: [
      { id: "ls", name: "LegalSoft", logo_url: null, primary_colors: ["#14161C", "#4F46E5"], counts: { fonts: 2, logos: 3, reference_assets: 12 }, source: "user" },
      { id: "ac", name: "Acme Health", logo_url: null, primary_colors: ["#145C8E", "#3FA7D6"], counts: { fonts: 1, logos: 2, reference_assets: 6 }, source: "user" },
    ],
  }),
};

/** Parameterised routes, tried in order after the static map misses. */
const ROUTES: [RegExp, (m: RegExpMatchArray) => unknown][] = [
  [/^\/api\/seo-geo\/brands\/([^/]+)$/, (m) => ({
    brand: SEO_BRANDS.find((b) => b.id === m[1]) ?? SEO_BRANDS[0],
    run: m[1] === "ac" ? null : seoRun(),
    gsc: { connected: true, property: "sc-domain:legalsoft.com" },
    plan: [
      { source: "fixes", action: "Rewrite /pricing title", detail: "Highest-value open fix this week." },
      { source: "topics", action: "Brief: ai intake for law firms", detail: "Rising query with no page." },
      { source: "competitors", action: "Watch clio.com/blog", detail: "Publishing weekly on staffing." },
    ],
    site_review: null,
  })],
  [/^\/api\/seo-geo\/pages\/([^/]+)$/, () => ({ pages: null })],
  [/^\/api\/seo-geo\/keywords\/([^/]+)$/, () => ({ lab: null })],
  [/^\/api\/seo-geo\/competitors\/([^/]+)\/profiles$/, () => ({ profiles: null })],
  [/^\/api\/seo-geo\/competitors\/([^/]+)$/, () => ({ tracked: ["clio.com", "mycase.com"], suggested: ["smokeball.com"], shifts: [], feed: {} })],
  [/^\/api\/seo-geo\/briefs\/([^/]+)$/, () => ({ briefs: [] })],
  [/^\/api\/seo-geo\/audit\/([^/]+)$/, () => ({ report: null })],

  [/^\/api\/geo\/brands\/([^/]+)\/poll\/status$/, (m): GeoPollStatus => ({
    brand_id: m[1], pending: 0, done: 70, total: 70,
    auto_poll: m[1] === "ls", interval_days: 7,
    last_completed_at: "2026-09-30T07:40:00Z", next_due_at: m[1] === "ls" ? "2026-10-07T07:00:00Z" : null,
    due_now: false, due_reason: "Swept yesterday; next sweep is scheduled.",
    manual_check_used: false, manual_check_by: null, manual_check_unlocks_at: null,
  })],
  [/^\/api\/geo\/brands\/([^/]+)\/report$/, () => geoReport()],
  [/^\/api\/geo\/brands\/([^/]+)\/comparison$/, () => geoComparison()],
  [/^\/api\/geo\/brands\/([^/]+)\/history$/, () => geoHistory()],
  [/^\/api\/geo\/brands\/([^/]+)\/answers$/, () => ({ answers: [], total: 0 })],
  [/^\/api\/geo\/brands\/([^/]+)\/strategy$/, (m): GeoStrategyDoc => ({ brand_id: m[1], current: null, history: [] })],
  [/^\/api\/geo\/brands\/([^/]+)\/page-checks$/, () => ({ analyses: [] })],
  [/^\/api\/geo\/brands\/([^/]+)\/config$/, (m): GeoBrandConfig => ({
    brand_id: m[1],
    aliases: { self: ["LegalSoft", "Legal Soft"] },
    competitors: [
      { key: "clio", name: "Clio", aliases: ["Clio"], domain: "clio.com" },
      { key: "mycase", name: "MyCase", aliases: ["MyCase"], domain: "mycase.com" },
    ],
    daily_cap: 400, aio_monthly_cap: 600, poll_interval_days: 7, auto_poll: m[1] === "ls",
    last_poll_completed_at: "2026-09-30T07:40:00Z", enabled: true,
  })],
  [/^\/api\/geo\/brands\/([^/]+)\/prompts$/, (m): GeoPromptUniverse => ({
    brand_id: m[1],
    prompts: [
      { id: "p1", text: "Best virtual assistant services for law firms?", intent: "category", stage: "consideration", enabled: true, source: "ai", persona: "managing_partner" },
      { id: "p2", text: "How do law firms handle client intake after hours?", intent: "problem", stage: "awareness", enabled: true, source: "ai", persona: "ops_manager" },
      { id: "p3", text: "Is outsourcing paralegal work worth it?", intent: "problem", stage: "awareness", enabled: true, source: "ai", persona: "managing_partner" },
      { id: "p4", text: "What does a legal intake specialist cost?", intent: "category", stage: "purchase", enabled: true, source: "custom", persona: "ops_manager" },
      { id: "p5", text: "LegalSoft reviews", intent: "brand", stage: "purchase", enabled: true, source: "ai", persona: "" },
      { id: "p6", text: "Legal answering service vs virtual receptionist?", intent: "category", stage: "consideration", enabled: false, source: "ai", persona: "" },
    ],
    personas: [
      { key: "managing_partner", label: "Managing partner", description: "Owns the P&L; asks about cost and risk." },
      { key: "ops_manager", label: "Operations manager", description: "Runs intake day to day; asks about workflows." },
    ],
    updated_at: "2026-09-28T09:00:00Z",
  })],

  [/^\/api\/blog\/runs\/([^/]+)$/, () => bwRun()],
  [/^\/api\/blog\/brands\/([^/]+)\/inventory$/, (): BwInventory => ({
    domain: "legalsoft.com", scanned: "2026-09-20T10:00:00Z",
    posts: [
      { url: "https://legalsoft.com/blog/intake-checklist", title: "The client intake checklist that survives contact" },
      { url: "https://legalsoft.com/blog/remote-paralegal", title: "Remote paralegals: what actually transfers" },
      { url: "https://legalsoft.com/blog/after-hours", title: "After-hours coverage without burnout" },
    ],
    counts: { sitemap_urls: 184, blog_urls: 62, titled: 60 },
    notes: ["Two posts missing titles were skipped."],
  })],
  [/^\/api\/blog\/brands\/([^/]+)\/voice$/, (m): BwVoice => ({
    brand_id: m[1], studied: "2026-09-20T10:20:00Z",
    posts_read: ["intake-checklist", "remote-paralegal", "after-hours"], count: 12,
    profile: {
      tone: "Plain-spoken, numerate, allergic to hype.",
      sentences: "Short declaratives; one idea per sentence.",
      evidence: ["Claims carry a number or a source", "No superlatives without proof"],
      person: "Second person, addressed to the firm's operator.",
    },
  })],
];

/* ------------------------------------------------------------------ API -- */

export function demoAnswer(path: string, method = "GET"): { status?: number; body: unknown } | null {
  if ((method || "GET").toUpperCase() !== "GET") return null;
  const p = path.split("?")[0];
  const exact = STATIC[p];
  if (exact) return { body: exact() };
  for (const [re, fn] of ROUTES) {
    const m = p.match(re);
    if (m) return { body: fn(m) };
  }
  return null;
}
