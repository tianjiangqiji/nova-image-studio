"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, Film, Image as ImageIcon, Music, Upload, X } from "lucide-react";
import { nanoid } from "nanoid";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getCredentialVersion, getPluginCredential, subscribePluginCredentials } from "@/lib/plugin-registry-client";
import {
  allFacetOptions,
  availableFacetValues,
  buildScope,
  checkSubmittable,
  coerceFacets,
  coerceFieldValues,
  defaultFacets,
  defaultFieldValues,
  estimateCost,
  isFieldVisible,
  resolveModel,
  visibleOptions,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
  type MediaKind,
  type PluginField,
} from "@/lib/plugin-schema";
import { describeRejections, formatBytes, getAcceptAttribute, selectFiles } from "@/lib/plugin-media-config";
import { findCanvasPromptField, visibleCanvasMediaFields } from "../canvas-video-generation-service";
import { setPendingMedia, type CanvasPendingMedia } from "../lib/canvas-video-media-store";

/**
 * 编排节点面板的视频模式区：参数（插件/档位/分辨率/字段）+ 素材槽。
 * 全部由插件 ui.schema 驱动——画布不认识任何具体上游，换插件不用改这里。
 *
 * 素材映射约定：
 * - 第一个 textarea 字段绑定画布提示词（面板不渲染它）；
 * - frame 样式的图片素材槽：从画布图片节点选择或本地上传（二选一）；
 * - 其余图片素材槽：提示词 @ 引用的画布图片 + 本地上传（@ 引用计入第一个非帧图片槽）；
 * - 视频/音频素材槽：仅本地上传；
 * - 素材只存内存 store（刷新即丢）。
 */

/** 画布上可作为帧引用的图片节点候选。 */
export interface CanvasImageOption {
  id: string;
  title: string;
  previewUrl?: string;
}

/** 读取节点上持久化的视频参数，缺省/非法时按插件 schema 收敛出安全默认值。 */
export function effectiveVideoState(
  plugin: InstalledPlugin,
  facets: FacetValues | undefined,
  fields: FieldValues | undefined,
): { facets: FacetValues; fields: FieldValues } {
  const schema = plugin.uiSchema;
  const baseFacets = facets && Object.keys(facets).length > 0 ? facets : defaultFacets(schema);
  const nextFacets = coerceFacets(schema, baseFacets);
  const baseFields = fields && Object.keys(fields).length > 0 ? fields : defaultFieldValues(schema, nextFacets);
  return { facets: nextFacets, fields: coerceFieldValues(schema, nextFacets, baseFields) };
}

/**
 * 视频模式的生成阻断原因（null = 可提交）。
 * 提交前 CanvasEditor 会用同一套规则做最终校验，这里只用于禁用按钮与提示。
 */
export function computeCanvasVideoBlockReason(args: {
  plugin: InstalledPlugin;
  facets: FacetValues;
  fields: FieldValues;
  /** @ 引用的画布图片数（计入第一个非帧图片槽） */
  imageCount: number;
  /** 帧槽 key → 引用的画布图片节点 ID（值可能指向已删节点，由 canvasImageIds 判定有效性） */
  frameRefs: Partial<Record<string, string>>;
  /** 画布上有效图片节点的 ID 集合 */
  canvasImageIds: ReadonlySet<string>;
  pendingMedia: CanvasPendingMedia[];
}): string | null {
  const { plugin, facets, fields, imageCount, frameRefs, canvasImageIds, pendingMedia } = args;
  const schema = plugin.uiSchema;
  if (!resolveModel(schema, facets)) return "当前参数组合没有对应的模型";

  const slots = visibleCanvasMediaFields(plugin, facets, fields);
  const firstImageSlot = slots.find(({ field }) => field.kind === "images" && field.style !== "frame");

  const mediaCounts: Record<string, number> = {};
  for (const { field } of slots) {
    const pendingCount = pendingMedia.filter(item => item.slot === field.key).length;
    const refId = frameRefs[field.key];
    const refCount = field.style === "frame" && refId && canvasImageIds.has(refId) ? 1 : 0;
    mediaCounts[field.key] = field === firstImageSlot?.field ? imageCount + pendingCount : refCount + pendingCount;
  }

  const check = checkSubmittable(schema, facets, fields, mediaCounts);
  return check.ok ? null : check.reason;
}

