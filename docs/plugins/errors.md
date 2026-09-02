# 错误与排错

---

## 加载期错误：插件装不上

插件包有问题时**服务器照常启动**，插件被标成加载失败，原因同时出现在：

- 服务器日志：`[plugin-registry] 插件 xxx 加载失败：...`
- 界面「设置 → 插件」的「加载失败的插件目录」区块

校验器会把所有问题一次列全，并精确到字段路径。常见的几条：

| 报错 | 原因 |
| --- | --- |
| `缺少必需文件 manifest.json` | 三个 JSON 少了一个 |
| `manifest.json 不是合法的 JSON：...` | 多余逗号、注释、单引号 |
| `manifest.id (x) 必须与插件目录名 (y) 一致` | 改了目录名忘了改 id |
| `manifest.apiVersion 必须为 1` | 写了 `"1"` 字符串或别的版本 |
| `manifest.version 必须是语义化版本` | 写了 `v1.0` 或 `1.0` |
| `manifest.permissions.hosts 至少要申报一个允许访问的主机名` | 漏了这一节 |
| `ui.schema.modelSelector.variants[0].model (x) 未在 manifest.models 中申报` | 模型 ID 拼错 |
| `ui.schema.modelSelector.variants[2] 缺少 facet「resolution」的取值` | variants 少写一列 |
| `ui.schema.fields[3].maxCount.byFacet (x) 不是已申报的 facet` | facet key 拼错 |
| `provider.submit.extract.taskId 必须给出上游任务 ID 的候选路径` | 漏了这一项 |
| `provider.poll.status.completed 至少要列出一个上游状态词` | 状态表不完整 |
| `provider.poll.result.assets 至少要描述一个产物` | 漏了 result |

改完对应 JSON 后重启后端（或在设置页点「重新读取」再刷新前端）。

---

## 提交期错误：任务建不起来

后端在 `POST /api/nova/plugin-tasks` 上做权威校验，返回 400 + `code`：

| code | 含义 | 典型触发 |
| --- | --- | --- |
| `PLUGIN_NOT_FOUND` | 插件未安装或加载失败 | 插件被移除但前端还缓存着列表 |
| `PLUGIN_INPUT_INVALID` | 表单值不合规 | 见下 |
| `QUEUE_FULL` / `RATE_LIMITED` / `TOO_MANY_PENDING_TASKS` | 宿主限流 | 与图片任务共用同一套限流 |
| `SERVER_NOT_ACCEPTING_TASKS` | 服务器维护中 | |

`PLUGIN_INPUT_INVALID` 的文案直接可读，例如：

- `参数「档位」的取值无效: "pro"`
- `当前参数组合没有对应的模型，请重新选择`
- `模型与参数组合不匹配：期望 x，收到 y`
- `「参考图片」为必填项`
- `「参考视频」最多 0 个，收到 1 个`
- `「提示词描述」超过 5000 字上限`
- `「参考图片」含无效的素材地址`

前端有同一套规则做即时反馈，所以正常操作下用户很难碰到这些——
碰到了通常意味着**前后端两套实现走偏了**，值得当 bug 看。

### 出网被拒

```
插件 x 未在 manifest.permissions.hosts 中申报主机 y
插件 x 不能访问内网地址 127.0.0.1
插件 x 的创建请求只允许 http/https 协议
```

这三条在提交那一刻就会报（宿主提交前会先用 baseUrl 试一次闸门），
不会等排到队首才失败。用户改了 baseUrl 指向未申报的主机时也是这条。

---

## 运行期错误：上游那边出问题

### 创建失败一律判死

`provider.submit` 的响应不 ok、或不是 JSON、或取不到 taskId，任务直接失败，
并立刻清理素材。文案取自 `submit.error.from`，取不到就截一段响应原文。

网络类错误会被归一化成人话：

