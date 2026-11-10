/**
 * 工具清单：一个 MCP 服务，多个工具。
 *
 * 每个工具只做三件事：校验/规整参数 → 调对应插件的 CLI（--json）→ 把结果整理成
 * 人可读摘要。业务逻辑全在插件里，这里不复制一行。
 */
import { join } from 'node:path';
import { DEFAULT_TIMEOUT_MS, ToolError, 提取JSON, 跑插件, 插件版本 } from './plugins.mjs';
import { 校验参数 } from './validate.mjs';
import { 格式化合并, 格式化比对, 格式化站点, 格式化发版 } from './format.mjs';

const 超时说明 = '整体超时（毫秒），默认 120000、上限 600000；超时会终止子进程并返回 timeout 错误。';

function 超时项() {
  return { type: 'integer', minimum: 1000, maximum: 600000, default: DEFAULT_TIMEOUT_MS, description: 超时说明 };
}

async function 跑并解析(短名, argv, 超时) {
  const 结果 = await 跑插件(短名, argv, { timeoutMs: 超时 });
  const 数据 = 提取JSON(结果.stdout);
  if (!数据) {
    const 尾 = String(结果.stderr || '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' | ');
    throw new ToolError(
      'bad_output',
      `${短名} 没有返回可解析的 JSON（退出码 ${结果.code}）。${尾 ? '最后输出：' + 尾 : ''}`,
      { exit_code: 结果.code },
    );
  }
  return 数据;
}

function 工具失败(短名, 数据) {
  const 原因 = 数据?.原因 || 数据?.error || 数据?.message || '插件报告失败';
  return new ToolError('tool_failed', `${短名} 失败：${原因}`, { detail: 数据 });
}

/* ───────────────────────── 工具定义 ───────────────────────── */

export const TOOLS = [
  {
    name: 'merge_docs',
    title: '合并文档',
    description:
      '把多份 .docx / .md / .txt（文件或目录）合并成一份带目录的 .docx。适合「把周报/合同附件/章节稿拼成一份交付文档」。只写 out 指定的文件，不删改输入。',
    inputSchema: {
      type: 'object',
      properties: {
        inputs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: '要合并的文件或目录路径（按给出顺序；给目录时按文件名排序）。',
        },
        out: {
          type: 'string',
          description: '输出的 .docx 路径。默认在当前工作目录生成 merged-<时间>.docx。',
        },
        title_from: {
          type: 'string',
          enum: ['filename', 'first-line', 'front-matter'],
          default: 'filename',
          description: '每份文件的章节标题来源，默认 filename（文件名）。',
        },
        sort: { type: 'string', enum: ['name', 'mtime'], default: 'name', description: '目录内文件的排序方式。' },
        page_break: { type: 'boolean', default: false, description: '每份文件是否另起一页。' },
        strip_title: { type: 'boolean', default: false, description: '是否去掉各文件开头的一级标题，避免与章节标题重复。' },
        dry_run: { type: 'boolean', default: false, description: '只预演，不写文件。' },
        timeout_ms: 超时项(),
      },
      required: ['inputs'],
      additionalProperties: false,
    },
    async run(args) {
      for (const p of args.inputs) {
        if (p.startsWith('-')) throw new ToolError('invalid_params', `inputs 里不能有以 - 开头的路径：${p}`);
      }
      if (args.out && args.out.startsWith('-')) throw new ToolError('invalid_params', `out 不能以 - 开头：${args.out}`);

      const out = args.out || join(process.cwd(), `merged-${时间戳()}.docx`);
      const argv = [...args.inputs];
      if (!args.dry_run) argv.push('-o', out);
      argv.push('--title-from', args.title_from, '--sort', args.sort);
      if (args.page_break) argv.push('--page-break');
      if (args.strip_title) argv.push('--strip-title');
      if (args.dry_run) argv.push('--dry-run');
      argv.push('--json');

      const 数据 = await 跑并解析('dsh-doc-merge', argv, args.timeout_ms);
      if (数据.ok === false) throw 工具失败('dsh-doc-merge', 数据);
      return {
        data: 数据,
        text: 格式化合并(数据) + 脚注('dsh-doc-merge'),
      };
    },
  },

  {
    name: 'compare_docs',
    title: '文档比对',
    description:
      '按段落比对两份 .docx / .md / .txt，给出修改/新增/删除的段数与改动比例，并预览改动片段。适合合同改版核对、版本差异确认。只读，不修改任何文件。',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', minLength: 1, description: '文件 A（基准/旧版）路径。' },
        b: { type: 'string', minLength: 1, description: '文件 B（新版）路径。' },
        max_paragraphs: { type: 'integer', minimum: 1, maximum: 20000, default: 2000, description: '最多比对多少段。' },
        out: { type: 'string', description: '可选：把完整的 Markdown 比对报告另存到这个路径。' },
        timeout_ms: 超时项(),
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    async run(args) {
      for (const p of [args.a, args.b]) {
        if (p.startsWith('-')) throw new ToolError('invalid_params', `文件路径不能以 - 开头：${p}`);
      }
      const argv = [args.a, args.b, '--max-paragraphs', String(args.max_paragraphs)];
      if (args.out) argv.push('--out', args.out);
      argv.push('--json');

      const 数据 = await 跑并解析('dsh-doc-compare', argv, args.timeout_ms);
      if (数据.ok === false) throw 工具失败('dsh-doc-compare', 数据);
      return {
        data: 数据,
        text: 格式化比对(数据) + 脚注('dsh-doc-compare'),
      };
    },
  },

  {
    name: 'site_audit',
    title: '站点体检',
    description:
      '上线前给站点做只读体检：内部链接 4xx/5xx、图片体积、基础 SEO、robots/sitemap、混合内容、重定向链。可以查在线站点（base）或本地构建目录（dir）。只发 GET/HEAD，不提交表单、不登录。',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: '在线站点起始页，如 https://example.com（与 dir 二选一）。' },
        dir: { type: 'string', description: '本地站点目录，如 ./dist（与 base 二选一，不发任何请求）。' },
        max_pages: { type: 'integer', minimum: 1, maximum: 2000, default: 50, description: '最多抓多少页。' },
        concurrency: { type: 'integer', minimum: 1, maximum: 16, default: 4, description: '并发上限。' },
        offline: {
          type: 'boolean',
          default: true,
          description: '是否关掉外链探测。默认 true（离线、更快）；要探测站外链接时传 false。',
        },
        timeout_ms: 超时项(),
      },
      required: [],
      additionalProperties: false,
    },
    async run(args) {
      if (!args.base && !args.dir) {
        throw new ToolError('invalid_params', '必须给 base（在线站点）或 dir（本地目录）之一。');
      }
      if (args.base && args.dir) {
        throw new ToolError('invalid_params', 'base 与 dir 只能二选一。');
      }
      if (args.base && !/^https?:\/\//i.test(args.base)) {
        throw new ToolError('invalid_params', `base 必须是 http:// 或 https:// 开头的地址：${args.base}`);
      }
      if (args.dir && args.dir.startsWith('-')) {
        throw new ToolError('invalid_params', `dir 不能以 - 开头：${args.dir}`);
      }

      const argv = ['--json', '--max-pages', String(args.max_pages), '--concurrency', String(args.concurrency)];
      if (args.base) argv.push('--base', args.base);
      if (args.dir) argv.push('--dir', args.dir);
      if (args.offline) argv.push('--offline');

      const 数据 = await 跑并解析('dsh-site-audit', argv, args.timeout_ms);
      if (数据.ok === false) throw 工具失败('dsh-site-audit', 数据);
      return {
        data: 数据,
        text: 格式化站点(数据) + 脚注('dsh-site-audit'),
      };
    },
  },

  {
    name: 'release_check',
    title: '发版检查',
    description:
      '按仓库的 .release-guard.json 规则检查「现在能不能发版」：版本一致性、tag/CHANGELOG、构建产物、敏感文件等，给出阻断与警告清单。只读仓库，不改文件。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库目录，默认当前工作目录。' },
        npm: { type: 'boolean', default: false, description: '是否额外查 npm 上的已发布版本（会联网，默认 false）。' },
        timeout_ms: 超时项(),
      },
      required: [],
      additionalProperties: false,
    },
    async run(args) {
      const 仓库 = args.repo || process.cwd();
      if (仓库.startsWith('-')) throw new ToolError('invalid_params', `repo 不能以 - 开头：${仓库}`);
      const argv = [仓库, '--json'];
      if (args.npm) argv.push('--npm');

      const 数据 = await 跑并解析('dsh-release-guard', argv, args.timeout_ms);
      if (数据.ok === false && 数据.error) throw 工具失败('dsh-release-guard', 数据);
      return {
        data: 数据,
        text: 格式化发版(数据) + 脚注('dsh-release-guard'),
      };
    },
  },
];

