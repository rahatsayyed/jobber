import { test, expect } from 'vitest';
import { getBaseResume, renderResume } from '../src/resume.js';
import { existsSync, statSync } from 'node:fs';

test('renders base resume to a PDF', async () => {
  const p = await renderResume(getBaseResume());
  expect(existsSync(p)).toBe(true);
  expect(statSync(p).size).toBeGreaterThan(10000);
}, 60000);
