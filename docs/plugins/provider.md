# provider.json 参考

上游请求的模板、轮询规则、结果与错误的取值路径。

模板语言刻意保持贫瘠：只有 `{{ }}` 插值、5 个函数和一个 `$switch`。
如果你发现需要在 JSON 里写循环或复杂判断，那说明协议缺一档能力，
正确做法是提 issue，而不是把这里撑成半个残废的编程语言。

---

## 顶层结构

```json
{
  "apiVersion": 1,
  "submit": { ... },
  "poll": { ... }
}
```

---

## 模板语法

### 插值

```json
"url": "{{baseUrl}}/v1/videos/{{upstreamTaskId}}"
```

**整个字符串就是一个 `{{}}` 时保留原始类型**，其余情况拼成字符串：

```json
"seconds": "{{fields.seconds}}"          → 8           （数字）
"images":  "{{media.multiImage}}"        → ["https://…"]（数组）
"note":    "时长 {{fields.seconds}} 秒"   → "时长 8 秒"   （字符串）
```

拼接时空值渲染成空串，不会出现 `undefined`。

### 空值自动丢弃

对象里任何解析为 `undefined` / `null` / `""` / `[]` 的字段**会被整个删掉**。

这条规则消灭了绝大多数条件：

```json
"reference_videos": "{{media.multiVideo}}"
```

用户没传参考视频时，`reference_videos` 这个 key 根本不会出现在请求体里，
不需要写任何 `$switch`。

要强制保留（上游用 `null` 表达「清空」之类），用 `$keep`：

```json
"seed": { "$keep": "{{fields.seed}}" }
```

`0` 和 `false` **不算空值**，会照常发出去。

### 取值路径

`a.b.0.c` 形式，数字段表示数组下标。任一层缺失得到 `undefined`，不会抛错。

### 模板上下文

| 名字 | 内容 |
| --- | --- |
| `baseUrl` | 用户填的 API 基地址（已去掉末尾斜杠） |
| `apiKey` | 用户填的密钥 |
| `model` | 由 facet 组合反解出的模型 ID |
| `facet.<key>` | facet 取值 |
| `fields.<key>` | 字段取值（只含当前可见字段） |
| `media.<key>` | 该素材字段已上传素材的公网 URL 数组 |
| `upstreamTaskId` | 上游任务 ID（仅 `poll` 阶段有值） |
| `publicBaseUrl` | 本服务的公网地址，需要回调时用 |
| `pluginId` / `pluginVersion` | 插件自身信息，可用于 User-Agent |

### 函数

写成 `{{函数名 参数1 参数2}}`。参数是取值路径，或单/双引号包裹的字面量。

| 函数 | 说明 | 例子 |
| --- | --- | --- |
| `string` | 转字符串。上游要求「数字字段传字符串」时用。 | `{{string fields.seconds}}` → `"8"` |
| `number` | 转数字，转不出来得到 `undefined`（于是字段被丢弃）。 | `{{number fields.seed}}` |
| `concat` | 拼接多个数组/单值，展平一级，丢掉空项。 | `{{concat media.firstFrame media.lastFrame}}` |
| `join` | 用分隔符连成字符串。 | `{{join ',' media.multiImage}}` |
| `default` | 第一个非空参数。 | `{{default fields.negative 'none'}}` |

### $switch

按某个值分支。没命中且没写 `$default` 时结果为 `undefined`，于是字段被丢弃。

```json
"size": {
  "$switch": "{{facet.resolution}}",
  "$cases": { "2K": "2K", "4K": "4K" }
}
```

上例的效果：只有 2K/4K 档位才发 `size` 字段，其它档位这个 key 不出现——
正是 MiniMax H3「`size` 与 `aspect_ratio` 互斥」的要求。

`$cases` 的值可以是任意模板，包括嵌套的 `{{}}`：

```json
"images": {
  "$switch": "{{fields.mode}}",
  "$cases": {
    "first-last-frame": "{{concat media.firstFrame media.lastFrame}}",
    "multi-reference": "{{media.multiImage}}"
  }
}
```

---

## submit

