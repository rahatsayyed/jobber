import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { loadProfiles } from '../src/platform/runner.js';

function def(name: string): { fm: string; body: string; tools: string[] } {
  const text = readFileSync(`.claude/agents/${name}.md`, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)!;
  const line = m[1].split(/\r?\n/).filter((l) => /^tools\s*:/.test(l))[0];
  return { fm: m[1], body: m[2], tools: line.replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean) };
}

const MAIL_TOOLS = [
  'mcp__db__list_queued_outreach', 'mcp__db__list_skipped_outreach', 'mcp__db__update_outreach_status', 'mcp__db__record_email_sent',
  'mcp__db__check_and_increment', 'mcp__gmail__send_email', 'mcp__db__approve_drafted_followups', 'mcp__db__list_followup_candidates',
  'mcp__db__list_approved_followups', 'mcp__db__claim_followup_for_send', 'mcp__db__mark_followup_sent', 'mcp__db__mark_followup_failed',
];

// The committed wake tool list (plan 8G task 13). Changing the wake profile means changing this list on purpose.
const WAKE_ALLOW = [
  'mcp__naukri__naukri_open', 'mcp__naukri__naukri_state', 'mcp__naukri__naukri_close', 'mcp__naukri__naukri_screenshot',
  'mcp__db__list_queued_outreach', 'mcp__db__get_funnel', 'mcp__db__get_outreach_stats', 'mcp__db__get_job_stats',
  'mcp__outreach__list_due_touches', 'mcp__outreach__next_contacts', 'mcp__outreach__record_inbound', 'mcp__outreach__escalate',
  'mcp__outreach__list_open_escalations',
  'mcp__linkedin__linkedin_open', 'mcp__linkedin__linkedin_state', 'mcp__linkedin__linkedin_scroll', 'mcp__linkedin__linkedin_click',
  'mcp__linkedin__linkedin_check_connection_status', 'mcp__linkedin__linkedin_connect_send', 'mcp__linkedin__linkedin_send_message',
  'mcp__naukri__naukri_search', 'mcp__naukri__naukri_discover', 'mcp__naukri__naukri_inbox', 'mcp__naukri__naukri_read_thread',
  'mcp__naukri__naukri_send_message', 'mcp__db__list_jobs', 'mcp__db__update_outreach_status',
  'mcp__linkedin__linkedin_layout', 'mcp__naukri__naukri_layout', 'mcp__linkedin__linkedin_search_jobs', 'mcp__linkedin__linkedin_search_posts',
  'mcp__scout__scout_search', 'mcp__scout__scout_open', 'mcp__scout__scout_state', 'mcp__scout__scout_scroll', 'mcp__scout__scout_click',
  'mcp__scout__scout_extract_jobs', 'mcp__scout__scout_save_jobs', 'mcp__scout__scout_capture_fixture', 'mcp__scout__scout_propose_provider',
  'mcp__scout__scout_tasks', 'mcp__scout__scout_task_update', 'mcp__scout__site_login', 'mcp__scout__site_signup',
  'mcp__scout__scout_layout', 'mcp__scout__scout_close',
  // pipeline and mail (task 13)
  'mcp__db__sweep_deadlines', 'mcp__db__save_match_result', 'mcp__db__mark_excluded', 'mcp__db__enqueue_outreach',
  'mcp__gates__apply_vetoes', 'mcp__gates__check_liveness',
  'mcp__job-fetch__source_status', 'mcp__job-fetch__board_status',
  'mcp__linkedin__linkedin_find_profiles', 'mcp__contacts__find_company_emails',
  'mcp__resume__get_base_resume', 'mcp__resume__render_resume', 'mcp__resume__check_text', 'mcp__resume__apply_review_edits',
  'mcp__db__list_sent_emails', 'mcp__db__set_email_thread', 'mcp__db__triage_replies', 'mcp__db__record_reply_check',
  'mcp__gmail__search_emails', 'mcp__gmail__read_email', 'mcp__gmail__send_email',
  'mcp__db__list_skipped_outreach', 'mcp__db__record_email_sent', 'mcp__db__check_and_increment',
  'mcp__db__approve_drafted_followups', 'mcp__db__list_followup_candidates', 'mcp__db__list_approved_followups',
  'mcp__db__claim_followup_for_send', 'mcp__db__mark_followup_sent', 'mcp__db__mark_followup_failed', 'mcp__db__save_followup_draft',
];

// Sentences moved verbatim from the sender: the dedupe rule and the follow-up guards.
const MOVED = [
  'Only send once per distinct `job_id`.',
  'a job with multiple LinkedIn profiles (recruiter + peer) produces multiple queue rows that intentionally share the SAME `email_subject`/`email_body`/`email_to` — they are the same email, not separate ones.',
  'Send ONLY rows from `followups`; never send a follow-up from memory or from an earlier list.',
  'NEVER send those, just report the count and `stuck_ids` so the user decides.',
  'Autonomous mode: `db.claim_followup_for_send({id})` ONLY; never call `db.check_and_increment` (the claim consumes the shared counter and enforces a fresh clean reply check).',
  'Never send without the claim.',
  'NEVER call `gmail.send_email` again for the same follow-up id in this run (the row stays `sending` and shows up as stuck next time; the user decides).',
  'Approval is the user\'s Telegram decision (`db.set_followup_approval`); never approve anything yourself.',
  'A follow-up is a real email and counts under the SAME daily `send_email` counter and limit as a cold email (Safety rule 2): there is no separate follow-up cap.',
  '`to` is an ARRAY of addresses in the Gmail MCP schema, so pass `[email_to]`.',
  '`{claimed: false, reason: "no_clean_reply_check"}`: stop the whole follow-up pass, send nothing more',
  'In autonomous mode the claim enforces the check in code and the prompt line is not required.',
];

