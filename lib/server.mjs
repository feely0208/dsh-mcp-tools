/**
 * 手写 MCP stdio 服务器（JSON-RPC 2.0）——不引官方 SDK，省 11 MB 依赖。
 *
 * 支持的帧格式：
 * - 按行分隔的 JSON（标准 MCP stdio）；
 * - Content-Length: N\r\n\r\n{...}（部分客户端仍在用），回包沿用请求的格式。
 *
 * stdout 只跑 JSON-RPC；日志一律 stderr。
 */
import { 调用工具, 工具清单 } from './tools.mjs';

export const SERVER_NAME = 'dsh-mcp-tools';
export const SERVER_TITLE = '深鲸工具箱';
export const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const LATEST_PROTOCOL = '2025-06-18';

const 消息上限 = 8 * 1024 * 1024;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** 处理单条 JSON-RPC 消息；通知（无 id）返回 null。 */
async function 处理一条(消息, { version }) {
  if (消息 === null || typeof 消息 !== 'object' || Array.isArray(消息)) {
    throw new RpcError(-32600, 'Invalid Request：消息必须是 JSON 对象');
  }

  const { id, method, params } = 消息;
  const 是通知 = !Object.prototype.hasOwnProperty.call(消息, 'id');

  if (typeof method !== 'string' || !method) {
    if (是通知) return null;
    throw new RpcError(-32600, 'Invalid Request：缺少 method');
  }

  try {
    let result;

    if (method === 'initialize') {
      const 请求版本 = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      result = {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(请求版本) ? 请求版本 : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version },
        instructions:
          '深鲸工具箱：一个 MCP 服务暴露多个本地工具。merge_docs 合并文档、compare_docs 比对文档、site_audit 站点体检、release_check 发版检查。参数错误会返回结构化 error，长任务默认 120 秒超时。',
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: 工具清单() };
    } else if (method === 'tools/call') {
      const name = params && params.name;
      if (typeof name !== 'string' || !name) throw new RpcError(-32602, 'Invalid params：缺少工具名 name');
      const 结果 = await 调用工具(name, params.arguments);
      if (结果.ok) {
        result = { content: [{ type: 'text', text: 结果.text }], isError: false };
      } else {
        result = {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: name, error: 结果.error }, null, 2) }],
          isError: true,
        };
      }
    } else if (method.startsWith('notifications/')) {
      return null; // initialized / cancelled 等通知，不需要回包
    } else {
      throw new RpcError(-32601, `Method not found：${method}`);
    }

    if (是通知) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (e) {
    if (是通知) return null;
    if (e instanceof RpcError) {
      return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32603, message: `Internal error：${e?.message || e}` } };
  }
}

/** 处理一条或一批消息，返回要写回的消息数组。 */
export async function 处理消息(消息, 环境) {
  if (Array.isArray(消息)) {
    if (!消息.length) return [{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request：空的批次' } }];
    const 结果们 = await Promise.all(消息.map((m) => 处理一条(m, 环境)));
    return 结果们.filter(Boolean);
  }
  const 结果 = await 处理一条(消息, 环境);
  return 结果 ? [结果] : [];
}

/** 从缓冲区里切出完整消息；返回消息数组与剩余字节。 */
export function 切消息(buffer) {
  const 消息们 = [];
  let rest = buffer;

  const 吞掉 = (n) => {
    rest = rest.subarray(n);
  };

  while (rest.length > 0) {
    // 跳过行首空白/空行
    let 首 = 0;
    while (首 < rest.length && (rest[首] === 0x0a || rest[首] === 0x0d || rest[首] === 0x20 || rest[首] === 0x09)) 首++;
    if (首 > 0) 吞掉(首);
    if (!rest.length) break;

    const 头 = rest.subarray(0, Math.min(rest.length, 32)).toString('utf8');
    if (/^Content-Length\s*:/i.test(头)) {
      const 分隔 = rest.indexOf('\r\n\r\n');
      if (分隔 < 0) break;
      const 头文本 = rest.subarray(0, 分隔).toString('utf8');
      const 匹配 = /Content-Length\s*:\s*(\d+)/i.exec(头文本);
      if (!匹配) {
        // 头坏了：丢掉这段，回一个解析错误
        吞掉(分隔 + 4);
        消息们.push({ __parseError: '坏的 Content-Length 头' });
        continue;
      }
      const 长度 = Number(匹配[1]);
      const 开始 = 分隔 + 4;
      if (长度 > 消息上限) {
        吞掉(Math.min(rest.length, 开始 + 长度));
        消息们.push({ __parseError: '消息超过 8 MB 上限' });
        continue;
      }
      if (rest.length < 开始 + 长度) break; // 还没收全
      const 体 = rest.subarray(开始, 开始 + 长度).toString('utf8');
      吞掉(开始 + 长度);
      try {
        消息们.push(JSON.parse(体));
      } catch {
        消息们.push({ __parseError: 'JSON 解析失败' });
      }
      continue;
    }

    const 换行 = rest.indexOf(0x0a);
    if (换行 < 0) break; // 还没收到完整一行
    const 行 = rest.subarray(0, 换行).toString('utf8').trim();
    吞掉(换行 + 1);
    if (!行) continue;
    try {
      消息们.push(JSON.parse(行));
    } catch {
      消息们.push({ __parseError: 'JSON 解析失败' });
    }
  }

  return { 消息们, rest };
}

/**
 * 启动 stdio 服务（阻塞到 stdin 关闭）。
 * @param {{version: string, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} 选项
 */
export function 启动({ version, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
  let 缓冲 = Buffer.alloc(0);

  stdout.on?.('error', () => {
    /* 客户端提前断开，静默退出 */
  });

  const 写回 = (消息, 用长度头) => {
    const 正文 = JSON.stringify(消息);
    if (用长度头) stdout.write(`Content-Length: ${Buffer.byteLength(正文)}\r\n\r\n${正文}`);
    else stdout.write(正文 + '\n');
  };

  return new Promise((resolve) => {
    stdin.on('error', (e) => {
      stderr.write(`[${SERVER_NAME}] stdin 出错：${e.message}\n`);
    });

    stdin.on('data', async (块) => {
      stdin.pause();
      try {
        缓冲 = Buffer.concat([缓冲, Buffer.isBuffer(块) ? 块 : Buffer.from(String(块), 'utf8')]);
        if (缓冲.length > 消息上限 && 缓冲.indexOf(0x0a) < 0 && 缓冲.indexOf('\r\n\r\n') < 0) {
          缓冲 = Buffer.alloc(0);
          写回({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error：单条消息超过 8 MB' } }, false);
          return;
        }

        const 用长度头 = /^\s*Content-Length\s*:/i.test(缓冲.subarray(0, 32).toString('utf8'));
        const { 消息们, rest } = 切消息(缓冲);
        缓冲 = rest;

        for (const 消息 of 消息们) {
          if (消息 && 消息.__parseError) {
            写回({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error：${消息.__parseError}` } }, 用长度头);
            continue;
          }
          const 回包们 = await 处理消息(消息, { version });
          for (const 回包 of 回包们) 写回(回包, 用长度头);
        }
      } catch (e) {
        stderr.write(`[${SERVER_NAME}] 处理消息失败：${e?.stack || e}\n`);
      } finally {
        stdin.resume();
      }
    });

    stdin.on('end', () => {
      // 不主动 process.exit：让 stdout 把最后一个回包刷干净
      resolve();
    });
  });
}
