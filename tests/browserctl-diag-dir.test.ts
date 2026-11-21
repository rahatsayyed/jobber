import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagDirOf, writeCommitDiag, writeDialogStructureDiag } from '../src/browserctl/diag.js';

const NOW = () => new Date('2026-10-14T10:00:00Z');
const page = { url: () => '/in/jane-example/' } as never;
const live = { role: 'button', name: 'More' } as never;
const tree = { url: '/in/jane-example/', nodes: [{ role: 'button', name: 'More', dialog: 0 }] } as never;

/** Files this test's platform tag left in the project's live diag folder (must stay none). */
const leaked = (platform: string): string[] => {
  const dir = path.join(process.cwd(), '.jobber', 'diag');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(platform)) : [];
};

describe('diag directory under the test runner', () => {
  it('no injected diagDir: there is no directory, so nothing can reach the live .jobber/diag', () => {
    expect(diagDirOf({ now: NOW })).toBeNull();
  });

  it('an injected diagDir is used as given', () => {
    expect(diagDirOf({ now: NOW, diagDir: '/x/y' })).toBe('/x/y');
  });

  it('writeCommitDiag without diagDir writes nothing and returns null', async () => {
    const r = await writeCommitDiag({ now: NOW }, page, { platform: 'zzleak1', code: 'more_menu_missing', live, urlBefore: '/in/jane-example/', after: tree });
    expect(r).toBeNull();
    expect(leaked('zzleak1')).toEqual([]);
  });

  it('writeDialogStructureDiag without diagDir writes nothing and returns null', () => {
    const r = writeDialogStructureDiag({ now: NOW }, { platform: 'zzleak2', code: 'resume_mismatch', tree, dlg: 0 });
    expect(r).toBeNull();
    expect(leaked('zzleak2')).toEqual([]);
  });

  it('with an injected diagDir both writers still write (the real diag path is unchanged)', async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'diagdir-')), 'diag');
    const a = await writeCommitDiag({ now: NOW, diagDir: dir }, page, { platform: 'linkedin', code: 'more_menu_missing', live, urlBefore: '/in/jane-example/', after: tree });
    const b = writeDialogStructureDiag({ now: NOW, diagDir: dir }, { platform: 'linkedin', code: 'resume_mismatch', tree, dlg: 0 });
    expect(a).toContain('linkedin-2026-10-14T10-00-00-000Z.json');
    expect(b).toContain('linkedin-dialog-resume_mismatch-');
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('repeated writes into an injected dir keep unique names', async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'diagdir-')), 'diag');
    for (let k = 0; k < 3; k++) await writeCommitDiag({ now: NOW, diagDir: dir }, page, { platform: 'naukri', code: 'x', live, urlBefore: '/a', after: null });
    expect(readdirSync(dir)).toHaveLength(3);
  });
});
