// tests/stack-cli.test.ts
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { loopbackProbe, parseArgs } from '../scripts/stack.js';

describe('stack CLI parse', () => {
  it('up and up --status', () => {
    expect(parseArgs(['up'])).toEqual({ cmd: 'up', status: false });
    expect(parseArgs(['up', '--status'])).toEqual({ cmd: 'up', status: true });
  });

  it('down flags', () => {
    expect(parseArgs(['down'])).toEqual({ cmd: 'down', keepBridge: false, force: false, yes: false });
    expect(parseArgs(['down', '--keep-bridge', '--force', '--yes'])).toEqual({
      cmd: 'down', keepBridge: true, force: true, yes: true,
    });
  });

  it('unknown flag, wrong-command flag and unknown command are errors', () => {
    expect(parseArgs(['up', '--bogus']).cmd).toBe('error');
    expect(parseArgs(['up', '--force']).cmd).toBe('error');
    expect(parseArgs(['down', '--status']).cmd).toBe('error');
    expect(parseArgs(['sideways']).cmd).toBe('error');
    expect(parseArgs([]).cmd).toBe('error');
  });

  it('package scripts map npm run up -- --status to [up, --status]', () => {
    const s = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(s.up).toBe('tsx scripts/stack.ts up');
    expect(s.down).toBe('tsx scripts/stack.ts down');
    expect(s.start).toBe(s.up);
    expect(s.stop).toBe(s.down);
    const argv = [...s.up.split(' ').slice(2), '--status'];
    expect(argv).toEqual(['up', '--status']);
    expect(parseArgs(argv)).toEqual({ cmd: 'up', status: true });
  });

  it('probe refuses non-loopback hosts without any request', async () => {
    expect(await loopbackProbe('http://example.com/api/auth/mode')).toBe(false);
    expect(await loopbackProbe('not a url')).toBe(false);
  });

  it('probe does not follow a redirect and counts a 3xx as up', async () => {
    let hits = 0;
    const srv = createServer((req, res) => {
      hits++;
      if (req.url === '/target') {
        res.statusCode = 200;
        res.end('ok');
      } else {
        res.statusCode = 302;
        res.setHeader('location', 'http://127.0.0.1:1/elsewhere');
        res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as { port: number }).port;
      expect(await loopbackProbe(`http://127.0.0.1:${port}/start`)).toBe(true);
      expect(hits).toBe(1);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