const norm = (s: string): string => s.replace(/\s+/g, ' ');

describe('mail-operator definition', () => {
  const d = def('mail-operator');
  it('lists exactly the Gmail send tool and the db queue and claim tools', () => {
    expect(d.tools).toEqual(MAIL_TOOLS);
  });
  it('has nothing for LinkedIn, Naukri, apply, scout, or any builtin', () => {
    for (const t of d.tools) {
      expect(t).not.toMatch(/^mcp__(linkedin|naukri|apply|scout|outreach|playwright|claude-in-chrome|resume|contacts)__/);
      expect(['Skill', 'Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch']).not.toContain(t);
    }
    expect(d.tools.filter((t) => t.startsWith('mcp__gmail__'))).toEqual(['mcp__gmail__send_email']);
  });
  it('is sonnet and states dry run, halted, the kill switch and untrusted input', () => {
    expect(d.fm).toMatch(/^model: sonnet$/m);
    for (const w of [/dry run/i, /halted/i, /kill switch/i, /untrusted/i]) expect(d.body).toMatch(w);
  });
  it('matches config/worker-tools.json', () => {
    expect(JSON.parse(readFileSync('config/worker-tools.json', 'utf8'))['mail-operator']).toEqual(d.tools);
  });
  it('carries the dedupe rule and the follow-up guard text verbatim', () => {
    const body = norm(d.body);
    for (const s of MOVED) expect(body, s).toContain(norm(s));
  });
  it('while the sender still exists it holds the same sentences', () => {
    if (!existsSync('.claude/agents/sender.md')) return;
    const sender = norm(def('sender').body);
    for (const s of MOVED) expect(sender, s).toContain(norm(s));
  });
  it('does not send, connect or apply on any non-email channel', () => {
    expect(d.body).not.toMatch(/linkedin_connect_send|linkedin_send_message|naukri_send_message|apply\.(linkedin|greenhouse|lever|workday|ashby)/);
  });
  it('does not raise the cap or ask for approval', () => {
    expect(d.body).toContain('the cap is never raised from here');
  });
});

describe('wake profile', () => {
  const wake = loadProfiles('config/run-profiles.json', 'config/permission-sets.json').outreach_wake;
  it('allow list equals the committed list', () => {
    expect(wake.allow).toEqual(WAKE_ALLOW);
  });
  it('allows Agent dispatch and every tool of the pipeline and mail agents', () => {
    expect(wake.builtin_tools).toEqual(expect.arrayContaining(['Skill', 'Agent']));
    for (const a of ['mail-operator', 'matcher', 'contact-finder', 'outreach-preparer', 'reply-watcher', 'followup-drafter']) {
      for (const t of def(a).tools) {
        if (t.startsWith('mcp__')) expect(wake.allow, `${a}: ${t}`).toContain(t);
        else expect(wake.builtin_tools, `${a}: ${t}`).toContain(t);
      }
    }
  });
  it('screens gmail send arguments and passes the follow-up mode keys', () => {
    expect(wake.screen_args).toContain('mcp__gmail__send_email');
    for (const k of ['SEND_LIMIT_PER_RUN', 'FOLLOWUPS_AUTONOMOUS']) expect(wake.env_keys).toContain(k);
  });
  it('passes the web, scout, site, dork and search prefixes (task 7) and no secret', () => {
    for (const p of ['WEB_', 'SCOUT_', 'SITE_', 'DORK_', 'SEARCH_']) expect(wake.env_prefixes).toContain(p);
    expect(wake.env_keys).toContain('APPLY_DRY_RUN');
    expect([...(wake.env_keys ?? []), ...(wake.env_prefixes ?? [])].some((k) => /SERPER|PASSWORD|TOKEN|SECRET|API_KEY/.test(k))).toBe(false);
  });
  it('serves every wake tool from a configured server', () => {
    const cfg = JSON.parse(readFileSync(wake.mcp_config, 'utf8')) as { mcpServers: Record<string, unknown> };
    for (const t of wake.allow) expect(Object.keys(cfg.mcpServers), t).toContain(t.split('__')[1]);
  });
});

describe('contact-finder and outreach-preparer', () => {
  it('contact-finder names the closed reason codes and the ladder domain', () => {
    const b = def('contact-finder').body;
    for (const c of ['skipped: hn_domain_unmatched', 'skipped: hn_job_unknown', 'no_company', 'no_domain', 'no_verified_contact', 'platform_halted', 'profiles_unscreened']) {
      expect(b, c).toContain(c);
    }
    expect(b).toContain('domain_source');
    expect(b).toContain('Never guess a domain');
  });
  it('outreach-preparer states the dispatch rule', () => {
    expect(def('outreach-preparer').body).toContain('a verified email contact, OR at least one LinkedIn profile, OR an apply-capable `apply_url`');
  });
});
