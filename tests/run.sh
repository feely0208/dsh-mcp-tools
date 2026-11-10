#!/usr/bin/env bash
# dsh-mcp-tools 自测：离线、可重复、无第三方依赖。
# 用法：bash tests/run.sh
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# 本地开发时插件在 ~/dsh-guard 下；已安装时留空由 Node 解析。
export DSH_MCP_TOOLS_PLUGIN_ROOT="${DSH_MCP_TOOLS_PLUGIN_ROOT:-$(cd "$ROOT/.." && pwd)}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ✅ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ❌ %s\n' "$1"; }

assert_eq() { # 期望 实际 说明
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3（期望 $1，实际 $2）"; fi
}
assert_contains() { # 文本 子串 说明
  case "$1" in
    *"$2"*) ok "$3" ;;
    *) bad "$3（输出里没有：$2）" ;;
  esac
}
assert_not_contains() {
  case "$1" in
    *"$2"*) bad "$3（不该出现：$2）" ;;
    *) ok "$3" ;;
  esac
}
assert_file() {
  if [ -f "$1" ]; then ok "$2"; else bad "$2（文件不存在：$1）"; fi
}

# 在临时目录里跑，避免污染仓库
run() { (cd "$TMP" && node "$ROOT/bin/mcp.mjs" "$@"); }

json_field() { # JSON 文件路径 -> node 表达式读取
  node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('$1','utf8'));process.stdout.write(String(eval('j.'+process.argv[1])))" "$2" 2>/dev/null
}

echo "== 1. --list：工具清单与 schema =="
LIST_JSON="$TMP/list.json"
run --list >"$LIST_JSON" 2>"$TMP/list.err"
CODE=$?
assert_eq 0 "$CODE" "--list 退出码 0"
if node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const want = ["merge_docs", "compare_docs", "site_audit", "release_check"];
const errs = [];
if (!doc.ok) errs.push("ok 不是 true");
if (!Array.isArray(doc.tools)) errs.push("tools 不是数组");
const names = (doc.tools || []).map((t) => t.name);
if (JSON.stringify(names) !== JSON.stringify(want)) errs.push("工具清单不符：" + names.join(","));
for (const t of doc.tools || []) {
  const s = t.inputSchema;
  if (!s || s.type !== "object") errs.push(t.name + " 的 schema.type 不是 object");
  if (!s || typeof s.properties !== "object" || Object.keys(s.properties).length === 0) errs.push(t.name + " 没有 properties");
  if (!Array.isArray(s.required)) errs.push(t.name + " 没有 required 数组");
  for (const k of s.required || []) {
    if (!s.properties || !s.properties[k]) errs.push(t.name + " 的必填项 " + k + " 不在 properties 里");
  }
  for (const [k, p] of Object.entries(s.properties || {})) {
    if (!p.type) errs.push(t.name + "." + k + " 缺 type");
    if (p.type === "array" && (!p.items || !p.items.type)) errs.push(t.name + "." + k + " 是数组但缺 items.type");
    if (p.enum && (!Array.isArray(p.enum) || !p.enum.length)) errs.push(t.name + "." + k + " 的 enum 非法");
  }
}
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log("schema-ok");
' "$LIST_JSON"; then
  ok "4 个工具，schema 的 type / required / items 齐全"
else
  bad "schema 校验失败"
fi
assert_eq "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LIST_JSON','utf8')).tools.length)")" 4 "工具数为 4"

echo "== 2. merge_docs：合并 2 份 md 并写 docx =="
mkdir -p "$TMP/docs"
printf '# 一\n\n第一段。\n\n## 小节\n\n第二段。\n' >"$TMP/docs/a.md"
printf '# 二\n\n第三段。\n' >"$TMP/docs/b.md"
MERGE_JSON="$TMP/merge.json"
run --call merge_docs "{\"inputs\":[\"docs\"],\"out\":\"$TMP/out.docx\"}" --json >"$MERGE_JSON" 2>"$TMP/merge.err"
CODE=$?
assert_eq 0 "$CODE" "merge_docs 退出码 0"
assert_file "$TMP/out.docx" "产出文件存在"
if [ -f "$TMP/out.docx" ]; then
  SIZE=$(wc -c <"$TMP/out.docx" | tr -d ' ')
  if [ "$SIZE" -gt 1000 ]; then ok "docx 非空（${SIZE} 字节）"; else bad "docx 过小（${SIZE} 字节）"; fi
  assert_eq "PK" "$(head -c 2 "$TMP/out.docx")" "docx 是合法 zip 容器"
