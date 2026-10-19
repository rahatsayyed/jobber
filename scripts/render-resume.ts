// Owner helper: render the resume to HTML and PDF by hand (the old `node renderer/index.js`).
//   npm run render                 -> renderer/resume.html and resume.pdf from user-data/resume.json
//   npm run render -- <folder>     -> renderer/automation/<folder>/ from its resume.json
// HTML comes from renderer/index.js; the PDF is printed by headless installed Chrome (src/pdfRender.ts).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToPdf } from '../src/pdfRender.js';

const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');

export async function main(folder?: string): Promise<number> {
  try {
    const out = await promisify(execFile)('node', folder ? ['index.js', folder] : ['index.js'], { cwd: rendererDir });
    process.stdout.write(out.stdout);
    const dir = folder ? path.join(rendererDir, 'automation', folder) : rendererDir;
    await htmlToPdf(path.join(dir, 'resume.html'), path.join(dir, 'resume.pdf'));
    console.log(`resume.pdf generated in ${path.relative(process.cwd(), dir) || '.'}`);
    return 0;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    console.error(String(err.stderr || err.message || 'render failed').split('\n').slice(0, 3).join('\n'));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).then((c) => process.exit(c));
}
