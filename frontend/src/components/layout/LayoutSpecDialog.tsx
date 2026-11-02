'use client';

// 构图规范主弹窗
// 三条产出路径共用同一份 LayoutSpec：AI 生成 / 图形化手动框选 / 内置模板 + 素材库导入。
// 打开时通过 key 重建内部状态，避免在 effect 里同步 setState。

import { useCallback, useRef, useState } from 'react';
import { AlertCircle, Check, LayoutTemplate, Loader2, Plus, Save, Sparkles, Trash2 } from 'lucide-react';

import { AgentTextAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { addTextAsset, type TextAsset } from '@/lib/asset-store';
import { dispatchImageActionToast } from '@/lib/image-actions';
import {
  createEmptyLayoutSpec,
  deriveLayoutRelations,
  isLayoutSpecEmpty,
  nextLayoutObjectId,
  nextLayoutLabel,
  parseLayoutSpec,
  stringifyLayoutSpec,
  type LayoutObject,
  type LayoutSpec,
} from '@/lib/layout-spec';
import { LAYOUT_TEMPLATES, type LayoutTemplate as LayoutTemplateItem } from '@/lib/layout-spec-templates';
import { cn } from '@/lib/utils';

import { getLayoutBoxColor, LayoutSketchCanvas, useLayoutDeleteKey } from './LayoutSketchCanvas';
import { LayoutSpecPreview } from './LayoutSpecPreview';
import {
  canGenerateLayoutSpec,
  generateLayoutSpec,
  LAYOUT_SPEC_MISSING_KEY_MESSAGE,
  type LayoutSpecGenerateHandle,
} from './layout-spec-ai-client';

const ASPECT_RATIO_OPTIONS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;

interface LayoutSpecDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时带入的既有规范 */
  initialSpec?: LayoutSpec | null;
  /** 可选底图，手动框选时作为对齐参考 */
  backgroundImageUrl?: string;
  /** 默认画布比例（来自生图参数） */
  defaultAspectRatio?: string;
  onConfirm: (spec: LayoutSpec) => void;
}

type BuildMode = 'ai' | 'sketch' | 'template';

function cloneSpec(spec: LayoutSpec | null | undefined, fallbackRatio?: string): LayoutSpec {
  if (!spec) return createEmptyLayoutSpec(fallbackRatio);
  return { ...spec, objects: spec.objects.map((item) => ({ ...item, box: { ...item.box } })) };
}

