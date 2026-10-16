// tests/setup-lineedit.test.ts
// The wizard prompt label is a protected prefix: editing keys only change the typed value.
// A tiny terminal emulator replays the escape sequences readline writes, so the test checks what
// the user would actually see. A fake stdin (PassThrough) drives it; no TTY is needed.
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { ttyIO } from '../src/setup/io.js';

/** Replays the output of one prompt: \r, \n, CSI n G / C / D / J / K, printable characters. */
class Screen {
  rows: string[][] = [[]];
  row = 0;
  col = 0;
  feed(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === '\x1b' && chunk[i + 1] === '[') {
        const m = /^\x1b\[(\d*)(?:;(\d*))?([A-Za-z])/.exec(chunk.slice(i));
        if (!m) continue;
        i += m[0].length - 1;
        const n = m[1] === '' ? undefined : Number(m[1]);
        const cur = this.rows[this.row];
        if (m[3] === 'G') this.col = Math.max(0, (n ?? 1) - 1);
        else if (m[3] === 'C') this.col += n ?? 1;
        else if (m[3] === 'D') this.col = Math.max(0, this.col - (n ?? 1));
        else if (m[3] === 'J') {
          cur.length = Math.min(cur.length, this.col);
          this.rows.length = this.row + 1;
        } else if (m[3] === 'K') cur.length = Math.min(cur.length, this.col);
      } else if (ch === '\r') this.col = 0;
      else if (ch === '\n') {
        this.row++;
        this.col = 0;
        this.rows[this.row] ??= [];
      } else {
        const cur = this.rows[this.row];
        while (cur.length < this.col) cur.push(' ');
        cur[this.col++] = ch;
      }
    }
  }
  /** The visible text of the line the cursor is on. */
  get line(): string {
    return this.rows[this.row].join('');
  }
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const HOME = '\x1b[H';
const END = '\x1b[F';
const BS = '\x7f';

// Sends keys one at a time, like a terminal does (one chunk would be handled as a paste).
async function keys(t: { input: PassThrough }, seq: string): Promise<void> {
  for (const k of seq.match(/\x1b\[[A-Z]|[\s\S]/g) ?? []) {
    t.input.write(k);
    await new Promise((r) => setImmediate(r));
  }
}

function make() {
  const input = new PassThrough();
  const output = new PassThrough();
  const screen = new Screen();
  let raw = '';
  output.on('data', (c: Buffer) => {
    raw += c.toString();
    screen.feed(c.toString());
  });
  const io = ttyIO(input, output, { terminal: true });
  return { input, io, screen, raw: () => raw };
}

const LABEL = 'Locations (for example India, UAE):';

describe('wizard line editor', () => {
  it('backspace edits only the typed value and never the label', async () => {
    const t = make();
    const p = t.io.ask(LABEL);
    await tick();
    await keys(t, 'Indiax');
    await tick();
    expect(t.screen.line).toBe(`${LABEL} Indiax`);
    await keys(t, BS);
    await tick();
    expect(t.screen.line).toBe(`${LABEL} India`);
    // many more backspaces than characters typed: the label must survive
    await keys(t, BS.repeat(20));
    await tick();
    expect(t.screen.line).toBe(`${LABEL} `);
    await keys(t, 'UAE\n');
    expect(await p).toBe('UAE');
    t.io.close();
  });

  it('left, right, home and end move within the value only', async () => {
    const t = make();
    const p = t.io.ask(LABEL);
    await tick();
    await keys(t, 'abcd');
    await keys(t, LEFT + LEFT + 'X'); // ab X cd -> abXcd
    await keys(t, HOME + 'S'); // S abXcd
    await keys(t, END + 'E');
    await keys(t, HOME + LEFT + RIGHT + BS); // at the start Left is a no-op; delete the S
    await tick();
    expect(t.screen.line).toBe(`${LABEL} abXcdE`);
    await keys(t, '\n');
    expect(await p).toBe('abXcdE');
    t.io.close();
  });

  it('ctrl-a, ctrl-e, ctrl-u and ctrl-w work on the value', async () => {
    const t = make();
    const p = t.io.ask(LABEL);
    await tick();
    await keys(t, 'one two three');
    await keys(t, '\x17'); // ctrl-w: delete the last word
    await tick();
    expect(t.screen.line).toBe(`${LABEL} one two `);
    await keys(t, '\x01' + 'Z' + '\x05' + 'Y'); // ctrl-a, Z, ctrl-e, Y
    await tick();
    expect(t.screen.line).toBe(`${LABEL} Zone two Y`);
    await keys(t, '\x15'); // ctrl-u: delete to the start of the value
    await tick();
    expect(t.screen.line).toBe(`${LABEL} `);
    await keys(t, 'final\n');
    expect(await p).toBe('final');
    t.io.close();
  });

  it('a pasted value arrives in one chunk', async () => {
    const t = make();
    const p = t.io.ask(LABEL);
    await tick();
    await keys(t, 'Berlin, Germany; Remote (EU)\n');
    expect(await p).toBe('Berlin, Germany; Remote (EU)');
    t.io.close();
  });

  it('a default stays in the label and a blank answer returns it', async () => {
    const t = make();
    const p = t.io.ask('Roles', { default: 'dev, ops' });
    await tick();
    expect(t.screen.line).toBe('Roles [dev, ops] ');
    await keys(t, BS + BS + '\n');
    expect(await p).toBe('dev, ops');
    t.io.close();
  });

  it('a multi-line prompt keeps its first lines and protects the last one', async () => {
    const t = make();
    const p = t.io.ask('Some explanation\nName:');
    await tick();
    await keys(t, 'ab' + BS.repeat(5));
    await tick();
    expect(t.screen.rows[0].join('')).toBe('Some explanation');
    expect(t.screen.line).toBe('Name: ');
    await keys(t, 'ok\n');
    expect(await p).toBe('ok');
    t.io.close();
  });
});

describe('hidden input (askSecret)', () => {
  it('echoes nothing, keeps the label and supports backspace and cursor keys', async () => {
    const t = make();
    const p = t.io.askSecret('Paste the key:');
    await tick();
    await keys(t, 'sekret-AB' + BS + 'C');
    await keys(t, HOME + 'x' + END);
    await keys(t, BS.repeat(3));
    await tick();
    await keys(t, 'Z\n');
    const v = await p;
    // x sek... : typed "sekret-AC", Home+x -> "xsekret-AC", 3 backspaces at the end -> "xsekret", +Z
    expect(v).toBe('xsekretZ');
    expect(t.raw()).toContain('Paste the key:');
    for (const frag of ['sekret', 'AC', 'xsek', 'Z\r']) expect(t.raw()).not.toContain(frag);
    expect(t.screen.rows[0].join('').startsWith('Paste the key:')).toBe(true);
    t.io.close();
  });

  it('shows "keep existing (set)" without the stored value, and blank keeps it', async () => {
    const t = make();
    const p = t.io.askSecret('API key:', { existing: 'stored-secret-123' });
    await tick();
    await keys(t, '\n');
    expect(await p).toBe('stored-secret-123');
    expect(t.raw()).toContain('keep existing (set)');
    expect(t.raw()).not.toContain('stored-secret-123');
    t.io.close();
  });

  it('a typed value replaces the stored one', async () => {
    const t = make();
    const p = t.io.askSecret('API key:', { existing: 'stored-secret-123' });
    await tick();
    await keys(t, 'new-value-9\n');
    expect(await p).toBe('new-value-9');
    t.io.close();
  });
});
