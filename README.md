# dsh-mcp-tools · 一个 MCP 服务，多个「干活」工具

把深鲸已有的本地能力（合并文档、比对文档、站点体检、发版检查）用标准 MCP 工具暴露出去，让 **Claude Desktop / Cursor / 任何 MCP 客户端**直接调用——不用你切终端敲命令，再把输出粘回对话。

## 不装会怎样

这些工具本来就有 CLI，但 AI 客户端看不见它们：Claude 只能「告诉你怎么敲」，不能自己跑。你会来回切换窗口、复制粘贴路径和报错，一轮下来十分钟没了；批量活儿更是没法让它自己迭代。装上以后，一句「把 `docs/` 合并成一份带目录的 docx，然后检查这个仓库能不能发版」，它自己会调工具、看结果、接着做。

## 它做什么

- **一个服务，四个工具**，工具再多也不增加服务数：

  | 工具 | 干什么 | 典型参数 | 写文件吗 |
  | --- | --- | --- | --- |
  | `merge_docs` | 多份 `.docx`/`.md`/`.txt` 合并成一份带目录的 `.docx` | `inputs`（文件或目录数组）、`out` | 只写 `out` |
  | `compare_docs` | 按段落比对两份文档，给修改/新增/删除与改动预览 | `a`、`b` | 只读（除非给 `out`） |
  | `site_audit` | 上线前站点体检：死链、图片体积、SEO、robots/sitemap、混合内容 | `base` 或 `dir` | 不写 |
  | `release_check` | 按仓库规则判断「现在能不能发版」，列阻断与警告 | `repo`、`npm` | 不写 |

- **不复制业务逻辑**：网关只做「校验参数 → 调插件自己的 `bin/cli.mjs --json` → 整理成人读摘要」。插件升级，网关自动受益；插件里修了 bug，这里立刻生效。
- **一屏能读完的结果**：返回「结论 + 关键数据 + 前几条问题」，不把整份 JSON 塞进上下文。
- **错误是结构化的**：缺参数、类型不对、插件没装、超时，都返回 `{ok:false, error:{code, message}}`，不会让服务崩。
- **长任务有超时**：默认 120 秒，可传 `timeout_ms`（上限 600 秒），超时会终止子进程并明确报 `timeout`。

## 安装

### 作为 DSH 插件（推荐）

```bash
dsh plugin --profile web add @deepwhale-cn/dsh-mcp-tools
```

装好后在 DSH 里即可让任意支持 MCP 的客户端接入这套工具；四个被代理的工具插件按需一起装（见下）。

### 作为 MCP 网关（手动部署）

需要 Node ≥ 20。建议装在用户目录下一个固定位置，四类插件作为同级依赖一起装（这样网关能直接找到它们）：

```bash
mkdir -p ~/dsh-mcp-tools && cd ~/dsh-mcp-tools
npm init -y >/dev/null
npm i @deepwhale-cn/dsh-mcp-tools \
      @deepwhale-cn/dsh-doc-merge \
      @deepwhale-cn/dsh-doc-compare \
      @deepwhale-cn/dsh-site-audit \
      @deepwhale-cn/dsh-release-guard
```

四个工具插件也可以按需只装其中几个：没装的工具被调用时返回 `plugin_missing`，并告诉你装哪个包，其他工具不受影响。

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（Windows：`%APPDATA%\Claude\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "dsh-tools": {
      "command": "node",
      "args": ["/Users/yourname/dsh-mcp-tools/node_modules/@deepwhale-cn/dsh-mcp-tools/bin/mcp.mjs"]
    }
  }
}
```

把 `/Users/yourname/...` 换成本机真实路径（Windows 用 `C:\\Users\\...`）。改完重启 Claude Desktop。

### Cursor

