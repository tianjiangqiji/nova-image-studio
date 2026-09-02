'use strict';

/**
 * 插件请求模板的求值器。
 *
 * 设计上刻意保持贫瘠：只有 `{{ }}` 插值、5 个函数和一个 `$switch`。一旦某个上游需要
 * 在 JSON 里写控制流，正确的做法是给协议加一档脚本能力，而不是把这里的表达式语言
 * 慢慢喂成半个残废的编程语言。
 *
 * 两条硬规则让绝大多数「可选字段」不需要写任何条件：
 *   1. 解析结果为 undefined / null / '' / [] 的对象字段会被丢弃（用 { "$keep": ... } 保留）
 *   2. 整个字符串就是单个 {{ }} 时保留原始类型，不会被强转成字符串
 */

/** 取值路径：a.b.0.c。任一层缺失返回 undefined，不抛异常。 */
function getPath(source, path) {
  if (path === '' || path === '.') return source;
  let current = source;
  for (const segment of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

/** '' / null / undefined / 空数组都算空；0 与 false 不算。 */
function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * 把表达式切成词。支持单引号 / 双引号字面量，引号内的空格不切。
 * 不支持转义——字面量在这里只用来写分隔符和常量，没有需要转义的场景。
 */
function tokenize(expression) {
  const tokens = [];
  let index = 0;
  const text = String(expression).trim();
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t') { index++; continue; }
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, index + 1);
      if (end < 0) throw new Error(`模板表达式引号未闭合: ${expression}`);
      tokens.push({ literal: text.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] !== ' ' && text[end] !== '\t') end++;
    tokens.push({ path: text.slice(index, end) });
    index = end;
  }
  return tokens;
}

const FUNCTIONS = {
  /** 强转字符串。上游 Go 服务常见「数字字段要求字符串」的场景靠它 */
  string: args => (isEmptyValue(args[0]) ? undefined : String(args[0])),
  number: args => {
    const value = Number(args[0]);
    return Number.isFinite(value) ? value : undefined;
  },
  /** 拼接数组（也接受单值），逐层展平一级，丢掉空项 */
  concat: args => {
    const result = [];
    for (const arg of args) {
      if (isEmptyValue(arg)) continue;
      if (Array.isArray(arg)) {
        for (const item of arg) if (!isEmptyValue(item)) result.push(item);
      } else {
        result.push(arg);
      }
    }
    return result;
  },
  /** join '<分隔符>' <数组> */
  join: args => {
    const [separator, value] = args;
    const list = Array.isArray(value) ? value : isEmptyValue(value) ? [] : [value];
    return list.length === 0 ? undefined : list.join(String(separator ?? ''));
  },
  /** 第一个非空参数 */
  default: args => args.find(arg => !isEmptyValue(arg)),
};

/** 求值单个 `{{ }}` 里的表达式，返回原始类型。 */
function evaluateExpression(expression, context) {
  const tokens = tokenize(expression);
  if (tokens.length === 0) return undefined;

  const head = tokens[0];
  if (head.path && Object.prototype.hasOwnProperty.call(FUNCTIONS, head.path)) {
    const args = tokens.slice(1).map(token =>
      'literal' in token ? token.literal : getPath(context, token.path));
    return FUNCTIONS[head.path](args);
  }

  if ('literal' in head) return head.literal;
  if (tokens.length > 1) {
    throw new Error(`未知的模板函数: ${head.path}（表达式: ${expression}）`);
  }
  return getPath(context, head.path);
}

const WHOLE_EXPRESSION = /^\{\{([^{}]+)\}\}$/;
const ANY_EXPRESSION = /\{\{([^{}]+)\}\}/g;

function resolveString(text, context) {
  const whole = text.match(WHOLE_EXPRESSION);
  // 整串就是一个表达式：保留原类型（数组、数字、undefined 都要能原样传出去）
  if (whole) return evaluateExpression(whole[1], context);
  return text.replace(ANY_EXPRESSION, (_, expression) => {
    const value = evaluateExpression(expression, context);
    return isEmptyValue(value) ? '' : String(value);
  });
}

/** 是否是 { "$keep": ... } 包装节点 */
function isKeepNode(node) {
  return Boolean(node)
    && typeof node === 'object'
    && !Array.isArray(node)
    && Object.prototype.hasOwnProperty.call(node, '$keep');
}

/**
 * 求值任意模板节点。
 * @param {unknown} node 模板（字符串 / 数组 / 对象 / 字面量）
 * @param {Record<string, unknown>} context 模板上下文
 */
function resolveTemplate(node, context) {
  if (typeof node === 'string') return resolveString(node, context);
  if (Array.isArray(node)) {
    const result = [];
    for (const item of node) {
      const value = resolveTemplate(item, context);
      if (!isEmptyValue(value)) result.push(value);
    }
    return result;
  }
  if (node === null || typeof node !== 'object') return node;

  // { "$keep": <模板> }：即使结果为空也保留该字段（由父对象负责保留，见 isKeepNode）
  if (isKeepNode(node)) {
    const value = resolveTemplate(node.$keep, context);
    return value === undefined ? null : value;
  }

  // { "$switch": "<路径>", "$cases": { ... }, "$default": <模板> }
  if (Object.prototype.hasOwnProperty.call(node, '$switch')) {
    const key = resolveTemplate(node.$switch, context);
    const cases = node.$cases && typeof node.$cases === 'object' ? node.$cases : {};
    const matchKey = key === undefined || key === null ? '' : String(key);
    if (Object.prototype.hasOwnProperty.call(cases, matchKey)) {
      return resolveTemplate(cases[matchKey], context);
    }
    return Object.prototype.hasOwnProperty.call(node, '$default')
      ? resolveTemplate(node.$default, context)
      : undefined;
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    const resolved = resolveTemplate(value, context);
    // { "$keep": ... } 的字段即使为空也保留；判断放在这里而不是递归内部，
    // 因为「保留」是父对象的行为，子节点自己无从表达。
    if (isKeepNode(value)) {
      result[key] = resolved === undefined ? null : resolved;
      continue;
    }
    // 空值丢弃：images / reference_videos / workflow_id 这类「有就传」的字段不必写条件
    if (isEmptyValue(resolved)) continue;
    result[key] = resolved;
  }
  return result;
}

module.exports = { resolveTemplate, evaluateExpression, getPath, isEmptyValue };
