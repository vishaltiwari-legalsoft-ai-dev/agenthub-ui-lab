"use client";

/** The work bar: what the dark rail used to hold for a workspace, laid as
 *  one row under the header — the way back, the specialist's identity, its
 *  subjects when it has more than one, and its sections. Workspaces that
 *  have not registered a WorkNav (the legacy three) get back and identity
 *  and keep their own internal navigation.
 *
 *  A handful of subjects sit as chips. Past `SUBJECT_CHIPS_MAX` they fold into
 *  one picker — the current subject on a button, the rest in a searchable
 *  list — because twelve brands as chips wrapped every label onto two lines
 *  and pushed the row out of its card. The picker moves exactly as a chip
 *  did: it calls the workspace's `onSubject`, so routes and links do not
 *  change.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WorkNav, WorkSubject } from "./context";
import { filterSubjects, usesSubjectPicker, type HubAgent } from "./model";
import { Ic } from "./Sprite";
import { Mono } from "./ui";

export function WorkBar({
  agent, nav, backLabel, onBack,
}: {
  agent?: HubAgent;
  nav: WorkNav | null;
  backLabel: string;
  onBack: () => void;
}) {
  if (!agent) return null;
  const many = !!nav && usesSubjectPicker(nav.subjects.length);
  return (
    <div className="wbar">
      <button type="button" className="wbar__back" onClick={onBack} title={`Back to ${backLabel}`}>
        <Ic name="chevron" />
        {backLabel}
      </button>
      <span className="wbar__id">
        <Mono agent={agent} />
        <b>{agent.name}</b>
        <em>{agent.role}</em>
      </span>
      {nav && many && (
        <SubjectPicker
          subjects={nav.subjects}
          current={nav.subject}
          noun={nav.subjectNoun || "Brand"}
          onPick={nav.onSubject}
        />
      )}
      {nav && !many && nav.subjects.length > 1 && (
        <span className="wbar__subjects">
          {nav.subjects.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`wbar__subject${s.id === nav.subject ? " is-on" : ""}`}
              aria-current={s.id === nav.subject ? "true" : undefined}
              title={s.name}
              onClick={() => nav.onSubject(s.id)}
            >
              <u aria-hidden="true">{s.ab}</u>
              <span>{s.name}</span>
              <Busy on={s.busy} />
            </button>
          ))}
        </span>
      )}
      {nav && nav.sections.length > 0 && (
        <nav className="wbar__sections" aria-label="Workspace sections">
          {nav.sections.map((sec) => (
            <button
              type="button"
              key={sec.id}
              className={`wbar__sec${sec.id === nav.section ? " is-on" : ""}`}
              aria-current={sec.id === nav.section ? "page" : undefined}
              title={sec.label}
              onClick={() => nav.onSection(sec.id)}
            >
              <Ic name={sec.icon} />
              <span>{sec.label}</span>
              {sec.count != null && sec.count > 0 && <u>{sec.count.toLocaleString("en-US")}</u>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function Busy({ on }: { on?: boolean }) {
  if (!on) return null;
  return (
    <>
      <i className="wbar__go" aria-hidden="true" />
      <span className="sr">running now</span>
    </>
  );
}

/** The current subject on a button; the rest one search away.
 *
 *  Focus stays in the search box while the list is open (a combobox driving a
 *  listbox by `aria-activedescendant`), so typing filters and the arrows move
 *  at once. Esc, or a press anywhere outside, closes it; Esc and a pick hand
 *  focus back to the button. */
function SubjectPicker({
  subjects, current, noun, onPick,
}: {
  subjects: WorkSubject[];
  current: string;
  noun: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (k: number) => `${uid}-opt-${k}`;

  const on = subjects.find((s) => s.id === current);
  const shown = useMemo(() => filterSubjects(subjects, q), [subjects, q]);
  // Held inside the list even if it shrinks under an open menu (a refetch).
  const active = shown.length ? Math.min(idx, shown.length - 1) : -1;
  const word = noun.toLowerCase();

  // With no search the highlight starts on the current subject, so Enter
  // straight away keeps it; a search starts on the best match.
  const startAt = (list: WorkSubject[], query: string) =>
    query.trim() ? 0 : Math.max(0, list.findIndex((s) => s.id === current));

  const show = () => {
    setQ("");
    setIdx(startAt(subjects, ""));
    setOpen(true);
  };

  const hide = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const pick = (s: WorkSubject | undefined) => {
    if (!s) return;
    hide(true);
    // Re-picking the current subject is not a move: navigating to the same
    // route would only reset the header line under it.
    if (s.id !== current) onPick(s.id);
  };

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // The highlighted row stays in view as the arrows walk past the list's edge.
  useEffect(() => {
    if (open && active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = shown.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx(n ? (active + 1) % n : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx(n ? (active - 1 + n) % n : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide(true);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="wbar__pick" ref={wrap}>
      <button
        type="button"
        ref={button}
        className={`wbar__picker${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={on?.name}
        onClick={() => (open ? hide(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        <em>{noun}</em>
        <u aria-hidden="true">{on?.ab || "··"}</u>
        <span>{on?.name || `Choose a ${word}`}</span>
        <Busy on={on?.busy} />
        <i className="tnav__caret" aria-hidden="true"><Ic name="chevron" /></i>
      </button>

      {open && (
        <div className="tnav__menu wbar__menu">
          <label className="wbar__find">
            <Ic name="search" />
            <span className="sr">Find a {word}</span>
            <input
              ref={input}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optId(active) : undefined}
              value={q}
              placeholder={`Find a ${word}`}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                const next = e.target.value;
                setQ(next);
                setIdx(startAt(filterSubjects(subjects, next), next));
              }}
              onKeyDown={onKey}
            />
          </label>
          <ul id={listId} role="listbox" aria-label={`${noun}s`} className="wbar__opts">
            {shown.map((s, k) => {
              const cur = s.id === current;
              return (
                <li
                  key={s.id}
                  id={optId(k)}
                  role="option"
                  aria-selected={cur}
                  className={`wbar__opt${k === active ? " is-active" : ""}${cur ? " is-on" : ""}`}
                  title={s.name}
                  // Keep focus in the search box; the click below does the pick.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => k !== active && setIdx(k)}
                  onClick={() => pick(s)}
                >
                  <u aria-hidden="true">{s.ab}</u>
                  <span>{s.name}</span>
                  <Busy on={s.busy} />
                  {s.note && <em>{s.note}</em>}
                  <b className="wbar__tick" aria-hidden="true">{cur && <Ic name="check" />}</b>
                </li>
              );
            })}
          </ul>
          {shown.length === 0 && (
            <p className="wbar__none" role="status">No {word} matches “{q.trim()}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
