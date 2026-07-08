#!/usr/bin/env bash
# tools/preflight.sh — 交付前一鍵檢查(v75)。在專案根目錄執行:bash tools/preflight.sh
# 順序:① node --check 全檔 ② 武器①(import 掃描) ③ 常駐不變式測試 tests/ ④ 武器②(jsdom 煙霧測)
# 任何一關失敗即以非零 exit code 結束——全綠才准打包。
set -u
FAIL=0
step() { echo; echo "━━━ $1"; }

step "① node --check 全部 JS"
for f in app.js modules/*.js utils/*.js; do
  node --check "$f" || { echo "  ✗ $f"; FAIL=1; }
done
[ $FAIL -eq 0 ] && echo "  全部通過"

step "② 武器①:跨模組 import 完整性掃描"
python3 tools/check-imports.py || FAIL=1

step "③ 安裝測試依賴(jsdom + fake-indexeddb,--no-save)"
if [ ! -d node_modules/jsdom ] || [ ! -d node_modules/fake-indexeddb ]; then
  npm i --no-save jsdom fake-indexeddb || { echo "  依賴安裝失敗"; exit 1; }
else
  echo "  已在,跳過"
fi

step "④ 常駐不變式測試 tests/"
node tests/run.mjs || FAIL=1

step "⑤ 武器②:jsdom 真渲染煙霧測"
node tools/smoke.mjs || FAIL=1

echo
if [ $FAIL -eq 0 ]; then
  echo "═══ preflight 全綠,可以打包。記得:升 config.json 版本戳、HANDOVER 補帳、README 版本段同步。"
  echo "    打包前清理:rm -rf _t*.mjs node_modules package.json package-lock.json(tests/ 是常駐的,留著!)"
else
  echo "═══ preflight 有失敗,不可打包。"
fi
exit $FAIL
