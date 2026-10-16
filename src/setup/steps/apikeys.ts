// src/setup/steps/apikeys.ts
// Step: optional API keys (Adzuna for jobs; Serper and Hunter for contact finding). Each provider is offered separately and can be
// skipped. Keys come only from askSecret, are checked with one best-effort call through ctx.fetch,
// and reach .env only through updateEnvText. A URL carrying a key is never logged and a thrown
// network error is replaced by a fixed message.
import { envFileValue, updateEnvText, writeEnvFile } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';
import { offerSkip, say } from '../coach.js';
import { SKIP_SPECS, type SkipSpec } from '../skips.js';

type Verdict = 'ok' | 'rejected' | 'unknown';
type Init = { method?: string; headers?: Record<string, string>; body?: string };

interface Provider {
  id: 'adzuna' | 'serper' | 'hunter';
  name: string;
  does: string;
  where: string;
  keys: { env: string; prompt: string }[];
  lose: string;
  defaultChoice: 'now' | 'later';
  request(values: Record<string, string>): { url: string; init?: Init };
}

// UNVERIFIED (plan 8F U4, U7): the endpoints, the credit cost of one check and the free-tier limits
// could not be checked offline. This table is the only place they live. 401 and 403 mean rejected;
// any other non-ok status, or a thrown error, means "could not verify".
const PROVIDERS: Provider[] = [
  {
    id: 'adzuna',
    name: 'Adzuna',
    does: 'a job-search API; one of the job sources',
    where: 'developer.adzuna.com (free developer account; check the site for current limits)',
    keys: [
      { env: 'ADZUNA_APP_ID', prompt: 'Adzuna app ID (input is hidden)' },
      { env: 'ADZUNA_APP_KEY', prompt: 'Adzuna app key (input is hidden)' },
    ],
    lose: 'Adzuna: one job source off (boards, Remotive and Naukri remain).',
    defaultChoice: 'now',
    request: (v) => {
      const q = new URLSearchParams({
        app_id: v.ADZUNA_APP_ID,
        app_key: v.ADZUNA_APP_KEY,
        results_per_page: '1',
        what: 'developer',
      });
      return { url: `https://api.adzuna.com/v1/api/jobs/in/search/1?${q.toString()}` };
    },
  },
  {
    id: 'serper',
    name: 'Serper',
    does: 'Google search API used to find company contact pages and emails',
    where: 'serper.dev (free credits on signup; check the site)',
    keys: [{ env: 'SERPER_API_KEY', prompt: 'Serper API key (input is hidden)' }],
    lose: 'Serper (contact finding): fewer verified contacts.',
    defaultChoice: 'now',
    request: (v) => ({
      url: 'https://google.serper.dev/search',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-KEY': v.SERPER_API_KEY },
        body: JSON.stringify({ q: 'jobber setup check', num: 1 }),
      },
    }),
  },
  {
    id: 'hunter',
    name: 'Hunter',
    does: 'last-resort email finder with a monthly credit cap',
    where: 'hunter.io',
    keys: [{ env: 'HUNTER_API_KEY', prompt: 'Hunter API key (input is hidden)' }],
    lose: 'Hunter: last-resort email lookup stays off.',
    defaultChoice: 'later',
    request: (v) => ({
      url: `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(v.HUNTER_API_KEY)}`,
    }),
  },
];

const keyValidate = (v: string): string | null =>
  v.trim() !== '' && !/\s/.test(v.trim()) ? null : 'Enter the value without spaces';

async function verify(ctx: SetupContext, p: Provider, values: Record<string, string>): Promise<Verdict> {
  try {
    const { url, init } = p.request(values);
    const res = await ctx.fetch(url, init);
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unknown';
  } catch {
    return 'unknown'; // the error text can carry the URL and so the key
  }
}

function readEnvText(ctx: SetupContext): string {
  return ctx.fs.exists(ctx.envPath) ? ctx.fs.read(ctx.envPath) : '';
}

export const apikeysStep: SetupStep = {
  id: 'apikeys',
  title: 'Optional API keys (Adzuna for jobs; Serper and Hunter for contact finding)',
  checkIds: ['api-keys'],
  async run(ctx) {
    const { io } = ctx;
    const base = SKIP_SPECS.find((s) => s.id === 'apikeys') as SkipSpec;
    const envText = readEnvText(ctx);
    const updates: Record<string, string> = {};
    let handled = 0;
    say(ctx, 'apikeys.intro');

    for (const p of PROVIDERS) {
      const existing: Record<string, string> = {};
      for (const k of p.keys) existing[k.env] = envFileValue(envText, k.env).trim();
      const allSet = p.keys.every((k) => existing[k.env] !== '');
      io.say(`${p.name}: ${p.does}.`);
      io.say(`Get a key at: ${p.where}`);
      say(ctx, `apikeys.${p.id}`);

      if (allSet) {
        for (const k of p.keys) io.registerSecret(existing[k.env]);
        if (await io.confirm(`Keep the existing ${p.name} key?`, true)) {
          handled++;
          continue;
        }
      } else {
        for (const k of p.keys) if (existing[k.env] !== '') io.registerSecret(existing[k.env]);
        const missing = p.keys.filter((k) => existing[k.env] === '').map((k) => k.env);
        if (missing.length < p.keys.length) {
          io.say(`${p.name} is only partly set; not set: ${missing.join(', ')}. Treating it as not configured.`);
        }
        const spec: SkipSpec = { ...base, title: p.name, lose: [p.lose] };
        if ((await offerSkip(ctx, spec, p.defaultChoice)) === 'later') continue;
      }

      let accepted: Record<string, string> | null = null;
      for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
        const values: Record<string, string> = {};
        for (const k of p.keys) {
          const v = (await io.askSecret(k.prompt, { validate: keyValidate })).trim();
          io.registerSecret(v);
          values[k.env] = v;
        }
        const verdict = await verify(ctx, p, values);
        if (verdict === 'ok') accepted = values;
        else if (verdict === 'unknown') {
          io.say(`warning: ${p.name} could not verify, the doctor will say.`);
          accepted = values;
        } else if (attempt === 0) io.say(`${p.name} rejected that key. Try once more.`);
        else if (await io.confirm('Keep it anyway?', false)) accepted = values;
      }
      if (!accepted) {
        io.say(allSet ? `${p.name} left unchanged (the existing value is kept).` : `${p.name} left unset.`);
        continue;
      }
      Object.assign(updates, accepted);
      handled++;

      if (p.id === 'hunter') {
        io.say('Hunter spends credits, capped per month by HUNTER_MONTHLY_CAP.');
        if (await io.confirm('Allow Hunter lookups (turn HUNTER_ENABLED on)?', false)) {
          updates.HUNTER_ENABLED = 'true';
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      const upd = updateEnvText(envText, updates);
      if (upd.changed.length > 0 || !ctx.fs.exists(ctx.envPath)) {
        writeEnvFile(ctx.envPath, upd.text, ctx.fs, ctx.now);
        io.say(`.env updated (${upd.changed.join(', ')})`);
      }
    }
    return handled === 0 ? 'skipped' : 'done';
  },
};