编辑 `~/.cursor/mcp.json`（全局）或项目里的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "dsh-tools": {
      "command": "node",
      "args": ["/Users/yourname/dsh-mcp-tools/node_modules/@deepwhale-cn/dsh-mcp-tools/bin/mcp.mjs"]
    }
  }
}
```

### 不装客户端也能自测

```bash
node bin/mcp.mjs --list
node bin/mcp.mjs --call release_check '{"repo":"."}'
node bin/mcp.mjs --call site_audit '{"dir":"./dist","offline":true}'
node bin/mcp.mjs --call merge_docs '{"inputs":["docs"],"out":"./merged.docx"}'
node bin/mcp.mjs --call compare_docs '{"a":"旧版.docx","b":"新版.docx"}'
```

## 工具参数

所有工具都接受可选的 `timeout_ms`（整数，1000–600000，默认 120000）。未知参数会被拒绝（防止拼错参数却静默生效）。

### `merge_docs`

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `inputs` | string[] | ✅ | — | 文件或目录；给目录时按文件名排序 |
| `out` | string | | `merged-<时间>.docx` | 输出路径 |
| `title_from` | `filename`/`first-line`/`front-matter` | | `filename` | 章节标题来源 |
| `sort` | `name`/`mtime` | | `name` | 目录内排序 |
| `page_break` | boolean | | `false` | 每份另起一页 |
| `strip_title` | boolean | | `false` | 去掉各文件开头的一级标题 |
| `dry_run` | boolean | | `false` | 只预演不写文件 |

### `compare_docs`

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `a` / `b` | string | ✅ | — | 旧版 / 新版文件 |
| `max_paragraphs` | integer | | `2000` | 最多比对多少段 |
| `out` | string | | — | 另存完整 Markdown 报告 |

### `site_audit`

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `base` | string | 二选一 | — | 在线站点起始页（`http(s)://`） |
| `dir` | string | 二选一 | — | 本地目录，不发任何请求 |
| `max_pages` | integer | | `50` | 最多抓多少页（上限 2000） |
| `concurrency` | integer | | `4` | 并发上限（上限 16） |
| `offline` | boolean | | `true` | 关掉外链探测；要探测站外链接传 `false` |

### `release_check`

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `repo` | string | | 当前工作目录 | 仓库路径 |
| `npm` | boolean | | `false` | 额外查 npm 已发布版本（会联网） |

## 错误约定

工具失败时 MCP 回包里 `isError: true`，正文是一段 JSON：

```json
{
  "ok": false,
  "tool": "merge_docs",
  "error": {
    "code": "invalid_params",
    "message": "缺少必填参数 inputs",
    "details": ["缺少必填参数 inputs"]
  }
}
```

| code | 含义 |
| --- | --- |
| `invalid_params` / `invalid_json` | 参数不合法（缺必填、类型不对、枚举越界、JSON 解析失败） |
| `unknown_tool` | 工具名不存在（会列出可用工具） |
| `plugin_missing` | 对应插件没装（会给 `npm i` 命令） |
| `plugin_broken` | 插件装了但找不到 CLI（版本过旧/安装不完整） |
| `timeout` | 超过 `timeout_ms`，子进程已终止 |
| `bad_output` | 插件没吐出可解析的 JSON（附最后几行 stderr） |
| `tool_failed` | 插件自己报告失败（如输入文件读不了） |
| `spawn_failed` / `internal_error` | 起不来 / 网关自身异常 |

## 边界

- **只在本机跑**：stdio 传输，不开端口、不上传任何数据、不内置 key。
- **唯一会联网的是 `site_audit`**——它要访问你要体检的那个站点（只 `GET`/`HEAD`，不提交表单、不登录）；默认 `offline: true` 连外链探测都关掉。`release_check` 只在 `npm: true` 时查一次 npm registry。
- **不拼 shell**：参数逐个透传给插件 CLI，`spawn(..., {shell:false})`，不存在命令注入。
- **不写你没指定的地方**：`merge_docs` 只写 `out`，`compare_docs` 只在给了 `out` 时写报告，其余只读。
- **子进程输出有上限**（stdout 4 MB / stderr 200 KB），避免异常输出打爆内存。
- **协议**：JSON-RPC 2.0 over stdio，支持 `initialize` / `tools/list` / `tools/call` / `ping`；按行分隔与 `Content-Length` 帧两种格式都认，回包沿用请求的格式。没有实现 `resources` / `prompts`。

## 已知限制

- 只实现了 `tools`，没有 `resources`、`prompts`、sampling。
- 客户端发 `notifications/cancelled` 时不会立刻杀子进程，最长等到 `timeout_ms`。
- 未在 Windows 上实测；路径请用绝对路径。
- 插件必须能被 Node 解析到（装在网关同级 `node_modules`，或设 `DSH_MCP_TOOLS_PLUGIN_ROOT` 指向插件目录）。

## 加一个新工具要多久

十分钟以内，四处改动：`lib/plugins.mjs` 登记插件包名与 CLI 路径 → `lib/tools.mjs` 加一条 schema 与 `run` → `lib/format.mjs` 加一段摘要 → `tests/run.sh` 加一条断言。服务数永远是 1。

## 开发与测试

```bash
bash tests/run.sh          # 36 条断言：清单/schema、四种工具、错误路径、JSON-RPC 往返、超时、缺插件
```

测试完全离线、可重复：站点体检用本地目录 fixture，发版检查用临时仓库，不访问网络。

---

[![](https://img.shields.io/badge/powered_by-dwh-005A8C?style=flat&logoColor=white)](https://deepwhale.org.cn)
