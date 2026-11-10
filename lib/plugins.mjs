/**
 * 定位被包装插件的 CLI，并用子进程调用它。
 *
 * 原则：
 * - 不复刻任何业务逻辑，只把参数逐个透传给插件自己的 bin/cli.mjs；
 * - 不经过 shell（不拼字符串、不用 sh -c），避免命令注入；
 * - 找不到插件时给一句人话，告诉用户装哪个包。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 支持的插件：包名 → CLI 相对路径。加工具时只在这里加一行。 */
export const PLUGINS = {
  'dsh-doc-merge': { pkg: '@deepwhale-cn/dsh-doc-merge', cli: 'bin/cli.mjs' },
  'dsh-doc-compare': { pkg: '@deepwhale-cn/dsh-doc-compare', cli: 'bin/cli.mjs' },
  'dsh-site-audit': { pkg: '@deepwhale-cn/dsh-site-audit', cli: 'bin/cli.mjs' },
  'dsh-release-guard': { pkg: '@deepwhale-cn/dsh-release-guard', cli: 'bin/cli.mjs' },
};

const 已解析 = new Map();

export class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.extra = extra;
  }
}

/**
 * 解析插件包根目录。顺序：
 * ① DSH_MCP_TOOLS_PLUGIN_ROOT（显式覆盖，本地开发/自测）
 * ② 从本包位置做 Node 解析（标准安装态：与网关同级 node_modules）
 * ③ 从当前工作目录解析（网关是软链/file: 安装，或插件装在启动目录的 node_modules 里）
 */
function 找包根(短名) {
  const 定义 = PLUGINS[短名];
  if (!定义) throw new ToolError('unknown_plugin', `未知插件：${短名}`);

  if (已解析.has(短名)) return 已解析.get(短名);

  const 候选们 = [];

  const 环境根 = process.env.DSH_MCP_TOOLS_PLUGIN_ROOT;
  if (环境根) {
    // 同时支持「放插件源码的目录」和「node_modules 目录」两种指法
    候选们.push(join(环境根, 短名, 'package.json'));
    候选们.push(join(环境根, '@deepwhale-cn', 短名, 'package.json'));
  }

  try {
    候选们.push(fileURLToPath(import.meta.resolve(`${定义.pkg}/package.json`)));
  } catch {
    // 未安装：继续尝试其他位置
  }

  try {
    // 用 cwd 作为解析起点；对 file:/npm link 安装的网关尤其有用
    候选们.push(createRequire(join(process.cwd(), '__dsh_mcp_tools_resolve__.js')).resolve(`${定义.pkg}/package.json`));
  } catch {
    // 当前目录也没有
  }

  let 包JSON = null;
  for (const 候选 of 候选们) {
    if (候选 && existsSync(候选)) {
      包JSON = 候选;
      break;
    }
  }

  if (!包JSON) {
    throw new ToolError(
      'plugin_missing',
      `缺少 ${短名}：请先安装它（npm i ${定义.pkg}），或把 DSH_MCP_TOOLS_PLUGIN_ROOT 指向放插件的目录。`,
      { package: 定义.pkg, cwd: process.cwd(), ...(候选们.length ? { searched: 候选们 } : {}) },
    );
  }

  const 包根 = dirname(包JSON);
  const cli = join(包根, 定义.cli);
  if (!existsSync(cli)) {
    throw new ToolError('plugin_broken', `${定义.pkg} 已安装，但找不到 ${定义.cli}（版本过旧或安装不完整）。`, {
      package: 定义.pkg,
      cli,
    });
  }

  const 信息 = { root: 包根, cli };
  已解析.set(短名, 信息);
  return 信息;
}

/** 插件版本，用于报告里标注「是谁干活的」。 */
export function 插件版本(短名) {
  try {
    return JSON.parse(readFileSync(join(找包根(短名).root, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

const 上限 = 600_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 跑一次插件 CLI。
 * @param {string} 短名 插件短名，如 dsh-doc-merge
 * @param {string[]} argv 逐个透传的参数（不含 node 与脚本路径）
 * @param {{cwd?: string, timeoutMs?: number}} 选项
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, signal: string|null}>}
 */
export function 跑插件(短名, argv, 选项 = {}) {
  const { cli } = 找包根(短名);
  const 超时 = 选项.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = 选项.cwd || process.cwd();

  return new Promise((resolve, reject) => {
    let 子进程;
    try {
      子进程 = spawn(process.execPath, [cli, ...argv], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false, // 明确关掉 shell：参数逐个透传
      });
    } catch (e) {
      reject(new ToolError('spawn_failed', `启动 ${短名} 失败：${e.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let 已结束 = false;
    let 超时了 = false;

    const 计时器 = setTimeout(() => {
      超时了 = true;
      // 子进程自己起孙进程时，至少先终止直接子进程；不阻塞在清理上
      子进程.kill('SIGKILL');
    }, Math.min(Math.max(超时, 1000), 上限));

    子进程.stdout.setEncoding('utf8');
    子进程.stderr.setEncoding('utf8');
    子进程.stdout.on('data', (d) => {
      // 防止恶意/异常大输出把内存打满
      if (stdout.length < 4_000_000) stdout += d;
    });
    子进程.stderr.on('data', (d) => {
      if (stderr.length < 200_000) stderr += d;
    });

    子进程.on('error', (e) => {
      if (已结束) return;
      已结束 = true;
      clearTimeout(计时器);
      reject(new ToolError('spawn_failed', `运行 ${短名} 失败：${e.message}`));
    });

    子进程.on('close', (code, signal) => {
      if (已结束) return;
      已结束 = true;
      clearTimeout(计时器);
      if (超时了) {
        reject(
          new ToolError('timeout', `${短名} 超过 ${Math.round(超时 / 1000)} 秒仍未结束，已终止。可用 timeout_ms 放宽（上限 600000）。`, {
            timeout_ms: 超时,
          }),
        );
        return;
      }
      resolve({ stdout, stderr, code, signal });
    });
  });
}

/**
 * 从 stdout 里取出 JSON 对象（CLI 可能先打印几行提示，再打 JSON）。
 */
export function 提取JSON(stdout) {
  const 文本 = String(stdout || '').trim();
  if (!文本) return null;
  const 首 = 文本.indexOf('{');
  const 尾 = 文本.lastIndexOf('}');
  const 片段 = 首 >= 0 && 尾 > 首 ? 文本.slice(首, 尾 + 1) : 文本;
  try {
    return JSON.parse(片段);
  } catch {
    return null;
  }
}
