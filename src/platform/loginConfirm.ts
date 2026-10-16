// Owner login scripts (npm run linkedin:login, npm run naukri:login): confirm which account is
// being logged in. No environment variable is consulted: either `--account main` is on the
// command line, or the owner answers y/yes on a terminal.
export interface LoginIo {
  isTTY: boolean;
  ask(question: string): Promise<string>;
}

export interface ConfirmResult {
  ok: boolean;
  reason?: string;
}

export async function confirmAccount(
  args: string[],
  io: LoginIo,
  expect: 'main',
  platform = 'LinkedIn',
): Promise<ConfirmResult> {
  const i = args.indexOf('--account');
  const fromEq = args.find((a) => a.startsWith('--account='))?.slice('--account='.length);
  const given = i >= 0 ? args[i + 1] : fromEq;
  if (given !== undefined) {
    if (given === expect) return { ok: true };
    return { ok: false, reason: `--account must be ${expect}` };
  }
  if (!io.isTTY) {
    return { ok: false, reason: `not a terminal: pass --account ${expect} to log in the ${expect.toUpperCase()} ${platform} account` };
  }
  const answer = (await io.ask(`Log in the ${expect.toUpperCase()} ${platform} account? (y/N) `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return { ok: true };
  return { ok: false, reason: 'not confirmed' };
}
