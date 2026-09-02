# 给 AI 的完整上下文（单文件）

> 把这一个文件整份粘给 AI，它就有了写 Nova Studio 视频插件所需的全部信息。
> 不需要再给它别的文件。人类读者请从 [README.md](README.md) 开始。

---

## 你的任务

为 Nova Studio 开源版编写一个**视频生成插件**。插件是一个目录，包含 3 个 JSON 文件，
**没有任何可执行代码**。宿主（Nova Studio）读这 3 个文件，据此渲染表单、发上游请求、
轮询状态、归一化产物。

产出物：

```
backend/plugins/<plugin-id>/
  manifest.json     身份、模型清单、申报价、凭据、出网白名单、素材配额
  ui.schema.json    表单描述（宿主渲染，插件不写前端代码）
  provider.json     上游请求模板 + 轮询规则 + 结果取值路径
  README.md         可选
  fixtures/         可选但强烈建议：离线契约用例
```

`<plugin-id>` 只能用小写字母、数字、短横线，且必须等于 `manifest.id`。

---

## 你需要先问清楚的事

写之前必须掌握上游 API 的这些信息。缺任何一项都不要靠猜，去问用户：

1. **创建任务**的方法、路径、请求头、请求体字段（含哪些必填、哪些互斥、类型是什么）
2. 创建响应里**上游任务 ID** 在哪个字段
3. **查询任务**的方法、路径
4. 查询响应里的**状态字段名**，以及成功/失败/排队/进行中各自可能的取值
5. 进度字段名与量纲（0–100 还是 0–1，或者没有）
6. 完成时**产物地址**在哪个字段（列出所有见过的形状）
7. 失败时**错误文案**在哪个字段
8. 模型 ID 清单，以及它们对应哪些维度组合（如 档位 × 分辨率）
9. 每个模型的价格与计费方式（按秒 / 按次）
10. 参考素材（图/视频/音频）的数量上限，以及哪些模型/模式支持
11. 插件自己会请求的主机名（创建/查询用的 API 域名，以及允许用户填的自建代理域名）

---

## 三条不可违反的规则

**1. 出网必须申报。** `manifest.permissions.hosts` 里没写的主机会被宿主拒绝。
私有网段与环回地址永远被拒。这张表只管**插件自己发起的请求**（`submit.url` / `poll.url`
解析出的主机），产物地址由浏览器直接加载，不必写进来。

**2. 凭据不由你管。** 用户在设置里填 apiKey 与 baseUrl，你只在模板里写
`{{apiKey}}` / `{{baseUrl}}`。不要在 JSON 里写任何真实密钥，fixtures 里也不行。

**3. 结果必须归一化。** 你在 `provider.poll.result.assets` 里给出候选路径，
宿主把产物压成统一结构存历史。这一步做不好，插件卸载后用户的旧记录就废了。

---

## manifest.json 完整规格

```jsonc
{
  "apiVersion": 1,                    // 必需，只能是数字 1
  "id": "example-video",              // 必需，= 目录名，小写字母数字短横线，2-64 字符
  "name": "Example 视频",              // 必需
  "version": "1.0.0",                 // 必需，严格语义化版本（x.y.z）
  "kind": "video",                    // 必需，只能是 "video"
  "mode": "declarative",              // 可选，只能是 "declarative"
  "description": "一句话说明",          // 可选
  "author": "",                       // 可选
  "homepage": "https://...",          // 可选
  "outputs": ["video"],               // 可选，缺省 ["video"]

  "credential": {                     // 必需
    "source": "client",               // 必需，只能是 "client"
    "label": "Example API Key",       // 必需，密钥输入框标签
    "defaultBaseUrl": "https://api.example.com",  // 可选
    "helpUrl": "https://..."          // 可选
  },

  "permissions": {                    // 必需
    "hosts": ["api.example.com"]      // 必需，至少一项，纯主机名（不带协议/路径）
  },

  "media": {                          // 用到参考素材时必需
    "images": { "maxCount": 9 },      // 该类素材跨所有字段的总量上限
    "videos": { "maxCount": 3 },
    "audios": { "maxCount": 3 }
  },

  "runtime": {                        // 可选
    "submitTimeoutMs": 90000,         // 缺省 90000
    "pollIntervalMs": 12000,          // 缺省 12000，夹取 2000-300000
    "maxPollMs": 1800000              // 缺省 1800000，夹取 60000-21600000
  },

  "models": [                         // 必需，至少一个
    {
      "id": "example-v1",             // 必需，提交给上游的模型标识，不可重复
      "name": "Example V1",           // 必需
      "shortName": "V1",              // 可选，缺省用 name
      "description": "",              // 可选
      "price": {                      // 可选，不写则界面上不显示任何价格
        "unit": "per-second",         // "per-second" | "per-call"
        "amount": 0.1,                // 非负数
        "currency": "CNY"             // CNY | USD | EUR
      }
    }
  ]
}
```

