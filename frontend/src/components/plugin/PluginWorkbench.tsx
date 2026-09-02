'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, PackageOpen, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SchemaToolbar, SchemaIcon } from '@/components/plugin/SchemaToolbar';
import { SchemaMediaField } from '@/components/plugin/SchemaMediaField';
import { PluginTotalPrice } from '@/components/plugin/PluginPriceTag';
import { PluginEmptyState } from '@/components/plugin/PluginEmptyState';
import { PluginPicker } from '@/components/plugin/PluginPicker';
import {
  getPluginCredential,
  getCredentialVersion,
  getLastUsedPluginId,
  getPluginRegistryServerSnapshot,
  getPluginRegistrySnapshot,
  loadPluginRegistry,
  setLastUsedPluginId,
  subscribePluginCredentials,
  subscribePluginRegistry,
} from '@/lib/plugin-registry-client';
import {
  buildScope,
  bodyEntries,
  checkSubmittable,
  coerceFacets,
  coerceFieldValues,
  defaultFacets,
  defaultFieldValues,
  estimateCost,
  facetsFromModel,
  findField,
  findModel,
  isFieldVisible,
  resolveModel,
  resolvedMediaFields,
  summarizeSchemaParams,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
  type MediaKind,
  type PluginField,
} from '@/lib/plugin-schema';
import { describeRejections, getMediaConfig, selectFiles } from '@/lib/plugin-media-config';
import { compressImageToWebp } from '@/lib/image-compress';
import { startPluginJob, type PendingMedia } from '@/lib/plugin-upload-runner';
import type { PluginJob, PluginParamChip } from '@/lib/plugin-job-store';

interface PluginWorkbenchProps {
  wideMode?: boolean;
  onConfigureCredential?: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  initialJob?: PluginJob | null;
}

/** 截断到上限，并回收被丢弃项的本地预览地址（切档位会缩小名额） */
function truncatePending(items: PendingMedia[], max: number): PendingMedia[] {
  if (items.length <= max) return items;
  for (const dropped of items.slice(max)) URL.revokeObjectURL(dropped.previewUrl);
  return items.slice(0, max);
}

/** 提交时冻结一份「标签 + 取值」快照，插件卸载后历史记录依然可读 */
function buildParamSummary(
  plugin: InstalledPlugin,
  facets: FacetValues,
  fields: FieldValues,
): PluginParamChip[] {
  return summarizeSchemaParams(plugin, facets, fields);
}

/** 主提示词字段：第一个 textarea。用于历史卡片的正文与搜索。 */
function findPromptField(plugin: InstalledPlugin): PluginField | undefined {
  return plugin.uiSchema.fields.find(field => field.type === 'textarea');
}

export function PluginWorkbench({
  wideMode = false,
  onConfigureCredential,
  showToast,
  initialJob,
}: PluginWorkbenchProps) {
  const registry = useSyncExternalStore(
    subscribePluginRegistry,
    getPluginRegistrySnapshot,
    getPluginRegistryServerSnapshot,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadPluginRegistry().finally(() => setLoading(false));
  }, []);

  const [pickedPluginId, setPickedPluginId] = useState<string>('');
  const plugins = registry.plugins;

  // 当前插件在渲染期直接推导，不用 effect 同步：用户选过的优先，否则上次用过的，否则第一个。
  // 插件列表是异步到位的，用 effect 回填 state 会多渲染一帧并触发级联更新。
  const plugin = plugins.find(item => item.id === pickedPluginId)
    ?? plugins.find(item => item.id === getLastUsedPluginId())
    ?? plugins[0]
    ?? null;

  if (loading && plugins.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-border bg-card p-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        正在读取已安装的插件…
      </div>
    );
  }

  if (!plugin) {
    return <PluginEmptyState registry={registry} />;
  }

  return (
    <PluginForm
      key={plugin.id}
      plugin={plugin}
      plugins={plugins}
      wideMode={wideMode}
      onSelectPlugin={id => {
        setPickedPluginId(id);
        setLastUsedPluginId(id);
      }}
      onConfigureCredential={onConfigureCredential}
      showToast={showToast}
      initialJob={initialJob && initialJob.pluginId === plugin.id ? initialJob : null}
    />
  );
}

