# Ccode H3 视频插件

MiniMax H3 系列视频生成，作为 Nova Studio 视频插件协议的参考实现随仓库分发。

## 能力

| 档位 | 可用分辨率 | 生成模式 | 参考素材上限 |
| --- | --- | --- | --- |
| 原版 Standard | 768P / 1080P / 2K / 4K | 全能参考、首尾帧 | 图 9 · 视频 3 · 音频 3 |
| 漫画版 Comic | 768P / 2K / 4K | 全能参考、首尾帧 | 图 9 · 视频 3 · 音频 3 |
| 量化版 Lite | 768P | 全能参考 | 图 4 |

- 时长 4–15 秒，按秒计费
- 2K / 4K 走上游的 `-cf-` 超分模型，**必须提供至少 1 张参考图片**
- 首尾帧模式提交 `workflow_id=fl2v`，首帧必填、尾帧可选

## 使用

1. 管理员把本目录放进 `backend/plugins/`
2. 重启后端（或在「设置 → 插件」点「重新读取」）
3. 用户在「设置 → 插件」里填入 Ccode API Key
4. 在「视频工作台」提交任务

## 需要访问的主机

- `pro.ccode.vip` — 创建与查询任务

产物地址直接用上游返回的原生 URL，**不做任何域名改写**。这是与商业版的一处有意差异：
商业版会把回源域名换成自家 CDN，开源插件不替上游做这种决定。
`permissions.hosts` 只需要 API 主机——白名单管的是插件的出网请求，
产物是浏览器直接加载的，不经过它。

## 价格

`manifest.json` 里的 `price` 是**申报值**，用于界面上的预估显示，
实际计费以上游为准。上游调价后需要更新本文件里的数字。

## 这个插件用到了协议的哪些特性

作为示例，它有意覆盖了大部分协议能力：

| 特性 | 用在哪 |
| --- | --- |
| 两个 facet + variants 表 | 档位 × 分辨率 → 8 个模型 ID |
| `hideWhenSingle` | 量化版只有 768P，分辨率按钮消失 |
| `availableWhen` | 量化版不支持首尾帧 |
| `showIf` | 素材槽随生成模式切换 |
| `requiredIf` + `requiredHint` | 2K/4K 时参考图变必填并解释原因 |
| `maxCount.byFacet` | 量化版参考图收紧到 4 张、视频音频归零 |
| 三种素材呈现 | `frame`（首尾帧）/ `thumbnail`（参考图）/ `chip`（视频音频） |
| `{{string …}}` | 上游要求 `seconds` 是字符串 |
| `$switch` | `size` 与 `aspect_ratio` 互斥；`workflow_id` 只在首尾帧出现 |
| `{{concat …}}` | 首帧 + 尾帧拼成一个 `images` 数组 |
| 空值自动丢弃 | `reference_videos` / `reference_audios` 有就传 |
| `fallbackUrl` | 上游只给状态不给地址时按任务 ID 拼 |
| `fixtures/` | 7 个离线契约用例 |

协议里的 `rewriteHosts` 本插件**不使用**（见上文）。用法参考 `docs/plugins/cookbook.md`。

## 自检

```bash
cd backend && npm run plugins:verify ccode-h3
```

## 已知的上游怪癖

这些都写进了 `provider.json`，列出来供其他插件作者参考：

- `seconds` 必须是字符串，传数字会报
  `json: cannot unmarshal number into Go struct field .Alias.seconds of type string`
- `size` 与 `aspect_ratio`、`megapixels`、`pixels` 互斥；但 `-cf-` 超分模型必须同时给
  `size`（`2K`/`4K`）与 `aspect_ratio`
- 偶尔在 `completed` 那一帧仍返回 `progress < 100`（宿主会补成 100）
- 产物直链只保留数小时，界面会在用户点预览/下载时探活
