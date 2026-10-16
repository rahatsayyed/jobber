// Owner CLI for secrets/site-accounts.json (plan 8G task 6).
//   npm run site:account -- add <host>     hidden prompt for the email and password (owner-created accounts)
//   npm run site:account -- list           host, email, source, verified (never a password)
//   npm run site:account -- remove <host>
//   npm run site:account -- status         file checks and the verification mode
// The agent never runs this; passwords are never printed.
import { fileURLToPath } from 'node:url';
import { accountKey, DEFAULT_ACCOUNTS_PATH, listAccounts, loadAccounts, removeAccount, saveAccount } from '../src/webcore/accounts.js';
import { parseSenders, verificationMode } from '../src/webcore/mailLink.js';
import { ttyIO, type SetupIO } from '../src/setup/io.js';

export interface CliDeps { path?: string; io?: SetupIO; env?: NodeJS.ProcessEnv; now?: () => Date }

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; lines: string[] }> {
  const p = deps.path ?? DEFAULT_ACCOUNTS_PATH;
  const env = deps.env ?? process.env;
  const [cmd, hostArg] = argv;
  if (cmd === 'list') {
    const l = listAccounts(p);
    if (!l) return { code: 1, lines: ['accounts file is unreadable or has wrong permissions; run status'] };
    return { code: 0, lines: l.length ? l.map((a) => `${a.host}  ${a.email}  ${a.source}  ${a.verified ? 'verified' : 'unverified'}`) : ['no accounts stored'] };
  }
  if (cmd === 'status') {
    const l = loadAccounts(p);
    const mode = verificationMode(env);
    return {
      code: l.ok ? 0 : 1,
      lines: [
        l.ok ? `accounts file ok (${Object.keys(l.accounts).length} account(s))` : `accounts file problem: ${l.reason}`,
        `verification mode: ${mode} (senders configured: ${parseSenders(env).length})`,
        `APPLY_ALLOW_ACCOUNT_CREATION=${env.APPLY_ALLOW_ACCOUNT_CREATION === 'true' ? 'true' : 'false'} SCOUT_ALLOW_SIGNUP=${env.SCOUT_ALLOW_SIGNUP === 'true' ? 'true' : 'false'}`,
      ],
    };
  }
  if (cmd === 'remove') {
    if (!hostArg || !accountKey(hostArg)) return { code: 2, lines: ['usage: remove <host>'] };
    return removeAccount(hostArg, p) ? { code: 0, lines: [`removed ${hostArg}`] } : { code: 1, lines: [`no account for ${hostArg}`] };
  }
  if (cmd === 'add') {
    const host = hostArg ? accountKey(hostArg) : null;
    if (!host) return { code: 2, lines: ['usage: add <host> (a registrable host or tenant host such as acme.wd5.myworkdayjobs.com)'] };
    const own = !deps.io;
    const io = deps.io ?? ttyIO(process.stdin, process.stdout, { terminal: process.stdin.isTTY });
    try {
      const email = (await io.ask(`Account email for ${host}`, { validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'enter an email address') })).trim();
      const password = await io.askSecret('Password (hidden)', { validate: (v) => (v.length >= 8 && v.length <= 200 ? null : 'use 8 to 200 characters') });
      saveAccount(host, { email, password, created_at: (deps.now ?? (() => new Date()))().toISOString(), source: 'owner', verified: true }, p);
      return { code: 0, lines: [`stored an account for ${host}`] };
    } finally {
      if (own) (io as ReturnType<typeof ttyIO>).close();
    }
  }
  return { code: 2, lines: ['usage: site:account -- add <host> | list | remove <host> | status'] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((r) => { for (const l of r.lines) console.log(l); process.exit(r.code); }, () => { console.error('site-account failed'); process.exit(1); });
}
