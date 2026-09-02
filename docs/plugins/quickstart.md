# 快速上手：10 分钟做一个视频插件

假设你要接一个虚构的上游 `api.example.com`，它的接口长这样：

```http
POST /v1/generate            创建任务，返回 { "task_id": "abc" }
  { "model": "...", "prompt": "...", "duration": 5, "ratio": "16:9" }

GET  /v1/generate/{task_id}  查询，返回 { "state": "running", "percent": 42 }
                             完成时     { "state": "done", "result": { "mp4": "https://..." } }
```

---

## 1. 建目录

```
backend/plugins/example-video/
```

目录名就是插件 ID，只能用小写字母、数字和短横线。

## 2. manifest.json

```json
{
  "apiVersion": 1,
  "id": "example-video",
  "name": "Example 视频",
  "version": "1.0.0",
  "kind": "video",
  "description": "示例上游的文生视频",
  "credential": {
    "source": "client",
    "label": "Example API Key",
    "defaultBaseUrl": "https://api.example.com"
  },
  "permissions": {
    "hosts": ["api.example.com"]
  },
  "models": [
    {
      "id": "example-v1",
      "name": "Example V1",
      "shortName": "V1",
      "price": { "unit": "per-second", "amount": 0.1, "currency": "CNY" }
    }
  ]
}
```

`permissions.hosts` 只需要**插件自己会去请求的主机**（创建与查询用的 API 域名）。
产物地址由浏览器直接加载，不必写进来。

## 3. ui.schema.json

最小可用表单：一个模型选择 + 时长 + 比例 + 提示词。

```json
{
  "apiVersion": 1,
  "priceQuantityField": "duration",
  "layout": {
    "toolbar": ["$model", "duration", "ratio"],
    "body": ["prompt"]
  },
  "modelSelector": {
    "familyLabel": "Example",
    "facets": [{ "key": "quality", "label": "画质", "icon": "sparkles" }],
    "facetOptions": {
      "quality": [{ "value": "standard", "label": "标准", "description": "默认画质" }]
    },
    "variants": [{ "model": "example-v1", "quality": "standard" }]
  },
  "fields": [
    {
      "key": "duration",
      "type": "select-grid",
      "label": "时长",
      "icon": "clock",
      "columns": 3,
      "default": 5,
      "options": [{ "value": 5, "label": "5s" }, { "value": 10, "label": "10s" }]
    },
    {
      "key": "ratio",
      "type": "select",
      "label": "画面比例",
      "icon": "ratio",
      "default": "16:9",
      "options": [{ "value": "16:9", "label": "16:9" }, { "value": "9:16", "label": "9:16" }]
    },
    {
      "key": "prompt",
      "type": "textarea",
      "label": "提示词",
      "icon": "clapperboard",
      "required": true,
      "maxLength": 2000,
      "placeholder": "描述你想生成的画面…"
    }
  ]
}
```

即使只有一个模型，`modelSelector` 也必须写：facet + variants 那张表是宿主
反解模型 ID 的唯一依据。

## 4. provider.json

```json
{
  "apiVersion": 1,
  "submit": {
    "method": "POST",
    "url": "{{baseUrl}}/v1/generate",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{apiKey}}"
    },
    "body": {
      "model": "{{model}}",
      "prompt": "{{fields.prompt}}",
      "duration": "{{fields.duration}}",
      "ratio": "{{fields.ratio}}"
    },
    "extract": { "taskId": ["task_id", "id"] }
  },
  "poll": {
    "method": "GET",
    "url": "{{baseUrl}}/v1/generate/{{upstreamTaskId}}",
    "headers": { "Authorization": "Bearer {{apiKey}}" },
    "intervalMs": 10000,
    "maxTotalMs": 1800000,
    "status": {
      "from": ["state"],
      "completed": ["done"],
      "failed": ["error", "failed"],
      "queued": ["queued", "pending"],
      "processing": ["running"]
    },
    "progress": { "from": ["percent"], "scale": "0-100" },
    "result": {
      "assets": [{ "kind": "video", "mime": "video/mp4", "url": ["result.mp4"] }]
    },
    "error": { "from": ["message", "error"] }
  }
}
```

## 5. 装上去

重启后端。终端会打印：

```
[plugin-registry] 已加载插件 example-video@1.0.0（1 个模型）
```

写错了也不会让服务起不来，而是打印具体是哪个字段的问题，并在「设置 → 插件」里
显示同一条原因。

## 6. 填凭据并试跑

打开界面 → 设置 → 插件 → 在「Example API Key」里填 key → 回到「视频工作台」→
输入提示词 → 开始生成。

---

## 接下来通常要加什么

| 需求 | 去看 |
| --- | --- |
| 参考图 / 视频 / 音频上传 | [ui-schema.md](ui-schema.md) 的 `media` 字段 |
| 某些档位不支持某些模式 | `availableWhen` / `showIf` |
| 某些档位的名额不一样 | `maxCount.byFacet` |
| 上游要求某个字段是字符串数字 | `{{string fields.x}}`（[provider.md](provider.md)） |
| 某个字段只在特定组合下才传 | `$switch`，或者干脆什么都不写——空值会自动丢弃 |
| 上游返回内部域名要换成 CDN | `result.rewriteHosts` |
| 不联网验证请求体 | [testing.md](testing.md) |
