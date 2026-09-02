'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ImageGenerationWorkbench } from '@/components/ImageGenerationWorkbench';
import { PluginWorkbench } from '@/components/plugin/PluginWorkbench';
import { PluginHistoryList } from '@/components/plugin/PluginHistoryList';
import { ReversePromptForm } from '@/components/ReversePromptForm';
import { GifGenerationWorkspace } from '@/components/GifGenerationWorkspace';
import { AgentChatWorkspace } from '@/components/agent/AgentChatWorkspace';
import { SessionSwitcher } from '@/components/agent/SessionSwitcher';
import { AssetsWorkspace } from '@/components/assets/AssetsWorkspace';
import { CanvasWorkspace } from '@/components/canvas/CanvasWorkspace';
import { SliceWorkspace } from '@/components/slice/SliceWorkspace';
import { PromptGallery } from '@/components/PromptGallery';
import { SettingsModal, type SettingsTab } from '@/components/SettingsModal';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { useQueueStatus } from '@/hooks/useQueueStatus';
import { useWideMode } from '@/hooks/useWideMode';
import { useServerTaskPolling } from '@/hooks/useServerTaskPolling';
import { useWorkspaceJobs } from '@/hooks/useWorkspaceJobs';
import { WorkspaceHeader, type WorkspaceHeaderRef } from '@/components/workspace/WorkspaceHeader';
import { WorkspaceModeTabs } from '@/components/workspace/WorkspaceModeTabs';
import { HistoryJobList, type GenerationHistoryFilter, type HistoryClearScope } from '@/components/workspace/results/HistoryJobList';
import { PromptGalleryAccessDialog, usePromptGalleryAccess } from '@/components/workspace/PromptGalleryAccess';
import { usePromptGalleryConfig } from '@/hooks/usePromptGalleryConfig';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { Toast, type ToastData } from '@/components/workspace/Toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Shuffle, Settings, User, Wallpaper, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { getNovaTask } from '@/lib/ccode-task-client';
import { finalizeCompletedServerTask } from '@/lib/workspace-task-service';
import { classifyTaskFailure } from '@/lib/task-failure';
import type { RefImageData, StoredJob } from '@/lib/job-store';
import type { PluginJob } from '@/lib/plugin-job-store';
import { subscribeImageActionToasts, subscribeUseAsImageReference } from '@/lib/image-actions';
import {
  submitImageToImage,
  submitTextToImage,
  type SubmitActions,
} from '@/lib/workspace-task-service';
import { cn } from '@/lib/utils';
import { BA_RANDOM_URL, BING_WALLPAPER_URL } from '@/lib/constants';
import { getActiveAgentSessionId, setActiveAgentSessionId } from '@/lib/agent-sessions';
import { setAgentSession } from '@/lib/agent-context-store';

