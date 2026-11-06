// throwaway: node zrmit.mjs <file> <title-prefix>... removes it(...) / describe(...) blocks whose title starts with a prefix
import { readFileSync, writeFileSync } from 'node:fs';
const [file, ...titles] = process.argv.slice(2);
const lines = readFileSync(file, 'utf8').split('\n');
for (const t of titles) {
  const a = lines.findIndex((l) => /^\s*(it|describe)(\.\w+)?\(/.test(l) && (l.includes(`'${t}`) || l.includes(`"${t}`) || l.includes(`\`${t}`)));
  if (a < 0) { console.error('not found:', file, t); continue; }
  const indent = /^(\s*)/.exec(lines[a])[1];
  let b = a;
  while (b < lines.length && !(lines[b] === `${indent}});` || lines[b] === `${indent}})`) ) b++;
  let end = b + 1;
  if (lines[end] === '') end++;
  lines.splice(a, end - a);
  console.log('removed', t.slice(0, 50), b - a + 1);
}
writeFileSync(file, lines.join('\n'));
