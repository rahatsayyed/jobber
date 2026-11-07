// src/web/noticeRoutes.ts
// Dashboard Notices API: a read-only list of the plain-text copies of what the code sent to Telegram (src/platform/noticeLog.ts).
// Auth, Host and Origin checks are enforced by the server for every route registered through `add`.
import { TOPIC_NAMES, type TopicName } from '../telegram/topics.js';
import { readNotices } from '../platform/noticeLog.js';
import { json, type Ctx } from './router.js';

export interface NoticeRoute { method: 'GET'; pattern: string; fn: (c: Ctx) => Promise<void> | void }

export function createNoticeRoutes(env: { root: string }): NoticeRoute[] {
  return [{
    method: 'GET', pattern: '/api/notices',
    fn: (c) => {
      const limitRaw = c.url.searchParams.get('limit');
      let limit = 50;
      if (limitRaw !== null) {
        if (!/^\d{1,3}$/.test(limitRaw)) return json(c.res, 400, { error: 'invalid limit' });
        limit = Number(limitRaw);
        if (limit < 1 || limit > 200) return json(c.res, 400, { error: 'invalid limit' });
      }
      const topic = c.url.searchParams.get('topic') ?? undefined;
      if (topic !== undefined && !(TOPIC_NAMES as readonly string[]).includes(topic)) return json(c.res, 400, { error: 'invalid topic' });
      json(c.res, 200, { notices: readNotices(env.root, { limit, topic: topic as TopicName | undefined }), topics: TOPIC_NAMES.filter((t) => t !== 'drips') });
    },
  }];
}