`media` 里只能出现 `images` / `videos` / `audios` 三个键。
`ui.schema.modelSelector.variants` 里出现的每个 `model` 都必须在 `models` 里申报过。

---

## ui.schema.json 完整规格

```jsonc
{
  "apiVersion": 1,                     // 必需
  "priceQuantityField": "seconds",     // per-second 计费时数量取哪个字段；不写则算不出总价
  "layout": {
    "toolbar": ["$model", "mode", "$resolution", "aspectRatio", "seconds"],
    "body": ["firstFrame", "lastFrame", "multiImage", "prompt"]
  },
  "modelSelector": { ... },            // 必需
  "fields": [ ... ]                    // 必需，至少一个
}
```

`layout.toolbar` 的元素：`$model`（模型选择器）、`$<facetKey>`（某个 facet 的小按钮）、
或字段 key。`layout.body` 只放素材字段与文本字段。两者都可省略（宿主会用默认顺序）。

### modelSelector

**核心思想：不写规则，写事实。** 把每个真实存在的「模型 = 维度组合」列成一行，
宿主自己算出「选了 A 之后 B 里该有哪些选项」。

```jsonc
"modelSelector": {
  "label": "模型与档位",               // 可选，模型按钮的 tooltip
  "familyLabel": "Example",           // 可选，模型按钮上显示的族名
  "familyDescription": "按秒计费 · 4-15 秒",  // 可选
  "facets": [                         // 必需，至少一个；申报顺序 = 选择先后顺序
    { "key": "tier", "label": "档位", "icon": "sparkles" },
    { "key": "resolution", "label": "分辨率", "icon": "maximize", "hideWhenSingle": true }
  ],
  "facetOptions": {                   // 必需，每个 facet 一个非空数组，顺序即界面顺序
    "tier": [
      { "value": "standard", "label": "Standard", "fullLabel": "原版", "description": "全功能" },
      { "value": "lite", "label": "Lite", "fullLabel": "量化版", "description": "高性价比" }
    ],
    "resolution": [
      { "value": "768P", "label": "768P" },
      { "value": "1080P", "label": "1080P" }
    ]
  },
  "variants": [                       // 必需，每行必须有 model + 每个 facet 的取值
    { "model": "ex-standard-768p",  "tier": "standard", "resolution": "768P" },
    { "model": "ex-standard-1080p", "tier": "standard", "resolution": "1080P" },
    { "model": "ex-lite-768p",      "tier": "lite",     "resolution": "768P" }
  ]
}
```

**第一个 facet 是一级选择**，总是展示全部申报值。后续 facet 的可选值受前面已定的
facet 约束，反之不然（避免「当前是 1080P」导致「量化版」点不进去）。

上例中 Lite 没有 1080P，所以选中 Lite 后分辨率只剩一项，`hideWhenSingle` 让按钮消失。
这些都不需要写条件。

即使只有一个模型也必须写 modelSelector——给一个单值 facet + `hideWhenSingle`。

### fields 公共字段

```jsonc
{
  "key": "seconds",            // 必需，唯一，不能与 facet 同名
  "type": "select-grid",       // 必需：textarea | text | select | select-grid | media | switch
  "label": "视频时长",          // 建议写，报错文案会用它
  "icon": "clock",             // 可选，见图标表
  "required": true,            // 可选，无条件必填
  "requiredIf": { "resolution": ["2K", "4K"] },   // 可选，条件必填
  "showIf": { "mode": ["first-last-frame"] },     // 可选，条件显示；不可见的字段不校验不提交
  "hideWhenSingle": true,      // 可选，select 类：只剩一个可选项时不显示
  "default": 4                 // 可选（media 除外）
}
```

**条件语法（`showIf` / `requiredIf` / `availableWhen` 三者相同）**：

```json
{ "键1": ["值a", "值b"], "键2": ["值c"] }
```

键之间是**且**，数组内是**或**。比较按字符串进行（`[4]` 能命中 `"4"`）。
作用域是 **facet 取值 + 字段取值合在一起**，所以既能引用 facet 也能引用其它字段。

### select / select-grid

