"""Generate static Taiwan copy; runtime has no OpenCC dependency.

Install inside this worktree:
  python3 -m pip install --no-cache-dir --target node_modules/.opencc-generator opencc-python-reimplemented==0.1.7
Run:
  PYTHONPATH=node_modules/.opencc-generator python3 scripts/generate-zh-hant.py
  pnpm exec prettier --write src/i18n/*.json
"""
import ast
import json
import re
import sys
from pathlib import Path
import opencc
from opencc import OpenCC

root = Path(__file__).resolve().parent.parent
converter = OpenCC('s2twp')
glossary = {}
exact_glossary = {}
for line in (root / 'specs/052-zh-hant/GLOSSARY-zh-Hant.md').read_text().splitlines():
    # The later v2 table contains input aliases, not display-copy overrides.
    if line.startswith('## 不转换'):
        break
    if not line.startswith('|'):
        continue
    cells = [cell.strip() for cell in line.split('|')[1:-1]]
    if len(cells) < 2 or cells[0] == '简体源' or re.fullmatch(r':?-+:?', cells[0]) or cells[1] == '原样':
        continue
    left, right = cells[:2]
    if left == '邮箱':
        glossary[left] = '信箱'  # All backend mail occurrences are prose, not input labels.
    elif left.startswith('周（'):
        glossary['周'] = '週'
    elif left.startswith('杆（'):
        glossary['杆'] = right
    elif left.startswith('杠杆（'):
        glossary['杠杆'] = right
    elif left == '次数（reps 义）':
        exact_glossary['次数'] = right
    elif left == 'N 次（reps 单位）':
        # Contextual reps examples must never replace general 次/次日/第N次.
        exact_glossary['N 次'] = right
    else:
        sources = left.split(' / ')
        targets = right.split(' / ')
        if len(targets) == 1:
            targets *= len(sources)
        for source, target in zip(sources, targets, strict=True):
            if source == '“ ”':
                glossary.update({'“': '「', '”': '」'})
            elif source == '‘ ’':
                glossary.update({'‘': '『', '’': '』'})
            else:
                glossary[source] = target
# 连杆 is a mechanical linkage, not a bar; leave it to OpenCC (連桿).
# Longest-first matching protects the glossary's lever-specific 杠杆 override.
pattern = re.compile('|'.join(
    r'(?<!连)杆' if key == '杆' else re.escape(key)
    for key in sorted(glossary, key=len, reverse=True)
))
placeholder = re.compile(r'%@|%lld|\{\{[^{}]+\}\}|\{[^{}]+\}')

def convert(source):
    if source in exact_glossary:
        return exact_glossary[source]
    # This catalog name denotes reps; do not rewrite ordinal/frequency 次.
    display_source = re.sub(
        r'^(\d+) 次(?=法弯举$)',
        lambda match: exact_glossary['N 次'].replace('N', match.group(1)),
        source,
    )
    saved = []
    def protect(match):
        saved.append(glossary[match.group()])
        return f'__GLOSSARY_{len(saved)-1}__'
    translated = converter.convert(pattern.sub(protect, display_source))
    for index, value in enumerate(saved):
        translated = translated.replace(f'__GLOSSARY_{index}__', value)
    assert placeholder.findall(source) == placeholder.findall(translated), source
    return translated

sources = set(glossary) | set(exact_glossary)
# Source copy is marked explicitly; no nicknames, notes, chat or arbitrary payloads.
for path in (root / 'src').rglob('*.ts'):
    sources.update(ast.literal_eval(match) for match in re.findall(r'''copy\(\s*[^,]+,\s*((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))''', path.read_text()))
# SQL migrations are the versioned catalog source, including later canonical renames.
# A superset of SQL strings is safe: only catalog-owned names use this table at runtime.
for path in (root / 'db/migrations').glob('*.sql'):
    for match in re.findall(r"'((?:[^']|'')*)'", path.read_text()):
        value = match.replace("''", "'")
        if re.search(r'[\u3400-\u9fff]', value) and len(value) <= 120:
            sources.add(value)
output = {source: convert(source) for source in sorted(sources)}
def emit(name, value):
    path = root / 'src/i18n' / name
    if '--check' in sys.argv:
        assert json.loads(path.read_text()) == value, f'Stale artifact: {path}'
    else:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
emit('zh-Hant.generated.json', output)
# Character-set difference, derived deterministically from the pinned OpenCC dictionary.
entries = [line.split('\t') for line in (Path(opencc.__file__).parent / 'dictionary/STCharacters.txt').read_text().splitlines() if '\t' in line]
traditional = set(''.join(value for _, value in entries).replace(' ', ''))
# Taiwan's accepted variants (峰/群, etc.) are not simplified-only characters.
taiwan_entries = [line.split('\t') for line in (Path(opencc.__file__).parent / 'dictionary/TWVariants.txt').read_text().splitlines() if '\t' in line]
traditional.update(''.join(value for _, value in taiwan_entries).replace(' ', ''))
simplified_only = ''.join(sorted({key for key, _ in entries if key not in traditional}))
emit('simplified-only.generated.json', simplified_only)
hits = {source: sorted(set(value) & set(simplified_only)) for source, value in output.items() if set(value) & set(simplified_only)}
assert not hits, hits
print(f'Generated {len(output)} translations; simplified-only character hits: 0')
