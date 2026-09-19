// 淘宝/天猫商品页提炼：只从当前已打开的标签页读标题、价格、店铺、SKU、主图、详情图。
// 选择器按 2026-08 桌面版 item.taobao.com 实测（hashed class），不是通用爬虫。

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const url = normalizeImageUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function normalizeImageUrl(raw) {
  let url = String(raw || '').trim();
  if (!url || url.startsWith('data:') || url.includes('g.alicdn.com/s.gif')) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  // 去掉淘宝缩略后缀，尽量拿原图
  url = url.replace(/_\d+x\d+(?:q\d+)?\.(?:jpg|jpeg|png|webp)/ig, '');
  url = url.replace(/_q\d+\.(?:jpg|jpeg|png|webp)/ig, '');
  url = url.replace(/_\.webp$/i, '');
  return url;
}

const TAOBAO_EXTRACT_EXPRESSION = `(() => {
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const textOf = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const attr = (el, name) => (el && (el.getAttribute(name) || el.dataset[name] || '')) || '';
  const abs = (raw) => {
    let value = String(raw || '').trim();
    if (!value || value.startsWith('data:') || value.includes('g.alicdn.com/s.gif')) return '';
    if (value.startsWith('//')) value = 'https:' + value;
    value = value.replace(/_\\d+x\\d+(?:q\\d+)?\\.(?:jpg|jpeg|png|webp)/ig, '');
    value = value.replace(/_q\\d+\\.(?:jpg|jpeg|png|webp)/ig, '');
    value = value.replace(/_\\.webp$/i, '');
    return value;
  };
  const uniq = (list) => {
    const seen = new Set();
    const out = [];
    for (const url of list) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  };

  const href = location.href;
  const itemId = (href.match(/[?&]id=(\\d+)/) || [])[1] || '';
  const platform = /tmall\\.com/i.test(href) ? 'tmall' : (/taobao\\.com/i.test(href) ? 'taobao' : 'unknown');

  const titleFromDoc = String(document.title || '').replace(/-淘宝网$|-天猫$|-tmall\\.com$/i, '').trim();
  const title = titleFromDoc;

  const priceEl = document.querySelector('[class*="normalPrice"], [class*="priceWrap"], [class*="Price--"]');
  const price = textOf(priceEl);

  const shopEl = document.querySelector('[class*="shopName--"], [class*="shopNameWrap"]');
  const shopName = textOf(shopEl);

  const skuProps = qa('[class*="skuItem--"]').map(item => {
    const raw = textOf(item);
    const name = (raw.split(/\\s+/)[0] || '规格').replace(/切换大图模式/g, '') || '规格';
    const values = item.querySelectorAll('[class*="valueItemText--"]').length
      ? Array.from(item.querySelectorAll('[class*="valueItemText--"]')).map(textOf).filter(Boolean)
      : Array.from(item.querySelectorAll('[class*="valueItem--"]')).map(el => textOf(el.querySelector('[class*="valueItemText--"]') || el)).filter(Boolean);
    const uniq = [];
    for (const value of values) if (!uniq.includes(value)) uniq.push(value);
    return { name, values: uniq };
  }).filter(prop => prop.values.length > 0);

  const mainImages = [];
  for (const img of qa('[class*="thumbnailPic--"], [class*="mainPic--"]')) {
    const url = abs(img.currentSrc || img.src || attr(img, 'data-src'));
    if (url) mainImages.push(url);
  }

  const detailImages = [];
  for (const img of qa('.descV8-singleImage-image, [class*="descV8-singleImage"] img')) {
    const url = abs(attr(img, 'data-src') || img.dataset.src || img.currentSrc || img.src);
    if (url) detailImages.push(url);
  }

  const errors = [];
  if (!title) errors.push('未识别到标题');
  if (mainImages.length === 0) errors.push('未识别到主图');

  return {
    platform,
    itemId: itemId || undefined,
    title,
    price: price || undefined,
    shopName: shopName || undefined,
    mainImages: uniq(mainImages),
    skuProps,
    detailImages: uniq(detailImages),
    url: href,
    errors: errors.length ? errors : undefined,
  };
})()`;

module.exports = {
  TAOBAO_EXTRACT_EXPRESSION,
  uniqueUrls,
  normalizeImageUrl,
};
