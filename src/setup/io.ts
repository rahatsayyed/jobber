// src/setup/io.ts
// Prompt IO for the setup wizard, injected everywhere so tests never touch a real terminal.
// Secrets: askSecret never echoes, and a secret answer never reaches say(), a transcript, a
// re-prompt message or an error string (the redacting wrapper and the loops below enforce it).
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

export interface SetupIO {
  /** Normal output (always redacted when wrapped by redactingIO). */
  say(line: string): void;
  ask(
    prompt: string,
    opts?: { default?: string; validate?: (v: string) => string | null },
  ): Promise<string>;
  /** No echo; the value is auto-registered as a secret by redactingIO. With `existing` (a value
   *  already stored) the prompt says "keep existing (set)" and a blank answer returns it; the
   *  stored value itself is never printed. */
  askSecret(
    prompt: string,
    opts?: { validate?: (v: string) => string | null; existing?: string },
  ): Promise<string>;
  confirm(prompt: string, defaultYes?: boolean): Promise<boolean>;
  choose<T extends string>(
    prompt: string,
    options: ChoiceOption<T>[],
    defaultValue?: T,
  ): Promise<T>;
  /** "Press Enter when done". */
  pause(prompt: string): Promise<void>;
}

const HIDDEN = '[hidden]';
const TOKEN_RE = /\d{5,}:[A-Za-z0-9_-]{10,}/g;
/** One initial attempt plus three re-prompts; the fourth failure throws. */
const MAX_ATTEMPTS = 4;
const TOO_MANY = 'Too many invalid answers';

function redactWith(text: string, secrets: Iterable<string>): string {
  let out = text.replace(TOKEN_RE, HIDDEN);
  // Longest first so a secret that contains another one is replaced whole.
  const list = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const s of list) out = out.split(s).join(HIDDEN);
  return out;
}

function stripValue(msg: string, value: string): string {
  let out = value ? msg.split(value).join(HIDDEN) : msg;
  const t = value.trim();
  if (t && t !== value) out = out.split(t).join(HIDDEN);
  return out;
}

/** A validator that throws must not leak the candidate through the error text. */
function safeValidate(
  validate: ((v: string) => string | null) | undefined,
  v: string,
): string | null {
  if (!validate) return null;
  try {
    return validate(v);
  } catch {
    return 'Invalid value';
  }
}

/** Wraps an IO: say lines, prompts and re-prompt messages have registered secrets and
 *  Telegram-token shapes replaced with [hidden]. */
export function redactingIO(
  inner: SetupIO,
  extraSecrets?: () => string[],
): SetupIO & { registerSecret(v: string): void } {
  const registered = new Set<string>();
  const all = (): string[] => [...registered, ...(extraSecrets ? extraSecrets() : [])];
  const red = (s: string): string => redactWith(s, all());
  const wrapValidate =
    (validate: ((v: string) => string | null) | undefined, isSecret: boolean) =>
    (v: string): string | null => {
      const msg = safeValidate(validate, v);
      if (msg === null) return null;
      // The candidate may not be registered yet; it must not survive in the message.
      return redactWith(msg, isSecret ? [...all(), v, v.trim()] : all());
    };
  return {
    registerSecret(v: string) {
      if (v) registered.add(v);
      if (v.trim()) registered.add(v.trim());
    },
    say: (line) => inner.say(red(line)),
    ask: (prompt, opts) =>
      inner.ask(red(prompt), opts ? { ...opts, validate: wrapValidate(opts.validate, false) } : opts),
    async askSecret(prompt, opts) {
      if (opts?.existing) {
        registered.add(opts.existing);
        if (opts.existing.trim()) registered.add(opts.existing.trim());
      }
      const v = await inner.askSecret(
        red(prompt),
        opts ? { ...opts, validate: wrapValidate(opts.validate, true) } : opts,
      );
      if (v) registered.add(v);
      if (v.trim()) registered.add(v.trim());
      return v;
    },
    confirm: (prompt, d) => inner.confirm(red(prompt), d),
    choose: (prompt, options, d) =>
      inner.choose(
        red(prompt),
        options.map((o) => ({ value: o.value, label: red(o.label) })),
        d,
      ),
    pause: (prompt) => inner.pause(red(prompt)),
  };
}