interface CanvasVideoConfigSectionProps {
  /** 内存素材 store 的键；为空时素材槽整体不渲染（参数区照常可用） */
  configNodeId?: string;
  plugin: InstalledPlugin;
  /** 可选的视频插件列表（多于一个时展示插件切换） */
  plugins: InstalledPlugin[];
  facets: FacetValues;
  fields: FieldValues;
  /** 整体替换（已收敛的）facet 取值 */
  onFacetsChange: (facets: FacetValues) => void;
  /** 浅合并字段取值 */
  onFieldsChange: (patch: Record<string, string | number | boolean>) => void;
  /** 帧槽 key → 画布图片节点 ID（传 undefined 表示清除） */
  onFrameRefChange: (patch: Partial<Record<string, string | undefined>>) => void;
  frameRefs: Partial<Record<string, string>>;
  onPluginChange: (pluginId: string) => void;
  canvasImages: CanvasImageOption[];
  /** @ 引用的画布图片数 */
  imageCount: number;
  /** 画布提示词（用于必填即时校验） */
  prompt: string;
  /** 面板统一订阅的内存素材快照（与面板共享同一份，避免重复订阅） */
  pendingMedia: CanvasPendingMedia[];
}

export function CanvasVideoConfigSection({
  configNodeId,
  plugin,
  plugins,
  facets,
  fields,
  onFacetsChange,
  onFieldsChange,
  onFrameRefChange,
  frameRefs,
  onPluginChange,
  canvasImages,
  imageCount,
  prompt,
  pendingMedia,
}: CanvasVideoConfigSectionProps) {
  const schema = plugin.uiSchema;
  const promptField = findCanvasPromptField(plugin);

  // 凭据状态：用户在设置里填了 key 后立刻可用
  const credentialVersion = useSyncExternalStore(subscribePluginCredentials, getCredentialVersion, () => 0);
  const credential = useMemo(
    () => getPluginCredential(plugin),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- credentialVersion 是外部 store 的变更信号
    [plugin, credentialVersion],
  );

  // 各槽位的拒绝原因行内小字（面板没有 toast，直接小字提示「已忽略 N 个…」）
  const [rejections, setRejections] = useState<Partial<Record<string, string | null>>>({});

  const slots = useMemo(() => visibleCanvasMediaFields(plugin, facets, fields), [plugin, facets, fields]);
  const slotCaps = useMemo(() => {
    const caps: Partial<Record<string, number>> = {};
    for (const { field, maxCount } of slots) caps[field.key] = maxCount;
    return caps;
  }, [slots]);

  // 模式/档位切换导致槽位上限收缩或槽位不再适用时截断素材，避免生成链路读到超限/过期文件
  useEffect(() => {
    if (!configNodeId) return;
    const counts = new Map<string, number>();
    const next: CanvasPendingMedia[] = [];
    let changed = false;
    for (const item of pendingMedia) {
      const cap = slotCaps[item.slot];
      const used = counts.get(item.slot) ?? 0;
      if (cap === undefined || used >= cap) {
        changed = true;
        continue;
      }
      counts.set(item.slot, used + 1);
      next.push(item);
    }
    if (changed) setPendingMedia(configNodeId, next);
  }, [configNodeId, pendingMedia, slotCaps]);

  const handleFacetChange = (key: string, value: string | number) => {
    const next = coerceFacets(schema, { ...facets, [key]: value });
    onFacetsChange(next);
    onFieldsChange(coerceFieldValues(schema, next, fields));
  };

  const handleFieldChange = (key: string, value: string | number | boolean) => {
    onFieldsChange({ [key]: value });
  };

  const pickFiles = (slot: string, kind: MediaKind, files: File[]) => {
    if (!configNodeId || files.length === 0) return;
    const cap = slotCaps[slot] ?? 0;
    const remaining = cap - pendingMedia.filter(item => item.slot === slot).length;
    const result = selectFiles(kind, files, remaining);
    const additions = result.accepted.map(file => ({
      id: nanoid(),
      slot,
      kind,
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    if (additions.length > 0) {
      setPendingMedia(configNodeId, [...pendingMedia, ...additions]);
      // 帧槽上传文件后与画布引用互斥
      const isFrameSlot = slots.find(entry => entry.field.key === slot)?.field.style === "frame";
      if (isFrameSlot) onFrameRefChange({ [slot]: undefined });
    }
    setRejections(prev => ({ ...prev, [slot]: describeRejections(kind, result) }));
  };

  const removeItem = (id: string) => {
    if (!configNodeId) return;
    setPendingMedia(configNodeId, pendingMedia.filter(item => item.id !== id));
  };

  const selectCanvasFrame = (slot: string, imageId: string) => {
    onFrameRefChange({ [slot]: imageId });
    // 与上传文件互斥：选了画布引用就丢掉该槽的本地文件
    if (configNodeId) {
      const kept = pendingMedia.filter(item => item.slot !== slot);
      if (kept.length !== pendingMedia.length) setPendingMedia(configNodeId, kept);
    }
  };

  const model = resolveModel(schema, facets);
  const effectiveFields = promptField ? { ...fields, [promptField.key]: prompt } : fields;
  const cost = model ? estimateCost(plugin, model, effectiveFields) : null;

  const firstImageSlot = slots.find(({ field }) => field.kind === "images" && field.style !== "frame");
  const canvasImageIds = useMemo(() => new Set(canvasImages.map(image => image.id)), [canvasImages]);
  const blockedReason = computeCanvasVideoBlockReason({
    plugin, facets, fields: effectiveFields, imageCount, frameRefs, canvasImageIds, pendingMedia,
  });

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-2 text-xs">
      {/* —— 插件选择（多于一个时展示） —— */}
      {plugins.length > 1 && (
        <Select<string>
          value={plugin.id}
          onValueChange={onPluginChange}
          options={plugins.map(item => ({ value: item.id, label: item.name }))}
          ariaLabel="视频插件"
          size="sm"
          className="text-xs"
        />
      )}

      {/* —— 档位 facet（control=list 的渲染为按钮组，其余为下拉） —— */}
      {schema.modelSelector.facets.map(facet => {
        const options = availableFacetValues(schema, facet.key, facets);
        if (facet.hideWhenSingle && options.length <= 1) return null;
        const all = allFacetOptions(schema, facet.key);
        if (facet.control === "list") {
          return (
            <div key={facet.key} className="flex gap-1">
              {options.map(value => {
                const option = all.find(item => String(item.value) === String(value));
                const selected = String(facets[facet.key]) === String(value);
                return (
                  <button
                    key={String(value)}
                    type="button"
                    title={option?.fullLabel || option?.description}
                    onClick={() => handleFacetChange(facet.key, value)}
                    className={cn(
                      "h-6 flex-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                      selected
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {option?.label ?? String(value)}
                  </button>
                );
              })}
            </div>
          );
        }
        return (
          <Select<string>
            key={facet.key}
            value={String(facets[facet.key])}
            onValueChange={value => handleFacetChange(facet.key, value)}
            options={options.map(value => ({ value: String(value), label: String(value) }))}
            ariaLabel={facet.label}
            size="sm"
            className="text-xs"
          />
        );
      })}

      {/* —— 字段区（select/select-grid/text/switch；第一个 textarea 是画布提示词不渲染） —— */}
      <div className="grid grid-cols-2 gap-1.5">
        {schema.fields.map(field => {
          if (field.type === "media") return null;
          if (field === promptField) return null;
          const scope = buildScope(facets, fields);
          if (!isFieldVisible(field, scope)) return null;
          if (field.hideWhenSingle && visibleOptions(field, scope).length <= 1) return null;

          if (field.type === "select" || field.type === "select-grid") {
            const options = visibleOptions(field, scope);
            return (
              <label key={field.key} className="min-w-0 space-y-0.5">
                <span className="block text-[10px] text-muted-foreground">{field.label || field.key}</span>
                <Select<string>
                  value={String(fields[field.key] ?? options[0]?.value ?? "")}
                  onValueChange={value => handleFieldChange(field.key, value)}
                  options={options.map(option => ({
                    value: String(option.value),
                    label: `${option.label}${field.suffix && !option.label.endsWith(field.suffix) ? field.suffix : ""}`,
                  }))}
                  ariaLabel={field.label || field.key}
                  size="sm"
                  className="text-xs"
                />
              </label>
            );
          }
          if (field.type === "switch") {
            return (
              <label key={field.key} className="flex items-center gap-1.5 self-end pb-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={Boolean(fields[field.key])}
                  onChange={event => handleFieldChange(field.key, event.target.checked)}
                  className="size-3.5 accent-primary"
                />
                {field.label || field.key}
              </label>
            );
          }
          return (
            <label key={field.key} className="min-w-0 space-y-0.5">
              <span className="block text-[10px] text-muted-foreground">{field.label || field.key}</span>
              <input
                type="text"
                value={String(fields[field.key] ?? "")}
                maxLength={field.maxLength}
                placeholder={field.placeholder}
                onChange={event => handleFieldChange(field.key, event.target.value)}
                className="h-7 w-full rounded-lg border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </label>
          );
        })}
      </div>

      {/* —— 价格与阻断信息 —— */}
      {(cost !== null || !credential.apiKey) && (
        <div className="flex items-center justify-between gap-2 text-[10px] leading-tight">
          {cost !== null && <span className="min-w-0 truncate text-muted-foreground">{plugin.name} · 约 ¥{cost.toFixed(2)}</span>}
          {!credential.apiKey && (
            <span className="flex shrink-0 items-center gap-1 text-destructive">
              <AlertCircle className="size-3" />
              未配置该插件的 API 密钥
            </span>
          )}
        </div>
      )}

      {/* —— 素材槽区 —— */}
      {slots.map(({ field, maxCount }) => {
        if (field.style === "frame") {
          return (
            <FrameSlot
              key={field.key}
              field={field}
              maxCount={maxCount}
              canvasImages={canvasImages}
              selectedId={frameRefs[field.key]}
              pendingMedia={pendingMedia.filter(item => item.slot === field.key)}
              rejection={rejections[field.key] ?? null}
              onPickFiles={pickFiles}
              onRemoveItem={removeItem}
              onSelectCanvasImage={selectCanvasFrame}
              onClearCanvasImage={() => onFrameRefChange({ [field.key]: undefined })}
            />
          );
        }
        return (
          <MediaSlot
            key={field.key}
            field={field}
            maxCount={maxCount}
            isReferenceImageSlot={field === firstImageSlot?.field}
            imageCount={imageCount}
            pendingMedia={pendingMedia.filter(item => item.slot === field.key)}
            rejection={rejections[field.key] ?? null}
            onPickFiles={pickFiles}
            onRemoveItem={removeItem}
          />
        );
      })}

      {/* —— 底部状态行 —— */}
      {blockedReason && (
        <p className="text-[10px] leading-tight text-destructive">{blockedReason}</p>
      )}
      {configNodeId && pendingMedia.length > 0 && (
        <p className="text-[10px] leading-tight text-muted-foreground/70">素材仅存于内存，刷新页面后需重新添加</p>
      )}
    </div>
  );
}

/** 隐藏的文件选择输入（按钮触发）。 */
function FilePickButton({ kind, slot, onPick, children, className }: {
  kind: MediaKind;
  slot: string;
  onPick: (slot: string, kind: MediaKind, files: File[]) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          className,
        )}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={getAcceptAttribute(kind)}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) onPick(slot, kind, files);
        }}
      />
    </>
  );
}

