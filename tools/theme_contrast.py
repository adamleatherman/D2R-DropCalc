"""WCAG contrast check of the light / dark palettes in index.html (stdlib only)."""
import re, sys
src = open(sys.argv[1] if len(sys.argv) > 1 else 'index.html', encoding='utf-8').read()

def pal(rule_start):
    i = src.index(rule_start)
    body = src[src.index('{', i) + 1:src.index('}', i)]
    return dict(re.findall(r'--([\w-]+):(#[0-9a-fA-F]{6})', body))

def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= .03928 else ((x + .055) / 1.055) ** 2.4 for x in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]

def cr(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + .05) / (lb + .05)

BG = ['bg', 'panel', 'panel2', 'hover']
tags = ['tag-champion', 'tag-unique', 'tag-minion', 'tag-super', 'tag-boss', 'tag-herald'] + ['side-' + s for s in 'prefix suffix auto staff socket ethereal superior'.split()]
checks = [('text', BG + ['primary-bg']), ('dim', BG), ('accent', BG + ['primary-bg']), ('good', BG), ('bad', BG), ('tz', BG), ('drop-orange', BG), ('drop-unique', BG), ('drop-set', BG), ('q-magic', ['panel2', 'hover']), ('q-rare', ['panel2', 'hover']), ('err', BG)] + [(t, ['panel2', 'hover']) for t in tags] + [('on-accent', ['accent'])] + [('chart-1', BG)]   # chart-1: a 2px line, graphics need only 3:1
MINC = {'chart-1': 3.0}
bad = 0
for name, start in (('dark', ':root {'), ('light', ':root[data-theme="light"]')):
    p = pal(start)
    print('==', name)
    for fg, bgs in checks:
        r = [(b, cr(p[fg], p[b])) for b in bgs]
        flag = any(v < MINC.get(fg, 4.5) for _, v in r); bad += flag
        print('%-14s %s  %s%s' % (fg, p[fg], '  '.join('%s %.2f' % x for x in r), '   FAIL' if flag else ''))
    if name == 'light':
        m = re.search(r'@media \(prefers-color-scheme: light\) \{ :root:not\(\[data-theme\]\) \{([^}]*)\}', src)
        q = dict(re.findall(r'--([\w-]+):(#[0-9a-fA-F]{6})', m.group(1)))
        print('media palette == light palette:', q == p)
sys.exit(1 if bad else 0)