export type ScriptItem =
  | { ask?: string }
  | { secret?: string }
  | { confirm?: boolean }
  | { choose?: string }
  | { pause?: true };

type ScriptKind = 'ask' | 'secret' | 'confirm' | 'choose' | 'pause';

function kindOf(item: ScriptItem): ScriptKind {
  for (const k of ['ask', 'secret', 'confirm', 'choose', 'pause'] as const) {
    if (k in item) return k;
  }
  return 'ask';
}

/** Test double: answers are consumed in order. The transcript records say lines and prompts,
 *  never an answer to a secret prompt. */
export function scriptedIO(script: ScriptItem[]): SetupIO & {
  transcript: string[];
  assertDone(): void;
} {
  const queue = [...script];
  const transcript: string[] = [];

  function next(kind: ScriptKind, prompt: string): ScriptItem {
    const item = queue.shift();
    if (!item) throw new Error(`scriptedIO: no scripted answer left for ${kind} "${prompt}"`);
    const got = kindOf(item);
    if (got !== kind) {
      throw new Error(`scriptedIO: unexpected ${kind} "${prompt}"; next scripted item is ${got}`);
    }
    return item;
  }

  async function loop(
    kind: 'ask' | 'secret',
    prompt: string,
    validate: ((v: string) => string | null) | undefined,
    dflt: string | undefined,
  ): Promise<string> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      transcript.push(`${kind}: ${prompt}`);
      const item = next(kind, prompt) as { ask?: string; secret?: string };
      const raw = (kind === 'ask' ? item.ask : item.secret) ?? '';
      const value = raw === '' && dflt !== undefined ? dflt : raw;
      const msg = safeValidate(validate, value);
      if (msg === null) return value;
      // The re-prompt message is recorded, but a secret candidate is stripped from it.
      transcript.push(`invalid: ${kind === 'secret' ? stripValue(msg, value) : msg}`);
    }
    throw new Error(TOO_MANY);
  }

  return {
    transcript,
    say: (line) => void transcript.push(`say: ${line}`),
    ask: (prompt, opts) => loop('ask', prompt, opts?.validate, opts?.default),
    askSecret: (prompt, opts) => loop('secret', prompt, opts?.validate, opts?.existing || undefined),
    async confirm(prompt, defaultYes = true) {
      transcript.push(`confirm: ${prompt}`);
      const item = next('confirm', prompt) as { confirm?: boolean };
      return item.confirm ?? defaultYes;
    },
    async choose<T extends string>(prompt: string, options: ChoiceOption<T>[], defaultValue?: T) {
      transcript.push(`choose: ${prompt}`);
      const item = next('choose', prompt) as { choose?: string };
      const v = item.choose === '' || item.choose === undefined ? defaultValue : item.choose;
      const hit = options.find((o) => o.value === v);
      if (!hit) {
        throw new Error(
          `scriptedIO: choose "${prompt}" answer is not one of [${options.map((o) => o.value).join(', ')}]`,
        );
      }
      return hit.value;
    },
    async pause(prompt) {
      transcript.push(`pause: ${prompt}`);
      next('pause', prompt);
    },
    assertDone() {
      if (queue.length > 0) {
        throw new Error(`scriptedIO: ${queue.length} unused scripted answer(s) left`);
      }
    },
  };
}

/** Real implementation on a readable and a writable stream using node:readline.
 *  askSecret mutes the readline echo and prints a newline after. Up to three re-prompts. */
