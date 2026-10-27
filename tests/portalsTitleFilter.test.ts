import { describe, it, expect } from 'vitest';
import { loadPortals, titlePasses } from '../src/sources/boards/filters.js';

const { config } = loadPortals();
const f = config!.title_filter;

describe('config/portals.json title_filter, real board titles', () => {
  it.each([
    'Senior Software Engineer, Frontend',
    'Full Stack Engineer',
    'Senior Fullstack Developer',
    'Frontend Engineer (React)',
    'Software Developer',
    'Senior Software Developer - Web',
    'Web Engineer',
    'Product Engineer',
    'Senior Product Engineer',
    'Founding Engineer',
    'React Native Developer',
    'JavaScript Engineer',
  ])('keeps %s', (title) => {
    expect(titlePasses(title, f)).toBe(true);
  });

  it.each([
    'Staff Software Engineer',
    'Principal Product Engineer',
    'Engineering Manager',
    'Product Manager',
    'Backend Engineer',
    'Sales Engineer',
    'Software Engineering Intern',
    'Head of Product Engineering',
  ])('still drops %s', (title) => {
    expect(titlePasses(title, f)).toBe(false);
  });
});