```jsonc
{
  "key": "mode", "type": "select", "label": "生成模式", "icon": "layers",
  "default": "multi-reference",
  "hideWhenSingle": true,
  "options": [                          // 必需，至少一项
    { "value": "multi-reference", "label": "全能参考", "description": "参考素材约束生成" },
    { "value": "first-last-frame", "label": "首尾帧", "description": "指定首尾帧",
      "availableWhen": { "tier": ["standard"] } }   // 不满足时置灰，不是消失
  ]
}
```

`select-grid` 额外支持 `"columns": 3`（方格列数）与 `"suffix": "秒"`（按钮上的单位）。
时长、比例这类用 `select-grid`；带说明的模式选择用 `select`。

当前取值在新组合下不可选时，宿主自动落到第一个可选项。

### textarea / text

```jsonc
{
  "key": "prompt", "type": "textarea", "label": "提示词描述", "icon": "clapperboard",
  "required": true,
  "maxLength": 5000,
  "rows": 9,
  "placeholder": "描述你想生成的画面…",
  "presets": ["电影感运镜，4K超高清画质", "赛博朋克霓虹街道，雨夜积水倒影"]
}
```

**第一个 `textarea` 字段被当作主提示词**：进历史记录正文与搜索，宽屏下吃掉剩余高度。
附加说明之类用 `text`。`presets` 是一排按钮，点一下用 `，` 追加到内容末尾。

### media

```jsonc
{
  "key": "multiImage", "type": "media", "kind": "images",
  "style": "thumbnail",                 // thumbnail(缺省) | frame | chip
  "label": "参考图片",
  "hint": "可选提供参考素材帮助模型理解画面风格。",
  "requiredHint": "2K / 4K 必须至少提供 1 张参考图片。",   // 变必填时替换 hint
  "requiredIf": { "resolution": ["2K", "4K"] },
  "showIf": { "mode": ["multi-reference"] },
  "accent": "blue",                     // blue | emerald | amber | primary（chip 配色）
  "maxCount": { "byFacet": "tier", "values": { "standard": 9, "lite": 4 }, "default": 0 }
}
```

- `kind` 必需：`images` / `videos` / `audios`
- `maxCount` 必需：整数，或 `{ byFacet, values, default }`。`byFacet` 必须是已申报的 facet
- **`maxCount` 为 0 的槽直接不显示**，所以「某档位不支持视频参考」不用写 `showIf`
- `style`：`thumbnail` 方形缩略图（参考图）、`frame` 宽画幅（首尾帧）、`chip` 文件名胶囊（视频/音频）
- 模板里用 `media.<key>` 取到**公网 URL 的有序数组**

### switch

布尔开关，提交时始终出现（`true`/`false`），不会因为是 `false` 被丢弃。

### 图标名

`sparkles`、`layers`、`maximize`、`ratio`、`clock`、`clapperboard`。
写别的名字不报错，回落到通用齿轮图标。

---

## provider.json 完整规格

### 模板语言（只有这些，没有更多）

**插值 `{{ }}`**

- 整个字符串就是一个 `{{}}` → **保留原始类型**（数字、数组、undefined）
- 混在字符串里 → 拼成字符串，空值渲染成空串

```json
"seconds": "{{fields.seconds}}"        → 8              (数字)
"images":  "{{media.multiImage}}"      → ["https://…"]  (数组)
"url":     "{{baseUrl}}/v1/videos"     → "https://…/v1/videos"
```

**空值自动丢弃**：对象里解析为 `undefined` / `null` / `""` / `[]` 的字段被整个删掉。
`0` 与 `false` 不算空。这条规则消灭了绝大多数条件——「有就传」的字段直接写即可。

**`$keep`**：强制保留（空时发 `null`）

```json
"seed": { "$keep": "{{fields.seed}}" }
```

**`$switch`**：按值分支，未命中且无 `$default` 时结果 `undefined`（于是字段被丢弃）

```json
"size": { "$switch": "{{facet.resolution}}", "$cases": { "2K": "2K", "4K": "4K" } }
```

**取值路径**：`a.b.0.c`，数字段是数组下标，任一层缺失得 `undefined`（不抛错）。

**5 个函数**（写成 `{{名 参数…}}`，参数是路径或引号字面量）：

| 函数 | 作用 | 例子 |
| --- | --- | --- |
| `string` | 转字符串 | `{{string fields.seconds}}` → `"8"` |
| `number` | 转数字，失败得 undefined | `{{number fields.seed}}` |
| `concat` | 拼多个数组/单值，展平一级，丢空项 | `{{concat media.firstFrame media.lastFrame}}` |
| `join` | 用分隔符连成字符串 | `{{join ',' media.multiImage}}` |
| `default` | 第一个非空参数 | `{{default fields.neg 'none'}}` |

