#!/usr/bin/env bash
# v90:產生「只含要上傳檔案」的乾淨包——dev-notes(交接/個人筆記)、tests、tools、
# node_modules 一律排除。部署 GitHub Pages 時只上傳這個 zip 的內容。
set -e
cd "$(dirname "$0")/.."
rm -rf _upload private-signal-upload.zip
mkdir _upload
cp -r index.html guard.js app.js style.css manifest.json icon.svg data modules utils _upload/
( cd _upload && zip -rq ../private-signal-upload.zip . )
rm -rf _upload
echo "✅ 已產生 private-signal-upload.zip(僅執行檔案;dev-notes/tests/tools 皆不在內)"
