"use client";

import { useCallback, useEffect, useState } from "react";
import "@/app/needs-answer.css";
import { api } from "@/lib/dashboard-api";
import { Badge, LoadingLines } from "@/components/dashboard/list-kit";
import {
  COMMENT_LIMIT, draftProblem, EMPTY_DRAFT, errorsFrom, hasOptions, limitOf, NeedJob, NeedPayload, NeedQuestion, openCount, planSave, skippableIds, type Draft,
} from "@/lib/question-model";

type SaveReply = { ok?: boolean; error?: string; results?: unknown };

/** POST that keeps the server's reason (the shared apiPost hides it behind a generic message). */
async function post(path: string, body: unknown, csrf: string | null): Promise<SaveReply> {
  const response = await fetch(path, {
    method: "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: JSON.stringify(body),
  });
  let data: SaveReply = {};
  try { data = (await response.json()) as SaveReply; } catch { /* not JSON */ }
  if (response.status === 401) throw new Error("Sign in is required.");
  if (response.status === 403) throw new Error("Not allowed. Reload the page and try again.");
  if (!response.ok && response.status !== 422) throw new Error(data.error ?? "The request failed.");
  return data;
}

function QuestionField({ q, draft, error, disabled, onChange }: {
  q: NeedQuestion; draft: Draft; error?: string; disabled: boolean; onChange: (d: Draft) => void;
}) {
  const id = `nq-${q.id}`;
  const limit = limitOf(q);
  const len = draft.text.length;
  const problem = draft.mode === "answer" && draft.text ? draftProblem(q, draft) : null;
  const waiting = q.status === "agent_handle";
  return <fieldset className="nq-q" disabled={disabled}>
    <legend className="nq-label"><span className="nq-label-text">{q.label}</span>
      <span className="nq-meta"> {q.kind}{q.job_count > 1 ? `, asked on ${q.job_count} jobs` : ""}</span></legend>
    {waiting ? <p className="muted nq-wait">Waiting for the agent to draft this. You can still answer it yourself.</p> : null}
    {q.owner_comment ? <p className="muted">Your earlier comment: {q.owner_comment}</p> : null}
    <div className="nq-choice" role="radiogroup" aria-label={`How to handle: ${q.label}`}>
      <label className="check"><input type="radio" name={id} checked={draft.mode === "answer"} onChange={() => onChange({ ...draft, mode: "answer" })} /> I&apos;ll answer</label>
      {q.agent_allowed ? <label className="check"><input type="radio" name={id} checked={draft.mode === "agent"} onChange={() => onChange({ ...draft, mode: "agent" })} /> Agent handles it</label> : null}
      {draft.mode ? <button type="button" className="text-link" onClick={() => onChange(EMPTY_DRAFT)}>Clear</button> : null}
    </div>
    {draft.mode === "agent" ? <p className="muted">The agent will draft this from the job description and your resume, through the same checks. Add guidance in the comment below.</p> : null}
    {draft.mode === "answer" ? <div className="nq-answer">
      {hasOptions(q)
        ? <>
          <label className="sr-only" htmlFor={id}>Answer: {q.label}</label>
          <select id={id} className="nq-input" value={draft.text} onChange={(e) => onChange({ ...draft, text: e.target.value })}>
            <option value="">Choose an option</option>
            {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </>
        : <>
          <label className="sr-only" htmlFor={id}>Answer: {q.label}</label>
          <textarea id={id} className="nq-input nq-text" rows={q.maxlength && q.maxlength <= 80 ? 2 : 5} maxLength={limit} value={draft.text}
            onChange={(e) => onChange({ ...draft, text: e.target.value })} />
          <div className={`nq-count${len > limit * 0.95 ? " warn" : ""}`}>{len} / {limit}{q.maxlength ? " (form limit)" : ""}</div>
        </>}
      {q.suggested && draft.text !== q.suggested ? <p className="nq-suggest">Suggested from your resume: <b>{q.suggested}</b>{" "}
        <button type="button" className="text-link" onClick={() => onChange({ ...draft, text: q.suggested as string })}>Use this</button></p> : null}
      <label className="check"><input type="checkbox" checked={draft.always} onChange={(e) => onChange({ ...draft, always: e.target.checked })} /> Use this for similar questions later</label>
      {problem ? <p className="nq-error" role="alert">{problem}</p> : null}
    </div> : null}
    {error ? <p className="nq-error" role="alert">{error}</p> : null}
  </fieldset>;
}

function JobCard({ job, csrf, onSaved }: { job: NeedJob; csrf: string | null; onSaved: (text: string) => void }) {
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [banner, setBanner] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const plan = planSave(job, drafts);
  const setDraft = (id: number, d: Draft) => { setDrafts((s) => ({ ...s, [id]: d })); setBanner(null); };

  const send = async (calls: { path: string; body: unknown }[], done: string) => {
    setBusy(true); setBanner(null); setErrors({});
    const failed: Record<number, string> = {};
    let fatal: string | null = null;
    try {
      for (const call of calls) {
        const r = await post(call.path, call.body, csrf);
        Object.assign(failed, errorsFrom(r.results));
        if (r.ok === false && !Object.keys(errorsFrom(r.results)).length && r.error) fatal = r.error;
      }
    } catch (e) { fatal = e instanceof Error ? e.message : "The request failed."; }
    setBusy(false);
    setErrors(failed);
    if (!fatal && !Object.keys(failed).length) { setDrafts({}); setComment(""); }
    if (fatal) { setBanner({ tone: "bad", text: fatal }); return; }
    if (Object.keys(failed).length) { setBanner({ tone: "bad", text: "Some questions were not saved. See the messages under them." }); }
    else setBanner({ tone: "ok", text: done });
    window.dispatchEvent(new Event("inbox-changed"));
    onSaved(done);
  };

  const save = () => {
    const calls: { path: string; body: unknown }[] = [];
    const note = comment.trim() ? { comment } : {};
    if (plan.answers.length) calls.push({ path: "/api/apply-questions/answer", body: { answers: plan.answers, ...note } });
    if (plan.agentIds.length) calls.push({ path: "/api/apply-questions/agent-handle", body: { ids: plan.agentIds, ...note } });
    if (!calls.length) return;
    const n = plan.answers.length + plan.agentIds.length;
    void send(calls, `Saved ${n} question${n === 1 ? "" : "s"}.`);
  };
  const skip = () => {
    const ids = skippableIds(job);
    if (!ids.length) return;
    void send([{ path: "/api/apply-questions/skip", body: { ids, ...(comment.trim() ? { comment } : {}) } }], "Marked as done by hand. The job will not be retried.");
  };

  return <article className="nq-card">
    <div className="nq-head">
      <div className="inbox-badges"><Badge tone="warn">Needs your answer</Badge><Badge>{openCount(job)} open</Badge></div>
      <h3 className="nq-title">{job.title}{job.company ? <span className="nq-company"> at {job.company}</span> : null}</h3>
      <div className="nq-links">
        {job.apply_url ? <a href={job.apply_url} target="_blank" rel="noopener noreferrer">Open the application form</a> : <span className="muted">No apply link stored</span>}
        {job.host ? <span className="muted"> on {job.host}</span> : null}
      </div>
      {job.resume_pdf || job.ats_note ? <div className="muted nq-extra">{job.resume_pdf ? <span>Resume: <code className="break">{job.resume_pdf}</code></span> : null}{job.ats_note ? <span> ATS: {job.ats_note}</span> : null}</div> : null}
    </div>
    {job.questions.map((q) => q.status === "open" || q.status === "agent_handle"
      ? <QuestionField key={q.id} q={q} draft={drafts[q.id] ?? EMPTY_DRAFT} error={errors[q.id] ?? plan.blocked.find((b) => b.id === q.id)?.reason} disabled={busy} onChange={(d) => setDraft(q.id, d)} />
      : null)}
    <div className="nq-comment">
      <label htmlFor={`nqc-${job.job_id}`}>Comment for this job (optional)</label>
      <textarea id={`nqc-${job.job_id}`} className="nq-input nq-text" rows={2} maxLength={COMMENT_LIMIT} value={comment} disabled={busy}
        onChange={(e) => { setComment(e.target.value); setBanner(null); }}
        placeholder="Guidance for the agent, or a note such as: I applied by hand" />
    </div>
    <div className="inbox-actions">
      <button type="button" className="button primary" disabled={busy || !csrf || plan.idle} onClick={save}>{busy ? "Saving" : "Save"}</button>
      <button type="button" className="button" disabled={busy || !csrf} onClick={skip} title="Stops asking about this job">I applied by hand / skip</button>
    </div>
    <div aria-live="polite">{banner ? <p className={banner.tone === "ok" ? "nq-ok" : "nq-error"}>{banner.text}</p> : null}</div>
  </article>;
}

/** The "Needs your answer" group at the top of the Inbox: one card per job with every missing question. */
export function NeedsAnswer({ csrf }: { csrf: string | null }) {
  const [data, setData] = useState<NeedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<NeedPayload>("/api/apply-questions?status=open")); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "The questions could not be loaded."); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("inbox-reload", refresh);
    return () => window.removeEventListener("inbox-reload", refresh);
  }, [load]);

  return <section className="nq" aria-labelledby="nq-heading">
    <h2 id="nq-heading" className="nq-heading">Needs your answer{data ? <span className="nq-count-badge"> {data.counts.questions}</span> : null}</h2>
    <p className="muted">These applications are paused because a form asked something your answer book does not cover. Answer here, or let the agent write a free-text one.</p>
    {!data && !error ? <div className="object-list"><LoadingLines /></div> : null}
    {error ? <div className="notice danger"><strong>Could not load the questions.</strong><br />{error} <button type="button" className="button" onClick={() => void load()}>Try again</button></div> : null}
    {data && !data.jobs.length && !error ? <div className="empty-state"><h3>No application is waiting for an answer</h3>When a form asks something new, it shows up here with the job.</div> : null}
    {data?.jobs.map((job) => <JobCard key={job.job_id} job={job} csrf={csrf} onSaved={() => void load()} />)}
  </section>;
}
