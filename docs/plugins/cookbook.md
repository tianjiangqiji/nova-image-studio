# Cookbook

常见需求的写法。每条都是从真实上游的坑里长出来的。

---

## 上游要求「数字字段传字符串」

某些 Go 服务把 `seconds` 声明成 `string`，传数字会报
`json: cannot unmarshal number into Go struct field .seconds of type string`。

```json
"seconds": "{{string fields.seconds}}"
```

反向的（表单里是字符串但上游要数字）用 `{{number fields.x}}`。

---

## 两个字段互斥

MiniMax H3 的 `size` 与 `aspect_ratio` 不能同时出现，但超分档位必须同时给。
用 `$switch` 让 `size` 只在特定档位出现：

```json
"aspect_ratio": "{{fields.aspectRatio}}",
"size": {
  "$switch": "{{facet.resolution}}",
  "$cases": { "2K": "2K", "4K": "4K" }
}
```

没命中的档位结果是 `undefined`，字段被自动丢弃。

---

## 「有就传，没有就别出现」

什么都不用写：

```json
"reference_videos": "{{media.multiVideo}}",
"reference_audios": "{{media.multiAudio}}",
"negative_prompt": "{{fields.negativePrompt}}"
```

空数组、空串、`undefined` 都会让整个 key 消失。**不要写成 `"{{default media.multiVideo ''}}"`**，
那会发一个空串上去。

---

## 上游要 `null` 表示「显式清空」

```json
"seed": { "$keep": "{{fields.seed}}" }
```

`$keep` 里的值为空时会发 `null` 而不是被丢弃。

---

## 首尾帧：两个槽拼成一个数组

```json
"images": {
  "$switch": "{{fields.mode}}",
  "$cases": {
    "first-last-frame": "{{concat media.firstFrame media.lastFrame}}",
    "multi-reference": "{{media.multiImage}}"
  }
},
"workflow_id": {
  "$switch": "{{fields.mode}}",
  "$cases": { "first-last-frame": "fl2v" }
}
```

`concat` 会丢掉空项，所以「只给首帧不给尾帧」得到的是长度 1 的数组，
不会出现 `[url, null]`。

对应的 ui.schema：

```json
{ "key": "firstFrame", "type": "media", "kind": "images", "style": "frame",
  "label": "首帧", "required": true, "showIf": { "mode": ["first-last-frame"] },
  "maxCount": { "byFacet": "tier", "values": { "standard": 1, "comic": 1 }, "default": 0 } },
{ "key": "lastFrame", "type": "media", "kind": "images", "style": "frame",
  "label": "尾帧", "hint": "可选", "showIf": { "mode": ["first-last-frame"] },
  "maxCount": { "byFacet": "tier", "values": { "standard": 1, "comic": 1 }, "default": 0 } }
```

---

## 某些档位必须带参考图

超分模型没有输入就无从超分。让参考图在这些档位变必填：

```json
{
  "key": "multiImage",
  "type": "media",
  "kind": "images",
  "label": "参考图片",
  "hint": "可选提供参考图片帮助模型理解画面风格。",
  "requiredHint": "2K / 4K 由上游超分模型生成，必须至少提供 1 张参考图片。",
  "requiredIf": { "resolution": ["2K", "4K"] },
  "maxCount": 9
}
```

`requiredHint` 会在变必填时替换 `hint`，让用户知道**为什么**现在必填。

---

## 某些档位不支持某个模式

在选项上写 `availableWhen`，不支持时置灰而不是消失——消失了用户会以为功能不存在：

```json
{
  "value": "first-last-frame",
  "label": "首尾帧 (FL2V)",
  "description": "指定首帧与尾帧，生成过渡视频",
  "availableWhen": { "tier": ["standard", "comic"] }
}
```

如果某档位下只剩一个可选模式，配 `"hideWhenSingle": true` 让整个按钮消失——
一个只有一项的下拉框没有意义。

---

## 某些档位的素材名额不一样

```json
"maxCount": { "byFacet": "tier", "values": { "standard": 9, "comic": 9, "lite": 4 }, "default": 0 }
```

`values` 里没写的档位落到 `default`。**`0` 表示这个槽在该档位直接不显示**，
所以「量化版不支持参考视频/音频」不需要额外的 `showIf`。

用户先选了 9 张图再切到量化版时，宿主会自动裁到 4 张并回收多余的预览地址。

---

## 上游返回的域名浏览器访问不到