/** 帧素材槽：画布图片引用或本地上传（互斥），用于首帧/尾帧等 frame 样式槽位。 */
function FrameSlot({
  field,
  maxCount,
  canvasImages,
  selectedId,
  pendingMedia,
  rejection,
  onPickFiles,
  onRemoveItem,
  onSelectCanvasImage,
  onClearCanvasImage,
}: {
  field: PluginField;
  maxCount: number;
  canvasImages: CanvasImageOption[];
  selectedId: string | undefined;
  pendingMedia: CanvasPendingMedia[];
  rejection: string | null;
  onPickFiles: (slot: string, kind: MediaKind, files: File[]) => void;
  onRemoveItem: (id: string) => void;
  onSelectCanvasImage: (slot: string, imageId: string) => void;
  onClearCanvasImage: () => void;
}) {
  const selected = canvasImages.find(image => image.id === selectedId);
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <span className="shrink-0 text-[11px] font-medium">{field.label || field.key}</span>
        <span className="min-w-0 truncate text-[10px] text-muted-foreground">
          {field.hint ? `${field.hint} · ` : ""}上限 {maxCount}
        </span>
      </div>

      {/* 画布图片引用 */}
      {selected && (
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background p-1">
          {selected.previewUrl && (
            <img src={selected.previewUrl} alt={selected.title} className="size-8 shrink-0 rounded object-cover" draggable={false} />
          )}
          <span className="min-w-0 flex-1 truncate text-[10px] text-foreground" title={selected.title}>{selected.title}</span>
          <button type="button" title="取消引用" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClearCanvasImage}>
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* 本地上传的帧文件（与画布引用互斥，选中引用时为空） */}
      {pendingMedia.map(item => (
        <div key={item.id} className="flex items-center gap-1.5 rounded-md border border-border bg-background p-1">
          {item.kind === "images" && item.previewUrl && (
            <img src={item.previewUrl} alt={item.file.name} className="size-8 shrink-0 rounded object-cover" draggable={false} />
          )}
          <span className="min-w-0 flex-1 truncate text-[10px] text-foreground" title={item.file.name}>{item.file.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(item.file.size)}</span>
          <button type="button" title="移除" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => onRemoveItem(item.id)}>
            <X className="size-3" />
          </button>
        </div>
      ))}

      <div className="flex items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ImageIcon className="size-3" />
              从画布选择
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-1">
            <p className="px-1.5 py-1 text-[10px] text-muted-foreground">选择画布图片节点作为{field.label || field.key}</p>
            <div className="max-h-52 overflow-auto">
              {canvasImages.length === 0 && (
                <p className="px-1.5 py-2 text-[10px] text-muted-foreground">画布上暂无图片节点</p>
              )}
              {canvasImages.map(image => (
                <button
                  key={image.id}
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-foreground transition-colors hover:bg-muted"
                  onClick={() => onSelectCanvasImage(field.key, image.id)}
                >
                  {image.previewUrl && (
                    <img src={image.previewUrl} alt={image.title} className="size-7 shrink-0 rounded object-cover" draggable={false} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{image.title}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <FilePickButton kind={field.kind ?? "images"} slot={field.key} onPick={onPickFiles}>
          <Upload className="size-3" />
          上传文件
        </FilePickButton>
      </div>

      {rejection && <p className="text-[10px] text-destructive">{rejection}</p>}
    </div>
  );
}

/** 普通素材槽（参考图片/视频/音频）：上传 chips + 第一个图片槽的 @ 引用计数。 */
function MediaSlot({
  field,
  maxCount,
  isReferenceImageSlot,
  imageCount,
  pendingMedia,
  rejection,
  onPickFiles,
  onRemoveItem,
}: {
  field: PluginField;
  maxCount: number;
  isReferenceImageSlot: boolean;
  imageCount: number;
  pendingMedia: CanvasPendingMedia[];
  rejection: string | null;
  onPickFiles: (slot: string, kind: MediaKind, files: File[]) => void;
  onRemoveItem: (id: string) => void;
}) {
  const total = (isReferenceImageSlot ? imageCount : 0) + pendingMedia.length;
  const icon = field.kind === "videos" ? <Film className="size-3" /> : field.kind === "audios" ? <Music className="size-3" /> : <ImageIcon className="size-3" />;
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        {icon}
        <span className="shrink-0 text-[11px] font-medium">{field.label || field.key}</span>
        <span className={cn("min-w-0 truncate text-[10px]", total > maxCount ? "text-destructive" : "text-muted-foreground")}>
          {total}/{maxCount}
        </span>
      </div>
      {isReferenceImageSlot && (
        <p className="text-[10px] leading-tight text-muted-foreground/80">
          画布图片请在提示词中输入 @ 引用（当前 {imageCount} 张），或直接上传本地文件
        </p>
      )}
      {pendingMedia.map(item => (
        <div key={item.id} className="flex items-center gap-1.5 rounded-md border border-border bg-background p-1">
          {item.kind === "images" && item.previewUrl && (
            <img src={item.previewUrl} alt={item.file.name} className="size-8 shrink-0 rounded object-cover" draggable={false} />
          )}
          <span className="min-w-0 flex-1 truncate text-[10px] text-foreground" title={item.file.name}>{item.file.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(item.file.size)}</span>
          <button type="button" title="移除" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => onRemoveItem(item.id)}>
            <X className="size-3" />
          </button>
        </div>
      ))}
      <FilePickButton kind={field.kind ?? "images"} slot={field.key} onPick={onPickFiles}>
        <Upload className="size-3" />
        上传{field.kind === "videos" ? "视频" : field.kind === "audios" ? "音频" : "图片"}
      </FilePickButton>
      {rejection && <p className="text-[10px] text-destructive">{rejection}</p>}
    </div>
  );
}