```json
"submit": {
  "method": "POST",
  "url": "{{baseUrl}}/v1/videos",
  "timeoutMs": 90000,
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer {{apiKey}}"
  },
  "body": { ... },
  "extract": { "taskId": ["id", "task_id", "data.id"] },
  "error": { "from": ["error.message", "error", "message"] }
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `method` | | 缺省 `GET`，创建任务基本都是 `POST`。 |
| `url` | ✅ | 解析后的主机必须在 `permissions.hosts` 里。 |
| `timeoutMs` | | 缺省取 `manifest.runtime.submitTimeoutMs`，再缺省 90 秒。 |
| `headers` | | 值会被转成字符串。没写 `Content-Type` 且有 body 时自动补 `application/json`。 |
| `body` | | 仅非 GET/HEAD 时发送，序列化为 JSON。 |
| `extract.taskId` | ✅ | 上游任务 ID 的候选路径，按顺序取第一个非空值。 |
| `error.from` | | 错误文案的候选路径。 |

创建失败一律判死（不重试）：`extract.taskId` 取不到值时任务直接标失败并提示
「上游未返回任务 ID」——继续轮询一个不存在的 ID 没有意义。

如果上游在创建时就直接返回成品（状态命中 `poll.status.completed` 且能取到产物），
宿主会跳过轮询直接完成。

---

## poll

```json
"poll": {
  "method": "GET",
  "url": "{{baseUrl}}/v1/videos/{{upstreamTaskId}}",
  "timeoutMs": 15000,
  "intervalMs": 12000,
  "maxTotalMs": 1800000,
  "headers": { "Authorization": "Bearer {{apiKey}}" },
  "status": { ... },
  "progress": { ... },
  "result": { ... },
  "error": { "from": ["error.message", "message"] },
  "fatalHttpStatus": [400, 401, 403]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `url` | ✅ | |
| `timeoutMs` | | 单次查询超时，缺省 15 秒。 |
| `intervalMs` | | 轮询间隔，夹取到 2 秒–5 分钟。10–30 秒是常见区间。 |
| `maxTotalMs` | | 总时长上限，超过判失败。夹取到 1 分钟–6 小时。 |
| `status` | ✅ | 见下。 |
| `progress` | | 不写就没有百分比，界面显示已用时间。 |
| `result` | ✅ | 见下。 |
| `error.from` | | |
| `fatalHttpStatus` | | 哪些 HTTP 状态码判死，缺省 `[400, 401, 403]`。 |

**非致命的失败不判死**：5xx、网络抖动、超时都只是本轮跳过，等下一轮。
只有 `fatalHttpStatus` 里的码才认定任务已经死了。这一点很重要——
上游 502 一次就把用户的任务杀掉是最容易被投诉的行为。

### status

把上游五花八门的状态词归一化成四种。

```json
"status": {
  "from": ["status", "state"],
  "lowercase": true,
  "completed": ["completed", "success", "succeeded", "done"],
  "failed": ["failed", "fail", "error"],
  "queued": ["queued", "pending", "queueing", "preparing", "waiting"],
  "processing": ["processing", "in_progress", "running", "generating"]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `from` | | 状态字段的候选路径，缺省 `["status", "state"]`。 |
| `lowercase` | | 缺省 `true`（先转小写再比对）。设 `false` 才区分大小写。 |
| `completed` | ✅ | |
| `failed` | ✅ | |
| `queued` | | 上游自己排队时的状态词。 |
| `processing` | | |

**认不出来的状态按 `processing` 处理**，同时在服务器日志里打一条 warn 带上原文。
这是有意的：静默当成生成中会让「排队」显示成「正在渲染」，而判死可能杀掉一个正常任务。
那条日志就是你补词表的唯一线索——上线后翻一遍日志把漏掉的词加进去。

`queued` 与 `processing` 都会显示成进行中，但界面上分别是「上游排队中」和「生成中」。

### progress

```json
"progress": { "from": ["progress"], "scale": "0-100" }
```

`scale` 只有 `0-100`（缺省）与 `0-1`。

**必须显式申报量纲，宿主不猜。** `progress: 1` 到底是 1% 还是 100% 无从分辨，
猜错比不显示更糟。字段缺失或不是有限数时不显示百分比，界面改用不定量动画 + 已用时间。

上游在完成那一帧仍返回 `progress < 100` 时宿主会补成 100——
进度条停在 97% 却已出片会让用户以为卡住了。

### result

```json
"result": {
  "assets": [
    {
      "kind": "video",
      "mime": "video/mp4",
      "url": ["video_url", "url", "output.video_url", "data.0.url"],
      "posterUrl": ["cover_url", "thumbnail_url"],
      "durationSec": ["duration", "seconds"],
      "fallbackUrl": "https://cdn.example.com/v1/videos/{{upstreamTaskId}}/content"
    }
  ],
  "rewriteHosts": { "video.internal.example.com": "cdn.example.com" }
}
```

| 字段 | 说明 |
| --- | --- |
| `assets[].kind` | 缺省 `video`。 |
| `assets[].mime` | 可选，存进历史记录。 |
| `assets[].url` | 候选路径，按顺序取第一个非空**字符串**。 |
| `assets[].posterUrl` | 封面图，可选。 |
| `assets[].durationSec` | 时长，可选。 |
| `assets[].fallbackUrl` | 所有候选路径都取不到时用这个模板拼一个地址。 |
| `rewriteHosts` | 主机名替换表。只改命中的主机，其它域名原样保留。 |

`url` 与 `fallbackUrl` 至少要有一个，否则加载失败。

**上游报告完成但一个产物地址都取不到时，宿主把任务判失败**并提示
「上游报告完成但没有返回可用的产物地址」。留一条 completed 但打不开的记录更糟。

`rewriteHosts` 的用途是上游返回内部/回源域名、浏览器访问不到，需要换成对外 CDN。
**只在确有必要时才用**——替上游改产物域名是个有主观判断的决定，默认应该原样透传。
随仓库分发的 `ccode-h3` 就刻意不使用它。

---

## 完整示例

`backend/plugins/ccode-h3/provider.json`。它用到了 `string`、`concat`、两处 `$switch`、
`fallbackUrl`，以及一份 16 个词的状态表；`rewriteHosts` 有意没用（产物地址原样透传）。
