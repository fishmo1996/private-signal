#!/usr/bin/env python3
"""武器①:跨模組 import 完整性掃描。
抓「某模組的 export、檔內有呼叫、卻不在 import 清單」的無聲 ReferenceError。
用法: python3 tools/check-imports.py   (在專案根目錄)
已知誤報型:動態 import(await import)、函式參數同名——逐筆查證即可。
"""
import re, glob, sys
exports=set()
for f in glob.glob('modules/*.js')+['utils/indexeddb.js']:
    s=open(f).read()
    exports.update(re.findall(r'export (?:async )?function (\w+)', s))
    exports.update(re.findall(r'export const (\w+)', s))
problems=[]
for f in glob.glob('modules/*.js')+['app.js']:
    s=open(f).read()
    imported=set()
    for m in re.finditer(r"import \{([^}]+)\} from", s):
        for n in m.group(1).split(','):
            imported.add(n.strip().split(' as ')[-1])
    declared=set(re.findall(r'(?:const|let|var|function)\s+(\w+)', s))
    declared.update(re.findall(r'export (?:async )?function (\w+)', s))
    # 動態 import 解構:const { X, Y } = await import(...)
    for m in re.finditer(r'\{([^{}]+)\}\s*=\s*await import\(', s):
        for n in m.group(1).split(','):
            declared.add(n.strip().split(':')[-1].strip())
    # 函式參數同名:function f(a, getX) / (a, getX) =>
    for m in re.finditer(r'(?:function\s+\w*|\w+\s*=)?\s*\(([^()]*)\)\s*(?:=>|\{)', s):
        for n in m.group(1).split(','):
            n=n.strip().split('=')[0].strip()
            if re.fullmatch(r'\w+', n): declared.add(n)
    used=set(re.findall(r'(?<![.\w])(\w+)\s*\(', s))
    missing=(used & exports) - imported - declared
    if missing: problems.append((f, sorted(missing)))
if problems:
    for f,ms in problems: print('!!!', f, '缺 import(查證動態 import/參數同名後再修):', ms)
    sys.exit(1)
print('全站掃描:所有跨模組引用的 import 都齊')
