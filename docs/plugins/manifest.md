# manifest.json 参考

插件的身份、能力与权限。每个字段的校验规则都写在
`backend/plugin-runtime/validate.js` 的 `validateManifest` 里，报错会指出具体字段名。

---

## 顶层字段

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `apiVersion` | `1` | ✅ | 目前只接受 `1`。不匹配的插件不会被加载。 |
| `id` | string | ✅ | 小写字母、数字、短横线，2–64 字符，**必须与目录名一致**。 |
| `name` | string | ✅ | 界面上显示的名字。 |
| `version` | string | ✅ | 语义化版本，如 `1.0.0`。历史记录会记下提交时的版本。 |
| `kind` | `"video"` | ✅ | v1 只支持 `video`。 |
| `mode` | `"declarative"` | | 缺省即声明式。目前只接受这个值。 |
| `description` | string | | 一句话说明，显示在设置页与插件切换按钮的 tooltip 上。 |
| `author` | string | | |
| `homepage` | string | | 设置页会渲染成「主页」链接。 |
| `outputs` | string[] | | 产物类型，缺省 `["video"]`。 |
| `credential` | object | ✅ | 见下。 |
| `permissions` | object | ✅ | 见下。 |
| `media` | object | | 素材配额，用到参考素材时必填。 |
| `runtime` | object | | 超时与轮询节奏的缺省值。 |
| `models` | object[] | ✅ | 至少一个。 |

---

## credential

用户在「设置 → 插件」里填，存浏览器 localStorage，提交任务时随请求转发，
只在发上游请求那一瞬间替换进模板。**不入库、不进日志、不出现在任何返回体里。**

```json
"credential": {
  "source": "client",
  "label": "Ccode API Key",
  "defaultBaseUrl": "https://pro.ccode.vip",
  "helpUrl": "https://pro.ccode.vip"
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `source` | ✅ | v1 只支持 `"client"`。 |
| `label` | ✅ | 密钥输入框的标签。写清楚是哪家的 key，用户可能装了好几个插件。 |
| `defaultBaseUrl` | | 用户没填时用它，也作为输入框的 placeholder。 |
| `helpUrl` | | 去哪申请密钥。 |

用户可以改 baseUrl（自建代理、区域端点），但改成的主机仍然要落在
`permissions.hosts` 里，否则提交那一刻就会被拒绝。

---

## permissions

```json
"permissions": {
  "hosts": ["pro.ccode.vip"]
}
```

`hosts` 是**出网白名单**，至少一项。它管的是**插件自己发起的请求**——也就是
`provider.submit.url` 与 `provider.poll.url` 解析出来的主机（通常就是 `baseUrl` 的主机，
以及用户可能改成的自建代理域名）。宿主在每次请求前检查：

- 主机不在表内 → 拒绝
- 协议不是 http/https → 拒绝
- 主机是环回或私有网段（`localhost`、`127.*`、`10.*`、`172.16-31.*`、`192.168.*`、
  `169.254.*`、`::1`、`0.0.0.0`）→ 拒绝

**产物地址不需要写进来**：视频由用户的浏览器直接加载，不经过服务端，也不经过这张表。
需要写进来的是：API 主机、以及你允许用户填进 baseUrl 的其它域名（区域端点、自建代理）。

---

## media

申报这个插件会用到哪几类参考素材，以及每类的总数上限。
**不申报的类别，上传端点会直接拒绝**——这是为了让「插件只声明图片」这件事
在服务端也成立，而不只是表单上不显示。

```json
"media": {
  "images": { "maxCount": 9 },
  "videos": { "maxCount": 3 },
  "audios": { "maxCount": 3 }
}
```

类别只有 `images` / `videos` / `audios`。`maxCount` 是该类**跨所有素材字段的总量上限**；
单个字段的名额在 ui.schema 的 `maxCount` 里另写，两处都会被校验。

格式与单文件体积上限由**部署方**通过环境变量控制（`NOVA_MEDIA_MAX_IMAGE_BYTES` 等），
插件管不着，也不该管——那属于服务器容量而不是协议。

---

## runtime

```json
"runtime": {
  "submitTimeoutMs": 90000,
  "pollIntervalMs": 12000,
  "maxPollMs": 1800000
}
```

| 字段 | 缺省 | 夹取范围 |
| --- | --- | --- |
| `submitTimeoutMs` | 90 000 | — |
| `pollIntervalMs` | 12 000 | 2 000 – 300 000 |
| `maxPollMs` | 1 800 000 | 60 000 – 21 600 000 |

`provider.poll` 里的 `intervalMs` / `maxTotalMs` 优先级更高。超过 `maxPollMs` 仍未出终态
的任务会被判失败并释放并发名额——不这么做，一个卡死的上游任务会永久占住一个名额。

---

## models

```json
"models": [
  {
    "id": "minimax-h3-original-768p",
    "name": "MiniMax H3 原版 768P",
    "shortName": "H3 原版 768P",
    "description": "文生视频，可使用参考素材",
    "price": { "unit": "per-second", "amount": 0.15, "currency": "CNY" }
  }
]
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 提交给上游的模型标识，不可重复。 |
| `name` | ✅ | 完整名称。 |
| `shortName` | | 历史卡片等窄处使用，缺省用 `name`。 |
| `description` | | |
| `price` | | 不写则界面上不显示任何价格标签（不会显示 ¥0.00）。 |

`price.unit` 只有两种：

- `per-second`：总价 = `amount` × `ui.schema.priceQuantityField` 指定字段的值
- `per-call`：总价 = `amount`

`price.currency` 目前认识 `CNY` / `USD` / `EUR`，其它值原样当前缀显示。

**申报价是给用户一个量级参考，不是账单。** 开源版不代理任何上游价格接口，
所以这里写死的数字过期了也没人替你更新——描述里最好说明「以上游实际计费为准」。

`ui.schema.modelSelector.variants` 里出现的每个 `model` 都必须在这里申报过，
否则加载失败并指出是哪一行。