| 实际错误 | 显示 |
| --- | --- |
| `fetch failed` / `ECONNRESET` / `socket hang up` | 连接上游失败，请检查服务器网络连接后重试。 |
| `AbortError` / timeout | 上游创建任务超时，请稍后重试。 |
| 其它 | 原文（超过 200 字截断） |

### 轮询失败**不**判死

这是最容易设计错的地方。宿主的规则：

- HTTP 状态码在 `fatalHttpStatus`（缺省 `400/401/403`）里 → 判死
- 其它任何情况（5xx、超时、DNS 失败、响应不是 JSON）→ 本轮跳过，等下一轮
- 单次失败不清空进度，沿用上一次成功读数——那是几秒前的真实值
- 直到 `maxTotalMs` 用完才判失败：`生成超时（超过 30 分钟仍未完成），请重试`

上游 502 一次就杀掉用户的任务是最容易被投诉的行为，所以默认偏向「继续等」。
反过来，401 继续重试也没意义（key 不会自己变对），所以那几个码判死。

### 上游状态认不出来

```
[plugin-task] 未识别的上游状态 my-plugin/task-42 status="rendering"
```

按 `processing` 继续轮询，同时留下这条日志。**上线后翻一遍日志把漏掉的词补进
`poll.status`**——这是唯一能发现漏词的途径。

### 完成但没有产物

```
上游报告完成但没有返回可用的产物地址
```

状态命中 `completed` 但 `result.assets` 的候选路径全空、且没有 `fallbackUrl`。
说明取值路径写错了，或上游改了返回结构。

---

## 结果期错误：拿到了但打不开

上游的产物直链通常只保留数小时，且响应里没有过期时间字段。宿主的做法是
**在用户真正要看/要下载时探一次**，探测失败就问要不要删记录（不自动删——
用户可能还想复制提示词或重用参数）。

探测用 `<video>` 元素而不是 `fetch`：上游 CDN 基本不带 CORS 头，`fetch` 会抛
TypeError，分不清「链接死了」和「跨域被拦」，那样会把好端端的视频误判成过期。
超时也不判死（慢网络下拿不到 metadata 很常见）。

---

## 怎么看到实际发出去的请求

服务器日志里不会打印请求体（含密钥）。要看拼出来的 body，用离线的方式：

```bash
cd backend
node -e "
const r = require('./plugin-runtime/registry');
const { resolveTemplate } = require('./plugin-runtime/template');
const { validateAndNormalizeInput } = require('./plugin-runtime/input');
const { buildContext } = require('./plugin-runtime/executor');

const p = r.getPlugin('ccode-h3');
const input = {
  facets: { tier: 'standard', resolution: '2K' },
  fields: { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: '一只猫' },
  media: { multiImage: ['https://h.test/api/nova/plugin-media/a.png'] },
};
const n = validateAndNormalizeInput(p, input);
const ctx = buildContext({ plugin: p, baseUrl: 'https://x.test', apiKey: 'sk-REDACTED', ...n });
console.log(JSON.stringify(resolveTemplate(p.provider.submit.body, ctx), null, 2));
"
```

详见 [testing.md](testing.md)——把这段写成测试比每次手敲划算。

---

## 自查清单

插件写完后逐条过一遍：

- [ ] `permissions.hosts` 里有插件会去请求的全部主机（API 域名 + 允许用户填的自建代理域名）
- [ ] `poll.status` 四类词都尽量列全，尤其 `queued` 与 `processing` 的同义拼法
- [ ] `poll.progress.scale` 与上游真实量纲一致
- [ ] `result.assets[].url` 的候选路径覆盖了上游所有已知形状
- [ ] 有 `fallbackUrl` 或确认上游一定给 URL
- [ ] `manifest.media` 申报的类别与 ui.schema 的素材字段对得上
- [ ] 每个 `variants` 行的模型都在 `manifest.models` 里
- [ ] 必填项该必填、条件必填的条件写对了
- [ ] 上游要字符串的数字字段套了 `{{string ...}}`
- [ ] 互斥字段用 `$switch` 而不是两个字段都发