fi
# 段落数口径：每章 = 1 个章节标题 + 原文块。a.md 4 块 + b.md 2 块 + 2 个章节标题 = 8
assert_eq 8 "$(json_field "$MERGE_JSON" 'data.统计.段落数')" "段落数为 8（章节标题 2 + 正文块 6）"
assert_eq 2 "$(json_field "$MERGE_JSON" 'data.章节.length')" "章节数为 2"
assert_contains "$(cat "$MERGE_JSON")" "$TMP/out.docx" "返回了输出文件的绝对路径"
MERGE_TEXT=$(run --call merge_docs "{\"inputs\":[\"docs\"],\"out\":\"$TMP/out2.docx\"}" 2>/dev/null)
assert_contains "$MERGE_TEXT" "合并完成" "人读摘要包含「合并完成」"
assert_contains "$MERGE_TEXT" "段落 8" "人读摘要包含关键数据（段落 8）"
assert_not_contains "$MERGE_TEXT" '{"ok":true' "人读输出不是整份 JSON"

echo "== 3. site_audit：本地目录体检能报出死链 =="
mkdir -p "$TMP/site"
printf '<html><head><title>T</title></head><body><h1>H</h1><a href="/missing.html">m</a></body></html>' >"$TMP/site/index.html"
printf '<html><head><title>OK</title></head><body><h1>OK</h1></body></html>' >"$TMP/site/ok.html"
SITE_OUT=$(run --call site_audit '{"dir":"site","offline":true}' 2>"$TMP/site.err")
CODE=$?
assert_eq 0 "$CODE" "site_audit 退出码 0（体检跑完，不是网关失败）"
assert_contains "$SITE_OUT" "未通过" "结论为未通过"
assert_contains "$SITE_OUT" "/missing.html" "报出了死链地址"
assert_contains "$SITE_OUT" "1 项阻断" "阻断计数为 1"
SITE_JSON="$TMP/site.json"
run --call site_audit '{"dir":"site","offline":true}' --json >"$SITE_JSON" 2>/dev/null
assert_eq 1 "$(json_field "$SITE_JSON" 'data.统计.阻断')" "结构化数据里阻断数为 1"

echo "== 4. 参数错误：结构化错误 + 非 0 退出码 =="
check_error() { # 说明 期望错误码 参数...
  local label="$1" want="$2"
  shift 2
  local out code
  out=$(run --call "$@" 2>/dev/null)
  code=$?
  if [ "$code" -eq 0 ]; then bad "$label 应当失败却成功了"; return; fi
  if ! printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.ok&&j.error&&j.error.code&&j.error.message)process.exit(0);process.exit(1)})' 2>/dev/null; then
    bad "$label 没有返回结构化 error（code/message）"
    return
  fi
  if [ -n "$want" ]; then
    local got
    got=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).error.code))')
    if [ "$got" != "$want" ]; then bad "$label 错误码应为 $want，实际 $got"; return; fi
  fi
  ok "$label"
}

check_error "缺必填 inputs" invalid_params merge_docs '{}'
check_error "inputs 类型错误" invalid_params merge_docs '{"inputs":"a.md"}'
check_error "未知参数被拒" invalid_params merge_docs '{"inputs":["a.md"],"outt":"x.docx"}'
check_error "site_audit 的 base 与 dir 互斥" invalid_params site_audit '{"base":"https://example.com","dir":"site"}'
check_error "未知工具" unknown_tool no_such_tool '{}'
check_error "参数不是合法 JSON" invalid_json merge_docs 'not-json'
check_error "枚举值越界" invalid_params merge_docs '{"inputs":["a.md"],"sort":"size"}'

echo "== 5. JSON-RPC 往返（管道喂消息）=="
RPC_OUT="$TMP/rpc.out"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"selftest","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"merge_docs","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"ping"}' \
  | (cd "$TMP" && node "$ROOT/bin/mcp.mjs") >"$RPC_OUT" 2>"$TMP/rpc.err"
