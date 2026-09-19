'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Download,
  ExternalLink,
  ImageIcon,
  Info,
  Package,
  RefreshCw,
  Save,
  Settings,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PluginsSettings } from '@/components/settings/PluginsSettings';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { BackupProgress } from '@/components/BackupProgress';
import { ProviderSettingsPanel } from '@/components/ProviderSettingsPanel';
import {
  DEFAULT_DEFAULTS,
  deriveImageAndTextModels,
  isSliceCapableImageModel,
  loadRegistry,
  saveRegistry,
  type DefaultModels,
  type ImageModelConfig,
  type TextModelConfig,
} from '@/lib/nova-models';
import {
  isCompleteProvider,
  type ProviderConfig,
} from '@/lib/provider-registry';

import { syncDynamicModelExports } from '@/lib/gemini-config';
import { exportAllData, importAllData, downloadBlob, generateBackupFilename, type BackupProgress as BackupProgressType } from '@/lib/backup-utils';
import { checkModelsAvailability, type ModelStatus } from '@/lib/ccode-task-client';
import { hasAnyApiKey } from '@/lib/settings-storage';
import { BA_RANDOM_URL, BING_WALLPAPER_URL } from '@/lib/constants';
import { PROMPT_DATA_SOURCES, getPromptSourceLabel } from '@/lib/prompt-gallery-data';

/** 设置弹层的页签。调用方可以指定打开时落在哪一页。 */
export type SettingsTab = 'models' | 'plugins' | 'backup' | 'about';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApiKeyChange?: (hasKey: boolean) => void;
  /** 打开时默认停在哪一页，缺省「模型配置」 */
  initialTab?: SettingsTab;
}

function isCompleteImageModel(model: ImageModelConfig): boolean {
  return Boolean(model.name.trim() && model.modelId.trim() && model.apiKey.trim() && model.baseUrl.trim());
}

function isCompleteTextModel(model: TextModelConfig): boolean {
  return Boolean(model.name.trim() && model.modelId.trim() && model.apiKey.trim() && model.baseUrl.trim());
}

