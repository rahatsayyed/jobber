import { execFile, spawn } from 'node:child_process';

export interface ExecOpts { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }
export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<{ stdout: string; stderr: string; code: number }>;

export const defaultExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (e.code === 'ENOENT') return resolve({ stdout: stdout ?? '', stderr: stderr || String(e.message), code: 127 });
        const code = typeof e.code === 'number' ? e.code : 1;
        resolve({ stdout: stdout ?? '', stderr: stderr || String(e.message), code });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(opts.input);
    }
  });

export function pipeExec(
  producer: { cmd: string; args: string[]; cwd?: string },
  consumer: { cmd: string; args: string[] },
): Promise<{ producerCode: number; consumerCode: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let producerCode: number | null = null;
    let consumerCode: number | null = null;
    const done = () => {
      if (producerCode !== null && consumerCode !== null) resolve({ producerCode, consumerCode, stderr });
    };
    const p = spawn(producer.cmd, producer.args, { cwd: producer.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const c = spawn(consumer.cmd, consumer.args, { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { stderr += String(d); });
    c.stderr.on('data', (d) => { stderr += String(d); });
    c.stdin.on('error', () => undefined);
    p.stdout.pipe(c.stdin);
    p.on('error', (e: NodeJS.ErrnoException) => {
      stderr += String(e.message);
      c.stdin.end();
      producerCode = e.code === 'ENOENT' ? 127 : 1;
      done();
    });
    c.on('error', (e: NodeJS.ErrnoException) => {
      stderr += String(e.message);
      p.kill();
      consumerCode = e.code === 'ENOENT' ? 127 : 1;
      done();
    });
    p.on('close', (code) => { producerCode = code ?? 1; done(); });
    c.on('close', (code) => { consumerCode = code ?? 1; done(); });
  });
}