CODE=$?
assert_eq 0 "$CODE" "stdio 服务读到 EOF 后正常退出"
assert_eq 4 "$(wc -l <"$RPC_OUT" | tr -d ' ')" "通知不回包：5 条输入 → 4 条回包"
if node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const errs = [];
const byId = new Map(lines.map((l) => [l.id, l]));
const init = byId.get(1);
if (!init || !init.result) errs.push("initialize 没有 result");
else {
  if (init.result.protocolVersion !== "2025-06-18") errs.push("protocolVersion 不对");
  if (!init.result.capabilities || !init.result.capabilities.tools) errs.push("capabilities.tools 缺失");
  if (!init.result.serverInfo || init.result.serverInfo.name !== "dsh-mcp-tools") errs.push("serverInfo.name 不对");
}
const list = byId.get(2);
if (!list || !list.result || list.result.tools.length !== 4) errs.push("tools/list 不是 4 个工具");
const call = byId.get(3);
if (!call || !call.result) errs.push("tools/call 没有 result");
else if (call.result.isError !== true) errs.push("缺参数时 isError 应为 true");
else if (!/invalid_params/.test(call.result.content[0].text)) errs.push("错误内容里没有 invalid_params");
const ping = byId.get(4);
if (!ping || JSON.stringify(ping.result) !== "{}") errs.push("ping 应返回 {}");
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
' "$RPC_OUT"; then
  ok "initialize / tools/list / tools/call / ping 全部符合 JSON-RPC 2.0"
else
  bad "JSON-RPC 往返校验失败"
fi

# Content-Length 帧（部分客户端会用），回包也用同一帧格式
BODY='{"jsonrpc":"2.0","id":7,"method":"ping"}'
LEN=$(printf '%s' "$BODY" | wc -c | tr -d ' ')
CL_OUT=$(printf 'Content-Length: %s\r\n\r\n%s' "$LEN" "$BODY" | (cd "$TMP" && node "$ROOT/bin/mcp.mjs") 2>/dev/null)
assert_contains "$CL_OUT" "Content-Length:" "Content-Length 帧：请求与回包同格式"
assert_contains "$CL_OUT" '"id":7' "Content-Length 帧：回包 id 正确"

echo "== 6. 超时与缺插件：错误要说人话 =="
FAKE="$TMP/fake"
mkdir -p "$FAKE/dsh-site-audit/bin"
printf '{"name":"@deepwhale-cn/dsh-site-audit","version":"9.9.9"}\n' >"$FAKE/dsh-site-audit/package.json"
printf 'await new Promise((r) => setTimeout(r, 5000));\nconsole.log("{}");\n' >"$FAKE/dsh-site-audit/bin/cli.mjs"
SLOW_OUT=$(cd "$TMP" && DSH_MCP_TOOLS_PLUGIN_ROOT="$FAKE" node "$ROOT/bin/mcp.mjs" --call site_audit '{"dir":".","timeout_ms":1000}' 2>/dev/null)
CODE=$?
assert_eq 1 "$CODE" "超时退出码 1"
assert_contains "$SLOW_OUT" '"code": "timeout"' "超时返回 timeout 错误"
assert_contains "$SLOW_OUT" "已终止" "超时错误说明了处置"

MISSING_OUT=$(cd "$TMP" && DSH_MCP_TOOLS_PLUGIN_ROOT="$TMP/nothing-here" node "$ROOT/bin/mcp.mjs" --call merge_docs '{"inputs":["x.md"]}' 2>/dev/null)
CODE=$?
assert_eq 1 "$CODE" "缺插件退出码 1"
assert_contains "$MISSING_OUT" '"code": "plugin_missing"' "缺插件返回 plugin_missing"
assert_contains "$MISSING_OUT" "npm i @deepwhale-cn/dsh-doc-merge" "缺插件给出了安装命令"

echo
echo "-----------------------------------------"
echo "通过 $PASS 条，失败 $FAIL 条"
if [ "$FAIL" -eq 0 ]; then echo "✅ 全部通过"; exit 0; else echo "❌ 有失败项"; exit 1; fi
