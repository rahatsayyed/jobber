// apply_list_roles and apply_open_role: careers pages that only LIST many roles (owner decision 2026-11-02).
//
// apply_list_roles reads the role links of the open listing page: same-host anchors only, cleaned, capped and screened as untrusted text.
// The operator picks at most three roles whose titles clearly fit the owner and calls apply_open_role({role_id}) for each, one at a time.
// The model never names a URL: a role_id maps to a link code read from the page, and the link is opened by code after the same
// guards as any apply_open (the veto, the dedupe by company and title, the host cap and the daily caps all run on the new job).
// A role becomes a job of its own (id role:<listing job>:<hash>, source careers_listing) with its own queue row, so it flows through the normal
// page tools, the apply counters and the owner's reports like any other job. A listing with no fitting role is parked by
// apply_escalate (reason no_relevant_role), which puts it on the manual apply queue with the listing URL.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getExcludedReason, getFirstHardStop, externalApplyDuplicate, saveJob } from '../../db.js';
import { classifyApplyUrl } from '../../apply/registry.js';
import { extractRoles, roleRelevance, MAX_ROLES_PER_LISTING } from '../../apply/careersRoles.js';
import { repeatContactOf } from '../../pipelineWork.js';
import { getBaseResume } from '../../resume.js';
import { hostAllowed } from '../../webcore/runtime.js';
import { findPreparedResumePath } from '../resume.js';
import { envOf, inPage, nowOf, preflight, refuse, type ApplierDeps, type ApplyResult } from './common.js';
import { screenText } from './state.js';
import { handleOpen } from './open.js';

export const ListRolesInput = z.object({}).strict();
export const OpenRoleInput = z.object({ role_id: z.string().regex(/^r\d{1,3}$/) }).strict();
export type OpenRoleInputT = z.infer<typeof OpenRoleInput>;

export const ROLE_SOURCE = 'careers_listing';
const NOT_A_LISTING = new Set(['form', 'review', 'confirmation', 'signin', 'account', 'blocked']);

export async function handleListRoles(_input: z.infer<typeof ListRolesInput>, deps: ApplierDeps): Promise<ApplyResult> {
  return inPage(deps, async ({ job, model, raw }) => {
    if (NOT_A_LISTING.has(model.stepKind)) return refuse('not_a_listing', 'the open page is a form or a sign-in page, not a list of roles');
    const roles = extractRoles(raw.links, raw.url, job.allowedHosts);
    const v = await screenText(roles.map((r) => `${r.role_id} ${r.title} | ${r.location}`).join('\n'), 'read', deps, 12000);
    if (v.blocked) return { status: 'blocked', code: v.code };
    deps.state.roles = { parentJobId: job.jobId, allowedHosts: [...job.allowedHosts], items: roles, opened: new Set() };
    return {
      status: 'ok', code: 'roles', platform: job.platform, host: job.host,
      roles: roles.map((r) => ({ role_id: r.role_id, title: r.title, location: r.location, kind: r.kind })),
      info: { count: roles.length, max_per_listing: MAX_ROLES_PER_LISTING },
      ...(v.unscreened ? { reason: 'classifier=unscreened' } : {}),
    };
  });
}

const roleJobId = (parent: string, href: string): string => `role:${parent}:${createHash('sha1').update(href).digest('hex').slice(0, 10)}`.slice(0, 200);

