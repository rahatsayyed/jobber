import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProfiles } from '../src/platform/runner.js';
import { followupMode } from '../src/followups.js';

function agent(name: string): { tools: string[]; body: string } {
  const text = readFileSync(`.claude/agents/${name}.md`, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`no frontmatter in ${name}`);
  const line = m[1].split(/\r?\n/).find((l) => /^tools\s*:/.test(l))!;
  const tools = line.replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean);
  return { tools, body: m[2] };
}

function dbTools(): Set<string> {
  const src = readFileSync('src/mcp/db.ts', 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/registerTool\(\s*'([A-Za-z0-9_]+)'/g)) out.add(`mcp__db__${m[1]}`);
  return out;
}

const sender = agent('sender');
const watcher = agent('reply-watcher');
const drafter = agent('followup-drafter');
const followupSection = sender.body.slice(sender.body.indexOf('## Follow-up mode'));

describe('follow-up agents: autonomous wiring', () => {
  it('sender follow-up section approves, then claims before sending, with no check_and_increment instruction', () => {
    expect(followupSection).toContain('approve_drafted_followups');
    const claim = followupSection.indexOf('claim_followup_for_send');
    const send = followupSection.indexOf('gmail.send_email({');
    expect(claim).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(claim);
    expect(followupSection.indexOf('approve_drafted_followups')).toBeLessThan(claim);
    // the autonomous steps never instruct a check_and_increment call (only a "do NOT" note)
    const autonomous = followupSection.slice(0, followupSection.indexOf('Legacy mode'));
    expect(autonomous).toMatch(/(do NOT|never|not) call `?db\.check_and_increment/i);
    expect(autonomous.replace(/(do NOT|never|not) call `?db\.check_and_increment`?/gi, '')).not.toContain('check_and_increment');
    expect(followupSection).toContain('no_clean_reply_check');
    expect(followupSection).toContain('no fresh clean reply check');
    expect(sender.tools).toContain('mcp__db__approve_drafted_followups');
  });

  it('legacy path: reply-check gate precedes the claim step, check_and_increment precedes claim', () => {
    const gate = followupSection.indexOf('pre-send reply check not confirmed');
    const step2 = followupSection.indexOf('2. **List and claim.**');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(step2);
    const step2Text = followupSection.slice(step2, followupSection.indexOf('3. **Send.**'));
    const cai = step2Text.indexOf('Legacy mode');
    expect(step2Text.indexOf('check_and_increment', cai)).toBeGreaterThan(-1);
    expect(step2Text.indexOf('check_and_increment', cai)).toBeLessThan(step2Text.indexOf('claim_followup_for_send', cai));
  });

  it('reply-watcher lists and calls record_reply_check after triage_replies, skipped in a dry run', () => {
    expect(watcher.tools).toContain('mcp__db__record_reply_check');
    const t = watcher.body.indexOf('db.triage_replies({messages, dry_run})');
    const r = watcher.body.indexOf('db.record_reply_check');
    expect(t).toBeGreaterThan(-1);
    expect(r).toBeGreaterThan(t);
    expect(watcher.body).toMatch(/record_reply_check[\s\S]{0,400}dry_run: true|dry_run: true[\s\S]{0,400}record_reply_check/);
  });

  it('follow-up drafter text is correct for both modes', () => {
    expect(drafter.body).toContain('next_n');
    expect(drafter.body).toContain('EMAIL_FOLLOWUP_GAPS_DAYS');
    expect(drafter.body).toContain('approve_drafted_followups');
    expect(drafter.body).not.toMatch(/The orchestrator shows these drafts/);
  });

  it('every tool named in the three agents is registered and allowed for profile hunt', () => {
    const real = dbTools();
    const hunt = loadProfiles('config/run-profiles.json', 'config/permission-sets.json').hunt;
    for (const [name, a] of [['sender', sender], ['reply-watcher', watcher], ['followup-drafter', drafter]] as const) {
      for (const t of a.tools) {
        if (t === 'Skill') continue;
        if (t.startsWith('mcp__db__')) expect(real.has(t), `${name}: ${t} not registered`).toBe(true);
        expect(hunt.allow, `${name}: ${t} not allowed for hunt`).toContain(t);
      }
    }
    const sets = JSON.parse(readFileSync('config/permission-sets.json', 'utf8'));
    expect(sets.outreach_send.allow).toContain('mcp__db__record_reply_check');
    expect(sets.outreach_send.allow).toContain('mcp__db__approve_drafted_followups');
  });

  it('draft-outreach follow-up mode covers n 1 to 4', () => {
    const s = readFileSync('.claude/skills/draft-outreach/SKILL.md', 'utf8');
    expect(s).toContain('n: 1|2|3|4');
    expect(s).toMatch(/n=4|n = 4/);
    expect(s).toContain('feedback');
  });
});

describe('FOLLOWUPS_AUTONOMOUS ships off', () => {
  it('.env.example sets it to exactly false', () => {
    const env = readFileSync('.env.example', 'utf8');
    const lines = env.split(/\r?\n/).filter((l) => /^FOLLOWUPS_AUTONOMOUS=/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0].replace(/\s*#.*$/, '').trim()).toBe('FOLLOWUPS_AUTONOMOUS=false');
    expect(env).toMatch(/FOLLOWUP_CHECK_MAX_AGE_MIN=30/);
    expect(env).toContain('EMAIL_FOLLOWUP_GAPS_DAYS');
  });
  it('followupMode is legacy when the key is unset', () => {
    expect(followupMode({})).toBe('legacy');
    expect(followupMode({ FOLLOWUPS_AUTONOMOUS: 'false' })).toBe('legacy');
  });
});