function getImageModelLabel(models: ImageModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function getTextModelLabel(models: TextModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function modelPickerOptions(models: Array<{ id: string; name: string; modelId: string }>): { value: string; label: string }[] {
  return models.map((model) => ({
    value: model.id,
    label: model.name.trim() || model.modelId,
  }));
}

function normalizeDefaults(
  defaults: DefaultModels,
  imageModels: ImageModelConfig[],
  textModels: TextModelConfig[],
): DefaultModels {
  const completeImageModels = imageModels.filter(isCompleteImageModel);
  const completeTextModels = textModels.filter(isCompleteTextModel);
  const sliceCapableImageModels = completeImageModels.filter(isSliceCapableImageModel);
  const firstImageModelId = completeImageModels[0]?.id || '';
  const firstTextModelId = completeTextModels[0]?.id || '';

  return {
    textToImage: completeImageModels.some((model) => model.id === defaults.textToImage) ? defaults.textToImage : firstImageModelId,
    imageToImage: completeImageModels.some((model) => model.id === defaults.imageToImage) ? defaults.imageToImage : firstImageModelId,
    reversePrompt: completeTextModels.some((model) => model.id === defaults.reversePrompt) ? defaults.reversePrompt : firstTextModelId,
    agent: completeTextModels.some((model) => model.id === defaults.agent) ? defaults.agent : firstTextModelId,
    promptOptimize: completeTextModels.some((model) => model.id === defaults.promptOptimize) ? defaults.promptOptimize : firstTextModelId,
    imageDescribe: completeTextModels.some((model) => model.id === defaults.imageDescribe) ? defaults.imageDescribe : firstTextModelId,
    sliceDecomposition: completeTextModels.some((model) => model.id === defaults.sliceDecomposition) ? defaults.sliceDecomposition : firstTextModelId,
    sliceReconstruct: completeTextModels.some((model) => model.id === defaults.sliceReconstruct) ? defaults.sliceReconstruct : firstTextModelId,
    // 切图的图片编辑只能落在 openai 协议模型上；没有这类模型时留空并在切图页提示
    sliceImageEdit: sliceCapableImageModels.some((model) => model.id === defaults.sliceImageEdit)
      ? defaults.sliceImageEdit
      : (sliceCapableImageModels[0]?.id || ''),
  };
}

export function SettingsModal({ isOpen, onClose, onApiKeyChange, initialTab = 'models' }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  // 每次打开都回到调用方指定的那一页：从「插件凭据未配置」的提示条点进来要直达插件页。
  // 用「渲染期按 prop 变化调整 state」而不是 effect，避免先渲染出模型页再跳一帧。
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setTab(initialTab);
  }

  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [defaults, setDefaults] = useState<DefaultModels>(DEFAULT_DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [checkingModels, setCheckingModels] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<ModelStatus[] | null>(null);
  const [modelCheckError, setModelCheckError] = useState<string | null>(null);

  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [initialSavedSnapshot, setInitialSavedSnapshot] = useState<string>('');

  const [backupProgress, setBackupProgress] = useState<BackupProgressType>({ percent: 0, message: '' });
  const [isBackupActive, setIsBackupActive] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupSuccess, setBackupSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { imageModels, textModels } = useMemo(
    () => deriveImageAndTextModels(providers),
    [providers],
  );

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isOpen) return;
    const registry = loadRegistry();
    const nextProviders = registry.providers || [];
    const nextDefaults = normalizeDefaults(registry.defaults, registry.imageModels, registry.textModels);
    setProviders(nextProviders);
    setSelectedProviderId(nextProviders[0]?.id || '');
    setDefaults(nextDefaults);
    setInitialSavedSnapshot(JSON.stringify({ providers: nextProviders, defaults: nextDefaults }));
    setError(null);
    setSuccess(null);
    setModelStatuses(null);
    setModelCheckError(null);
    setBackupError(null);
    setBackupSuccess(null);
    setShowUnsavedConfirm(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setDefaults((prev) => {
      const next = normalizeDefaults(prev, imageModels, textModels);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [imageModels, isOpen, textModels]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const isDirty = useMemo(() => {
    if (!isOpen || !initialSavedSnapshot) return false;
    return JSON.stringify({ providers, defaults }) !== initialSavedSnapshot;
  }, [isOpen, initialSavedSnapshot, providers, defaults]);

  const persistRegistry = (): boolean => {
    if (!providers.some(isCompleteProvider)) {
      setError('至少完成一个供应商的名称、Base URL 和 API Key');
      return false;
    }
    if (!imageModels.some(isCompleteImageModel)) {
      setError('请至少给一个模型勾选「图片」用途');
      return false;
    }
    if (!textModels.some(isCompleteTextModel)) {
      setError('请至少给一个模型勾选「文本」用途');
      return false;
    }

    const nextDefaults = normalizeDefaults(defaults, imageModels, textModels);
    const registry = {
      providers,
      imageModels,
      textModels,
      defaults: nextDefaults,
    };

    saveRegistry(registry);
    syncDynamicModelExports();
    window.dispatchEvent(new Event('nova-model-registry-updated'));
    onApiKeyChange?.(hasAnyApiKey());
    setSuccess('设置已保存');
    setError(null);
    setModelStatuses(null);
    setModelCheckError(null);
    setInitialSavedSnapshot(JSON.stringify({ providers, defaults: nextDefaults }));
    return true;
  };

  const handleCheckModels = async () => {
    const configuredModels = [
      ...imageModels.filter(isCompleteImageModel),
      ...textModels.filter(isCompleteTextModel),
    ];
    if (configuredModels.length === 0) {
      setModelCheckError('请先完成至少一个图片模型或文本模型配置');
      return;
    }

    setCheckingModels(true);
    setModelCheckError(null);
    setModelStatuses(null);
    try {
      const statuses = await checkModelsAvailability(configuredModels.map((model) => model.id));
      setModelStatuses(statuses);
    } catch (err) {
      setModelCheckError(err instanceof Error ? err.message : '检查模型失败');
    } finally {
      setCheckingModels(false);
    }
  };

  const handleExport = async (configOnly = false) => {
    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const blob = await exportAllData((progress) => setBackupProgress(progress), { includeImages: !configOnly });
      const filename = generateBackupFilename(configOnly);
      downloadBlob(blob, filename);
      setBackupSuccess(`数据已成功导出为 ${filename}`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setIsBackupActive(false);
    }
  };

  const handleImport = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setBackupError('请选择有效的备份文件（.zip 格式）');
      return;
    }

    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const warnings = await importAllData(file, (progress) => setBackupProgress(progress));

      setBackupSuccess(warnings.length > 0
        ? `数据已导入，但有 ${warnings.length} 项提示：${warnings.join('；')}。页面将在 2 秒后刷新。`
        : '数据已成功导入，页面将在 2 秒后刷新。');
      // 立即复位处理中状态：BackupProgress 卸载时会移除 beforeunload 监听，
      // 否则 2 秒后的刷新（以及窗口关闭）会被拦截，页面卡死在 100%
      setIsBackupActive(false);

      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导入失败');
      setIsBackupActive(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleImport(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const completeImageOptions = modelPickerOptions(imageModels.filter(isCompleteImageModel));
  const completeTextOptions = modelPickerOptions(textModels.filter(isCompleteTextModel));
  // 切图的图片编辑只能落在 openai 协议模型上（带 mask 的 /v1/images/edits）
  const sliceCapableImageOptions = modelPickerOptions(
    imageModels.filter((model) => isCompleteImageModel(model) && isSliceCapableImageModel(model)),
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open, eventDetails) => {
      if (!open) {
        if (isBackupActive) {
          eventDetails.cancel();
          return;
        }
        if (isDirty) {
          eventDetails.cancel();
          setShowUnsavedConfirm(true);
        } else {
          onClose();
        }
      }
    }}>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden p-0 pt-0 gap-0 sm:max-w-5xl">
        <DialogHeader className="p-4 pb-3">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-muted-foreground" />
            <DialogTitle>设置</DialogTitle>
          </div>
          <DialogDescription>一个供应商一把 Key。拉取或添加模型后配置为文本或图片模型。至少配置一个文本模型和一个图片模型后，外部功能才会解锁。</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={value => setTab(value as SettingsTab)} className="min-h-0 flex-1 gap-0">
          <TabsList className="w-full rounded-none border-b bg-transparent h-auto p-0">
            <TabsTrigger value="models" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <ImageIcon className="w-4 h-4" />
              模型配置
            </TabsTrigger>
            <TabsTrigger value="plugins" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Package className="w-4 h-4" />
              插件
            </TabsTrigger>
            <TabsTrigger value="backup" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Database className="w-4 h-4" />
              备份
            </TabsTrigger>
            <TabsTrigger value="about" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Info className="w-4 h-4" />
              关于
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="min-h-0 overflow-y-auto p-4 sm:p-6 mt-0 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">供应商配置</p>
                <p className="text-xs text-muted-foreground">同一把 Key 下配置文本与图片模型，支持灵活切换模型类型与调用协议。</p>
              </div>
              <Button onClick={persistRegistry} className="gap-2">
                <Save className="w-4 h-4" />
                保存设置
              </Button>
            </div>

            {error && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            {success && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">{success}</div>}

            <ProviderSettingsPanel
              providers={providers}
              selectedProviderId={selectedProviderId}
              onChange={setProviders}
              onSelect={setSelectedProviderId}
            />

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">默认模型</p>
                  <p className="text-xs text-muted-foreground">这里只会显示已经配置完整的模型。</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleCheckModels} disabled={checkingModels}>
                  <RefreshCw className={`w-4 h-4 ${checkingModels ? 'animate-spin' : ''}`} />
                  {checkingModels ? '检查中...' : '检查模型'}
                </Button>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">文生图默认模型</label>
                  <Select value={defaults.textToImage} onValueChange={(value) => setDefaults((prev) => ({ ...prev, textToImage: value }))} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">图生图默认模型</label>
                  <Select value={defaults.imageToImage} onValueChange={(value) => setDefaults((prev) => ({ ...prev, imageToImage: value }))} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">反推提示词默认模型</label>
                  <Select value={defaults.reversePrompt} onValueChange={(value) => setDefaults((prev) => ({ ...prev, reversePrompt: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Agent 默认模型</label>
                  <Select value={defaults.agent} onValueChange={(value) => setDefaults((prev) => ({ ...prev, agent: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">提示词优化默认模型</label>
                  <Select value={defaults.promptOptimize} onValueChange={(value) => setDefaults((prev) => ({ ...prev, promptOptimize: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">图片描述默认模型</label>
                  <Select value={defaults.imageDescribe} onValueChange={(value) => setDefaults((prev) => ({ ...prev, imageDescribe: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">AI 拆图默认模型</label>
                  <Select value={defaults.sliceDecomposition} onValueChange={(value) => setDefaults((prev) => ({ ...prev, sliceDecomposition: value }))} options={completeTextOptions} />
                  <p className="text-[11px] text-muted-foreground">UI设计模式：识别切片与背景候选，需要视觉能力</p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">网页复刻默认模型</label>
                  <Select value={defaults.sliceReconstruct} onValueChange={(value) => setDefaults((prev) => ({ ...prev, sliceReconstruct: value }))} options={completeTextOptions} />
                  <p className="text-[11px] text-muted-foreground">UI设计模式：多轮工具调用生成网页，建议用能力更强的模型</p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">切图图片编辑默认模型</label>
                  <Select value={defaults.sliceImageEdit} onValueChange={(value) => setDefaults((prev) => ({ ...prev, sliceImageEdit: value }))} options={sliceCapableImageOptions} />
                  <p className="text-[11px] text-muted-foreground">
                    {sliceCapableImageOptions.length === 0
                      ? '需要一个 OpenAI 协议的图片模型；Gemini / Grok 不支持带蒙版的局部编辑'
                      : 'AI 透明化与背景补齐使用，仅支持 OpenAI 协议'}
                  </p>
                </div>
              </div>

              {modelCheckError && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{modelCheckError}</div>}
              {modelStatuses && (
                <div className="grid gap-2 md:grid-cols-2">
                  {modelStatuses.map((status) => (
                    <div key={status.modelId} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{getTextModelLabel(textModels, status.modelId) ?? getImageModelLabel(imageModels, status.modelId) ?? status.actualName ?? status.modelId}</div>
                        <div className="truncate text-xs text-muted-foreground">{status.message || status.actualName || status.modelId}</div>
                      </div>
                      {status.available ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-destructive" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="plugins" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 mt-0">
            <PluginsSettings />
          </TabsContent>

          <TabsContent value="backup" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 mt-0">
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-base font-medium">数据备份与恢复</h3>
                <p className="text-sm text-muted-foreground">导出所有数据（模型配置、任务历史、设置、图片）为 ZIP 压缩包，或从备份文件恢复数据。</p>
              </div>

              <BackupProgress percent={backupProgress.percent} message={backupProgress.message} isActive={isBackupActive} />

              {backupSuccess && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-500 mt-0.5" />
                  <p className="text-sm text-emerald-900 dark:text-emerald-100">{backupSuccess}</p>
                </div>
              )}

              {backupError && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                  <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive break-all">{backupError}</p>
                </div>
              )}

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Download className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">导出数据</h4>
                    <p className="text-sm text-muted-foreground">将所有数据打包为 ZIP 文件下载到本地。全量备份包含模型配置、本地记录和画布图片/媒体文件，请自行保管。仅配置导出不含图片、媒体、素材与生成结果。</p>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => void handleExport(false)} disabled={isBackupActive} className="gap-2">
                        <Download className="w-4 h-4" />
                        全量备份
                      </Button>
                      <Button onClick={() => void handleExport(true)} disabled={isBackupActive} variant="outline" className="gap-2">
                        <Download className="w-4 h-4" />
                        仅配置导出（不含图片）
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Upload className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">导入数据</h4>
                    <p className="text-sm text-muted-foreground">从备份文件恢复数据。<span className="font-medium text-destructive">警告：这会覆盖现有数据。</span></p>
                    <input ref={fileInputRef} type="file" accept=".zip" onChange={handleFileSelect} className="hidden" />
                    <Button onClick={() => fileInputRef.current?.click()} disabled={isBackupActive} variant="outline" className="gap-2">
                      <Upload className="w-4 h-4" />
                      选择备份文件
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="about" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4 mt-0">
            <div className="space-y-4 text-sm">
              <h3 className="text-lg font-medium">Nova Studio <span className="text-xs text-muted-foreground font-normal">v{process.env.NEXT_PUBLIC_APP_VERSION}</span></h3>
              <p className="text-sm text-muted-foreground">
                项目地址：
                {' '}
                <a
                  href="https://github.com/tianjiangqiji/nova-image-studio"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  tianjiangqiji/nova-image-studio <ExternalLink className="w-3 h-3" />
                </a>
              </p>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  使用方法
                </summary>
                <ol className="mt-3 list-decimal list-inside space-y-2 text-muted-foreground">
                  <li>先添加供应商，填写 Base URL 和 API Key，读取模型后勾选文本 / 图片用途。</li>
                  <li>保存后，外部工作区只会显示这些配置完整的模型。</li>
                  <li>再为各工作流指定默认模型，即可开始生图、反推或 Agent 工作流。</li>
                </ol>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  数据来源
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>
                    <span className="text-foreground">提示词广场</span> - 提示词来源：
                    <ul className="mt-1 ml-5 list-disc list-inside space-y-1">
                      {PROMPT_DATA_SOURCES.map((source) => (
                        <li key={source.name}>
                          <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                            {getPromptSourceLabel(source.sourceUrl)} <ExternalLink className="w-3 h-3" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    <span className="text-foreground">随机图片 · BA人物</span> -{' '}
                    <a href={BA_RANDOM_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      img.catcdn.cn <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    <span className="text-foreground">随机图片 · Bing壁纸</span> -{' '}
                    <a href={BING_WALLPAPER_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      bing.img.run <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                </ul>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  隐私条款
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>本站为本地优先应用：模型配置、任务历史、设置与生成图片默认保存在你的浏览器本地。</li>
                  <li>每个模型的 API Key 和 Base URL 仅用于调用你自己配置的上游服务。</li>
                  <li>生图、反推、Agent、提示词优化等功能会把你当前选择的提示词、参考图或对话内容发送到对应模型配置的上游接口。</li>
                  <li>UI设计模式会把源图截图、切图资产总览图与对话内容发送到你配置的文本/图片模型；切图工作区与图片数据只存在本地 IndexedDB。</li>
                  <li>备份文件可能包含模型配置、本地任务记录与图片数据，请自行妥善保管。</li>
                </ul>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  参考项目
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>
                    项目仓库：
                    {' '}
                    <a href="https://github.com/tianjiangqiji/nova-image-studio" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      tianjiangqiji/nova-image-studio <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    基于
                    {' '}
                    <a href="https://github.com/aaronkwhite/nanobanana-studio-web" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      aaronkwhite/nanobanana-studio-web <ExternalLink className="w-3 h-3" />
                    </a>
                    {' '}
                    修改而来。
                  </li>
                  <li>
                    无限画布工作区参考
                    {' '}
                    <a href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      basketikun/infinite-canvas <ExternalLink className="w-3 h-3" />
                    </a>
                    。
                  </li>
                  <li>
                    UI设计模式（图片切图）参考
                    {' '}
                    <a href="https://github.com/50kg/image-to-slice" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      50kg/image-to-slice <ExternalLink className="w-3 h-3" />
                    </a>
                    {' '}
                    实现。原项目是 Figma 插件，本项目移植了其中与 Figma 无关的核心切图流程。
                  </li>
                  <li>
                    切图的本地 SVG 矢量化基于
                    {' '}
                    <a href="https://github.com/jankovicsandras/imagetracerjs" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      jankovicsandras/imagetracerjs <ExternalLink className="w-3 h-3" />
                    </a>
                    。
                  </li>
                </ul>
              </details>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>

      <Dialog open={showUnsavedConfirm} onOpenChange={(open) => {
        if (!open) setShowUnsavedConfirm(false);
      }}>
        <DialogContent className="sm:max-w-md z-[60]" overlayClassName="bg-black/30">
          <DialogHeader>
            <DialogTitle>未保存的更改</DialogTitle>
            <DialogDescription>
              当前有未保存的设置内容，是否在关闭前保存？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-4">
            <Button
              variant="outline"
              size="default"
              onClick={() => setShowUnsavedConfirm(false)}
            >
              取消
            </Button>
            <Button
              variant="outline"
              size="default"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => {
                setShowUnsavedConfirm(false);
                onClose();
              }}
            >
              不保存并关闭
            </Button>
            <Button
              size="default"
              onClick={() => {
                const saved = persistRegistry();
                if (saved) {
                  setShowUnsavedConfirm(false);
                  onClose();
                } else {
                  setShowUnsavedConfirm(false);
                }
              }}
            >
              保存并关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
