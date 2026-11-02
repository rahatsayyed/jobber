import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { addEscalation } from '../src/outreach/service.js';
import { classifyEscalation, countOpenCards, listEscalations, reasonTopic, todoFor, whatToDo } from '../src/outreach/escalations.js';
import { recordQuestion, pauseJobNeedsAnswer } from '../src/apply/questions.js';
import { buildManualQueue } from '../src/manual/manualApply.js';
import { renderEscalations } from '../src/status/escalations.js';
import { makeHarness, START, type Harness } from './helpers/webHarness.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const OFF: NodeJS.ProcessEnv = {};
const ON: NodeJS.ProcessEnv = { APPLY_LINKEDIN_EASY: 'true' };
let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); migrateOutreachTables(db); });
afterEach(() => { db.close(); });

function job(id: string, o: { url?: string; title?: string; company?: string; source?: string } = {}): void {
  const url = o.url ?? `https://boards.greenhouse.io/acme/jobs/${id}`;
  saveJob(db, { id, source: o.source ?? 'remotive', title: o.title ?? `Dev ${id}`, company: o.company ?? `Acme ${id}`, url, apply_url: url, description: 'x' });
}
function queue(id: string, status: string | null, o: { platform?: string; url?: string } = {}): number {
  const qid = enqueueOutreach(db, {
    job_id: id, resume_pdf_path: null, email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null,
    connect_category: null, connect_company: null, apply_platform: o.platform ?? 'greenhouse', apply_url: o.url ?? `https://boards.greenhouse.io/acme/jobs/${id}`,
  });
  db.prepare('UPDATE outreach_queue SET apply_status = ? WHERE id = ?').run(status, qid);
  return qid;
}
const applyEsc = (reason: string, detail: string, threadRef?: string): number => addEscalation(db, { runId: null, platform: 'apply', reason, detail, threadRef }, NOW);
let personN = 0;
const person = (): number => Number(db.prepare("INSERT INTO people (platform, profile_key, name, headline, company, company_key, category) VALUES ('linkedin', ?, 'Sam Lee', 'Recruiter', 'Globex', 'globex', 'recruiter')").run(`k${++personN}`).lastInsertRowid);
function reply(reason: string, excerpt: string | null, threadRef = '2-thread1'): number {
  return addEscalation(db, { runId: null, platform: 'linkedin', personId: person(), threadRef, reason, excerpt: excerpt ?? undefined, sender: 'Sam Lee' }, NOW);
}
const itemFor = (id: number) => listEscalations(db, { now: NOW, status: 'open' }).items.find((i) => i.ids.includes(id))!;

