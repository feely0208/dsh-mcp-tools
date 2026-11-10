#!/usr/bin/env node
/**
 * @deepwhale-cn/dsh-mcp-tools
 *
 * 用法：
 *   node bin/mcp.mjs                        # 作为 MCP stdio 服务运行（给 Claude Desktop / Cursor）
 *   node bin/mcp.mjs --list                 # 打印工具清单（JSON）
 *   node bin/mcp.mjs --call <工具> '<JSON>' # 直接调用一次（自测 / 调试）
 *
 * 注意：stdio 模式下 stdout 专用于 JSON-RPC，所有日志走 stderr。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, 启动 } from '../lib/server.mjs';
import { 工具清单, 调用工具 } from '../lib/tools.mjs';

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(包根, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);

function 用法() {
  return `dsh-mcp-tools v${pkg.version} —— 一个 MCP 服务，多个本地工具

作为 MCP 服务（Claude Desktop / Cursor 等客户端会这样启动）：
  node ${join(包根, 'bin', 'mcp.mjs')}

自测 / 调试：
  node bin/mcp.mjs --list                  打印工具清单（JSON）
  node bin/mcp.mjs --call <工具> '<JSON>'  调用一次，如：
    node bin/mcp.mjs --call release_check '{"repo":"."}'
    node bin/mcp.mjs --call site_audit '{"dir":"./dist","offline":true}'

工具：${工具清单().map((t) => t.name).join(' / ')}
文档：https://deepwhale.org.cn/plugins.html
`;
}

function 退出(码, 文本, 流 = process.stdout) {
  流.write(文本.endsWith('\n') ? 文本 : 文本 + '\n');
  process.exitCode = 码;
}

async function 主流程() {
  if (argv.includes('--help') || argv.includes('-h')) {
    退出(0, 用法());
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    退出(0, pkg.version);
    return;
  }

  if (argv[0] === '--list') {
    退出(0, JSON.stringify({ ok: true, name: pkg.name, version: pkg.version, tools: 工具清单() }, null, 2));
    return;
  }

  if (argv[0] === '--call') {
    const 位置参数 = argv.slice(1).filter((a) => !a.startsWith('--'));
    const 要JSON = argv.includes('--json');
    const 工具名 = 位置参数[0];
    if (!工具名) {
      退出(2, JSON.stringify({ ok: false, error: { code: 'usage', message: "用法：--call <工具> '<JSON>'" } }, null, 2));
      return;
    }
    const 参数文本 = 位置参数[1] ?? '{}';

    const 结果 = await 调用工具(工具名, 参数文本);
    if (!结果.ok) {
      退出(1, JSON.stringify({ ok: false, tool: 工具名, error: 结果.error }, null, 2));
      return;
    }
    if (要JSON) {
      退出(0, JSON.stringify({ ok: true, tool: 工具名, text: 结果.text, data: 结果.data }, null, 2));
      return;
    }
    退出(0, 结果.text);
    return;
  }

  if (argv.length > 0) {
    退出(2, `不认识的参数：${argv.join(' ')}\n\n${用法()}`, process.stderr);
    return;
  }

  // 默认：MCP stdio 服务
  await 启动({ version: pkg.version });
}

主流程().catch((e) => {
  process.stderr.write(`[${SERVER_NAME}] 启动失败：${e?.stack || e}\n`);
  process.exit(1);
});
