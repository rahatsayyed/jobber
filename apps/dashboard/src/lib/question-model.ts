// Pure model for the Inbox "Needs your answer" group. No React, no fetch, no path aliases, so vitest can import this file directly.
// Question labels, options, job titles and comments are untrusted text: this file only counts, compares and builds request bodies;
// the UI renders every text as plain text.

export type QuestionKind = "text" | "select" | "radio" | "checkbox";
export type QuestionStatus = "open" | "answered" | "skipped" | "agent_handle";

export type NeedQuestion = {
  id: number; label: string; kind: QuestionKind; options: string[]; maxlength: number | null; status: QuestionStatus;
  answer: string | null; owner_comment: string | null; suggested: string | null; agent_allowed: boolean; job_count: number;
};
export type NeedJob = {
  job_id: string; title: string; company: string; apply_url: string | null; host: string; resume_pdf: string | null; ats_note: string | null;
  apply_status: string | null; questions: NeedQuestion[];
};
export type NeedPayload = { jobs: NeedJob[]; counts: { questions: number; jobs: number } };

/** What the owner chose for one question: nothing yet, leave it to the agent, or type the answer. */
export type Mode = "" | "agent" | "answer";
export type Draft = { mode: Mode; text: string; always: boolean };
export const EMPTY_DRAFT: Draft = { mode: "", text: "", always: false };

export const ANSWER_LIMIT = 2000;

export const hasOptions = (q: Pick<NeedQuestion, "kind" | "options">): boolean => (q.kind === "select" || q.kind === "radio") && q.options.length > 0;

/** The effective character limit of the answer box: the form's maxlength, else the stored-answer ceiling. */
export const limitOf = (q: Pick<NeedQuestion, "maxlength">): number => (q.maxlength && q.maxlength > 0 ? Math.min(q.maxlength, ANSWER_LIMIT) : ANSWER_LIMIT);

export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

/** A problem with the typed answer that the server would also refuse (shape only; the server still runs the gates). Null when fine. */
export function draftProblem(q: NeedQuestion, d: Draft): string | null {
  if (d.mode !== "answer") return null;
  const v = normalizeText(d.text);
  if (!v) return "Type an answer or pick an option.";
  if (v.length > limitOf(q)) return `Too long: ${v.length} of ${limitOf(q)} characters.`;
  if (hasOptions(q) && !q.options.some((o) => o.trim().toLowerCase() === v.toLowerCase())) return "Pick one of the options.";
  return null;
}

export type SavePlan = {
  agentIds: number[];
  answers: { id: number; answer: string; scope: "once" | "always" }[];
  /** Questions the owner started answering but cannot be saved yet, with the reason. */
  blocked: { id: number; reason: string }[];
  /** Nothing to send. */
  idle: boolean;
};

export function planSave(job: NeedJob, drafts: Record<number, Draft | undefined>): SavePlan {
  const plan: SavePlan = { agentIds: [], answers: [], blocked: [], idle: true };
  for (const q of job.questions) {
    const d = drafts[q.id] ?? EMPTY_DRAFT;
    if (d.mode === "agent") {
      if (!q.agent_allowed) plan.blocked.push({ id: q.id, reason: "The agent can only draft free-text motivational questions." });
      else if (q.status !== "agent_handle") plan.agentIds.push(q.id);
    } else if (d.mode === "answer") {
      const problem = draftProblem(q, d);
      if (problem) plan.blocked.push({ id: q.id, reason: problem });
      else plan.answers.push({ id: q.id, answer: normalizeText(d.text), scope: d.always ? "always" : "once" });
    }
  }
  plan.idle = !plan.agentIds.length && !plan.answers.length;
  return plan;
}

/** The ids "I applied by hand / skip" applies to: every question of the job that is not answered yet. */
export const skippableIds = (job: NeedJob): number[] => job.questions.filter((q) => q.status === "open" || q.status === "agent_handle").map((q) => q.id);

export const openCount = (job: NeedJob): number => job.questions.filter((q) => q.status === "open").length;

/** Per-question errors from a save response (`results` rows with ok false), keyed by question id. */
export function errorsFrom(results: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  if (!Array.isArray(results)) return out;
  for (const r of results) {
    const row = r as { id?: unknown; ok?: unknown; error?: unknown };
    if (typeof row.id === "number" && row.ok === false) out[row.id] = typeof row.error === "string" ? row.error : "Not saved.";
  }
  return out;
}

export const COMMENT_LIMIT = 1000;
