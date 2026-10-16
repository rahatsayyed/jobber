// tests/ui-term.test.ts
// Colour toggle logic and the guarantee that plain output (tests, --json, pipes) has no escapes.
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { formatJson, formatReport, type CheckOutcome } from '../src/platform/doctor.js';
import { renderTable } from '../src/verify/engine.js';
import { ttyIO } from '../src/setup/io.js';
import { PLAIN, colorEnabled, extractColorFlag, makeTerm, stripAnsi, termFor } from '../src/ui/term.js';

const ESC = '\x1b';

describe('colorEnabled', () => {
  it('is on for a TTY and off otherwise', () => {
    expect(colorEnabled({ env: {}, isTTY: true })).toBe(true);
    expect(colorEnabled({ env: {}, isTTY: false })).toBe(false);
    expect(colorEnabled({})).toBe(false);
  });
  it('NO_COLOR, TERM=dumb and --no-color turn it off on a TTY', () => {
    expect(colorEnabled({ env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
    expect(colorEnabled({ env: { TERM: 'dumb' }, isTTY: true })).toBe(false);
    expect(colorEnabled({ env: {}, isTTY: true, argv: ['--no-color'] })).toBe(false);
  });
  it('an empty NO_COLOR is ignored', () => {
    expect(colorEnabled({ env: { NO_COLOR: '' }, isTTY: true })).toBe(true);
  });
  it('FORCE_COLOR=1 forces it on even when piped or TERM=dumb', () => {
    expect(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true);
    expect(colorEnabled({ env: { FORCE_COLOR: '1', TERM: 'dumb' }, isTTY: false })).toBe(true);
    expect(colorEnabled({ env: { FORCE_COLOR: '0' }, isTTY: false })).toBe(false);
    expect(colorEnabled({ env: { FORCE_COLOR: 'false' }, isTTY: false })).toBe(false);
  });
  it('--no-color and NO_COLOR win over FORCE_COLOR', () => {
    expect(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: true, argv: ['--no-color'] })).toBe(false);
    expect(colorEnabled({ env: { FORCE_COLOR: '1', NO_COLOR: '1' }, isTTY: true })).toBe(false);
  });
  it('termFor reads the stream, env and argv it is given', () => {
    expect(termFor({ isTTY: true }, {}, []).color).toBe(true);
    expect(termFor({ isTTY: false }, {}, []).color).toBe(false);
    expect(termFor({ isTTY: true }, {}, ['--no-color']).color).toBe(false);
  });
  it('extractColorFlag removes --no-color and reports it', () => {
    expect(extractColorFlag(['up', '--no-color', '--status'])).toEqual({ argv: ['up', '--status'], noColor: true });
    expect(extractColorFlag(['up'])).toEqual({ argv: ['up'], noColor: false });
  });
});

const SAMPLE = [
  'PASS  tmux installed: tmux 3.8',
  'WARN  classifier: not fitted',
  '       fix: npm run classifier:fit',
  'FAIL  .env: missing',
  'SKIP  Telegram: skipped by choice',
  'MODE: DRY RUN',
  'MODE: LIVE',
  'components:',
  '  bridge     running          tmux attach -t ccgram-daemon',
  '  hunt       not running      tmux attach -t ccgram',
  '  web        skipped (setup)  npm run setup -- --step dashboard',
  'warning: manager config unreadable: x',
  'STACK: skipped by choice: telegram',
  'Stop: npm stop (or npm run down)   Emergency: npm run jobber:control -- stop',
  '3 done, 1 skipped, 0 failed',
  'already done',
  '{"passed":1,"failed":0}',
];

describe('plain term', () => {
  it('returns every input unchanged', () => {
    for (const f of [PLAIN.bold, PLAIN.dim, PLAIN.red, PLAIN.green, PLAIN.yellow, PLAIN.cyan, PLAIN.question, PLAIN.paint]) {
      expect(f('some text')).toBe('some text');
    }
    expect(PLAIN.paint(SAMPLE.join('\n'))).toBe(SAMPLE.join('\n'));
    expect(PLAIN.defaultHint('x')).toBe('[x]');
    expect(PLAIN.badge('pass')).toBe('PASS');
    expect(PLAIN.header(2, 5, 'Title')).toBe('Step 2 of 5: Title');
    expect(PLAIN.color).toBe(false);
  });
  it('box and rule use ASCII only', () => {
    const out = [...PLAIN.box(['a', 'bb'], 'T'), PLAIN.rule('x')].join('\n');
    expect(out).not.toContain(ESC);
    expect(/^[\x20-\x7e\n]*$/.test(out)).toBe(true);
  });
  it('doctor text and json, and the dry-run table, carry no escape sequence', () => {
    const results: CheckOutcome[] = [
      { id: 'a', title: 'First', result: { status: 'pass', detail: 'ok' } },
      { id: 'b', title: 'Second', result: { status: 'fail', detail: 'bad', fix: 'do x' } },
    ];
    expect(formatReport(results)).not.toContain(ESC);
    expect(formatJson(results)).not.toContain(ESC);
    expect(PLAIN.paint(formatReport(results))).toBe(formatReport(results));
    const table = renderTable([{ id: 's', title: 'Stage', status: 'pass', detail: 'fine' } as never]);
    expect(PLAIN.paint(table)).toBe(table);
    expect(table).not.toContain(ESC);
  });
});

describe('coloured term', () => {
  const T = makeTerm(true);
  it('adds escapes and stripping them gives the plain text back', () => {
    expect(T.bold('x')).toContain(ESC);
    expect(stripAnsi(T.cyan('x'))).toBe('x');
    for (const line of SAMPLE) expect(stripAnsi(T.paint(line)), line).toBe(line);
    expect(T.paint('{"passed":1}')).toBe('{"passed":1}');
  });
  it('badges keep one width and distinct colours', () => {
    const all = (['pass', 'warn', 'fail', 'skip'] as const).map((s) => T.badge(s));
    for (const b of all) expect(stripAnsi(b).length).toBe(4);
    expect(new Set(all).size).toBe(4);
  });
  it('the step header paints "Step i of n: title"', () => {
    const h = T.paint('Step 3 of 13: Job questions');
    expect(h).toContain(ESC);
    expect(stripAnsi(h)).toContain('Step 3 of 13: Job questions');
  });
  it('question keeps the label, explanation and example text intact', () => {
    for (const q of ['KEY (days): what it limits', 'Roles you want (for example react, node)', 'Plain question']) {
      expect(stripAnsi(T.question(q))).toBe(q);
    }
    expect(T.question('Plain question')).toContain(ESC);
  });
  it('box lines have equal visible width', () => {
    const rows = T.box([T.green('ok'), 'longer line'], 'Title');
    const widths = rows.map((r) => stripAnsi(r).length);
    expect(new Set(widths).size).toBe(1);
  });
});

describe('ttyIO output', () => {
  async function run(term?: ReturnType<typeof makeTerm>): Promise<string> {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c: Buffer) => (out += c.toString()));
    const io = ttyIO(input, output, term ? { term } : undefined);
    io.say('Step 1 of 2: Demo');
    io.say('warning: careful');
    input.write('Alice\n');
    await io.ask('Name (for example Alice):', { default: 'Bob' });
    input.write('bad\nok\n');
    await io.ask('Code:', { validate: (v) => (v === 'ok' ? null : 'Not valid') });
    input.write('y\n');
    await io.confirm('Go?');
    input.write('2\n');
    await io.choose('Pick', [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], 'a');
    input.write('hidden-value\n');
    await io.askSecret('Key:');
    input.write('\n');
    await io.pause('Press Enter');
    io.close();
    return out;
  }

  it('default (no term) output has no escape sequences', async () => {
    expect(await run()).not.toContain(ESC);
  });
  it('an explicit plain term is byte-identical to the default', async () => {
    expect(await run(PLAIN)).toBe(await run());
  });
  it('a coloured term only adds escapes: stripping them gives the plain transcript back', async () => {
    const coloured = await run(makeTerm(true));
    expect(coloured).toContain(ESC);
    expect(coloured).not.toContain('hidden-value');
    const plain = await run();
    // the step header gains a blank line and a rule when painted; everything else is identical
    const ruleless = stripAnsi(coloured).replace(/^\n/, '').replace(/^─+\n/m, '');
    expect(ruleless).toBe(plain);
  });
});
