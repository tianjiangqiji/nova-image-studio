# 测试与调试

插件是纯 JSON，所以调试的关键不是「跑起来看看」，而是**在不联网的情况下断言映射是否正确**。
联网只能验证「这次通了」；fixtures 验证的是「所有分支都还是当初的样子」。

---

## 结构校验

```bash
cd backend
npm run plugins:verify              # 校验全部插件
npm run plugins:verify ccode-h3     # 只校验一个
```

输出：

```
✓ ccode-h3@1.0.0 结构校验通过（8 个模型）
    ✓ 01-standard-768p-text2video
    ✓ 02-standard-4k-with-reference
    ...
全部通过
```

写错时会精确指出字段路径并以非 0 退出，适合放进 CI。

---

## 契约用例（fixtures）

在插件目录下建 `fixtures/`，每个子目录是一个用例：

```
backend/plugins/my-plugin/fixtures/
  01-basic/
    input.json              必需：这一单的表单值
    expected-request.json   可选：断言拼出来的创建请求
    upstream-submit.json    可选：模拟的创建响应（用来取 upstreamTaskId）
    upstream-poll.json      可选：模拟的查询响应
    expected-result.json    可选：断言归一化后的结果
```

用例按目录名排序执行。凭据固定为 `baseUrl = https://upstream.test`、
`apiKey = sk-fixture`，所以**不要把真实密钥写进 fixtures**。

### input.json

就是前端提交的三段值：

```json
{
  "facets": { "tier": "standard", "resolution": "2K" },
  "fields": { "mode": "multi-reference", "aspectRatio": "9:16", "seconds": 8, "prompt": "一只猫" },
  "media": { "multiImage": ["https://host.test/api/nova/plugin-media/ref-1.png"] }
}
```

素材 URL 必须是 `.../api/nova/plugin-media/<文件名>` 形式——后端只接受本机素材地址，
fixtures 走的是同一套校验。

`input.json` 会先经过后端的权威校验，所以一个用例同时也在测**约束是否写对了**：
2K 缺参考图、量化版配首尾帧这类组合会在这一步就报错。

### expected-request.json

按需断言，不写的字段不检查：

```json
{
  "model": "minimax-h3-original-cf-2k",
  "method": "POST",
  "url": "https://upstream.test/v1/videos",
  "body": {
    "model": "minimax-h3-original-cf-2k",
    "prompt": "一只猫",
    "seconds": "8",
    "aspect_ratio": "9:16",
    "size": "2K",
    "images": ["https://host.test/api/nova/plugin-media/ref-1.png"]
  }
}
```

`body` 是**全量深比较**：多一个不该出现的字段也会失败。这正是我们想要的——
「参考视频没传时不该出现 `reference_videos`」这种规则只有全量比较才拦得住。

### upstream-poll.json + expected-result.json

```json
// upstream-poll.json
{ "id": "up-1", "status": "completed", "progress": 97, "video_url": "https://video.internal/out.mp4" }
```

```json
// expected-result.json
{
  "state": "completed",
  "progress": 100,
  "assets": [{ "kind": "video", "url": "https://cdn.example.com/out.mp4", "mime": "video/mp4" }]
}
```

`state` 只有 `queued` / `processing` / `completed` / `failed`。
归一化走的是线上同一个函数，所以这里断言的就是用户会看到的东西。

### 建议覆盖的用例

参考 `backend/plugins/ccode-h3/fixtures/`，它覆盖了：

| 用例 | 在验证什么 |
| --- | --- |
| 最简文生视频 | 可选字段全都不出现 |
| 带全部素材 + 超分档位 | `$switch` 出的互斥字段、三类素材都传上 |
| 首尾帧模式 | `concat` 拼接、`workflow_id` 只在这个模式出现、隐藏槽位的残留被丢弃 |
| 最弱档位 | `maxCount.byFacet` 收紧后仍能提交 |
| 上游失败 | 错误文案取值路径 |
| 上游排队 | `queued` 词表（含大小写差异） |
| 完成但没给 URL | `fallbackUrl` 生效 |

---

## 单元测试里跑 fixtures

`backend/test/plugin-runtime.test.js` 里已经有一条测试遍历所有已安装插件的 fixtures，
新增插件不需要改测试代码：

```bash
cd backend && npm test
```

前端一侧，`frontend/src/lib/__tests__/plugin-schema.test.ts` 直接读你的 `ui.schema.json`
来验证宿主的求解结果（可选分辨率、素材槽名额、必填切换、计价）。
接新插件时照着加一个 describe 块即可。

---

## 手工看拼出来的请求体

```bash
cd backend
node -e "
const r = require('./plugin-runtime/registry');
const { resolveTemplate } = require('./plugin-runtime/template');
const { validateAndNormalizeInput } = require('./plugin-runtime/input');
const { buildContext } = require('./plugin-runtime/executor');
const p = r.getPlugin('my-plugin');
const n = validateAndNormalizeInput(p, require('./plugins/my-plugin/fixtures/01-basic/input.json'));
const ctx = buildContext({ plugin: p, baseUrl: 'https://upstream.test', apiKey: 'sk-x', ...n });
console.log(JSON.stringify(resolveTemplate(p.provider.submit.body, ctx), null, 2));
"
```

把它跑一次、把输出粘成 `expected-request.json`，然后就再也不用手跑了。

---

## 联网试跑前的准备

- 「设置 → 插件」里填好凭据
- 用参考素材时确认服务器有公网地址：内网部署要配 `NOVA_PUBLIC_BASE_URL`，
  否则上游拉不到素材（会明确报 `无法确定素材的公网地址`）
- 第一次跑完去翻服务器日志，搜 `未识别的上游状态`——把漏掉的状态词补进 `poll.status`

---

## 改了插件之后

插件在后端启动时加载一次并缓存。改完 JSON：

- 在「设置 → 插件」点「重新读取」（会让后端重新扫描插件目录，不用重启），或
- 重启后端

`npm run plugins:verify` 每次都是重新读盘，不受缓存影响。

注意：已经在跑的任务仍然用它启动时那份插件定义；重新读取只影响之后新建的任务。
