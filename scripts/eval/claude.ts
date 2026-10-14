// Shared `claude -p` runner for the eval scripts (subscription auth, no API key, no MCP servers).
// Each call runs in a throwaway temp cwd that is always removed afterwards, success or failure.
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type Runner = (prompt: string) => Promise<string>;

export function makeClaudeRunner(model: string, tmpPrefix: string, label: string): Runner {
  return async (prompt) => {
    const cwd = mkdtempSync(path.join(tmpdir(), tmpPrefix));
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn('claude', ['-p', '--model', model, '--output-format', 'text', '--strict-mcp-config'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
        let out = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${label} timed out after 600s`)); }, 600_000);
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude -p exited ${code}`)); });
        child.stdin.end(prompt);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}
