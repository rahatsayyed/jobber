// One Telegram topic per lane (mail, linkedin): creation, migration of old state, window routing, silent defaults, reply notice routing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApiResult, TelegramApi } from '../src/telegram/api.js';
import { CREATED_TOPIC_NAMES, TOPIC_NAMES, ensureTopics, readTopicState, topicsPath } from '../src/telegram/topics.js';
import { ensureWindowTopic, topicKindOf, windowOfThread } from '../src/telegram/windows/topics.js';
import { DEFAULT_SILENT_TOPICS, resolveSilent, silentTopicsFromEnv } from '../src/telegram/silent.js';
import { replyNoticeTopic } from '../src/scheduler/replyCheck.js';

const CHAT = '777';
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'tg-lane-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeApi(): { api: TelegramApi; created: string[] } {
  const created: string[] = [];
  let id = 500;
  const api: TelegramApi = {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
      if (method === 'createForumTopic') { created.push(String(payload.name)); return { ok: true, result: { message_thread_id: id++ } as T }; }
      return { ok: true, result: {} as T };
    },
  };
  return { api, created };
}

const writeState = (st: unknown): void => {
  mkdirSync(path.join(root, '.jobber'), { recursive: true });
  writeFileSync(topicsPath(root), JSON.stringify(st));
};

describe('topic list', () => {
  it('has the lane topics and keeps drips only as a valid old name', () => {
    expect([...TOPIC_NAMES].sort()).toEqual(['alerts', 'assist', 'chat', 'drips', 'inbox', 'linkedin', 'mail', 'wakes']);
    expect([...CREATED_TOPIC_NAMES].sort()).toEqual(['alerts', 'assist', 'chat', 'inbox', 'linkedin', 'mail', 'wakes']);
  });
});

describe('ensureTopics', () => {
  it('fresh setup creates mail and linkedin and no drips', async () => {
    const f = fakeApi();
    const st = await ensureTopics(f.api, root, CHAT);
    expect(f.created.sort()).toEqual([...CREATED_TOPIC_NAMES].sort());
    expect(st.topics.drips).toBeUndefined();
    expect(st.topics.mail).toBeTypeOf('number');
    expect(st.topics.linkedin).toBeTypeOf('number');
  });

  it('old state (with drips, without the lane topics) gets only the two new topics, drips id kept, second start creates nothing', async () => {
    writeState({ chat_id: CHAT, forum: true, topics: { alerts: 1, wakes: 2, drips: 3, inbox: 4, assist: 5, chat: 6 } });
    const f = fakeApi();
    const st = await ensureTopics(f.api, root, CHAT);
    expect(f.created.sort()).toEqual(['linkedin', 'mail']);
    expect(st.topics.drips).toBe(3);
    const again = fakeApi();
    await ensureTopics(again.api, root, CHAT);
    expect(again.created).toEqual([]);
    expect(readTopicState(root)?.topics.drips).toBe(3);
  });

  it('a window topic stored under windows.mail becomes the lane topic: no second topic', async () => {
    writeState({ chat_id: CHAT, forum: true, topics: { alerts: 1, wakes: 2, inbox: 4, assist: 5, chat: 6 }, windows: { mail: 77, boards: 88 } });
    const f = fakeApi();
    const st = await ensureTopics(f.api, root, CHAT);
    expect(f.created).toEqual(['linkedin']);
    expect(st.topics.mail).toBe(77);
    expect(st.windows).toEqual({ boards: 88 });
    const disk = JSON.parse(readFileSync(topicsPath(root), 'utf8'));
    expect(disk.topics.mail).toBe(77);
    expect(disk.windows).toEqual({ boards: 88 });
  });

  it('windows map with only the lane windows is dropped after the move', async () => {
    writeState({ chat_id: CHAT, forum: true, topics: { alerts: 1 }, windows: { mail: 77, linkedin: 78 } });
    const st = await ensureTopics(fakeApi().api, root, CHAT, ['mail', 'linkedin']);
    expect(st.topics.mail).toBe(77);
    expect(st.topics.linkedin).toBe(78);
    expect(st.windows).toBeUndefined();
  });
});

