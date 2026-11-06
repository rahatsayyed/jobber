// Test helper: career_ops_v1 score_dims for a wanted Global score. Every positive dimension equals the Global (so the "global is never above the
// best dimension" guard does not bite), red_flags 0. The stored score is the Global itself (1..5): coDims(4.0) -> 4.
export const coDims = (global: number, over: Record<string, unknown> = {}) => ({
  rubric: 'career_ops_v1',
  cv_match: global, north_star: global, comp: global, culture: global,
  red_flags: 0, global,
  archetype: 'Full-stack developer',
  evidence: { north_star: '"Full Stack Developer" - "We build web apps with React and Node."' },
  ...over,
});
