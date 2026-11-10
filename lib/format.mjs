/**
 * 把插件 CLI 的 JSON 结果整理成人可读的摘要。
 * 只放「结论 + 关键数据」，整份 JSON 不往对话里塞（客户端自己会截断）。
 */

const 条数上限 = 20;

function 行(标题, 值) {
  return `   ${标题}${String(标题).endsWith('：') ? '' : ' '}${值}`;
}

function 截断(文本, 长度) {
  const s = String(文本 ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 长度 ? s.slice(0, 长度) + '…' : s;
}

export function 格式化合并(d) {
  const 统计 = d.统计 || {};
  const 章节 = d.章节 || [];
  const 跳过 = d.跳过 || [];
  const 提示 = d.提示 || [];
  const 行们 = [];

  if (d.dryRun) {
    行们.push(`🧪 预演：将合并 ${章节.length} 份（没有写文件）`);
  } else {
    行们.push(`✅ 合并完成：${章节.length} 份 → ${d.输出}`);
  }
  行们.push(
    行('段落', 统计.段落数 ?? '?') +
      ' · ' +
      `表格 ${统计.表格数 ?? 0} · 字符 ${统计.字符数 ?? 0} · 目录 ${统计.目录条数 ?? 章节.length} 条 · 预估 ${统计.预估页数 ?? '?'} 页`,
  );

  if (章节.length) {
    const 名单 = 章节.slice(0, 条数上限).map((c) => `${c.序号}. ${c.标题}`);
    行们.push(行('章节：', 名单.join('；') + (章节.length > 条数上限 ? ` …等 ${章节.length} 条` : '')));
  }
  for (const s of 跳过) {
    行们.push(`   ⚠️ 跳过第 ${s.序号} 份（${s.原因 || '解析失败'}）：${s.路径 || ''}`);
  }
  for (const t of 提示) {
    行们.push(`   ⚠️ 忽略 ${t.输入 || ''}：${t.原因 || ''}`);
  }
  return 行们.join('\n');
}

export function 格式化比对(d) {
  const 统计 = d.统计 || {};
  const 行们 = [];

  if (!d.有差异) {
    行们.push('✅ 两份文档没有发现差异');
  } else {
    行们.push(
      `⚠️ 有差异：修改 ${统计.修改 ?? 0} 处、新增 ${统计.新增 ?? 0} 处、删除 ${统计.删除 ?? 0} 处，改动比例 ${统计.改动比例 ?? 0}%`,
    );
  }
  行们.push(
    行(
      '规模：',
      `A ${d.A?.段落数 ?? '?'} 段 / ${d.A?.标题数 ?? '?'} 标题 · B ${d.B?.段落数 ?? '?'} 段 / ${d.B?.标题数 ?? '?'} 标题 · 表格 ${统计.表格数A ?? '?'} → ${统计.表格数B ?? '?'}`,
    ),
  );

  const 高风险 = (d.标题事件 || []).filter((e) => e.风险 === '高');
  for (const e of 高风险.slice(0, 5)) {
    const 描述 = [
      e.事件 || '标题变化',
      e.级别 ? `H${e.级别}` : '',
      e.文本 ? `「${截断(e.文本, 60)}」` : '',
      e.说明 ? `—${截断(e.说明, 60)}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    行们.push(`   ⚠️ 标题风险：${描述}`);
  }

  const 差异 = d.差异 || [];
  if (差异.length) {
    行们.push(行('改动预览：', `共 ${差异.length} 处，列出前 ${Math.min(5, 差异.length)} 处`));
    for (const x of 差异.slice(0, 5)) {
      const 位置 = x.位置 ? `（${x.位置}）` : '';
      let 文本;
      if (x.类型 === '修改' && (x.改前 || x.改后)) {
        文本 = `「${截断(x.改前, 60)}」→「${截断(x.改后, 60)}」`;
      } else if (typeof x.原文 === 'string') {
        文本 = 截断(x.原文, 80);
      } else if (Array.isArray(x.片段)) {
        文本 = 截断(x.片段.map((p) => p.文本 ?? '').join(''), 80);
      } else {
        文本 = 截断(x.片段 ?? '', 80);
      }
      行们.push(`   · ${x.类型}${位置}：${文本}`);
    }
  }
  if (d.截断?.发生) {
    行们.push('   ⚠️ 文档过大，只比对了前一部分；可用 max_paragraphs 放宽。');
  }
  return 行们.join('\n');
}

export function 格式化站点(d) {
  const 统计 = d.统计 || {};
  const 问题 = d.问题 || [];
  const 行们 = [];

  const 阻断 = 统计.阻断 ?? 0;
  const 警告 = 统计.警告 ?? 0;
  行们.push(
    阻断
      ? `❌ 站点体检未通过：${阻断} 项阻断、${警告} 项警告（共 ${统计.页面数 ?? 0} 页）`
      : 警告
        ? `⚠️ 没有阻断项，但有 ${警告} 项警告（共 ${统计.页面数 ?? 0} 页）`
        : `✅ 站点体检通过：${统计.页面数 ?? 0} 页，没有阻断也没有警告`,
  );
  行们.push(行('目标：', `${d.模式 === 'local' ? '本地目录' : '在线站点'} ${d.目标 || ''}`));

  if (问题.length) {
    const 等级 = { block: '❌', warn: '⚠️' };
    行们.push(行('问题：', `（共 ${问题.length} 项，列出前 ${Math.min(10, 问题.length)} 项）`));
    for (const p of 问题.slice(0, 10)) {
      行们.push(`   ${等级[p.级别] || '·'} [${p.类别}] ${p.对象}：${截断(p.详情, 110)}`);
    }
  }
  return 行们.join('\n');
}

export function 格式化发版(d) {
  const 行们 = [];
  const 阻断 = d.blocks ?? 0;
  const 警告 = d.warnings ?? 0;

  行们.push(`${阻断 ? '❌' : 警告 ? '⚠️' : '✅'} ${d.conclusion || (阻断 ? '不可发版' : '可以发版')}`);
  行们.push(行('包：', `${d.name || '?'} ${d.version ? 'v' + d.version : ''}`));
  行们.push(行('仓库：', d.repo || ''));

  const 项 = d.items || [];
  const 问题项 = 项.filter((x) => x.level === 'fail' || x.level === 'warn');
  if (问题项.length) {
    行们.push(行('检查项：', `${项.length} 项，其中 ${阻断} 项阻断、${警告} 项警告（列出前 10 项）`));
    for (const x of 问题项.slice(0, 10)) {
      const 标记 = x.level === 'fail' ? '❌' : '⚠️';
      行们.push(`   ${标记} ${x.title}${x.evidence?.length ? '：' + 截断(x.evidence[0], 100) : ''}`);
    }
  } else {
    行们.push(行('检查项：', `${项.length} 项全部通过或跳过`));
  }
  return 行们.join('\n');
}
