/**
 * 极简 JSON Schema 校验器（只覆盖本包用到的子集）。
 * 目标：缺参数 / 类型不对 / 未知参数，都能返回一条人看得懂的结构化错误，而不是崩。
 */

function 类型名(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function 校验一个(字段, spec, 值, 错误们) {
  const 类型 = spec.type;
  if (类型 === 'string') {
    if (typeof 值 !== 'string') {
      错误们.push(`${字段} 必须是字符串（收到 ${类型名(值)}）`);
      return undefined;
    }
    if (spec.minLength && 值.length < spec.minLength) {
      错误们.push(`${字段} 不能为空`);
      return undefined;
    }
    if (spec.enum && !spec.enum.includes(值)) {
      错误们.push(`${字段} 只能是 ${spec.enum.join(' / ')}（收到 ${值}）`);
      return undefined;
    }
    return 值;
  }

  if (类型 === 'integer' || 类型 === 'number') {
    if (typeof 值 !== 'number' || !Number.isFinite(值) || (类型 === 'integer' && !Number.isInteger(值))) {
      错误们.push(`${字段} 必须是${类型 === 'integer' ? '整数' : '数字'}（收到 ${JSON.stringify(值)}）`);
      return undefined;
    }
    if (spec.minimum !== undefined && 值 < spec.minimum) {
      错误们.push(`${字段} 不能小于 ${spec.minimum}`);
      return undefined;
    }
    if (spec.maximum !== undefined && 值 > spec.maximum) {
      错误们.push(`${字段} 不能大于 ${spec.maximum}`);
      return undefined;
    }
    return 值;
  }

  if (类型 === 'boolean') {
    if (typeof 值 !== 'boolean') {
      错误们.push(`${字段} 必须是 true / false（收到 ${类型名(值)}）`);
      return undefined;
    }
    return 值;
  }

  if (类型 === 'array') {
    if (!Array.isArray(值)) {
      错误们.push(`${字段} 必须是数组（收到 ${类型名(值)}）`);
      return undefined;
    }
    if (spec.minItems && 值.length < spec.minItems) {
      错误们.push(`${字段} 至少要有 ${spec.minItems} 项`);
      return undefined;
    }
    if (spec.maxItems && 值.length > spec.maxItems) {
      错误们.push(`${字段} 最多 ${spec.maxItems} 项`);
      return undefined;
    }
    if (spec.items) {
      const 结果 = [];
      for (let i = 0; i < 值.length; i++) {
        const 子 = 校验一个(`${字段}[${i}]`, spec.items, 值[i], 错误们);
        if (子 !== undefined) 结果.push(子);
      }
      return 结果;
    }
    return 值;
  }

  错误们.push(`${字段} 的 schema 类型不受支持：${String(类型)}`);
  return undefined;
}

/**
 * @param {{type: string, properties?: Record<string, any>, required?: string[], additionalProperties?: boolean}} schema
 * @param {unknown} 输入
 * @returns {{ok: true, value: Record<string, any>} | {ok: false, error: {code: string, message: string, details?: string[]}}}
 */
export function 校验参数(schema, 输入) {
  const 错误们 = [];

  if (输入 === null || typeof 输入 !== 'object' || Array.isArray(输入)) {
    return {
      ok: false,
      error: {
        code: 'invalid_params',
        message: `参数必须是一个 JSON 对象（收到 ${类型名(输入)}）`,
      },
    };
  }

  const 定义们 = schema.properties || {};
  const 必填 = schema.required || [];
  const 结果 = {};

  for (const 键 of 必填) {
    if (输入[键] === undefined) 错误们.push(`缺少必填参数 ${键}`);
  }

  if (schema.additionalProperties === false) {
    for (const 键 of Object.keys(输入)) {
      if (!Object.prototype.hasOwnProperty.call(定义们, 键)) {
        错误们.push(`不认识的参数 ${键}（可用参数：${Object.keys(定义们).join(', ')}）`);
      }
    }
  }

  for (const [键, 定义] of Object.entries(定义们)) {
    const 原值 = 输入[键];
    if (原值 === undefined) {
      if (定义.default !== undefined) 结果[键] = 定义.default;
      continue;
    }
    const 值 = 校验一个(键, 定义, 原值, 错误们);
    if (值 !== undefined) 结果[键] = 值;
  }

  if (错误们.length) {
    return {
      ok: false,
      error: {
        code: 'invalid_params',
        message: 错误们[0],
        details: 错误们,
      },
    };
  }

  return { ok: true, value: 结果 };
}