**模板上下文变量**：

| 名字 | 内容 |
| --- | --- |
| `baseUrl` | 用户填的 API 基地址（无尾斜杠） |
| `apiKey` | 用户填的密钥 |
| `model` | 由 facet 组合反解出的模型 ID |
| `facet.<key>` | facet 取值 |
| `fields.<key>` | 字段取值（只含当前可见字段） |
| `media.<key>` | 该素材字段的公网 URL 数组 |
| `upstreamTaskId` | 上游任务 ID（仅 poll 阶段有值） |
| `publicBaseUrl` | 本服务公网地址 |
| `pluginId` / `pluginVersion` | 插件自身信息 |

### 结构

```jsonc
{
  "apiVersion": 1,                     // 必需

  "submit": {                          // 必需
    "method": "POST",                  // 缺省 GET
    "url": "{{baseUrl}}/v1/videos",    // 必需，主机须在 permissions.hosts 内
    "timeoutMs": 90000,                // 可选
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{apiKey}}"
    },
    "body": { },                       // 仅非 GET/HEAD 发送，序列化为 JSON
    "extract": {
      "taskId": ["id", "task_id", "data.id"]   // 必需，按顺序取第一个非空值
    },
    "error": { "from": ["error.message", "error", "message"] }   // 可选
  },

  "poll": {                            // 必需
    "method": "GET",
    "url": "{{baseUrl}}/v1/videos/{{upstreamTaskId}}",   // 必需
    "timeoutMs": 15000,                // 单次查询超时，缺省 15000
    "intervalMs": 12000,               // 轮询间隔，夹取 2000-300000
    "maxTotalMs": 1800000,             // 总时长上限，夹取 60000-21600000
    "headers": { "Authorization": "Bearer {{apiKey}}" },

    "status": {                        // 必需
      "from": ["status", "state"],     // 缺省 ["status","state"]
      "lowercase": true,               // 缺省 true
      "completed": ["completed", "success", "succeeded", "done"],   // 必需
      "failed": ["failed", "fail", "error"],                        // 必需
      "queued": ["queued", "pending", "waiting"],                   // 可选
      "processing": ["processing", "running", "generating"]          // 可选
    },

    "progress": {                      // 可选；不写则界面显示不定量动画 + 已用时间
      "from": ["progress"],
      "scale": "0-100"                 // "0-100"(缺省) | "0-1"，必须显式申报，宿主不猜
    },

    "result": {                        // 必需
      "assets": [                      // 必需，至少一个
        {
          "kind": "video",             // 缺省 video
          "mime": "video/mp4",         // 可选
          "url": ["video_url", "url", "output.video_url", "data.0.url"],
          "posterUrl": ["cover_url"],  // 可选
          "durationSec": ["duration"], // 可选
          "fallbackUrl": "{{baseUrl}}/v1/videos/{{upstreamTaskId}}/content"
        }
      ],
      "rewriteHosts": { "origin.internal.example.com": "cdn.example.com" }  // 可选，默认不要用
    },

    "error": { "from": ["error.message", "message"] },   // 可选
    "fatalHttpStatus": [400, 401, 403]                  // 缺省 [400,401,403]
  }
}
```

`assets[].url` 与 `fallbackUrl` 至少要有一个。

### 关键行为（务必理解）

- **创建失败一律判死**，并立刻清理素材
- **轮询失败不判死**：只有 `fatalHttpStatus` 里的码才判死；5xx / 超时 / DNS 失败都只是本轮跳过
- **认不出的状态词按 processing 处理**并打日志（不静默、不判死）
- **completed 但取不到任何产物地址 → 判失败**
- **completed 时进度自动补成 100**
- `rewriteHosts` 只替换主机名，且**默认不要用**：替上游改产物域名是主观决定，应原样透传

---

## fixtures：离线契约用例（强烈建议写）

```
fixtures/01-basic/
  input.json              必需：{ facets, fields, media }
  expected-request.json   可选：{ model?, method?, url?, body? }  body 是全量深比较
  upstream-submit.json    可选：模拟创建响应（取 upstreamTaskId）
  upstream-poll.json      可选：模拟查询响应
  expected-result.json    可选：{ state, progress?, assets?, error? }
```

固定凭据：`baseUrl = https://upstream.test`，`apiKey = sk-fixture`。
素材 URL 必须写成 `https://host.test/api/nova/plugin-media/<名字>` 形式。

`expected-result.json` 的 `state` 只有 `queued` / `processing` / `completed` / `failed`。

