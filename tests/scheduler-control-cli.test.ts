import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { haltPlatform, haltReason } from '../src/outreach/limits.js';
import {
  applyStop,
  applyResume,
  readControl,
  defaultDeps,
  projectRootFromScriptDir,
  stopFileForRoot,
  STOP_PREFIX,
  DEFAULT_STOP_FILE,
} from '../src/scheduler/control.js';

const NOW = new Date('2026-10-15T10:00:00Z');

describe('applyStop / applyResume', () => {
  it('stop keeps an existing active halt and prefixes the ones it writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobber-cli-'));
    const db = openDb(':memory:');
    try {
      haltPlatform(db, 'linkedin', 'checkpoint seen', NOW);
      const f = stopFileForRoot(dir);
      const r = applyStop(db, f, 'maintenance', NOW);
      expect(r.kept).toEqual({ linkedin: 'checkpoint seen' });
      expect(r.written.sort()).toEqual(['all', 'naukri']);
      expect(haltReason(db, 'linkedin')).toBe('checkpoint seen');
      expect(haltReason(db, 'all')).toBe(`${STOP_PREFIX}maintenance`);
      expect(readFileSync(f, 'utf8').startsWith(`${STOP_PREFIX}maintenance`)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resume clears only prefixed halts and reports the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobber-cli-'));
    const db = openDb(':memory:');
    try {
      haltPlatform(db, 'linkedin', 'checkpoint seen', NOW);
      haltPlatform(db, 'naukri', 'consecutive failures', NOW);
      const f = stopFileForRoot(dir);
      applyStop(db, f, 'maintenance', NOW);
      const r = applyResume(db, f, NOW);
      expect(r.stopFileRemoved).toBe(true);
      expect(existsSync(f)).toBe(false);
      expect(r.cleared).toEqual(['all']);
      expect(r.remaining).toEqual({ linkedin: 'checkpoint seen', naukri: 'consecutive failures' });
      expect(haltReason(db, 'all')).toBeNull();
      expect(haltReason(db, 'linkedin')).toBe('checkpoint seen');
      const s = readControl(db, defaultDeps({}, f));
      expect(s.halted.naukri).toBe('consecutive failures');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop then resume with no prior halts clears everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobber-cli-'));
    const db = openDb(':memory:');
    try {
      const f = stopFileForRoot(dir);
      applyStop(db, f, 'x', NOW);
      const r = applyResume(db, f, NOW);
      expect(r.cleared.sort()).toEqual(['all', 'linkedin', 'naukri']);
      expect(r.remaining).toEqual({});
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('STOP path resolution', () => {
  it('derives the root from the script dir, independent of cwd', () => {
    const root = projectRootFromScriptDir('/p/JobApplier/scripts');
    expect(root).toBe('/p/JobApplier');
    expect(stopFileForRoot(root)).toBe('/p/JobApplier/.jobber/STOP');
  });
  it('keeps the relative default for tests', () => {
    expect(DEFAULT_STOP_FILE).toBe('.jobber/STOP');
  });
});
