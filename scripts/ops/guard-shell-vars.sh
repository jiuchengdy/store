#!/usr/bin/env bash
# 守卫：`$VAR` 后紧跟非 ASCII 字符 → bash 会把中文并进变量名，运行时报 unbound variable。
# 本仓库的运维脚本消息全是中文，所以这个坑会反复出现，而且**只在出错分支才触发**——
# 也就是说：写错的那条"无法体检"路径永远不会被执行到，门禁看起来接上了，实际是个死分支。
#
# 典型（真实发生过）：echo "无法连接数据库容器 $DB_CONTAINER（库 ...）"   → line 46: DB_CONTAINER（: unbound variable
# 正确写法：echo "... ${DB_CONTAINER}（库 ...）"
#
# 退出码：0 = 干净；1 = 有违规（或守卫读不到自己的对象）
# 用法：scripts/ops/guard-shell-vars.sh [目录，默认 scripts/]
set -u
ROOT="${1:-scripts}"
if [ ! -d "$ROOT" ]; then
  echo "guard: directory not found: ${ROOT} — cannot prove the invariant" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "guard: python3 not found — refusing to pass without being able to run the check" >&2
  exit 1
fi

python3 - "$ROOT" <<'PY'
import re, sys, pathlib
root = pathlib.Path(sys.argv[1])
pat = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])')
cash = re.compile(r'\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]')
hits = 0
files = 0
for p in sorted(root.rglob('*.sh')):
    files += 1
    try:
        text = p.read_text(encoding='utf-8')
    except Exception as e:
        print(f"guard: cannot read {p}: {e} — refusing to pass", file=sys.stderr)
        sys.exit(1)
    for i, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith('#'):
            continue
        for m in pat.finditer(line):
            hits += 1
            print(f"{p}:{i}: ${m.group(1)} 后紧跟非 ASCII 字符 → 用 ${{{m.group(1)}}}")
if hits:
    print(f"guard: FAILED — {hits} 处变量后紧跟非 ASCII 字符（{files} 个文件已扫）")
    sys.exit(1)
print(f"guard: ok — no 'shell var followed by non-ASCII' patterns ({files} files scanned)")
PY