export function ttyIO(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  opts?: { terminal?: boolean },
): SetupIO & {
  close(): void;
  history(): readonly string[];
  // Release the terminal to a child process: close readline (drops raw mode) and discard
  // buffered lines. Call resume() once the child has exited.
  suspend(): void;
  // Take the terminal back: flush type-ahead typed while suspended, re-attach readline.
  resume(): void;
} {
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });
  const isTty = opts?.terminal ?? (input as { isTTY?: boolean }).isTTY === true;
  // historySize 0: a secret must never enter readline's history; empty prompt: no stale "> ".
  const lines: string[] = [];
  const waiters: { resolve: (l: string) => void; reject: (e: Error) => void }[] = [];
  let closed = false;
  let suspended = false;

  function attach(): ReturnType<typeof createInterface> {
    const r = createInterface({ input, output: sink, terminal: isTty, historySize: 0 });
    r.setPrompt('');
    r.on('line', (l) => {
      if (suspended) return;
      const w = waiters.shift();
      if (w) w.resolve(l);
      else lines.push(l);
    });
    r.on('close', () => {
      if (suspended) return;
      closed = true;
      for (const w of waiters.splice(0)) w.reject(new Error('Input closed before an answer was given'));
    });
    return r;
  }
  let rl = attach();

  function drainInput(): void {
    const r = (input as { read?: () => unknown }).read;
    if (typeof r !== 'function') return;
    try {
      while (r.call(input) !== null) {
        // discard type-ahead
      }
    } catch {
      // best effort
    }
  }

  function readLine(): Promise<string> {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (closed) return Promise.reject(new Error('Input closed before an answer was given'));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  function write(s: string): void {
    output.write(s);
  }

  // The label is a protected prefix: readline owns it (setPrompt + prompt), so its line
  // refresh (backspace, kill-line, cursor moves) redraws the label instead of erasing it. Any
  // text before the last newline is plain output; only the last line is the readline prompt.
  async function line(prompt: string, secret: boolean): Promise<string> {
    const nl = prompt.lastIndexOf('\n');
    if (nl >= 0) write(prompt.slice(0, nl + 1));
    const tail = prompt.slice(nl + 1);
    const queued = lines.shift();
    if (queued !== undefined) {
      write(tail);
      if (secret) write('\n');
      return queued;
    }
    if (closed) throw new Error('Input closed before an answer was given');
    rl.setPrompt(tail);
    rl.prompt();
    // Mute only after the label is on screen; typed characters then never reach the output
    // while editing (backspace and cursor keys still work on the hidden buffer).
    muted = secret;
    try {
      return await readLine();
    } finally {
      muted = false;
      if (secret) write('\n');
    }
  }

  async function loop(
    prompt: string,
    secret: boolean,
    validate: ((v: string) => string | null) | undefined,
    dflt: string | undefined,
  ): Promise<string> {
    const shown = dflt ? `${prompt} [${secret ? 'keep existing (set)' : dflt}] ` : `${prompt} `;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const raw = await line(shown, secret);
      const value = raw === '' && dflt !== undefined ? dflt : raw;
      const msg = safeValidate(validate, value);
      if (msg === null) return value;
      write(`${secret ? stripValue(msg, value) : msg}\n`);
    }
    throw new Error(TOO_MANY);
  }

  return {
    close: () => rl.close(),
    suspend() {
      if (suspended || closed) return;
      suspended = true;
      lines.length = 0;
      rl.close(); // pauses the input and leaves raw mode
      (input as { setRawMode?: (m: boolean) => void }).setRawMode?.(false);
    },
    resume() {
      if (!suspended) return;
      lines.length = 0;
      drainInput();
      rl = attach();
      suspended = false;
    },
    history: () => ((rl as unknown as { history?: string[] }).history ?? []),
    say: (l) => write(`${l}\n`),
    ask: (prompt, opts) => loop(prompt, false, opts?.validate, opts?.default),
    askSecret: (prompt, opts) => loop(prompt, true, opts?.validate, opts?.existing || undefined),
    async confirm(prompt, defaultYes = true) {
      const hint = defaultYes ? '[Y/n]' : '[y/N]';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const a = (await line(`${prompt} ${hint} `, false)).trim().toLowerCase();
        if (a === '') return defaultYes;
        if (a === 'y' || a === 'yes') return true;
        if (a === 'n' || a === 'no') return false;
        write('Please answer y or n.\n');
      }
      throw new Error(TOO_MANY);
    },
    async choose<T extends string>(prompt: string, options: ChoiceOption<T>[], defaultValue?: T) {
      write(`${prompt}\n`);
      options.forEach((o, i) => write(`  ${i + 1}) ${o.label}\n`));
      const dIdx = defaultValue ? options.findIndex((o) => o.value === defaultValue) : -1;
      const hint = dIdx >= 0 ? ` [${dIdx + 1}]` : '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const a = (await line(`Choose 1-${options.length}${hint}: `, false)).trim();
        if (a === '' && dIdx >= 0) return options[dIdx].value;
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
        const byValue = options.find((o) => o.value === a);
        if (byValue) return byValue.value;
        write('Not a valid choice.\n');
      }
      throw new Error(TOO_MANY);
    },
    async pause(prompt) {
      await line(`${prompt} `, false);
    },
  };
}