describe('reply card todo text (point 2)', () => {
  it('information or thanks needs no action', () => {
    const e = reply('linkedin_reply_needed', 'Thanks a lot, great to meet you last week.');
    const i = itemFor(e);
    expect(i.group).toBe('human');
    expect(i.todo).toBe('No action needed unless you want to answer yourself. The agent has read it.');
    expect(i.todoKind).toBe('info');
  });

  it('owner-only asks name the topic: salary, interview time, personal data, links', () => {
    const cases: [string, string | null, string][] = [
      ['salary', 'What is your expected CTC?', 'salary'],
      ['interview_time', 'Are you free on Friday?', 'interview time'],
      ['personal_data', 'Please share your date of birth', 'personal data'],
      ['link_or_phone', 'Can you share your portfolio link?', 'links'],
      ['linkedin_reply_needed', 'Can you share your GitHub link?', 'links'],
      ['linkedin_reply_needed', 'Please send your phone number', 'personal data'],
    ];
    cases.forEach(([reason, excerpt, topic], n) => {
      const i = itemFor(reply(reason, excerpt, `2-owner${n}`));
      expect(i.group).toBe('human');
      expect(i.todo).toBe(`Open the conversation on Linkedin and answer yourself: it asks about ${topic}.`);
      expect(i.todoKind).toBe('owner');
    });
  });

  it('an ask the agent may answer shows the reply draft state from reply_drafts', () => {
    const states: [string, RegExp, string][] = [
      ['approved', /^The agent will send a reply with your resume\.$/, 'agent'],
      ['drafted', /^The agent drafted a reply with your resume and will send it soon\.$/, 'agent'],
      ['sent', /^Sent: the agent replied with your resume\. No action needed\.$/, 'agent'],
      ['failed', /could not be sent\. Open the conversation on Linkedin and answer yourself\.$/, 'owner'],
      ['skipped', /decided not to reply/, 'owner'],
    ];
    states.forEach(([status, re, kind], n) => {
      const e = reply('documents', 'Could you send your resume please?', `2-draft${n}`);
      db.prepare("INSERT INTO reply_drafts (escalation_id, person_id, thread_ref, kind, body, attach_resume, status, created_at) VALUES (?, (SELECT person_id FROM escalations WHERE id = ?), ?, 'reply', 'hi', 1, ?, ?)")
        .run(e, e, `2-draft${n}`, status, NOW.toISOString());
      const i = itemFor(e);
      expect(i.todo).toMatch(re);
      expect(i.todoKind).toBe(kind);
      expect(i.replyDraft).toEqual({ status, attachResume: true });
    });
  });

  it('a documents request without a draft yet says the agent will send the resume', () => {
    expect(itemFor(reply('documents', 'Please send your CV.', '2-nodraft')).todo).toBe('The agent will send a reply with your resume.');
  });

  it('a plain ask with no draft is left to the owner and never says the agent never replies', () => {
    const i = itemFor(reply('recruiter_inquiry', 'We have an opening, are you open to it?', '2-plain'));
    expect(i.todo).toBe('Open the conversation on Linkedin and answer yourself if you want to. The agent has not drafted a reply.');
    for (const t of [i.todo, whatToDo('human', 'reply', 'linkedin', 'x'), whatToDo('human', 'salary', 'linkedin', 'salary')]) expect(t).not.toMatch(/never (answers|replies)/i);
  });

  it('the /escalations text shows the same line and no longer says the agent never replies', () => {
    reply('documents', 'Please send your CV.', '2-status');
    const { items, counts } = listEscalations(db, { now: NOW, status: 'open' });
    const text = renderEscalations(items, counts, NOW);
    expect(text).toContain('next: The agent will send a reply with your resume.');
    expect(text).toContain('The agent replies by itself to safe asks');
    expect(text).not.toMatch(/never answers a third party|Answer on the platform itself;/);
  });

  it('classifies the closed operator reasons as replies, not as platform problems', () => {
    for (const r of ['documents', 'personal_data', 'references', 'link_or_phone', 'salary', 'interview_time', 'recruiter_inquiry']) expect(classifyEscalation('linkedin', r, null).group).toBe('human');
    expect(reasonTopic('personal_data')).toBe('personal data');
    expect(todoFor('platform', 'other', 'linkedin', 'layout_drift').kind).toBe('info');
  });
});

describe('apply cards carry their job (point 4)', () => {
  it('shows title, company, host, a safe link and the question labels for a job id', () => {
    job('j1', { title: 'React Dev', company: 'Kompatible' });
    queue('j1', 'needs_owner');
    const e = applyEsc('apply:question', 'reason=question platform=greenhouse host=boards.greenhouse.io job=j1');
    const q = recordQuestion(db, { jobId: 'j1', host: 'boards.greenhouse.io', label: 'Why do you want this job?', maxLength: null, options: [], kind: 'text' }, NOW);
    expect(q.id).toBeGreaterThan(0);
    const i = itemFor(e);
    expect(i.applyJob).toEqual({
      jobId: 'j1', title: 'React Dev', company: 'Kompatible', host: 'boards.greenhouse.io', url: 'https://boards.greenhouse.io/acme/jobs/j1', questions: ['Why do you want this job?'],
    });
  });

  it('never makes a link from an unsafe address', () => {
    job('j2', { url: 'http://insecure.example/apply/2' });
    queue('j2', 'needs_owner', { url: 'http://insecure.example/apply/2' });
    const i = itemFor(applyEsc('apply:drift', 'reason=drift platform=greenhouse host=insecure.example job=j2'));
    expect(i.applyJob?.url).toBeNull();
    expect(i.applyJob?.host).toBe('insecure.example');
    expect(i.applyJob?.title).toBe('Dev j2');
  });

  it('an old row with only host and url is matched to its job by url, else shows the host only', () => {
    job('j3', { url: 'https://old.example/apply/3', title: 'Old Role' });
    queue('j3', 'manual_review', { url: 'https://old.example/apply/3' });
    const byUrl = itemFor(applyEsc('apply:drift', 'reason=drift platform=unknown host=old.example\nurl=https://old.example/apply/3 host=old.example step=form block=none'));
    expect(byUrl.applyJob).toMatchObject({ jobId: 'j3', title: 'Old Role', host: 'old.example', url: 'https://old.example/apply/3' });
    const hostOnly = itemFor(applyEsc('apply:drift', 'reason=drift platform=unknown host=nowhere.example'));
    expect(hostOnly.applyJob).toEqual({ jobId: null, title: null, company: null, host: 'nowhere.example', url: null, questions: [] });
  });

  it('an unknown host stays null instead of the word unknown', () => {
    expect(itemFor(applyEsc('apply:other', 'reason=other platform=unknown host=unknown')).applyJob?.host).toBeNull();
  });
});

