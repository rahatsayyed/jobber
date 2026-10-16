// src/ui/term.ts
// Tiny ANSI helpers for the owner-facing CLIs (setup wizard, doctor, dry-run, up/down). No
// dependency, no TUI. Colour is OFF unless the output is a terminal that wants it:
//   --no-color            off (always wins)
//   NO_COLOR (non-empty)  off
//   FORCE_COLOR=1         on, even when piped (any value except "", "0" and "false")
//   TERM=dumb             off
//   stdout is a TTY       on
// Everything that is captured by tests or consumed by machines (--json, Telegram replies, files)
// goes through the PLAIN term, whose helpers return their input unchanged, so that output stays
// byte-identical: the renderers in src/ never import this module, only the entry scripts and the
// setup IO (which defaults to PLAIN) do.

export type Status = 'pass' | 'warn' | 'fail' | 'skip';

export interface ColorEnv {
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  argv?: readonly string[];
}

export function colorEnabled(i: ColorEnv = {}): boolean {
  const env = i.env ?? {};
  if ((i.argv ?? []).includes('--no-color')) return false;
  if ((env.NO_COLOR ?? '') !== '') return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0' && force.toLowerCase() !== 'false') return true;
  if (env.TERM === 'dumb') return false;
  return i.isTTY === true;
}

/** Removes --no-color from an argv (the CLIs' own parsers reject unknown flags). */
export function extractColorFlag(argv: readonly string[]): { argv: string[]; noColor: boolean } {
  return { argv: argv.filter((a) => a !== '--no-color'), noColor: argv.includes('--no-color') };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface Term {
  readonly color: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  /** Fixed width (4) PASS / WARN / FAIL / SKIP badge. */
  badge(status: Status): string;
  /** A horizontal rule, optionally with a title. */
  rule(title?: string, width?: number): string;
  /** "Step 3 of 13: Title" as a blank line, a bold line and a rule. */
  header(index: number, total: number, title: string): string;
  /** Lines framed in a box with an optional title. Plain terms use ASCII. */
  box(lines: string[], title?: string): string[];
  /** Style one line (or several) of a CLI output. Returns the input unchanged when colour is off. */
  paint(text: string): string;
  /** Style a wizard question: the label bold cyan, an explanation or example dim. */
  question(label: string): string;
  /** A default value in brackets. */
  defaultHint(value: string): string;
}

const BADGE_TEXT: Record<Status, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };

function wrap(code: string, on: boolean): (s: string) => string {
  return on ? (s) => (s === '' ? s : `\x1b[${code}m${s}\x1b[0m`) : (s) => s;
}

const STATE_GOOD = /^(running|unit loaded)$/;
const STATE_WARN = /^(not running|window up, no answer|disabled)$/;

