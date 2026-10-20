#!/usr/bin/env python3
"""Cross-file consistency checks for the LC Coach extension."""
import json
import os
import re
import sys

ROOT = sys.argv[1]
os.chdir(ROOT)

problems = []
notes = []


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


# ------------------------------------------------------------------ ids
html = read("src/sidepanel.html")
js = read("src/sidepanel.js")

html_ids = set(re.findall(r'\bid="([^"]+)"', html))
js_ids = set(re.findall(r'\$\("([^"]+)"\)', js))
js_ids |= set(re.findall(r'getElementById\("([^"]+)"\)', js))

missing = sorted(js_ids - html_ids)
unused = sorted(html_ids - js_ids)

if missing:
    problems.append(f"JS 引用了 HTML 里不存在的 id: {missing}")
if unused:
    notes.append(f"HTML 里有但 JS 没用的 id（可能正常）: {unused}")

# ------------------------------------------------------------------ selectors
sel_used = set(re.findall(r'querySelectorAll\("([^"]+)"\)', js))
for s in sorted(sel_used):
    if s.startswith("."):
        cls = s[1:]
        if f'class="{cls}"' not in html and f' {cls}' not in html and f'"{cls} ' not in html:
            # class may be applied dynamically by JS — check there too
            if cls not in js:
                problems.append(f"JS 用了选择器 {s}，但 HTML 和 JS 里都找不到这个 class")
notes.append(f"JS 使用的 querySelectorAll 选择器: {sorted(sel_used)}")

# ------------------------------------------------------------------ imports/exports
MODULES = [
    "src/config.js",
    "src/prompts.js",
    "src/providers.js",
    "src/probe.js",
    "src/markdown.js",
    "src/archive.js",
    "src/manual-notes.js",
    "src/note-sync.js",
]

exports = {}
for m in MODULES:
    src = read(m)
    names = set()
    names |= set(re.findall(r'export\s+(?:async\s+)?function\s+(\w+)', src))
    names |= set(re.findall(r'export\s+const\s+(\w+)', src))
    names |= set(re.findall(r'export\s+let\s+(\w+)', src))
    names |= set(re.findall(r'export\s+class\s+(\w+)', src))
    for group in re.findall(r'export\s*\{([^}]*)\}', src):
        for part in group.split(","):
            part = part.strip()
            if not part:
                continue
            names.add(part.split(" as ")[-1].strip())
    exports[m] = names

CONSUMERS = [
    "src/sidepanel.js",
    "src/background.js",
    "src/content.js",
    "src/hook.js",
    "src/notes.js",
]

for consumer in CONSUMERS:
    src = read(consumer)
    for names_blob, target in re.findall(r'import\s*\{([^}]*)\}\s*from\s*"\./([\w.]+)"', src):
        path = "src/" + target
        if path not in exports:
            problems.append(f"{consumer} 导入了未知模块 ./{target}")
            continue
        for name in [n.strip() for n in names_blob.split(",") if n.strip()]:
            if name not in exports[path]:
                problems.append(f"{consumer} 从 ./{target} 导入了 {name}，但该文件没有导出它")

for m, names in exports.items():
    notes.append(f"{m} 导出: {sorted(names)}")

# ------------------------------------------------------------------ classic scripts must not use export/import
note_html = read("src/notes.html")
note_js = read("src/notes.js")
note_ids = set(re.findall(r'\bid="([^"]+)"', note_html))
missing_note_ids = set(re.findall(r'\$\("([^"]+)"\)', note_js)) - note_ids
if missing_note_ids:
    problems.append(f"手记 JS 引用了不存在的 id: {sorted(missing_note_ids)}")
for asset in ["src/notes.html", "src/notes.css", "src/notes.js"]:
    if not os.path.exists(asset):
        problems.append(f"缺少手记窗口资源: {asset}")

for f in ["src/content.js", "src/hook.js"]:
    src = read(f)
    if re.search(r'^\s*export\s', src, re.M) or re.search(r'^\s*import\s', src, re.M):
        problems.append(f"{f} 是普通 content script，不能有 import/export（会是语法错误）")

# ------------------------------------------------------------------ referenced files exist
manifest = json.load(open("manifest.json", encoding="utf-8"))
refs = []
refs += manifest.get("content_scripts", [{}])[0].get("js", [])
refs.append(manifest["background"]["service_worker"])
refs.append(manifest["side_panel"]["default_path"])
for war in manifest.get("web_accessible_resources", []):
    refs += war.get("resources", [])
refs += list(manifest.get("icons", {}).values())

for r in refs:
    if "*" in r:
        continue
    if not os.path.exists(r):
        problems.append(f"manifest 引用了不存在的文件: {r}")
notes.append(f"manifest 引用的文件全部检查过（{len(set(refs))} 个唯一路径）")

# side panel assets
for a in ["src/sidepanel.css", "src/sidepanel.js"]:
    if not os.path.exists(a):
        problems.append(f"HTML 引用了不存在的文件: {a}")

# ------------------------------------------------------------------ report
print("=" * 62)
for n in notes:
    print("  ·", n)
print("=" * 62)
if problems:
    print(f"发现 {len(problems)} 个问题：")
    for p in problems:
        print("  ✗", p)
    sys.exit(1)
print("✅ 全部一致性检查通过")