function 脚注(短名) {
  const 版本 = 插件版本(短名);
  return `\n（由 ${短名}${版本 ? ' v' + 版本 : ''} 执行；参数与结果均只在本机处理）`;
}

function 时间戳() {
  const d = new Date();
  const 补 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${补(d.getMonth() + 1)}${补(d.getDate())}-${补(d.getHours())}${补(d.getMinutes())}${补(d.getSeconds())}`;
}

export function 找工具(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

export function 工具清单() {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));
}

/**
 * 统一入口：校验 → 执行 → 归一化结果。永不抛异常。
 * @returns {Promise<{ok: true, text: string, data: any} | {ok: false, error: {code: string, message: string, [k: string]: any}}>}
 */
export async function 调用工具(name, 原始参数) {
  const 工具 = 找工具(name);
  if (!工具) {
    return {
      ok: false,
      error: { code: 'unknown_tool', message: `未知工具 ${name}。可用：${TOOLS.map((t) => t.name).join(', ')}` },
    };
  }

  let 入参;
  try {
    入参 = 原始参数 === undefined || 原始参数 === null ? {} : 原始参数;
    if (typeof 入参 === 'string') 入参 = JSON.parse(入参);
  } catch (e) {
    return { ok: false, error: { code: 'invalid_json', message: `参数不是合法 JSON：${e.message}` } };
  }

  const 校验 = 校验参数(工具.inputSchema, 入参);
  if (!校验.ok) return { ok: false, error: 校验.error };

  try {
    const 结果 = await 工具.run(校验.value);
    return { ok: true, text: 结果.text, data: 结果.data };
  } catch (e) {
    if (e instanceof ToolError) {
      return { ok: false, error: { code: e.code, message: e.message, ...e.extra } };
    }
    return { ok: false, error: { code: 'internal_error', message: String(e?.message || e) } };
  }
}
