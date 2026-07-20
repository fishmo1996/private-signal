#!/usr/bin/env python3
"""tools/check-docs.py — 文件一致性對表(v91,preflight 第⑥關)。
治「文件=跨代 AI 的記憶,但文件會悄悄過期」的慢性病。對表項目:
  1. data/config.json 的 version == README 所有「目前版本:**vXX**」== HANDOVER「最後更新…版本 vXX」
  2. modules/*.js 實際檔數 == 兩份文件樹狀圖的「# N 模組」宣稱
  3. tests/*.test.mjs 實際檔數 == HANDOVER「常駐檔數:N」宣稱
dev-notes/ 不在(如乾淨上傳包)= 印提示後跳過,不擋。任何不符 = exit 1(紅燈不可打包)。
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
README = os.path.join(ROOT, 'dev-notes', 'README.md')
HANDOVER = os.path.join(ROOT, 'dev-notes', 'HANDOVER.md')

if not (os.path.exists(README) and os.path.exists(HANDOVER)):
    print('  dev-notes/ 不在(乾淨上傳包?),文件對表跳過')
    sys.exit(0)

fails = []
version = json.load(open(os.path.join(ROOT, 'data', 'config.json'), encoding='utf-8'))['version']
readme = open(README, encoding='utf-8').read()
handover = open(HANDOVER, encoding='utf-8').read()

# 1) 版本戳
for i, v in enumerate(re.findall(r'目前版本:\*\*(v[\w.]+)\*\*', readme), 1):
    if v != version:
        fails.append(f'README 第 {i} 個「目前版本」= {v},config = {version}')
m = re.search(r'最後更新:.*?版本 (v[\w.]+)', handover)
if not m:
    fails.append('HANDOVER 找不到「最後更新…版本 vXX」行')
elif m.group(1) != version:
    fails.append(f'HANDOVER 最後更新版本 = {m.group(1)},config = {version}')

# 2) 模組數(樹狀圖註解「# N 模組」)
actual_mods = len(glob.glob(os.path.join(ROOT, 'modules', '*.js')))
for name, doc in (('README', readme), ('HANDOVER', handover)):
    for n in re.findall(r'#\s*(\d+)\s*模組', doc):
        if int(n) != actual_mods:
            fails.append(f'{name} 樹狀圖宣稱 {n} 模組,實際 {actual_mods}')

# 3) 常駐測試數(HANDOVER §7「常駐檔數:N」)
actual_tests = len(glob.glob(os.path.join(ROOT, 'tests', '*.test.mjs')))
m = re.search(r'常駐檔數:(\d+)', handover)
if not m:
    fails.append('HANDOVER §7 找不到「常駐檔數:N」對表行')
elif int(m.group(1)) != actual_tests:
    fails.append(f'HANDOVER 宣稱常駐測試 {m.group(1)} 份,實際 {actual_tests}')

if fails:
    for f in fails:
        print('  ✗', f)
    print(f'  文件對表:{len(fails)} 項不符——改文件或改宣稱,對齊後再打包')
    sys.exit(1)
print(f'  文件對表全符:版本 {version}、模組 {actual_mods}、常駐測試 {actual_tests}')
