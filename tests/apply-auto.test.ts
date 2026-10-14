import { describe, it, expect } from 'vitest';

// apply.ts is an MCP server entrypoint (registers tools against a McpServer instance and
// calls server.connect() at import time unless VITEST=true is set) — so this test exercises
// the pure routing decision directly rather than spinning up the MCP server, mirroring how
// this project already avoids testing its other *.ts MCP entrypoints end-to-end.
import { routeApplyAuto } from '../src/mcp/applyAutoRouter.js';

describe('routeApplyAuto', () => {
  it('routes a Greenhouse URL to the greenhouse platform with expected_platform pinned', () => {
    expect(routeApplyAuto('https://boards.greenhouse.io/acme/jobs/123')).toEqual({
      kind: 'external',
      platform: 'greenhouse',
    });
  });

  it('routes a Lever URL to the lever platform with expected_platform pinned', () => {
    expect(routeApplyAuto('https://jobs.lever.co/acme/abc-123')).toEqual({
      kind: 'external',
      platform: 'lever',
    });
  });

  it('routes a LinkedIn URL to the linkedin (Easy Apply) path', () => {
    expect(routeApplyAuto('https://www.linkedin.com/jobs/view/123456')).toEqual({ kind: 'linkedin' });
  });

  it('does not treat look-alike LinkedIn hosts as LinkedIn (no burner-session Easy Apply)', () => {
    for (const url of ['https://evillinkedin.com/jobs/view/1', 'https://linkedin.com.evil.net/jobs/view/1', 'https://www.linkedin.com@evil.net/jobs/view/1']) {
      expect(routeApplyAuto(url)).toEqual({ kind: 'external', platform: null });
    }
    expect(routeApplyAuto('https://linkedin.com/jobs/view/1')).toEqual({ kind: 'linkedin' });
  });

  it('routes an unrecognized domain to the bootstrap path (external, no expected_platform)', () => {
    expect(routeApplyAuto('https://jobs.newats.example/apply/123')).toEqual({
      kind: 'external',
      platform: null,
    });
  });

  it('routes a malformed URL to the bootstrap path rather than throwing', () => {
    expect(routeApplyAuto('not a url')).toEqual({ kind: 'external', platform: null });
  });
});