interface PluginFormProps {
  plugin: InstalledPlugin;
  plugins: InstalledPlugin[];
  wideMode: boolean;
  onSelectPlugin: (id: string) => void;
  onConfigureCredential?: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  initialJob: PluginJob | null;
}

/**
 * 单个插件的表单。整棵表单由 ui.schema 驱动：facet 决定模型，字段决定载荷，
 * 素材槽的数量与名额随 facet 变化。这里没有任何具体上游的知识。
 *
 * key={plugin.id} 让切换插件时整个组件重建——不同插件的字段集合完全不同，
 * 尝试在同一份 state 里迁移只会留下上一份 schema 的残留值。
 */
function PluginForm({
  plugin,
  plugins,
  wideMode,
  onSelectPlugin,
  onConfigureCredential,
  showToast,
  initialJob,
}: PluginFormProps) {
  const schema = plugin.uiSchema;

  const [parallelCount, setParallelCount] = useState(1);

  const [facets, setFacets] = useState<FacetValues>(() => {
    const fromJob = initialJob ? facetsFromModel(schema, initialJob.model) : null;
    return fromJob ? coerceFacets(schema, fromJob) : defaultFacets(schema);
  });
  const [fields, setFields] = useState<FieldValues>(() => {
    const base = defaultFieldValues(schema, facets);
    return initialJob ? coerceFieldValues(schema, facets, { ...base, ...initialJob.fields }) : base;
  });
  /** 素材字段 key → 已选中但尚未上传的文件 */
  const [media, setMedia] = useState<Record<string, PendingMedia[]>>({});
  /** 正在做本地压缩的素材字段（压缩是纯本地操作，与上传无关） */
  const [compressingSlot, setCompressingSlot] = useState<string | null>(null);

  // 凭据变化（用户在设置里刚填了 key）要让按钮立刻可用
  const credentialVersion = useSyncExternalStore(
    subscribePluginCredentials,
    getCredentialVersion,
    () => 0,
  );
  const credential = useMemo(
    () => getPluginCredential(plugin),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- credentialVersion 是外部 store 的变更信号
    [plugin, credentialVersion],
  );

  const model = resolveModel(schema, facets);
  const mediaFields = resolvedMediaFields(schema, facets, fields);
  const mediaCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [key, items] of Object.entries(media)) counts[key] = items.length;
    return counts;
  }, [media]);

  const cost = model ? estimateCost(plugin, model, fields) : null;
  const check = checkSubmittable(schema, facets, fields, mediaCounts);
  const promptField = findPromptField(plugin);

  // 「重用参数」把历史任务同步进表单。用 React 官方推荐的「渲染期按 prop 变化调整 state」
  // 写法，而不是 effect —— 避免多渲染一帧再级联更新。
  const [appliedJobId, setAppliedJobId] = useState<string | null>(initialJob?.id ?? null);
  if (initialJob && initialJob.id !== appliedJobId) {
    const nextFacets = coerceFacets(schema, facetsFromModel(schema, initialJob.model) ?? facets);
    setAppliedJobId(initialJob.id);
    setFacets(nextFacets);
    setFields(coerceFieldValues(schema, nextFacets, {
      ...defaultFieldValues(schema, nextFacets),
      ...initialJob.fields,
    }));
  }

  /** facet 变化时收敛后续 facet 与字段值，并裁掉新组合放不下的素材 */
  const handleFacetChange = useCallback((key: string, value: string | number) => {
    setFacets(prev => {
      const next = coerceFacets(schema, { ...prev, [key]: value });
      setFields(current => coerceFieldValues(schema, next, current));
      // 切到能力更弱的档位会失去某些素材槽并收紧名额，提前裁剪避免提交超限载荷
      setMedia(currentMedia => {
        const allowed = resolvedMediaFields(schema, next, fields);
        const nextMedia: Record<string, PendingMedia[]> = {};
        for (const [slot, items] of Object.entries(currentMedia)) {
          const target = allowed.find(entry => entry.field.key === slot);
          if (!target) {
            for (const dropped of items) URL.revokeObjectURL(dropped.previewUrl);
            continue;
          }
          nextMedia[slot] = truncatePending(items, target.maxCount);
        }
        return nextMedia;
      });
      return next;
    });
  }, [fields, schema]);

  const handleFieldChange = useCallback((key: string, value: string | number | boolean) => {
    setFields(prev => {
      const next = { ...prev, [key]: value };
      // 字段也能出现在 showIf 里（如 mode 决定素材槽），所以同样要裁剪素材
      setMedia(currentMedia => {
        const allowed = resolvedMediaFields(schema, facets, next);
        const nextMedia: Record<string, PendingMedia[]> = {};
        for (const [slot, items] of Object.entries(currentMedia)) {
          const target = allowed.find(entry => entry.field.key === slot);
          if (!target) {
            nextMedia[slot] = items; // 只是暂时隐藏（如切回原模式仍要用），不回收
            continue;
          }
          nextMedia[slot] = truncatePending(items, target.maxCount);
        }
        return nextMedia;
      });
      return next;
    });
  }, [facets, schema]);

  /**
   * 选中一批素材。只做本地处理：类型/体积/名额分流 → 图片压成 WebP → 生成本地预览。
   * 不发任何网络请求；真正的上传推迟到点击提交之后，由 plugin-upload-runner 执行。
   *
   * 压缩仍留在这一步：它是纯本地操作，没有滥用面，且用户能立刻看到压缩后的真实体积
   * 与失败原因，而不是等提交后才在进度条里报错。
   */
  const handleFilesPick = useCallback(async (
    slot: string,
    kind: MediaKind,
    maxCount: number,
    files: File[],
  ) => {
    if (files.length === 0) return;
    const remaining = maxCount - (media[slot]?.length || 0);
    const selection = selectFiles(kind, files, remaining);
    const rejectionNote = describeRejections(kind, selection);
    if (rejectionNote) showToast?.(rejectionNote, 'error');
    if (selection.accepted.length === 0) return;

    const config = getMediaConfig(kind);
    setCompressingSlot(config.compress ? slot : null);
    try {
      const picked: PendingMedia[] = [];
      for (const original of selection.accepted) {
        let file = original;
        if (config.compress) {
          const { file: compressed } = await compressImageToWebp(original, { maxBytes: config.maxBytes });
          file = compressed;
        }
        picked.push({
          id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          slot,
          kind,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }
      setMedia(prev => ({
        ...prev,
        [slot]: truncatePending([...(prev[slot] || []), ...picked], maxCount),
      }));
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '处理素材失败', 'error');
    } finally {
      setCompressingSlot(null);
    }
  }, [media, showToast]);

  /** 移除单个素材并回收它的本地预览地址 */
  const handleRemoveMedia = useCallback((slot: string, index: number) => {
    setMedia(prev => {
      const items = prev[slot] || [];
      const target = items[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return { ...prev, [slot]: items.filter((_, i) => i !== index) };
    });
  }, []);

  // 卸载时统一回收未提交素材的 objectURL。提交后素材交给 runner，预览地址在提交处一并释放，
  // 进度面板展示的是文件名而非缩略图，不依赖这些 URL。
  const allPendingRef = useRef<PendingMedia[]>([]);
  useEffect(() => {
    allPendingRef.current = Object.values(media).flat();
  }, [media]);
  useEffect(() => () => {
    for (const item of allPendingRef.current) URL.revokeObjectURL(item.previewUrl);
  }, []);

  const handleSubmit = useCallback(() => {
    if (!model) return;
    if (!credential.apiKey) {
      showToast?.(`请先在设置 → 插件里填写「${plugin.credential.label}」`, 'error');
      onConfigureCredential?.();
      return;
    }
    if (!check.ok) {
      if (check.reason) showToast?.(check.reason, 'error');
      return;
    }

    // 只提交当前可见素材槽里的文件：切档位后隐藏的槽位残留不该被带上去
    const visibleSlots = new Set(mediaFields.map(entry => entry.field.key));
    const items = Object.entries(media)
      .filter(([slot]) => visibleSlots.has(slot))
      .flatMap(([, list]) => list);

    const submitFields: FieldValues = {};
    const scope = buildScope(facets, fields);
    for (const field of schema.fields) {
      if (field.type === 'media') continue;
      if (!isFieldVisible(field, scope)) continue;
      const value = fields[field.key];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed !== '') submitFields[field.key] = trimmed;
        continue;
      }
      if (value !== undefined) submitFields[field.key] = value;
    }

    const modelInfo = findModel(plugin, model);
    const job: PluginJob = {
      id: `plugin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      status: 'uploading',
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginVersion: plugin.version,
      model,
      modelLabel: modelInfo?.shortName || modelInfo?.name || model,
      prompt: promptField ? String(submitFields[promptField.key] ?? '') : '',
      facets,
      fields: submitFields,
      paramSummary: buildParamSummary(plugin, facets, fields),
      estimatedCost: cost,
      currency: modelInfo?.price?.currency || 'CNY',
      createdAt: new Date().toISOString(),
    };

    startPluginJob({
      job,
      items,
      parallelCount,
      buildPayload: () => ({
        pluginId: plugin.id,
        apiKey: credential.apiKey,
        baseUrl: credential.baseUrl,
        model,
        facets,
        fields: submitFields,
      }),
    });

    // 素材已交给 runner（File 在内存里被持有），表单清空以便继续下一单；
    // 预览地址由这里回收，进度面板展示文件名不依赖它们。
    for (const item of items) URL.revokeObjectURL(item.previewUrl);
    setMedia({});

    showToast?.(
      items.length > 0 ? `任务已创建，正在上传 ${items.length} 个素材...` : '任务已提交，正在生成中...',
      'success',
    );
  }, [check, cost, credential, facets, fields, media, mediaFields, model, onConfigureCredential, parallelCount, plugin, promptField, schema, showToast]);

  const body = bodyEntries(schema);

  return (
    <div className={cn('flex flex-col gap-4', wideMode && 'xl:min-h-full')}>
      <div
        className={cn(
          'space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5',
          // 宽屏下卡片撑满高度，主提示词吃掉剩余空间，和右侧历史卡片上下对齐
          wideMode && 'xl:flex xl:min-h-full xl:flex-1 xl:flex-col xl:gap-4 xl:space-y-0',
        )}
      >
        {plugins.length > 1 && (
          <PluginPicker plugins={plugins} activeId={plugin.id} onSelect={onSelectPlugin} />
        )}

        <SchemaToolbar
          plugin={plugin}
          facets={facets}
          fields={fields}
          model={model}
          onFacetChange={handleFacetChange}
          onFieldChange={handleFieldChange}
          parallelCount={parallelCount}
          onParallelChange={setParallelCount}
        />

        {!credential.apiKey && (
          <button
            type="button"
            onClick={onConfigureCredential}
            className="flex w-full items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
          >
            <PackageOpen className="size-3.5 shrink-0" />
            <span>
              还没有配置「{plugin.credential.label}」。点此前往设置 → 插件填写后即可提交任务。
            </span>
          </button>
        )}

        {/* 素材区：显示哪些槽、每槽几个名额，全部由 schema + 当前 facet 求出 */}
        {mediaFields.length > 0 && (
          <div className="space-y-3 rounded-2xl border border-border/50 bg-muted/30 p-3.5">
            {mediaFields
              .filter(entry => body.includes(entry.field.key))
              .map(entry => (
                <SchemaMediaField
                  key={entry.field.key}
                  field={entry.field}
                  maxCount={entry.maxCount}
                  required={entry.required}
                  items={media[entry.field.key] || []}
                  busy={compressingSlot === entry.field.key}
                  onPick={files => void handleFilesPick(
                    entry.field.key,
                    (entry.field.kind || 'images') as MediaKind,
                    entry.maxCount,
                    files,
                  )}
                  onRemove={index => handleRemoveMedia(entry.field.key, index)}
                />
              ))}
          </div>
        )}

        {/* 文本与开关字段。宽屏下主提示词吃掉剩余高度 */}
        {body.map(key => {
          const field = findField(schema, key);
          if (!field || field.type === 'media') return null;
          if (field.type !== 'text' && field.type !== 'textarea' && field.type !== 'switch') return null;
          if (!isFieldVisible(field, buildScope(facets, fields))) return null;
          if (field.type === 'switch') {
            return (
              <SwitchFieldControl
                key={field.key}
                field={field}
                value={fields[field.key] === true}
                onChange={value => handleFieldChange(field.key, value)}
              />
            );
          }
          const isPrompt = promptField?.key === field.key;
          return (
            <TextFieldControl
              key={field.key}
              field={field}
              value={String(fields[field.key] ?? '')}
              stretch={isPrompt && wideMode}
              onChange={value => handleFieldChange(field.key, value)}
            />
          );
        })}

        {/* 提交栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-3">
          {/* 插件没申报价格时整行不出现，留一个「预估计费：」空标签更像故障 */}
          {model && cost !== null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>预估计费：</span>
              <PluginTotalPrice plugin={plugin} modelId={model} cost={cost} parallelCount={parallelCount} />
            </div>
          ) : (
            <span />
          )}

          <Button
            type="button"
            variant="default"
            size="default"
            disabled={!check.ok || Boolean(compressingSlot)}
            onClick={handleSubmit}
            title={check.reason ?? undefined}
            className="h-10 rounded-xl px-6 text-xs font-bold shadow-md shadow-primary/20 transition-all hover:scale-[1.01] sm:text-sm"
          >
            {compressingSlot ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                正在处理素材...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 size-4" />
                开始生成{parallelCount > 1 ? ` x${parallelCount}` : (cost !== null && cost > 0 ? ` (¥${cost.toFixed(2)})` : '')}
              </>
            )}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground/80">
          当前组合：{buildParamSummary(plugin, facets, fields).map(chip => chip.value).join(' · ')}
          {model && <span className="ml-1 font-mono opacity-70">({model})</span>}
        </p>
      </div>
    </div>
  );
}

/** 布尔开关字段。提交时始终带上 true/false，不因为是 false 就被丢弃。 */
function SwitchFieldControl({
  field,
  value,
  onChange,
}: {
  field: PluginField;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/50 bg-muted/20 px-3.5 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <SchemaIcon name={field.icon} className="size-3.5 text-primary" />
          {field.label || field.key}
        </span>
        {field.hint && (
          <span className="block text-[11px] leading-relaxed text-muted-foreground">{field.hint}</span>
        )}
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

/** 文本 / 多行文本字段。多行字段可带一排预设短语，点一下追加到末尾。 */
function TextFieldControl({
  field,
  value,
  stretch,
  onChange,
}: {
  field: PluginField;
  value: string;
  stretch: boolean;
  onChange: (value: string) => void;
}) {
  const maxLength = field.maxLength || 0;

  return (
    <div className={cn('space-y-2', stretch && 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:space-y-0 xl:gap-2')}>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <SchemaIcon name={field.icon} className="size-3.5 text-primary" />
          {field.label || field.key}
          {field.required && <span className="text-destructive">*</span>}
        </label>
        <div className="flex items-center gap-2">
          {maxLength > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {value.length}/{maxLength}
            </span>
          )}
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange('')}
              className="flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              清空
            </button>
          )}
        </div>
      </div>

      <Textarea
        value={value}
        onChange={event => onChange(maxLength > 0 ? event.target.value.slice(0, maxLength) : event.target.value)}
        placeholder={field.placeholder}
        rows={field.rows || (field.type === 'textarea' ? 9 : 2)}
        className={cn(
          'resize-y rounded-2xl border-border bg-muted/20 p-3.5 text-xs leading-relaxed focus-visible:ring-primary sm:text-sm',
          field.type === 'textarea' && 'min-h-[180px] sm:min-h-[220px]',
          stretch && 'xl:min-h-[140px] xl:flex-1 xl:resize-none',
        )}
      />

      {field.presets && field.presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {field.presets.map((preset, index) => (
            <button
              key={index}
              type="button"
              onClick={() => {
                const next = value ? `${value}，${preset}` : preset;
                onChange(maxLength > 0 ? next.slice(0, maxLength) : next);
              }}
              className="inline-flex items-center rounded-xl border border-border/40 bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              + {preset.split('，')[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