export function makeTerm(enabled: boolean): Term {
  const bold = wrap('1', enabled);
  const dim = wrap('2', enabled);
  const red = wrap('31', enabled);
  const green = wrap('32', enabled);
  const yellow = wrap('33', enabled);
  const cyan = wrap('36', enabled);
  const boldRed = wrap('1;31', enabled);
  const boldGreen = wrap('1;32', enabled);
  const boldYellow = wrap('1;33', enabled);
  const boldCyan = wrap('1;36', enabled);
  const dash = enabled ? '─' : '-';

  const badge = (s: Status): string => {
    const t = BADGE_TEXT[s];
    if (!enabled) return t;
    return s === 'pass' ? boldGreen(t) : s === 'warn' ? boldYellow(t) : s === 'fail' ? boldRed(t) : dim(t);
  };

  const rule = (title?: string, width = 60): string => {
    if (!title) return dim(dash.repeat(width));
    const head = `${dash.repeat(2)} ${title} `;
    return dim(head + dash.repeat(Math.max(2, width - head.length)));
  };

  const header = (i: number, total: number, title: string): string =>
    enabled ? `\n${boldCyan(`Step ${i} of ${total}`)}${bold(`: ${title}`)}\n${rule()}` : `Step ${i} of ${total}: ${title}`;

  const box = (lines: string[], title?: string): string[] => {
    const w = Math.max(title ? title.length + 2 : 0, ...lines.map((l) => stripAnsi(l).length));
    const tl = enabled ? '┌' : '+';
    const tr = enabled ? '┐' : '+';
    const bl = enabled ? '└' : '+';
    const br = enabled ? '┘' : '+';
    const v = enabled ? '│' : '|';
    const top = title ? `${tl}${dash} ${title} ${dash.repeat(Math.max(0, w - title.length - 1))}${tr}` : `${tl}${dash.repeat(w + 2)}${tr}`;
    return [
      top,
      ...lines.map((l) => `${v} ${l}${' '.repeat(w - stripAnsi(l).length)} ${v}`),
      `${bl}${dash.repeat(w + 2)}${br}`,
    ];
  };

  const paintLine = (line: string): string => {
    let m: RegExpExecArray | null;
    if ((m = /^(PASS|WARN|FAIL|SKIP)(\s{2})(.*)$/.exec(line))) {
      const st = m[1].toLowerCase() as Status;
      const rest = m[3];
      const colon = rest.indexOf(': ');
      const body = colon > 0 ? `${bold(rest.slice(0, colon))}: ${rest.slice(colon + 2)}` : rest;
      return `${badge(st)}${m[2]}${st === 'skip' ? dim(stripAnsi(body)) : body}`;
    }
    if (/^\s+fix:/.test(line)) return dim(line);
    if ((m = /^(MODE:\s*)(DRY RUN)(.*)$/.exec(line))) return `${bold(m[1])}${boldGreen(m[2])}${m[3]}`;
    if ((m = /^(MODE:\s*)(LIVE)(.*)$/.exec(line))) return `${bold(m[1])}${boldRed(m[2])}${m[3]}`;
    if ((m = /^Step (\d+) of (\d+): (.*)$/.exec(line))) return header(Number(m[1]), Number(m[2]), m[3]);
    if (/^(warning|warn)\b/i.test(line)) return yellow(line);
    if (/^(step failed|setup stopped|error|doctor has failures|kill switch is on)/i.test(line)) return red(line);
    if (/^already done\b/.test(line)) return dim(green(line));
    if ((m = /^(\d+) done, (\d+) skipped, (\d+) failed$/.exec(line))) {
      return `${green(`${m[1]} done`)}, ${yellow(`${m[2]} skipped`)}, ${Number(m[3]) > 0 ? red(`${m[3]} failed`) : `${m[3]} failed`}`;
    }
    if (/^STACK:/.test(line)) return yellow(line);
    if (/^(Stop|windows|ticks|dry-run):/.test(line)) return dim(line);
    // component table rows: "  name  state  how to look"
    if ((m = /^(\s{2}\S+\s+)(.+?)(\s{2,}.*)?$/.exec(line)) && /^\s{2}\S/.test(line)) {
      const state = m[2];
      const tail = m[3] ?? '';
      if (/^skipped \(setup\)$/.test(state)) return `${m[1]}${dim(state)}${dim(tail)}`;
      if (STATE_WARN.test(state)) return `${m[1]}${yellow(state)}${dim(tail)}`;
      if (STATE_GOOD.test(state)) return `${m[1]}${green(state)}${dim(tail)}`;
    }
    return line;
  };

  const paint = enabled ? (text: string): string => text.split('\n').map(paintLine).join('\n') : (text: string): string => text;

  const question = (label: string): string => {
    if (!enabled) return label;
    const nl = label.lastIndexOf('\n');
    const head = nl >= 0 ? label.slice(0, nl + 1) : '';
    const last = label.slice(nl + 1);
    let m: RegExpExecArray | null;
    if ((m = /^([^:]{1,80}?:)\s(.+)$/.exec(last))) return `${head}${boldCyan(m[1])} ${dim(m[2])}`;
    if ((m = /^(.*?)(\s\([^()]*\))$/.exec(last))) return `${head}${boldCyan(m[1])}${dim(m[2])}`;
    return `${head}${boldCyan(last)}`;
  };

  const defaultHint = (value: string): string => (enabled ? `${dim('[')}${bold(value)}${dim(']')}` : `[${value}]`);

  return { color: enabled, bold, dim, red, green, yellow, cyan, badge, rule, header, box, paint, question, defaultHint };
}

/** The no-op term: every helper returns its input. Used by default everywhere. */
export const PLAIN: Term = makeTerm(false);

/** Term for an output stream, from the real environment and argv. */
export function termFor(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv.slice(2),
): Term {
  return makeTerm(colorEnabled({ env, isTTY: stream.isTTY === true, argv }));
}

/** Entry-script helper: pulls --no-color out of process.argv (so the CLI's own parser never
 *  sees it) and returns the term for stdout. */
export function initTerm(stream: { isTTY?: boolean } = process.stdout): Term {
  const { argv, noColor } = extractColorFlag(process.argv.slice(2));
  if (noColor) process.argv = [...process.argv.slice(0, 2), ...argv];
  return makeTerm(colorEnabled({ env: process.env, isTTY: stream.isTTY === true, argv: noColor ? ['--no-color'] : [] }));
}
