// tests/setup-env-writer.test.ts
import { describe, it, expect } from 'vitest';
import { updateEnvText, writeEnvFile, type EnvFs } from '../src/setup/envWriter.js';
import { parseEnv } from '../src/platform/envFile.js';

interface FakeFile { data: string; mode: number }

function fakeFs(initial: Record<string, string> = {}, opts: { failWriteOn?: RegExp } = {}) {
  const files = new Map<string, FakeFile>();
  for (const [p, d] of Object.entries(initial)) files.set(p, { data: d, mode: 0o644 });
  const fs: EnvFs = {
    exists: (p) => files.has(p),
    read: (p) => {
      const f = files.get(p);
      if (!f) throw new Error('ENOENT');
      return f.data;
    },
    write: (p, data, mode) => {
      if (opts.failWriteOn && opts.failWriteOn.test(p)) {
        files.set(p, { data: data.slice(0, 3), mode }); // partial file
        throw new Error('disk full');
      }
      files.set(p, { data, mode });
    },
    rename: (from, to) => {
      const f = files.get(from);
      if (!f) throw new Error('ENOENT');
      files.delete(from);
      files.set(to, f);
    },
    chmod: (p, mode) => {
      const f = files.get(p);
      if (!f) throw new Error('ENOENT');
      f.mode = mode;
    },
    remove: (p) => {
      files.delete(p);
    },
  };
  return { fs, files };
}

