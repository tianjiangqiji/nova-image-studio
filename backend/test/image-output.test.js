const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeImagePayload, detectImageMime, extractSvgPayload, extractChatImagePayload } = require('../image-output');
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>';

test('decodes raw, base64, percent-encoded and mislabeled SVG without rasterizing', () => {
  for (const value of [svg, Buffer.from(svg).toString('base64'), `data:image/svg+xml,${encodeURIComponent(svg)}`, `data:image/png;base64,${Buffer.from(svg).toString('base64')}`]) {
    const result = decodeImagePayload(value);
    assert.equal(result.mimeType, 'image/svg+xml');
    assert.equal(result.bytes.toString(), svg);
  }
  assert.equal(detectImageMime(Buffer.from(`<?xml version="1.0"?>\n<!--vector-->${svg}`)), 'image/svg+xml');
});

test('recovers the observed SVG error wrapper but does not turn unrelated API errors into success', () => {
  const error = { type: 'invalid_request_error', code: 'bad_request', message: `<CodeBlock language="xml">${svg}</CodeBlock>` };
  assert.equal(extractSvgPayload({ error }, 400), svg);
  assert.equal(extractSvgPayload({ error: { ...error, code: 'insufficient_quota' } }, 400), undefined);
  assert.equal(extractSvgPayload({ error }, 401), undefined);
  assert.equal(extractSvgPayload({ choices: [{ message: { content: `\`\`\`svg\n${svg}\n\`\`\`` } }] }), svg);
});

test('extracts chat media links and base64 while rejecting inaccessible sandbox paths', () => {
  const payload = content => ({ choices: [{ message: { content } }] });
  assert.equal(extractChatImagePayload(payload('![image](https://example.test/result.png)')), 'https://example.test/result.png');
  assert.equal(extractChatImagePayload(payload('data:image/gif;base64,R0lGODlh')), 'data:image/gif;base64,R0lGODlh');
  assert.throws(() => extractChatImagePayload(payload('[file](sandbox:/mnt/data/file.gif)')), /sandbox/);
});