describe('window topics', () => {
  it('topicKindOf', () => {
    const table: Record<string, string> = {
      mail: 'mail', linkedin: 'linkedin', 'drip-mail-abc': 'mail', 'drip-mailrc': 'mail', 'drip-linkedin-9': 'linkedin',
      'drip-other': 'drips', 'wake-1': 'wakes', boards: 'own', scheduler: 'own', chat: 'own',
    };
    for (const [w, k] of Object.entries(table)) expect(topicKindOf(w), w).toBe(k);
  });

  it('the mail window view, drip-mail runs and the lane notices all use the same topic id; typed text maps back to the mail window', async () => {
    const f = fakeApi();
    await ensureTopics(f.api, root, CHAT);
    const mailId = readTopicState(root)?.topics.mail;
    const a = await ensureWindowTopic(f.api, root, CHAT, 'mail', topicKindOf('mail'));
    const b = await ensureWindowTopic(f.api, root, CHAT, 'drip-mail-x', topicKindOf('drip-mail-x'));
    expect(a).toBe(mailId);
    expect(b).toBe(mailId);
    expect(f.created.filter((n) => n === 'mail')).toHaveLength(1);
    expect(windowOfThread(root, mailId as number)).toBe('mail');
    const liId = readTopicState(root)?.topics.linkedin;
    expect(await ensureWindowTopic(f.api, root, CHAT, 'linkedin', 'linkedin')).toBe(liId);
    expect(windowOfThread(root, liId as number)).toBe('linkedin');
  });

  it('old windows.mail id is reused by the mail window view (migration through the view path)', async () => {
    writeState({ chat_id: CHAT, forum: true, topics: { alerts: 1 }, windows: { mail: 77 } });
    const f = fakeApi();
    expect(await ensureWindowTopic(f.api, root, CHAT, 'mail', 'mail')).toBe(77);
    expect(f.created).not.toContain('mail');
    expect(readTopicState(root)?.topics.mail).toBe(77);
    expect(readTopicState(root)?.windows).toBeUndefined();
  });

  it('a non-lane worker window keeps its own topic named like the window', async () => {
    const f = fakeApi();
    await ensureWindowTopic(f.api, root, CHAT, 'boards', 'own');
    expect(f.created).toContain('boards');
  });
});

describe('silent defaults', () => {
  it('mail and linkedin are silent with wakes and drips; the env list is validated against the new names', () => {
    expect([...DEFAULT_SILENT_TOPICS].sort()).toEqual(['drips', 'linkedin', 'mail', 'wakes']);
    const ok = silentTopicsFromEnv({ TELEGRAM_SILENT_TOPICS: 'mail, linkedin' } as NodeJS.ProcessEnv);
    expect([...ok.topics].sort()).toEqual(['linkedin', 'mail']);
    expect(ok.warnings).toEqual([]);
    const bad = silentTopicsFromEnv({ TELEGRAM_SILENT_TOPICS: 'mail,mails' } as NodeJS.ProcessEnv);
    expect([...bad.topics]).toEqual(['mail']);
    expect(bad.warnings.join(' ')).toContain('mails');
    expect(resolveSilent('mail', undefined, {})).toBe(true);
    expect(resolveSilent('linkedin', undefined, {})).toBe(true);
    expect(resolveSilent('inbox', undefined, {})).toBe(false);
    expect(resolveSilent('alerts', undefined, {})).toBe(false);
    // an explicit loud flag on a lane topic always wins
    expect(resolveSilent('mail', false, {})).toBe(false);
  });
});

describe('reply notice routing (golden)', () => {
  const row = (o: Record<string, unknown>) => ({
    message_id: 'm', job_id: 'j', classification: 'replied', action: 'proposed', proposed_outcome: null, from_addr: 'a@b.c', subject: 's', excerpt: 'e',
    needs_you: 0, company: 'Acme', title: 'Dev', auto_note: null, ...o,
  }) as Parameters<typeof replyNoticeTopic>[0][number];
  it('anything that may need the owner stays in inbox; only routine groups go to mail', () => {
    expect(replyNoticeTopic([row({ needs_you: 1 })])).toBe('inbox');
    expect(replyNoticeTopic([row({ classification: 'interview' })])).toBe('inbox');
    expect(replyNoticeTopic([row({ classification: 'replied', action: 'ignored' })])).toBe('inbox');
    expect(replyNoticeTopic([row({ classification: 'bounce', action: 'bounced', auto_note: 'x' })])).toBe('inbox');
    expect(replyNoticeTopic([row({ classification: 'auto_ack', action: 'ignored' })])).toBe('mail');
    expect(replyNoticeTopic([row({ classification: 'replied', auto_note: 'answered automatically: ctc' })])).toBe('mail');
    expect(replyNoticeTopic([row({ classification: 'auto_ack' }), row({ needs_you: 1 })])).toBe('inbox');
    expect(replyNoticeTopic([])).toBe('inbox');
  });
});