/** 内部实现：只在 open 时挂载，状态由 props 初始值直接构造 */
function LayoutSpecDialogBody({
  initialSpec,
  backgroundImageUrl,
  defaultAspectRatio,
  onConfirm,
  onCancel,
}: {
  initialSpec?: LayoutSpec | null;
  backgroundImageUrl?: string;
  defaultAspectRatio?: string;
  onConfirm: (spec: LayoutSpec) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<BuildMode>(() =>
    initialSpec && initialSpec.objects.length > 0 ? 'sketch' : 'ai',
  );
  const [spec, setSpec] = useState<LayoutSpec>(() => cloneSpec(initialSpec, defaultAspectRatio));
  const [selectedId, setSelectedId] = useState('');

  // AI 生成
  const [intent, setIntent] = useState('');
  const [rawOutput, setRawOutput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const generateHandleRef = useRef<LayoutSpecGenerateHandle | null>(null);

  // 素材库
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);

  const aspectRatio = spec.aspectRatio || defaultAspectRatio || '1:1';

  const setObjects = useCallback((objects: LayoutObject[]) => {
    setSpec((prev) => ({ ...prev, objects, relations: deriveLayoutRelations(objects) }));
  }, []);

  const handleDeleteObject = useCallback((id: string) => {
    setSpec((prev) => {
      const objects = prev.objects.filter((item) => item.id !== id);
      return { ...prev, objects, relations: deriveLayoutRelations(objects) };
    });
    setSelectedId((prev) => (prev === id ? '' : prev));
  }, []);

  useLayoutDeleteKey(selectedId || undefined, handleDeleteObject);

  const handleRenameObject = useCallback((id: string, label: string) => {
    setSpec((prev) => ({
      ...prev,
      objects: prev.objects.map((item) => (item.id === id ? { ...item, label } : item)),
    }));
  }, []);

  const handleAddObject = useCallback(() => {
    setSpec((prev) => {
      const objects: LayoutObject[] = [
        ...prev.objects,
        {
          id: nextLayoutObjectId(prev.objects),
          label: nextLayoutLabel(prev.objects),
          box: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 },
        },
      ];
      return { ...prev, objects, relations: deriveLayoutRelations(objects) };
    });
  }, []);

  const handleAspectRatioChange = useCallback((next: string) => {
    setSpec((prev) => ({ ...prev, aspectRatio: next }));
  }, []);

  const handleGenerate = useCallback(() => {
    const trimmed = intent.trim();
    if (!trimmed || generating) return;

    if (!canGenerateLayoutSpec()) {
      setGenerateError(LAYOUT_SPEC_MISSING_KEY_MESSAGE);
      return;
    }

    generateHandleRef.current?.abort();
    setRawOutput('');
    setGenerateError(null);
    setGenerating(true);

    let buffer = '';
    generateHandleRef.current = generateLayoutSpec(trimmed, {
      onDelta(token) {
        buffer += token;
        setRawOutput(buffer);
      },
      onDone(fullText) {
        const text = fullText?.trim() ? fullText : buffer;
        setRawOutput(text);
        setGenerating(false);
        const parsed = parseLayoutSpec(text);
        if (!parsed) {
          setGenerateError('AI 返回的内容不是合法的构图 JSON，可重试或改用手动框选。');
          return;
        }
        setSpec({ ...parsed, aspectRatio: parsed.aspectRatio || aspectRatio });
        setMode('sketch');
      },
      onError(err) {
        setGenerating(false);
        setGenerateError(err.message);
      },
    });
  }, [aspectRatio, generating, intent]);

  const handleGenerateCancel = useCallback(() => {
    generateHandleRef.current?.abort();
    generateHandleRef.current = null;
    setGenerating(false);
  }, []);

  const handleApplyTemplate = useCallback((template: LayoutTemplateItem) => {
    setSpec(cloneSpec(template.spec, aspectRatio));
    setSelectedId('');
    setMode('sketch');
  }, [aspectRatio]);

  const handleAssetConfirm = useCallback((asset: TextAsset) => {
    const parsed = parseLayoutSpec(asset.content);
    if (!parsed) {
      dispatchImageActionToast('该素材不是有效的构图规范', 'error');
      return;
    }
    setSpec(parsed);
    setSelectedId('');
    setMode('sketch');
  }, []);

  const handleSaveAsset = useCallback(async () => {
    if (isLayoutSpecEmpty(spec)) {
      dispatchImageActionToast('请先创建至少一个物体', 'error');
      return;
    }
    try {
      await addTextAsset({
        content: stringifyLayoutSpec(spec),
        sourceKind: 'layout',
        sourceLabel: '构图规范',
      });
      dispatchImageActionToast('构图规范已保存到素材库', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存构图规范失败', 'error');
    }
  }, [spec]);

  const handleConfirm = useCallback(() => {
    if (isLayoutSpecEmpty(spec)) {
      dispatchImageActionToast('请先创建至少一个物体', 'error');
      return;
    }
    onConfirm(spec);
  }, [onConfirm, spec]);

  const empty = isLayoutSpecEmpty(spec);

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">画布比例</span>
        <div className="flex flex-wrap gap-1">
          {ASPECT_RATIO_OPTIONS.map((option) => (
            <Button
              key={option}
              type="button"
              size="xs"
              variant={aspectRatio === option ? 'default' : 'outline'}
              onClick={() => handleAspectRatioChange(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      </div>

      <Tabs value={mode} onValueChange={(value) => setMode(value as BuildMode)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="self-start">
          <TabsTrigger value="ai">
            <Sparkles className="mr-1 size-3.5" />
            AI 生成
          </TabsTrigger>
          <TabsTrigger value="sketch">
            <LayoutTemplate className="mr-1 size-3.5" />
            手动框选
          </TabsTrigger>
          <TabsTrigger value="template">
            <LayoutTemplate className="mr-1 size-3.5" />
            模板导入
          </TabsTrigger>
        </TabsList>

        <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto md:grid-cols-[1.15fr_0.85fr]">
          <div className="min-h-0">
            <TabsContent value="ai" className="mt-0 flex flex-col gap-2">
              <Textarea
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder="描述画面意图，例如：左边一个蓝色机器人，中间一个小橙色方块，右边一盆绿色植物，都放在桌子上"
                rows={4}
                className="resize-none"
              />
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={handleGenerate} disabled={!intent.trim() || generating}>
                  {generating ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Sparkles className="mr-1 size-3.5" />}
                  {generating ? '生成中…' : '生成构图'}
                </Button>
                {generating && (
                  <Button type="button" size="sm" variant="ghost" onClick={handleGenerateCancel}>
                    中止
                  </Button>
                )}
                {generateError && (
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <AlertCircle className="size-3.5 shrink-0" />
                    {generateError}
                  </span>
                )}
              </div>
              {rawOutput && (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
                  {rawOutput}
                </pre>
              )}
            </TabsContent>

            <TabsContent value="sketch" className="mt-0 flex flex-col gap-2">
              <LayoutSketchCanvas
                objects={spec.objects}
                aspectRatio={aspectRatio}
                backgroundImageUrl={backgroundImageUrl}
                selectedId={selectedId}
                onChange={setObjects}
                onSelect={setSelectedId}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" size="xs" variant="outline" onClick={handleAddObject}>
                  <Plus className="mr-1 size-3" />
                  添加物体
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  拖拽空白处新建 · 拖拽框体移动 · 右下角缩放 · Delete 删除
                </span>
              </div>
            </TabsContent>

            <TabsContent value="template" className="mt-0 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">内置模板</span>
                <Button type="button" size="xs" variant="outline" onClick={() => setAssetPickerOpen(true)}>
                  从素材库导入
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {LAYOUT_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => handleApplyTemplate(template)}
                    className={cn(
                      'rounded-lg border border-border bg-card p-2.5 text-left transition-colors',
                      'hover:border-primary/60 hover:bg-accent',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{template.title}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {template.category}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{template.description}</p>
                  </button>
                ))}
              </div>
            </TabsContent>
          </div>

          <div className="flex min-h-0 flex-col gap-2">
            <span className="text-xs text-muted-foreground">预览与提示词段落</span>
            <LayoutSpecPreview spec={spec} />

            {spec.objects.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">物体列表</span>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
                  {spec.objects.map((object, index) => (
                    <div
                      key={object.id}
                      className={cn(
                        'flex items-center gap-1.5 border-b border-border/60 px-2 py-1 last:border-b-0',
                        object.id === selectedId ? 'bg-accent' : '',
                      )}
                      onClick={() => setSelectedId(object.id)}
                    >
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: getLayoutBoxColor(index) }} />
                      <Input
                        value={object.label}
                        onChange={(event) => handleRenameObject(object.id, event.target.value)}
                        className="h-6 flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteObject(object.id);
                        }}
                        aria-label={`删除 ${object.label}`}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Tabs>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <Button type="button" size="sm" variant="ghost" onClick={() => void handleSaveAsset()} disabled={empty}>
          <Save className="mr-1 size-3.5" />
          存入素材库
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="button" size="sm" onClick={handleConfirm} disabled={empty}>
          <Check className="mr-1 size-3.5" />
          应用构图
        </Button>
      </div>

      <AgentTextAssetPickerDialog
        open={assetPickerOpen}
        onOpenChange={setAssetPickerOpen}
        onConfirm={handleAssetConfirm}
      />
    </>
  );
}

export function LayoutSpecDialog({
  open,
  onOpenChange,
  initialSpec,
  backgroundImageUrl,
  defaultAspectRatio,
  onConfirm,
}: LayoutSpecDialogProps) {
  const handleConfirm = useCallback(
    (spec: LayoutSpec) => {
      onConfirm(spec);
      onOpenChange(false);
    },
    [onConfirm, onOpenChange],
  );

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate className="size-4" />
            构图模式
          </DialogTitle>
          <DialogDescription>
            用包围盒描述物体的位置、相对尺寸与空间关系，确认后会作为布局段落拼进提示词。
          </DialogDescription>
        </DialogHeader>

        {/* DialogContent 在关闭时不渲染子树，因此每次打开都是全新挂载，状态天然重置 */}
        <LayoutSpecDialogBody
          initialSpec={initialSpec}
          backgroundImageUrl={backgroundImageUrl}
          defaultAspectRatio={defaultAspectRatio}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      </DialogContent>
    </Dialog>
  );
}
