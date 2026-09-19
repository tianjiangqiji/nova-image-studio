const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { TAOBAO_EXTRACT_EXPRESSION, normalizeImageUrl } = require('../taobao-extract');

test('表达式语法合法', () => {
  assert.equal(typeof TAOBAO_EXTRACT_EXPRESSION, 'string');
  assert.ok(TAOBAO_EXTRACT_EXPRESSION.includes('skuItem'));
  new vm.Script(TAOBAO_EXTRACT_EXPRESSION);
});

test('商品提炼按 SKU 分组读取各自的规格值', () => {
  const createNode = (text, className = '', values = [], fallbackValues = []) => ({
    className,
    innerText: text,
    textContent: text,
    dataset: {},
    getAttribute: () => '',
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('valueItemText--') ? values : fallbackValues,
  });
  const colorBlack = createNode('黑色', 'valueItemText--black');
  const sizeWhite = createNode('白色', 'valueItem--white');
  const skuColor = createNode('颜色 黑色', 'skuItem--color', [colorBlack]);
  const skuSize = createNode('尺码 白色', 'skuItem--size', [], [sizeWhite]);
  const document = {
    title: '测试商品-淘宝网',
    querySelector: () => null,
    querySelectorAll: selector => {
      if (selector.includes('skuItem--')) return [skuColor, skuSize];
      if (selector.includes('valueItemText--')) return [colorBlack];
      return [];
    },
  };

  const result = new vm.Script(TAOBAO_EXTRACT_EXPRESSION).runInNewContext({
    document,
    location: { href: 'https://item.taobao.com/item.htm?id=123' },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.skuProps)), [
    { name: '颜色', values: ['黑色'] },
    { name: '尺码', values: ['白色'] },
  ]);
});

test('normalizeImageUrl 去掉缩略后缀和占位图', () => {
  assert.equal(normalizeImageUrl('//img.alicdn.com/a.jpg_q50.jpg_.webp'), 'https://img.alicdn.com/a.jpg');
  assert.equal(normalizeImageUrl('https://img.alicdn.com/a.jpg_760x760q30.jpg_.webp'), 'https://img.alicdn.com/a.jpg');
  assert.equal(normalizeImageUrl('https://g.alicdn.com/s.gif'), '');
});

test('页面提炼表达式会去掉淘宝缩略后缀', () => {
  assert.match(TAOBAO_EXTRACT_EXPRESSION, /_q\\d+/);
  assert.match(TAOBAO_EXTRACT_EXPRESSION, /_\\.webp/);
});
