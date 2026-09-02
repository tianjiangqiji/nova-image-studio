# ui.schema.json 参考

表单的描述。你不写任何前端代码——宿主用自己的 shadcn 组件渲染，所以插件的界面
天然与生图工作台一致，也天然获得暗色主题、移动端适配和 PWA。

代价是控件类型有限。这是有意的：能力上限之内的表单能做到零维护，
上限之外的需求应该推动协议加一档能力，而不是让每个插件各写一套 UI。

---

## 顶层结构

```json
{
  "apiVersion": 1,
  "priceQuantityField": "seconds",
  "layout": { "toolbar": [...], "body": [...] },
  "modelSelector": { ... },
  "fields": [ ... ]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `apiVersion` | ✅ | `1` |
| `priceQuantityField` | | 按秒计费时数量取哪个字段。不写则 `per-second` 的价格算不出来，界面上不显示价格。 |
| `layout.toolbar` | | 工具栏里从左到右放什么。`$model` 是模型选择器，`$<facetKey>` 是某个 facet 的小按钮，其余是字段 key。 |
| `layout.body` | | 主体区从上到下放什么（素材槽与文本字段）。 |
| `modelSelector` | ✅ | 见下。 |
| `fields` | ✅ | 至少一个。 |

`layout` 不写时宿主按「模型 + 后续 facet + 所有 select 字段」进工具栏、
「素材 + 文本字段」进主体区，顺序按 `fields` 的申报顺序。

---

## modelSelector：用一张表描述模型矩阵

这是整个 schema 里最重要的部分。思路是：**不写规则，写事实。**

上游往往有一堆模型 ID，它们其实是几个维度的组合（档位 × 分辨率）。
你把每个真实存在的组合列成一行 `variant`，宿主就能：

- 反解出该提交哪个模型 ID
- 算出「选了漫画版之后分辨率里该有哪些选项」
- 在切换档位后把分辨率收敛到仍然存在的值

```json
"modelSelector": {
  "label": "模型与档位",
  "familyLabel": "MiniMax H3",
  "familyDescription": "按秒计费 · 4–15 秒 · 768P 至 4K",
  "facets": [
    { "key": "tier", "label": "档位", "icon": "sparkles" },
    { "key": "resolution", "label": "分辨率", "icon": "maximize", "hideWhenSingle": true }
  ],
  "facetOptions": {
    "tier": [
      { "value": "standard", "label": "Standard", "fullLabel": "原版", "description": "全功能" },
      { "value": "lite", "label": "Lite", "fullLabel": "量化版", "description": "高性价比" }
    ],
    "resolution": [
      { "value": "768P", "label": "768P" },
      { "value": "1080P", "label": "1080P" }
    ]
  },
  "variants": [
    { "model": "h3-standard-768p",  "tier": "standard", "resolution": "768P" },
    { "model": "h3-standard-1080p", "tier": "standard", "resolution": "1080P" },
    { "model": "h3-lite-768p",      "tier": "lite",     "resolution": "768P" }
  ]
}
```

上例中 Lite 没有 1080P，于是选中 Lite 后分辨率按钮只有一个选项，
配合 `hideWhenSingle` 直接不显示——这些都不需要你写任何条件。

### facets

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `key` | ✅ | 在 `variants` 与条件表达式里引用的名字，不能与字段 key 同名。 |
| `label` | ✅ | |
| `icon` | | 见下方图标表。 |
| `hideWhenSingle` | | 只剩一个可选值时不显示这个按钮。 |

**facet 的申报顺序 = 选择的先后顺序。** 第一个 facet 是一级选择（通常是「档位」），
它总是展示全部申报值；后续 facet 的可选值受前面已定的 facet 约束，反之不然。
这样「当前是 1080P」不会导致「漫画版」这个档位变得点不进去。

### facetOptions

每个 facet 一个数组，顺序即界面顺序。

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `value` | ✅ | 字符串或数字。 |
| `label` | ✅ | 短标签，工具栏按钮上显示。 |
| `fullLabel` | | 展开列表里的完整名，缺省用 `label`。 |
| `description` | | 一级 facet 的列表里会显示这一行说明。 |

### variants

每行必须有 `model`（要在 `manifest.models` 里申报过），以及**每个 facet 的取值**。
少写一个 facet 会加载失败并指出是第几行。

---

## fields

```json
{ "key": "seconds", "type": "select-grid", "label": "视频时长", ... }
```

### 公共字段

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `key` | 全部 | 唯一，不能与 facet 同名。提交时作为 `fields.<key>` 出现在模板上下文里。 |
| `type` | 全部 | `textarea` / `text` / `select` / `select-grid` / `media` / `switch` |
| `label` | 全部 | |
| `icon` | 全部 | |
| `required` | 全部 | 无条件必填。 |
| `requiredIf` | 全部 | 条件必填，见下。 |
| `showIf` | 全部 | 条件显示。不可见的字段不校验、不提交。 |
| `hideWhenSingle` | select 类 | 只剩一个可选项时不显示。 |
| `default` | 非 media | 缺省值。select 类不写则取第一个可用选项。 |

### 条件：showIf / requiredIf / availableWhen

三者同一套语法：

```json
"showIf": { "mode": ["first-last-frame"] }
"requiredIf": { "resolution": ["2K", "4K"] }
"availableWhen": { "tier": ["standard", "comic"] }
```

**键之间是「且」，键内的数组是「或」。** 比较按字符串进行，所以 `[4]` 能命中 `"4"`。

作用域是 **facet 取值与字段取值合在一起**，所以条件里既能引用 `tier`（facet）
也能引用 `mode`（字段）。

### select / select-grid

`select` 是一列带说明的选项，`select-grid` 是紧凑的方格（时长、比例这类）。

| 字段 | 说明 |
| --- | --- |
| `options[].value` | 字符串或数字。 |
| `options[].label` | |
| `options[].description` | `select` 会显示，`select-grid` 作为 tooltip。 |
| `options[].availableWhen` | 该选项在什么组合下才可选。不可选时置灰并给出说明。 |
| `columns` | 仅 `select-grid`，方格列数，缺省 3。 |
| `suffix` | 工具栏按钮上追加的单位，如 `"秒"`。展开的方格里只显示 `label`，所以 `label` 应当只写数值（`"5"` 而不是 `"5s"`），否则按钮上会出现「5s秒」这样的两个单位。 |

某个组合下当前取值变得不可选时，宿主会自动落到第一个可选项——
不这么做，切到量化版后「首尾帧」会留在表单里，直到提交才被后端拒绝。

### textarea / text

| 字段 | 说明 |
| --- | --- |
| `maxLength` | 超长会被截断，且提交前校验。 |
| `rows` | 缺省 9（textarea）。 |
| `placeholder` | |
| `presets` | 一排短语按钮，点一下追加到内容末尾（用 `，` 连接）。 |

**第一个 `textarea` 字段被当作主提示词**：它进历史记录的正文与搜索，宽屏下会吃掉
剩余高度。所以主提示词要用 `textarea`，附加说明之类的用 `text`。

### media

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `kind` | ✅ | `images` / `videos` / `audios` |
| `maxCount` | ✅ | 整数，或按 facet 取值的映射（见下）。 |
| `style` | | `thumbnail`（方形缩略图，缺省）/ `frame`（宽画幅，首尾帧用）/ `chip`（文件名胶囊，视频音频用） |
| `hint` | | 区域下方的说明文字。 |
| `requiredHint` | | 该字段变必填时替换 `hint`，用来解释「为什么现在必填」。 |
| `accent` | | `blue` / `emerald` / `amber` / `primary`，给 chip 样式配色。 |

`maxCount` 随档位变化时写成映射：

```json
"maxCount": { "byFacet": "tier", "values": { "standard": 9, "comic": 9, "lite": 4 }, "default": 0 }
```

`byFacet` 必须是已申报的 facet。当前取值不在 `values` 里就用 `default`（不写则 0）。

**`maxCount` 为 0 的素材槽直接不显示。** 所以「量化版不支持参考视频」不需要写 `showIf`，
把 `values` 里那个档位留空即可。

素材上传后宿主给你的是**本机公网 URL 的有序数组**，在模板里通过 `media.<key>` 取。
外部 URL 一律不被接受——素材必须经过宿主，否则任务删除时无从清理。

### switch

布尔开关。提交时始终出现（`true` / `false`），不会因为是 `false` 就被丢弃。

---

## 图标名

`icon` 可用：`sparkles`、`layers`、`maximize`、`ratio`、`clock`、`clapperboard`。
写别的名字不会报错，会回落到一个通用齿轮图标——协议不该因为一个装饰性字段而拒绝加载。

---

## 一个完整例子

见 `backend/plugins/ccode-h3/ui.schema.json`：两个 facet、四种字段类型、
五个素材槽、`showIf` / `requiredIf` / `availableWhen` / `maxCount.byFacet` 全都用到了。