export function WorkspaceShell() {
  const queueStatus = useQueueStatus();
  const { wideMode, toggleWideMode } = useWideMode();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置弹层打开时停在哪一页。插件凭据的提示条要直达插件页，其余入口都回到模型配置。 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('models');
  const openSettings = useCallback((tab: SettingsTab = 'models') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const [missingApiKeyDialogOpen, setMissingApiKeyDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'image-generation' | 'video-generation' | 'agent' | 'canvas' | 'image-to-slice' | 'assets' | 'reverse-prompt' | 'gif' | 'prompt-gallery'>('agent');
  const [videoInitialJob, setVideoInitialJob] = useState<PluginJob | null>(null);
  const [generationHistoryFilter, setGenerationHistoryFilter] = useState<GenerationHistoryFilter>('all');
  const [generationClearScope, setGenerationClearScope] = useState<HistoryClearScope | null>(null);
  const [referenceDraft, setReferenceDraft] = useState<{ id: number; refImages: RefImageData[]; prompt?: string } | null>(null);
  const workspace = useWorkspaceJobs();
  const galleryConfig = usePromptGalleryConfig();
  const promptGallery = usePromptGalleryAccess(galleryConfig.mode, galleryConfig.passwordEnabled, setError, () => setActiveTab('prompt-gallery'));
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sessionId = getActiveAgentSessionId();

    void Promise.resolve(setAgentSession(sessionId)).then(() => {
      if (!cancelled) setActiveSessionId(sessionId);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAgentSessionChange = useCallback(async (sessionId: string) => {
    if (!sessionId || sessionId === activeSessionId) return;
    await setAgentSession(sessionId);
    setActiveAgentSessionId(sessionId);
    setActiveSessionId(sessionId);
  }, [activeSessionId]);

  // Toast state
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastIdRef = useRef(0);
  const headerRef = useRef<WorkspaceHeaderRef>(null);
  const referenceDraftIdRef = useRef(0);

  const showToast = useCallback((message: string, type: ToastData['type']) => {
    const id = `toast-${++toastIdRef.current}`;
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => subscribeImageActionToasts(detail => showToast(detail.message, detail.type)), [showToast]);

  useEffect(() => subscribeUseAsImageReference(detail => {
    workspace.setRetryData(null);
    setReferenceDraft({ id: ++referenceDraftIdRef.current, refImages: detail.refImages, prompt: detail.prompt });
    setActiveTab('image-generation');
  }), [workspace]);

  const handleImageDraftConsumed = useCallback(() => {
    workspace.setRetryData(null);
    setReferenceDraft(null);
  }, [workspace]);

  // Checking debounce state
  const [checkingJobIds, setCheckingJobIds] = useState<Set<string>>(new Set());
  // Cooldown state: jobId -> cooldown end timestamp
  const [cooldowns, setCooldowns] = useState<Map<string, number>>(new Map());

  const submitActions = useMemo<SubmitActions>(() => ({
    addJob: workspace.addJob,
    replaceJob: workspace.replaceJob,
    completeJob: workspace.completeJob,
    failJob: workspace.failJob,
    getJob: workspace.getJob,
  }), [workspace.addJob, workspace.completeJob, workspace.failJob, workspace.replaceJob, workspace.getJob]);

  useServerTaskPolling(workspace.jobs, submitActions, workspace.hasJob);

  const handleSubmitError = useCallback((message: string) => {
    if (message === '请先配置 API 密钥') {
      setError(null);
      setMissingApiKeyDialogOpen(true);
      return;
    }
    showToast(message, 'error');
  }, [showToast]);

  const handleCheckStatus = useCallback(async (job: StoredJob) => {
    if (!job.serverTaskId || checkingJobIds.has(job.id) || cooldowns.has(job.id)) return;
    setCheckingJobIds(prev => new Set(prev).add(job.id));
    // Set 5s cooldown
    setCooldowns(prev => new Map(prev).set(job.id, Date.now() + 5000));
    try {
      const task = await getNovaTask(job.serverTaskId);
      if (task.status === 'completed') {
        showToast('生成完成，正在下载图片…', 'success');
        await finalizeCompletedServerTask(job, task, submitActions);
      } else if (task.status === 'failed' || task.status === 'expired') {
        const { terminal } = classifyTaskFailure(task);
        const message = task.error || task.warning
          || (task.status === 'expired' ? '该任务已超出取回时间' : '任务失败');
        void submitActions.failJob(job.id, message, { terminal });
        showToast(`任务失败：${message}`, 'error');
      } else if (task.status === 'processing') {
        submitActions.replaceJob(job.id, cur => ({ ...cur, status: 'processing' }));
        showToast('任务正在生成中，请稍候…', 'info');
      } else if (task.status === 'queued' || task.status === '排队中') {
        submitActions.replaceJob(job.id, cur => ({ ...cur, status: '排队中' }));
        showToast('任务排队中，请耐心等待…', 'info');
      }
    } catch {
      showToast('查询失败，请稍后重试', 'error');
    } finally {
      setCheckingJobIds(prev => { const next = new Set(prev); next.delete(job.id); return next; });
      // Cleanup cooldown after 5s
      setTimeout(() => {
        setCooldowns(prev => {
          const next = new Map(prev);
          next.delete(job.id);
          return next;
        });
      }, 5000);
    }
  }, [checkingJobIds, cooldowns, submitActions, showToast]);

  const generationInitialData = useMemo(() => (
    workspace.retryData
      ? {
        prompt: workspace.retryData.prompt,
        outputSize: workspace.retryData.outputSize,
        customSize: workspace.retryData.customSize,
        aspectRatio: workspace.retryData.aspectRatio,
        temperature: workspace.retryData.temperature,
        model: workspace.retryData.model,
        gptImageQuality: workspace.retryData.gptImageQuality,
        gptImageStyle: workspace.retryData.gptImageStyle,
        gptImageBackground: workspace.retryData.gptImageBackground,
        parallelCount: workspace.retryData.parallelCount,
        refImages: workspace.retryData.refImages,
      }
      : undefined
  ), [workspace.retryData]);

  const generationJobs = useMemo(
    () => [...workspace.textJobs, ...workspace.imageJobs].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [workspace.imageJobs, workspace.textJobs]
  );
  const filteredGenerationJobs = useMemo(
    () => generationHistoryFilter === 'all'
      ? generationJobs
      : generationJobs.filter(job => job.mode === generationHistoryFilter),
    [generationHistoryFilter, generationJobs]
  );
  const generationEmptyDescription = generationHistoryFilter === 'text-to-image'
    ? '提交一段文字描述来生成图片'
    : generationHistoryFilter === 'image-to-image'
      ? '添加参考图并输入描述来转换'
      : '输入提示词，或添加参考图后再生成';
  const clearScopeLabel = generationClearScope === 'all'
    ? '文生图和图生图'
    : generationClearScope === 'text-to-image'
      ? '文生图'
      : generationClearScope === 'image-to-image'
        ? '图生图'
        : '当前模式';

  const handleConfirmClearGeneration = useCallback(() => {
    if (!generationClearScope) return;
    const scope = generationClearScope;
    setGenerationClearScope(null);
    if (scope === 'all') {
      void Promise.all([
        workspace.clearJobsByMode('text-to-image'),
        workspace.clearJobsByMode('image-to-image'),
      ]);
      return;
    }
    if (scope === 'text-to-image' || scope === 'image-to-image') {
      void workspace.clearJobsByMode(scope);
    }
  }, [generationClearScope, workspace]);

  return (
    <div
      className={cn(
        'mx-auto flex min-h-screen w-full flex-col gap-4 overflow-x-hidden px-3 py-3 transition-[max-width] duration-200 sm:gap-5 sm:px-6 sm:py-5 lg:px-8',
        wideMode ? 'max-w-none xl:h-dvh xl:min-h-0 xl:gap-3 xl:py-3 xl:overflow-hidden' : 'max-w-5xl',
        !wideMode && activeTab === 'agent' && 'h-dvh min-h-0 overflow-hidden'
      )}
    >
      <div className={cn(
        'flex-1 bg-transparent shadow-none sm:rounded-3xl sm:bg-card/95 sm:shadow-sm sm:border sm:border-border/70',
        wideMode && 'flex min-h-0 flex-col',
        !wideMode && activeTab === 'agent' && 'flex min-h-0 flex-col'
      )}>
        <div className={cn(
          'p-0 sm:p-5',
          wideMode
            ? 'flex h-full flex-1 flex-col min-h-0 sm:p-3'
            : activeTab === 'agent'
              ? 'flex h-full flex-1 flex-col min-h-0 gap-4'
              : 'space-y-4'
        )}>
          <WorkspaceHeader
            ref={headerRef}
            queueStatus={queueStatus}
            wideMode={wideMode}
            onToggleWideMode={toggleWideMode}
            onOpenSettings={() => openSettings()}
            onLogoClick={promptGallery.handlePromptGalleryEntry}
            sidebarMode={wideMode}
          />

          <Tabs
            value={activeTab}
            onValueChange={value => setActiveTab(value as typeof activeTab)}
            orientation={wideMode ? 'vertical' : 'horizontal'}
            className={cn(
              wideMode
                ? 'gap-4 xl:flex-row xl:flex-1 xl:min-h-0'
                : activeTab === 'agent'
                  ? 'gap-2 flex flex-col flex-1 min-h-0'
                  : 'gap-2'
            )}
          >
            <div className={cn('flex flex-col', wideMode && 'self-stretch sticky top-4 h-full xl:shrink-0')}>
              {wideMode && (
                <button
                  type="button"
                  onClick={promptGallery.handlePromptGalleryEntry}
                  className="flex items-center gap-2 px-2 pt-3 pb-1 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Nova Studio logo"
                >
                  <img
                    src="/favicon.png"
                    alt="Nova Studio"
                    className="h-8 w-8 shrink-0 rounded-lg object-cover ring-1 ring-border/60"
                  />
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold tracking-tight leading-tight">Nova Studio</h2>
                    <p className="truncate text-[11px] text-muted-foreground leading-tight">批量 API 图像生成器</p>
                  </div>
                </button>
              )}
              <div className={cn(wideMode ? 'flex flex-col py-4 flex-1' : 'flex flex-col py-1')}>
                <WorkspaceModeTabs wideMode={wideMode} showPromptGallery={promptGallery.showPromptGallery} />
              </div>

              {wideMode && (
                <div className="hidden flex-col gap-1 xl:flex">
                  <div className="flex flex-col gap-1">
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger
                        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full justify-start gap-2 rounded-xl px-3 text-xs')}
                        title="随机图片"
                        aria-label="随机图片"
                      >
                        <Shuffle className="size-4 shrink-0" />
                        随机图片
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" sideOffset={4}>
                        <DropdownMenuItem onClick={() => headerRef.current?.openRandomImage(BA_RANDOM_URL, 'BA人物')}>
                          <User className="w-4 h-4" />
                          BA人物
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => headerRef.current?.openRandomImage(BING_WALLPAPER_URL, 'Bing壁纸')}>
                          <Wallpaper className="w-4 h-4" />
                          Bing壁纸
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="flex flex-col gap-1 [&_button]:w-full [&_button]:justify-start [&_button]:rounded-xl [&_button_svg]:size-4 [&_button_svg]:shrink-0">
                    <ThemeToggle />
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2 rounded-xl px-3 text-xs" onClick={toggleWideMode}>
                      {wideMode ? <PanelLeftClose className="size-4 shrink-0" /> : <PanelLeftOpen className="size-4 shrink-0" />}
                      {wideMode ? '退出宽屏' : '宽屏'}
                    </Button>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2 rounded-xl px-3 text-xs" onClick={() => openSettings()}>
                      <Settings className="size-4 shrink-0" />
                      设置
                    </Button>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="h-px bg-border" />
                    {queueStatus ? (
                      <div className="flex flex-col gap-1">
                        <span className="rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
                          并发 {queueStatus.processingCount}
                        </span>
                        <span className={cn(
                          'rounded-full px-3 py-1 text-center text-xs',
                          typeof queueStatus.queuedCount === 'number' && typeof queueStatus.maxQueueSize === 'number' && queueStatus.queuedCount >= queueStatus.maxQueueSize
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-muted text-muted-foreground'
                        )}>
                          排队 {queueStatus.queuedCount}{typeof queueStatus.maxQueueSize === 'number' ? ` (最大${queueStatus.maxQueueSize})` : ''}
                        </span>
                        <span className="rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
                          状态 {queueStatus.acceptingNewTasks ? '开启' : '关闭'}
                        </span>
                        {queueStatus.serverMessage && (
                          <span className="rounded-xl bg-destructive/10 px-3 py-1 text-center text-xs text-destructive">
                            {queueStatus.serverMessage}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-center text-xs text-muted-foreground">排队状态未知</span>
                    )}
                  </div>
                </div>)}
            </div>

            <div className={cn(
              wideMode && 'xl:flex xl:flex-1 xl:min-h-0 xl:min-w-0',
              wideMode && (activeTab === 'image-generation' || activeTab === 'agent'
                ? 'xl:overflow-hidden'
                : 'xl:overflow-y-auto xl:overflow-x-hidden'),
              !wideMode && activeTab === 'agent' && 'flex flex-1 flex-col min-h-0'
            )}>
              <TabsContent value="image-generation" keepMounted className={cn(wideMode ? 'space-y-6 xl:flex xl:min-h-0 xl:space-y-0' : 'space-y-3')}>
                <div className={cn(wideMode ? 'grid items-start gap-5 xl:h-full xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(460px,0.95fr)_minmax(0,1.35fr)] xl:items-stretch' : 'space-y-3')}>
                  <div className={cn(wideMode && 'xl:h-full xl:min-h-0 xl:overflow-y-auto xl:pr-1')}>
                    <ImageGenerationWorkbench
                      wideMode={wideMode}
                      onSubmitText={data => void submitTextToImage(data, submitActions, handleSubmitError)}
                      onSubmitImage={data => void submitImageToImage(data, submitActions, handleSubmitError)}
                      disabled={!workspace.hasApiKey}
                      onConfigureApiKey={() => openSettings()}
                      onDraftConsumed={handleImageDraftConsumed}
                      initialData={generationInitialData}
                      referenceDraft={referenceDraft}
                    />
                  </div>
                  <HistoryJobList
                    wideMode={wideMode}
                    active={activeTab === 'image-generation'}
                    title="生图任务"
                    mode="text-to-image"
                    historyFilter={generationHistoryFilter}
                    onHistoryFilterChange={setGenerationHistoryFilter}
                    hasAnyJobs={generationJobs.length > 0}
                    emptyDescription={generationEmptyDescription}
                    jobs={filteredGenerationJobs}
                    loadedImages={workspace.loadedImages}
                    checkingJobIds={checkingJobIds}
                    cooldowns={cooldowns}
                    onRetry={job => {
                      workspace.retryJob(job);
                      setActiveTab('image-generation');
                    }}
                    onRetryDownload={workspace.retryDownload}
                    onClear={jobId => void workspace.removeJob(jobId)}
                    onClearAll={scope => setGenerationClearScope(scope)}
                    onCancel={jobId => workspace.setCancelJobId(jobId)}
                    onCheckStatus={handleCheckStatus}
                  />
                </div>
              </TabsContent>

              <TabsContent
                value="agent"
                keepMounted
                className={cn('flex-1 flex flex-col min-h-0', wideMode && 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col')}
              >
                {activeSessionId && (
                  <div className="flex min-h-0 flex-1 gap-3">
                    <SessionSwitcher
                      activeSessionId={activeSessionId}
                      onSessionChange={handleAgentSessionChange}
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <AgentChatWorkspace
                        key={activeSessionId}
                        activeSessionId={activeSessionId}
                        wideMode={wideMode}
                        disabled={!workspace.hasApiKey}
                        onConfigureApiKey={() => openSettings()}
                      />
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="video-generation" keepMounted className={cn(wideMode ? 'space-y-6 xl:flex xl:min-h-0 xl:space-y-0' : 'space-y-3')}>
                <div className={cn(wideMode ? 'grid items-start gap-5 xl:h-full xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(460px,0.95fr)_minmax(0,1.35fr)] xl:items-stretch' : 'space-y-3')}>
                  <div className={cn(wideMode && 'xl:h-full xl:min-h-0 xl:overflow-y-auto xl:pr-1')}>
                    <PluginWorkbench
                      wideMode={wideMode}
                      onConfigureCredential={() => openSettings('plugins')}
                      showToast={showToast}
                      initialJob={videoInitialJob}
                    />
                  </div>
                  <PluginHistoryList
                    wideMode={wideMode}
                    active={activeTab === 'video-generation'}
                    showToast={showToast}
                    onReuseParams={job => {
                      setVideoInitialJob(job);
                      setActiveTab('video-generation');
                    }}
                  />
                </div>
              </TabsContent>

              <TabsContent value="canvas" keepMounted className={cn('min-h-0', wideMode ? 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col' : 'space-y-6')}>
                <CanvasWorkspace
                  wideMode={wideMode}
                  onConfigureApiKey={() => openSettings()}
                  onEnableWideMode={() => { if (!wideMode) toggleWideMode(); }}
                  showToast={showToast}
                  showPromptGallery={promptGallery.showPromptGallery}
                />
              </TabsContent>

              <TabsContent value="image-to-slice" keepMounted className={cn(wideMode ? 'space-y-6 xl:min-h-0 xl:flex xl:flex-col' : 'space-y-6')}>
                <SliceWorkspace
                  wideMode={wideMode}
                  onConfigureApiKey={() => openSettings()}
                  onEnableWideMode={() => { if (!wideMode) toggleWideMode(); }}
                  showToast={showToast}
                />
              </TabsContent>

              <TabsContent value="assets" keepMounted className={cn(wideMode ? 'space-y-6 xl:min-h-0 xl:min-w-0 xl:flex xl:flex-col' : 'space-y-6')}>
                <AssetsWorkspace wideMode={wideMode} active={activeTab === 'assets'} />
              </TabsContent>

              <TabsContent value="reverse-prompt" keepMounted className={cn(wideMode ? 'space-y-6 xl:min-h-0 xl:flex xl:flex-col' : 'space-y-6')}>
                <ReversePromptForm
                  wideMode={wideMode}
                  disabled={!workspace.hasApiKey}
                  onConfigureApiKey={() => openSettings()}
                />
              </TabsContent>

              <TabsContent value="gif" keepMounted className={cn(wideMode ? 'space-y-6 xl:min-h-0 xl:flex xl:flex-col' : 'space-y-6')}>
                <GifGenerationWorkspace
                  wideMode={wideMode}
                  hasApiKey={workspace.hasApiKey}
                  onConfigureApiKey={() => openSettings()}
                  onError={message => showToast(message, 'error')}
                  showToast={showToast}
                />
              </TabsContent>

              {promptGallery.showPromptGallery && (
                <TabsContent value="prompt-gallery" keepMounted>
                  <div className={cn('bg-transparent p-0 shadow-none sm:rounded-2xl sm:bg-card sm:p-4 sm:shadow-sm sm:border sm:border-border', wideMode && 'sm:p-5')}>
                    <PromptGallery wideMode={wideMode} />
                  </div>
                </TabsContent>
              )}
            </div>
          </Tabs>
        </div>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onApiKeyChange={workspace.setHasApiKey}
        initialTab={settingsTab}
      />

      <MissingApiKeyDialog
        open={missingApiKeyDialogOpen}
        onOpenChange={setMissingApiKeyDialogOpen}
        onConfigure={() => openSettings()}
      />

      <PromptGalleryAccessDialog
        open={promptGallery.passwordDialogOpen}
        passwordInput={promptGallery.passwordInput}
        onPasswordChange={promptGallery.setPasswordInput}
        onClose={() => promptGallery.setPasswordDialogOpen(false)}
        onSubmit={() => void promptGallery.handlePasswordSubmit()}
      />

      {workspace.cancelJobId && createPortal(
        <ConfirmDialog
          title="取消生成任务"
          message={
            <>
              取消后会删除本地任务记录并停止前端等待流程。
              <span className="mt-1 block text-warning">如果任务已进入服务端队列，可能仍会继续执行。</span>
            </>
          }
          confirmText="取消并删除"
          onConfirm={() => {
            const jobId = workspace.cancelJobId;
            workspace.setCancelJobId(null);
            if (jobId) {
              void workspace.removeJob(jobId);
            }
          }}
          onCancel={() => workspace.setCancelJobId(null)}
        />,
        document.body
      )}

      {generationClearScope && createPortal(
        <ConfirmDialog
          title="清空记录"
          message={`确定要清空${clearScopeLabel}历史记录吗？此操作无法撤销。`}
          confirmText="清空"
          onConfirm={handleConfirmClearGeneration}
          onCancel={() => setGenerationClearScope(null)}
        />,
        document.body
      )}

      {error && createPortal(
        <div className="fixed bottom-4 right-4 z-[10000] max-w-sm rounded-xl border border-destructive/20 bg-card px-4 py-3 text-sm text-destructive shadow-lg">
          {error}
        </div>,
        document.body
      )}

      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