运行：

```bash
cd backend && npm run plugins:verify <plugin-id>
```

建议至少覆盖 7 个用例：最简（可选字段全不出现）、带全部素材、每个特殊模式、
最弱档位、上游失败、上游排队、completed 但无 URL。

---

## 完整参考实现

`backend/plugins/ccode-h3/` 是随仓库分发的示例，覆盖了协议几乎所有特性：
2 个 facet × 8 个模型、4 种字段类型、5 个素材槽、`showIf` / `requiredIf` /
`availableWhen` / `maxCount.byFacet`、`string` / `concat` / 两处 `$switch`、
`fallbackUrl`、16 个状态词、7 个 fixtures（它有意不使用 `rewriteHosts`）。

**写新插件时先完整读一遍它。** 遇到不确定的写法，那里大概率已经有答案。

---

## 常见错误（不要犯）

| 错误 | 正确做法 |
| --- | --- |
| 用 `{{default media.x ''}}` 让字段「有就传」 | 直接写 `{{media.x}}`，空值自动丢弃 |
| 两个互斥字段都发出去 | 用 `$switch` 让其中一个在不该出现时解析为 undefined |
| 上游要字符串数字，直接传数字 | 套 `{{string fields.x}}` |
| 自己算一个进度百分比 | 不写 `progress`，让界面显示不定量动画 |
| 猜 progress 的量纲 | 显式写 `scale` |
| 把 404 加进 `fatalHttpStatus` 而上游刚创建时会返回 404 | 不要加，会杀掉正常任务 |
| 把产物 CDN 写进 `permissions.hosts` | 不需要——那张表只管插件发起的请求 |
| 顺手加上 `rewriteHosts` 改产物域名 | 默认原样透传，确认浏览器访问不到才用 |
| `permissions.hosts` 写成 `https://api.x.com/` | 只写纯主机名 `api.x.com` |
| `version` 写 `v1.0` | 严格 `x.y.z` |
| `manifest.id` 与目录名不一致 | 改成一致 |
| variants 里的 model 没在 manifest.models 申报 | 补上 |
| variants 少写某个 facet 的取值 | 每行都要有全部 facet |
| 用 `showIf` 实现「某档位不支持这类素材」 | 在 `maxCount` 映射里给 0（或省略让它落到 default 0） |
| 某档位只剩一个模式还留着下拉框 | 加 `hideWhenSingle: true` |
| fixtures 里写真实密钥 | 用固定占位凭据 |
| 只写一条 `url` 候选路径 | 把见过的形状都列上，多写没有代价 |
| 状态词只写上游文档里那几个 | 把同义拼法一起列上 |

---

## 交付前自查

- [ ] `manifest.id` = 目录名；`version` 是 `x.y.z`；三个文件都有 `"apiVersion": 1`
- [ ] `permissions.hosts` 含插件会请求的全部主机（API + 允许用户填的代理域名），且都是纯主机名
- [ ] 每个 `variants` 行有 `model` + 全部 facet 取值；每个 `model` 都在 `manifest.models` 里
- [ ] 主提示词用 `textarea`；`priceQuantityField` 指向真实存在的字段
- [ ] 用到素材时 `manifest.media` 申报了对应类别，且总量不小于各字段 `maxCount` 之和
- [ ] 上游要字符串的数字字段套了 `{{string …}}`
- [ ] 互斥字段用 `$switch`；可选字段直接写、不加 `default ''`
- [ ] `poll.status` 四类词尽量列全；`progress.scale` 与上游一致（没有进度就不写）
- [ ] `result.assets[].url` 覆盖所有已知形状，且有 `fallbackUrl` 或确认上游必给 URL
- [ ] 写了 fixtures 并且 `npm run plugins:verify <id>` 全绿
- [ ] JSON 里没有注释、没有尾随逗号、没有单引号、没有真实密钥

---

## 你不需要做、也做不到的事

宿主已经提供，不要试图在插件里实现：视频 tab 与导航、任务队列与并发控制、
轮询调度与超时判死、素材上传与落盘与 TTL 清理、上传进度与重试、历史记录、
预览与下载、链接失效探测、限流、表单渲染、价格显示、凭据存储。

插件拿不到：数据库、文件系统、`fetch`、`process`、任何 Node 模块。
v1 不支持自定义 HTML/JS、不支持沙箱脚本、不支持外部进程、不支持回调端点。
如果需求真的超出声明式协议的表达力，正确做法是向仓库提 issue 说明具体卡在哪里，
而不是把模板语言撑成半个编程语言。