describe('display-side dedupe and the badge count (point 3)', () => {
  function seed(): { inManual: number; inAnswer: number; stray: number; old: number; reply: number } {
    // a job in Apply by hand (manual_review) with a drift card
    job('m1'); queue('m1', 'manual_review');
    const inManual = applyEsc('apply:drift', 'reason=drift platform=greenhouse host=boards.greenhouse.io job=m1');
    // a job that waits for an answer, with the host card and a captcha card of the same job
    job('a1'); queue('a1', null);
    recordQuestion(db, { jobId: 'a1', host: 'forms.acme.io', label: 'Why us?', maxLength: null, options: [], kind: 'text' }, NOW);
    pauseJobNeedsAnswer(db, 'a1');
    const inAnswer = applyEsc('apply:captcha', 'reason=captcha platform=greenhouse host=forms.acme.io job=a1');
    applyEsc('apply:needs_answer', 'needs your answer: 1 question for job a1 on forms.acme.io', 'answers:forms.acme.io');
    // a failing job that is NOT shown elsewhere (a captcha: needs_human)
    job('h1'); queue('h1', 'needs_human');
    const stray = applyEsc('apply:captcha', 'reason=captcha platform=greenhouse host=boards.greenhouse.io job=h1');
    // an old card with no job
    const old = applyEsc('apply:drift', 'reason=drift platform=unknown host=nowhere.example');
    const r = reply('linkedin_reply_needed', 'Thanks!');
    return { inManual, inAnswer, stray, old, reply: r };
  }

  it('hides apply cards whose job is in Apply by hand or Needs your answer, and the needs-answer host card; keeps every row', () => {
    const s = seed();
    const raw = listEscalations(db, { now: NOW, status: 'open' });
    expect(raw.items.map((i) => i.id)).toContain(s.inManual);
    const dd = listEscalations(db, { now: NOW, status: 'open', dedupeApply: { env: OFF } });
    const shown = dd.items.flatMap((i) => i.ids);
    expect(shown).not.toContain(s.inManual);
    expect(shown).not.toContain(s.inAnswer);
    expect(dd.items.some((i) => /needs_answer/.test(i.reason))).toBe(false);
    expect(shown).toEqual(expect.arrayContaining([s.stray, s.old, s.reply]));
    expect(dd.hiddenDuplicates).toBe(3);
    expect((db.prepare('SELECT COUNT(*) c FROM escalations').get() as { c: number }).c).toBe(6);
  });

  it('counts each job once: cards + needs-answer jobs + manual jobs has no overlap', () => {
    seed();
    expect(countOpenCards(db, NOW)).toBe(6);
    const cards = countOpenCards(db, NOW, OFF);
    expect(cards).toBe(3);
    const manual = buildManualQueue(db, OFF).count;
    const answerJobs = (db.prepare("SELECT COUNT(DISTINCT job_id) n FROM outreach_queue WHERE apply_status = 'needs_answer'").get() as { n: number }).n;
    expect(manual).toBe(1);
    expect(answerJobs).toBe(1);
    // the three visible cards are three different things, none of them a job already counted by the other two groups
    const jobsInCards = listEscalations(db, { now: NOW, status: 'open', dedupeApply: { env: OFF } }).items.map((i) => i.applyJob?.jobId).filter(Boolean);
    expect(jobsInCards).toEqual(['h1']);
  });

  it('a resolved duplicate is not hidden (it is history)', () => {
    const s = seed();
    db.prepare('UPDATE escalations SET resolved_at = ? WHERE id = ?').run(NOW.toISOString(), s.inManual);
    const all = listEscalations(db, { now: NOW, status: 'all', dedupeApply: { env: OFF } });
    expect(all.items.flatMap((i) => i.ids)).toContain(s.inManual);
  });
});