export async function handleOpenRole(input: OpenRoleInputT, deps: ApplierDeps): Promise<ApplyResult> {
  const g = preflight(deps);
  if (g) return g;
  const rs = deps.state.roles;
  if (!rs) return refuse('no_roles', 'call apply_list_roles on the listing page first');
  const cur = deps.state.cur;
  if (cur && cur.jobId !== rs.parentJobId && !cur.submitted) return refuse('job_open', 'finish or close the open application before opening another role');
  const item = rs.items.find((r) => r.role_id === input.role_id);
  if (!item) return refuse('unknown_role', 'no such role in the last list');
  if (rs.opened.has(item.role_id)) return refuse('already_opened', 'that role was already opened in this run');
  if (!hostAllowed(item.href, rs.allowedHosts)) return refuse('host_change', 'the role link leaves the careers site; it is never opened');

  const db = deps.db;
  const env = envOf(deps);
  const now = nowOf(deps);
  const parentId = rs.parentJobId;
  const parent = db.prepare('SELECT id, company, description, url FROM jobs WHERE id = ?').get(parentId) as { id: string; company: string | null; description: string | null; url: string | null } | undefined;
  if (!parent) return refuse('unknown_job', 'no such job');
  if (getExcludedReason(db, parentId)) return refuse('vetoed', 'the job is excluded');
  if (getFirstHardStop(db, parentId)) return refuse('hard_stop', 'the job has a hard stop');

  // At most three roles per listing: this run and every earlier run (the children are counted by their id prefix).
  const prefix = `role:${parentId}:`;
  const earlier = (db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE substr(id, 1, ?) = ?').get(prefix.length, prefix) as { n: number }).n;
  const childId = roleJobId(parentId, item.href);
  const exists = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(childId) !== undefined;
  if (rs.opened.size >= MAX_ROLES_PER_LISTING || (!exists && earlier >= MAX_ROLES_PER_LISTING)) return refuse('role_limit', `at most ${MAX_ROLES_PER_LISTING} roles per listing`);

  let resume: Record<string, unknown> | null = null;
  try { resume = (deps.draft?.baseResume ?? getBaseResume)() as Record<string, unknown>; } catch { /* the title rules still run */ }
  const fit = roleRelevance({ title: item.title, location: item.location }, resume);
  if (!fit.ok) return refuse('not_relevant', `the role does not fit the resume (${fit.reason})`);

  // The role as a job of its own. Created before the guards so the company and title keys exist for the dedupe checks.
  if (!exists) {
    saveJob(db, {
      id: childId, source: ROLE_SOURCE, title: item.title, company: parent.company ?? '', url: item.href, apply_url: item.href,
      description: `${item.location ? `Location: ${item.location}\n\n` : ''}Role found on the careers page of ${parent.company ?? 'the company'}: ${item.title}`,
    });
  }
  const dup = externalApplyDuplicate(db, childId);
  if (dup) return refuse(dup, 'an application for this company and title already exists');
  if (repeatContactOf(db, childId, now)) {
    db.prepare("UPDATE jobs SET status = 'repeat_contact' WHERE id = ? AND status IS NULL").run(childId);
    return refuse('repeat_contact', 'this company and title were contacted in the last 90 days');
  }

  let queueId = (db.prepare('SELECT id FROM outreach_queue WHERE job_id = ? ORDER BY id LIMIT 1').get(childId) as { id: number } | undefined)?.id;
  if (queueId === undefined) {
    const pdf = findPreparedResumePath(db, parentId) ?? null;
    const parentRow = db.prepare('SELECT resume_json FROM outreach_queue WHERE job_id = ? ORDER BY id LIMIT 1').get(parentId) as { resume_json: string | null } | undefined;
    const cls = classifyApplyUrl(item.href, ROLE_SOURCE, env);
    queueId = Number(db.prepare(
      "INSERT INTO outreach_queue (job_id, resume_pdf_path, resume_json, apply_platform, apply_tier, apply_url, status) VALUES (?,?,?,?,?,?,'queued')",
    ).run(childId, pdf, parentRow?.resume_json ?? null, cls.platform, cls.tier, item.href).lastInsertRowid);
  }

  rs.opened.add(item.role_id);
  // The runtime already waits out the per-host gap before it navigates; the in-code refusal would only make the operator stop at the second role.
  deps.state.lastOpen.delete(new URL(item.href).hostname.toLowerCase());
  const r = await handleOpen({ job_id: childId }, deps);
  if (r.status === 'ok') {
    db.prepare("UPDATE outreach_queue SET apply_status = 'listing_expanded', apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued')")
      .run(`roles opened: ${rs.opened.size}`, parentId);
  }
  return { ...r, job_id: childId, queue_id: queueId };
}