describe('updateEnvText', () => {
  it('preserves comments, blank lines, unknown keys and order; only the target changes', () => {
    const text = '# header\n\nFOO=1\n# note\nUNKNOWN=keep me\n\nBAR=2\n';
    const r = updateEnvText(text, { FOO: '9' });
    expect(r.text).toBe('# header\n\nFOO=9\n# note\nUNKNOWN=keep me\n\nBAR=2\n');
    expect(r.changed).toEqual(['FOO']);
    expect(r.unchanged).toEqual([]);
  });

  it('moves an inline comment to its own line above the key', () => {
    const r = updateEnvText('A=1\nMATCH_THRESHOLD=60   # only pursue jobs\nB=2\n', { MATCH_THRESHOLD: '70' });
    expect(r.text).toBe('A=1\n# only pursue jobs\nMATCH_THRESHOLD=70\nB=2\n');
  });

  it('keeps the export prefix', () => {
    const r = updateEnvText('export KEY=old\n', { KEY: 'new' });
    expect(r.text).toBe('export KEY=new\n');
  });

  it('changes only the last duplicate', () => {
    const r = updateEnvText('K=one\nX=1\nK=two\n', { K: 'three' });
    expect(r.text).toBe('K=one\nX=1\nK=three\n');
  });

  it('appends absent keys at the end', () => {
    expect(updateEnvText('A=1\n', { B: '2' }).text).toBe('A=1\nB=2\n');
    expect(updateEnvText('A=1', { B: '2' }).text).toBe('A=1\nB=2\n');
    expect(updateEnvText('', { B: '2' }).text).toBe('B=2\n');
    expect(updateEnvText('A=1\n\n', { B: '2' }).text).toBe('A=1\n\nB=2\n');
  });

  it('quotes values with whitespace, #, quote or $ and round-trips through parseEnv', () => {
    const r = updateEnvText('', { A: 'two words', B: 'x#y', C: 'cost$5' });
    expect(r.text).toBe("A='two words'\nB='x#y'\nC='cost$5'\n");
    expect(parseEnv(r.text)).toEqual({ A: 'two words', B: 'x#y', C: 'cost$5' });
  });

  it('never escapes: parseEnv reads every quoted value back exactly', () => {
    const vals = ['a\\b', 'say "hi"', "it's", `it's "x"`, '$HOME', 'a b # c', '"hi"'];
    for (const v of vals) {
      const r = updateEnvText('', { K: v });
      expect(parseEnv(r.text).K).toBe(v);
      expect(r.text).not.toContain('\\"');
      // the writer's own reader agrees with the loaders, so a second pass is a no-op
      expect(updateEnvText(r.text, { K: v }).changed).toEqual([]);
    }
    expect(updateEnvText('', { A: "it's" }).text).toBe('A="it\'s"\n');
    expect(updateEnvText('', { A: 'a\\b' }).text).toBe("A='a\\b'\n");
  });

  it('keeps an inline comment after a quoted value', () => {
    const r = updateEnvText("K='a b'   # why\n", { K: 'c d' });
    expect(r.text).toBe("# why\nK='c d'\n");
  });

  it('onlyIfMissing leaves non-empty values and fills empty ones', () => {
    const r = updateEnvText('A=keep\nB=\nC="  "\n', { A: 'x', B: 'y', D: 'z' }, { onlyIfMissing: true });
    expect(r.text).toBe('A=keep\nB=y\nC="  "\nD=z\n');
    expect(r.changed).toEqual(['B', 'D']);
    expect(r.unchanged).toEqual(['A']);
  });

  it('throws on a newline in a value without echoing it', () => {
    const secret = 'sup3r-secret\nINJECT=1';
    let msg = '';
    try {
      updateEnvText('', { TOKEN: secret });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('sup3r-secret');
    expect(() => updateEnvText('', { TOKEN: 'a\rb' })).toThrow();
  });

  it('throws on a bad key name', () => {
    expect(() => updateEnvText('', { '1BAD': 'x' })).toThrow();
    expect(() => updateEnvText('', { 'A B': 'x' })).toThrow();
  });

  it('is a no-op the second time', () => {
    const first = updateEnvText('X=1 # c\n', { X: '2', Y: 'a b' });
    const second = updateEnvText(first.text, { X: '2', Y: 'a b' });
    expect(second.changed).toEqual([]);
    expect(second.unchanged.sort()).toEqual(['X', 'Y']);
    expect(second.text).toBe(first.text);
  });
});

describe('writeEnvFile', () => {
  const now = () => new Date('2026-10-14T10:20:30.123Z');

  it('creates a new file with mode 600 and no backup', () => {
    const { fs, files } = fakeFs();
    const bak = writeEnvFile('/p/.env', 'A=1\n', fs, now);
    expect(bak).toBeNull();
    expect(files.get('/p/.env')).toEqual({ data: 'A=1\n', mode: 0o600 });
    expect([...files.keys()]).toEqual(['/p/.env']);
  });

  it('backs up the old text at mode 600, writes mode 600 and leaves no temp file', () => {
    const { fs, files } = fakeFs({ '/p/.env': 'OLD=1\n' });
    const bak = writeEnvFile('/p/.env', 'NEW=2\n', fs, now);
    expect(bak).not.toBeNull();
    expect(bak).toMatch(/^\/p\/\.env\.bak-/);
    // same millisecond, second write: backup name must not collide
    const again = writeEnvFile('/p/.env', 'NEWER=3\n', fs, now);
    expect(again).not.toBe(bak);
    expect(files.get(bak as string)?.data).toBe('OLD=1\n');
    expect(files.get(again as string)?.data).toBe('NEW=2\n');
    expect(files.get(bak as string)).toEqual({ data: 'OLD=1\n', mode: 0o600 });
    expect(files.get('/p/.env')).toEqual({ data: 'NEWER=3\n', mode: 0o600 });
    expect([...files.keys()].some((k) => k.includes('.tmp-'))).toBe(false);
  });

  it('keeps the original untouched when the write throws', () => {
    const { fs, files } = fakeFs({ '/p/.env': 'OLD=1\n' }, { failWriteOn: /\.tmp-/ });
    expect(() => writeEnvFile('/p/.env', 'NEW=2\n', fs, now)).toThrow();
    expect(files.get('/p/.env')?.data).toBe('OLD=1\n');
    expect([...files.keys()].some((k) => k.includes('.tmp-'))).toBe(false);
  });

  it('does nothing when the text is unchanged', () => {
    const { fs, files } = fakeFs({ '/p/.env': 'A=1\n' });
    expect(writeEnvFile('/p/.env', 'A=1\n', fs, now)).toBeNull();
    expect([...files.keys()]).toEqual(['/p/.env']);
  });
});