describe('easy_apply_off label (point 5)', () => {
  function linkedinJob(id: string): void {
    saveJob(db, { id, source: 'linkedin-jobs', title: `Dev ${id}`, company: 'Acme', url: `https://www.linkedin.com/jobs/view/${id}/`, apply_url: `https://www.linkedin.com/jobs/view/${id}/`, description: 'x' });
    queue(id, 'needs_owner', { platform: 'none', url: `https://www.linkedin.com/jobs/view/${id}/` });
  }
  it('says easy_apply_off for a LinkedIn Easy Apply job while the lane is off, even after a failed attempt', () => {
    linkedinJob('3001');
    const off = buildManualQueue(db, OFF);
    expect(off.items[0].reason).toBe('easy_apply_off');
    expect(off.easyApplyOff).toBe(1);
  });
  it('the failed-lane reason only appears while the lane is on', () => {
    linkedinJob('3002');
    db.prepare("UPDATE outreach_queue SET apply_status = 'manual_review', apply_note = 'easy_apply:failed'").run();
    expect(buildManualQueue(db, OFF).items[0].reason).toBe('easy_apply_off');
    // lane on: the drip lane owns pending rows, a parked failed row is listed as failed
    const on = buildManualQueue(db, ON);
    for (const it of on.items) expect(it.reason).not.toBe('easy_apply_off');
  });
});

describe('Inbox badge route (point 3)', () => {
  let h: Harness | null = null;
  afterEach(async () => { if (h) await h.close(); h = null; });

  it('GET /api/escalations/count counts each job once and GET /api/escalations hides the duplicate card', async () => {
    h = await makeHarness({});
    const { cookie } = await h.login();
    const d = h.data;
    saveJob(d, { id: 'r1', source: 'remotive', title: 'Dev r1', company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/r1', apply_url: 'https://boards.greenhouse.io/acme/jobs/r1', description: 'x' });
    const qid = enqueueOutreach(d, {
      job_id: 'r1', resume_pdf_path: null, email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null,
      connect_category: null, connect_company: null, apply_platform: 'greenhouse', apply_url: 'https://boards.greenhouse.io/acme/jobs/r1',
    });
    d.prepare("UPDATE outreach_queue SET apply_status = 'manual_review' WHERE id = ?").run(qid);
    addEscalation(d, { runId: null, platform: 'apply', reason: 'apply:drift', detail: 'reason=drift platform=greenhouse host=boards.greenhouse.io job=r1' }, new Date(START));
    addEscalation(d, { runId: null, platform: 'apply', reason: 'apply:drift', detail: 'reason=drift platform=unknown host=nowhere.example' }, new Date(START));
    const count = JSON.parse((await h.call('GET', '/api/escalations/count', { headers: { cookie } })).body) as { cards: number; manualApply: number; questionJobs: number; badge: number; open: number };
    expect(count.open).toBe(2);
    expect(count.cards).toBe(1);
    expect(count.manualApply).toBe(1);
    expect(count.badge).toBe(2);
    const list = JSON.parse((await h.call('GET', '/api/escalations', { headers: { cookie } })).body) as { items: { applyJob: { host: string } | null }[]; hiddenDuplicates: number };
    expect(list.items).toHaveLength(1);
    expect(list.items[0].applyJob?.host).toBe('nowhere.example');
    expect(list.hiddenDuplicates).toBe(1);
  });
});
