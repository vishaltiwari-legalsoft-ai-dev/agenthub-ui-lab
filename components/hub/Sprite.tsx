"use client";

/** The console's icons, drawn by Lucide.
 *
 *  The revamp retires the hand-drawn sprite sheet for Lucide's set — one
 *  consistent, professionally-hinted line family — while keeping the `Ic`
 *  contract every call site already speaks: `<Ic name="home" />`. The map
 *  below is the whole change; sizes still come from each context's CSS, and
 *  the global `svg[aria-hidden]` rule keeps the 1.6px stroke this console
 *  has always drawn, so the icons sit in the type the way the old ones did.
 *
 *  An unknown name renders a dashed circle rather than nothing: a missing
 *  icon should look missing, not like a layout gap.
 */

import type { LucideIcon } from "lucide-react";
import {
  Activity, ArrowDown, ArrowUp, Bell, BookOpen, Brush, CalendarClock, CalendarDays, Clock,
  ChartLine, ChartPie, Check, ChevronRight, CircleDashed, Compass, Database,
  Download, Feather, Files, FileText, Filter, Gauge, Globe, Hash, HeartPulse,
  House, Images, Inbox, Info, Layers, LayoutDashboard, LayoutGrid, Link2, MailPlus,
  Megaphone, MessageCircle, Minus, Moon, NotebookPen, Palette, PenLine, Plug, Plus,
  RotateCcw, Search, SearchCheck, Send, Settings, ShieldCheck,
  SlidersVertical, Sparkles, Store, Sun, Swords, Target, TrendingUp,
  TriangleAlert, Type, UserRound, Wrench, X,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  // the shell
  home: House, issues: TriangleAlert, agents: LayoutGrid, runs: Activity,
  library: Images, models: SlidersVertical, integrations: Plug,
  settings: Settings, admin: ShieldCheck, plan: CalendarDays,
  search: Search, bell: Bell, chevron: ChevronRight,
  // verbs
  plus: Plus, check: Check, x: X, up: ArrowUp, send: Send, download: Download,
  fix: Wrench, tries: RotateCcw, sweep: Sparkles,
  // direction, for a change on the period before
  down: ArrowDown, flat: Minus,
  // appearance
  sun: Sun, moon: Moon,
  // the workspaces
  globe: Globe, desk: LayoutDashboard, reports: FileText, vendors: Store,
  leads: Filter, ask: MessageCircle, data: Database, lines: ChartLine,
  layers: Layers, kit: Palette, draft: PenLine, research: BookOpen,
  overview: Gauge, trend: TrendingUp, sources: Link2, competitors: Swords,
  optimizer: Target, pages: Files, keywords: Hash, health: HeartPulse,
  // field-type marks for the record's grid (Runs)
  text: Type, user: UserRound, clock: Clock, info: Info,
  // the specialists, one mark each — keyed by agent id so a card can say
  // `<Ic name={agent.id} />` and be sure of a face
  a1: Brush, a2: SearchCheck, a6: ChartPie, a9: NotebookPen, a10: Globe,
  a12: Inbox, a3: Feather, a4: CalendarClock, a5: Megaphone, a7: MailPlus,
  a8: Compass,
};

export function Ic({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] ?? CircleDashed;
  return <I aria-hidden="true" focusable="false" className={className} />;
}

/** The sprite sheet is gone — Lucide draws each icon inline — but the shell
 *  still mounts `<Sprite />`, so it stays as a polite no-op. */
export function Sprite() {
  return null;
}
