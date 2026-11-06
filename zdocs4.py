import re

def sub(path, pairs, count=1):
    s = open(path).read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit('missing in %s: %s' % (path, a[:90]))
        s = s.replace(a, b, count if count else -1)
    open(path, 'w').write(s)

sub('tests/platform-checks-scheduler.test.ts', [
    ("never mentions WINDOW_LANES'", "never mentions the old lane flag'"),
    ("expect(fine.detail).not.toMatch(/WINDOW_LANES/);", "expect(fine.detail).not.toMatch(new RegExp('WINDOW_' + 'LANES'));"),
])
sub('tests/stack-up.test.ts', [("expect(d.out.join('\\n')).not.toMatch(/WINDOW_LANES/);", "expect(d.out.join('\\n')).not.toMatch(new RegExp('WINDOW_' + 'LANES'));")])
sub('src/platform/windowConfig.ts', [("(matched against WINDOW_LANES)", "(descriptive; also read by scripts/window-env.ts for the start-time records)")])
sub('src/scheduler/mailDrip.ts', [("(config/manager-windows.json, WINDOW_LANES)", "(config/manager-windows.json)")])
sub('CLAUDE.md', [("RUN_WINDOW_KEEP_MIN", "RUN_WINDOW_KEEP_MIN")], 1) if False else None

for path in ('CLAUDE.md', 'docs/reference/platform-and-sessions.md'):
    s = open(path).read()
    L = s.split('\n')
    for i, l in enumerate(L):
        if 'WINDOW_LANES' in l:
            print(path, i + 1, [m.start() for m in re.finditer('WINDOW_LANES', l)], l[max(0, l.index('WINDOW_LANES') - 160): l.index('WINDOW_LANES') + 200])