先确认真的访问不到——**默认应该原样透传上游给的地址**，替上游改域名是个有主观判断的决定。
随仓库分发的 `ccode-h3` 就不做改写。确有必要时：

```json
"result": {
  "assets": [{ "kind": "video", "url": ["video_url"] }],
  "rewriteHosts": { "video.internal.example.com": "cdn.example.com" }
}
```

只替换主机名，路径与查询串原样保留；不在表里的域名不动。
源主机与目标主机都**不需要**写进 `permissions.hosts`——那张表只管插件自己发起的请求，
产物是浏览器直接加载的。

---

## 上游只给状态不给地址

有些上游的产物地址是可以按任务 ID 拼出来的：

```json
"assets": [{
  "kind": "video",
  "url": ["video_url", "url", "data.0.url"],
  "fallbackUrl": "{{baseUrl}}/v1/videos/{{upstreamTaskId}}/content"
}]
```

候选路径全空时才用 `fallbackUrl`。两者都没有且上游报 completed，
宿主会把任务判失败——留一条打不开的「已完成」记录更糟。

---

## 上游返回结构不稳定

把所有见过的形状都列进候选路径，按可信度排序：

```json
"url": [
  "video_url", "url", "download_url",
  "output.url", "output.video_url", "output",
  "result.url", "result.video_url", "result",
  "data.0.url", "data.0.video_url", "data.0"
]
```

只取第一个非空**字符串**，所以 `output` 是对象时会被跳过而不是变成
`"[object Object]"`。多写几条没有代价。

---

## 上游状态词五花八门

宁可多列：

```json
"status": {
  "from": ["status", "state", "task_status"],
  "completed": ["completed", "complete", "success", "succeeded", "done", "finished"],
  "failed": ["failed", "fail", "error", "cancelled", "canceled", "timeout"],
  "queued": ["queued", "queueing", "pending", "waiting", "preparing", "submitted"],
  "processing": ["processing", "in_progress", "running", "generating", "rendering"]
}
```

认不出来的词按 `processing` 处理并打一条日志。上线后翻日志把漏掉的补进来——
这是唯一能发现漏词的途径。

---

## 上游用 0–1 表示进度

```json
"progress": { "from": ["progress"], "scale": "0-1" }
```

必须显式申报。宿主不猜量纲：`progress: 1` 是 1% 还是 100% 无从分辨。

上游完全不给进度就**别写 `progress`**，界面会显示不定量动画 + 已用时间。
不要拿 `elapsed / estimated` 之类自己算一个——假进度条在任务已经失败时会让用户白等。

---

## 上游偶发 5xx 不该杀任务

默认行为已经是这样：只有 `fatalHttpStatus`（缺省 `400/401/403`）才判死。
如果某上游用 404 表示「任务不存在」（说明确实死了），把它加进去：

```json
"fatalHttpStatus": [400, 401, 403, 404]
```

反过来，如果上游会在任务刚创建的几秒内对查询返回 404，**千万别加** —— 那会杀掉正常任务。

---

## 轮询节奏

```json
"intervalMs": 12000,
"maxTotalMs": 1800000
```

视频生成通常几分钟起，10–30 秒一次足够。设得太密只会更快撞上游限流。
`maxTotalMs` 要留足余量：超时会判失败并释放并发名额，但用户的钱可能已经花了。

---

## 请求头里放插件标识

```json
"headers": {
  "Authorization": "Bearer {{apiKey}}",
  "User-Agent": "nova-image-plugin/{{pluginId}}@{{pluginVersion}}"
}
```

---

## 需要上游回调本服务

```json
"body": {
  "callback_url": "{{publicBaseUrl}}/api/nova/plugin-tasks/callback"
}
```

**但 v1 没有回调端点**——宿主只做轮询。列在这里是因为 `publicBaseUrl` 这个上下文变量
确实存在（素材地址就是用它拼的），别误以为写了回调就能用。

---

## 只有一个模型、没有维度可分

facet 表仍然要写，给一个单值 facet 就行：

```json
"facets": [{ "key": "quality", "label": "画质", "hideWhenSingle": true }],
"facetOptions": { "quality": [{ "value": "standard", "label": "标准" }] },
"variants": [{ "model": "only-model", "quality": "standard" }]
```

`hideWhenSingle` 让这个按钮不显示，界面上就只剩模型名。

---

## 临时停用一个插件

把目录改名成 `_my-plugin`。以 `.` 或 `_` 开头的目录会被跳过，
既不加载也不报错，随时改回来。
