'use client';

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Pencil,
  RefreshCw,
  Trash2,
  Undo2,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AgentGenerationResult } from '@/components/agent/AgentGenerationResult';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { ImageHoverActions } from '@/components/workspace/results/ImageHoverActions';
import { cn, clampIndex } from '@/lib/utils';
import { renderReasoning, renderMarkdown } from '@/lib/render-reasoning';
import { handleMarkdownCodeCopyButtonClick } from '@/lib/markdown-code-copy';
import { getAgentImageBytes } from '@/lib/agent-context-store';
import type { AgentMessage, AgentImageRecord } from '@/lib/agent-chat-config';
import type { ImageActionPayload } from '@/lib/image-actions';

export interface AgentMessageBubbleProps {
  message: AgentMessage;
  imageMap: Map<string, AgentImageRecord>;
  sessionId: string;
  onWithdraw: (noteId: string) => void;
  messageActionsDisabled?: boolean;
  onReedit?: (messageId: string) => void;
  /** 非空闲阶段（生成中/提案确认中）禁止重新编辑，与 useAgentChat 的 phase 守卫一致 */
  reeditDisabled?: boolean;
  onCopy?: () => void;
  onDelete?: () => void;
  onRollback?: () => void;
  /** 仅最后一条用户消息会拿到该回调；见 useAgentChat 的 retryableMessageId */
  onRetry?: () => void;
  onRedescribe?: (imgId: string) => Promise<string>;
}

function getUsableDescription(description: string): string {
  const trimmed = description.trim();
  if (
    !trimmed ||
    trimmed === 'AI 未生成描述' ||
    trimmed === '(无描述)' ||
    trimmed === '(图片描述生成失败)'
  ) {
    return '';
  }
  return trimmed;
}

function getAgentImageSourceLabel(source: AgentImageRecord['source']): string {
  if (source === 'generated') return 'Agent 生成图片';
  if (source === 'asset') return '素材库导入';
  return 'Agent 上传图片';
}

export function AgentMessageBubble({
  message,
  imageMap,
  onWithdraw,
  messageActionsDisabled,
  onReedit,
  reeditDisabled,
  onCopy,
  onDelete,
  onRollback,
  onRetry,
  onRedescribe,
  sessionId,
}: AgentMessageBubbleProps) {
  const [previewImages, setPreviewImages] = useState<string[] | null>(null);
  const [previewSourceImages, setPreviewSourceImages] = useState<AgentImageRecord[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [descDialogImg, setDescDialogImg] = useState<{ imgId: string; description: string } | null>(null);
  const [descCopied, setDescCopied] = useState(false);
  const [isRedescribing, setIsRedescribing] = useState(false);
  const previewObjectUrlsRef = useRef<string[]>([]);
  const previewTokenRef = useRef(0);
  const mdContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mdContentRef.current;
    if (!el) return;

    const handler = (e: MouseEvent) => {
      if (!handleMarkdownCodeCopyButtonClick(e.target)) return;
      e.preventDefault();
    };

    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, []);

  const isGenerationResult = message.role === 'assistant' &&
    message.text &&
    message.text.includes('分析：') &&
    message.text.includes('优化提示词：') &&
    message.text.includes('结果：') &&
    message.imageIds &&
    message.imageIds.length > 0;

  // 缓存 Markdown / Reasoning 渲染结果，避免父组件重渲染时重复执行正则
  const renderedMarkdown = useMemo(() => renderMarkdown(message.text), [message.text]);
  const renderedReasoning = useMemo(() => message.reasoning ? renderReasoning(message.reasoning) : '', [message.reasoning]);

  const revokePreviewUrls = useCallback(() => {
    for (const url of previewObjectUrlsRef.current) URL.revokeObjectURL(url);
    previewObjectUrlsRef.current = [];
  }, []);

  const openPreview = useCallback(async (imgs: AgentImageRecord[], startIndex = 0) => {
    revokePreviewUrls();
    const token = ++previewTokenRef.current;
    const thumbs = imgs.map(i => i.thumbnail);
    setPreviewIndex(clampIndex(startIndex, thumbs.length));
    setPreviewImages(thumbs);
    setPreviewSourceImages(imgs);

    const blobs = await Promise.all(imgs.map(i => getAgentImageBytes(i.imgId, sessionId)));
    if (token !== previewTokenRef.current) return;

    const objectUrls: string[] = [];
    const fullSrcs = thumbs.map((thumb, idx) => {
      const blob = blobs[idx];
      if (!blob) return thumb;
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      return url;
    });
    previewObjectUrlsRef.current = objectUrls;
    setPreviewImages(fullSrcs);
  }, [revokePreviewUrls, sessionId]);

  const closePreview = useCallback(() => {
    previewTokenRef.current++;
    revokePreviewUrls();
    setPreviewImages(null);
    setPreviewSourceImages([]);
  }, [revokePreviewUrls]);

  useEffect(() => revokePreviewUrls, [revokePreviewUrls]);

  const makeActionPayload = useCallback((img: AgentImageRecord): ImageActionPayload => ({
    id: img.imgId,
    name: img.imgId,
    agentImageId: img.imgId,
    sourceKind: 'agent',
    sourceLabel: getAgentImageSourceLabel(img.source),
    sourceRef: img.imgId,
    prompt: getUsableDescription(img.description) || img.description,
    note: getUsableDescription(img.description),
    sessionId,
  }), [sessionId]);

  if (message.role === 'context-divider') {
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70">
        <div className="h-px flex-1 bg-border" />
        <span className="shrink-0">{message.text}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (message.role === 'system-note') {
    return (
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {message.text}
          {message.withdrawable && !messageActionsDisabled && (
            <button
              type="button"
              onClick={() => onWithdraw(message.id)}
              className="inline-flex items-center gap-0.5 font-medium text-foreground/70 hover:text-foreground"
              title="撤回上一条已发消息，避免干扰后续上下文"
            >
              <Undo2 className="h-3 w-3" />
              撤回消息
            </button>
          )}
        </span>
      </div>
    );
  }

  const isUser = message.role === 'user';
  const linkedImages = (message.imageIds || [])
    .map(id => imageMap.get(id))
    .filter((img): img is AgentImageRecord => Boolean(img));

  return (
    <div className={cn('flex gap-2.5 group/message', isUser && 'flex-row-reverse')}>
      <div className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
        isUser ? 'bg-foreground/10 text-foreground' : 'bg-primary/10 text-primary'
      )}>
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={cn('flex min-w-0 max-w-[80%] flex-col gap-2', isUser && 'items-end')}>
        {!isUser && message.reasoning && !isGenerationResult && (
          <div className="rounded-xl border border-border/60 bg-muted/30">
            <button
              type="button"
              onClick={() => setReasoningOpen(prev => !prev)}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <Brain className="h-3.5 w-3.5" />
              思考过程
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', reasoningOpen && 'rotate-180')} />
            </button>
            {reasoningOpen && (
              <div className="border-t border-border/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <div dangerouslySetInnerHTML={{ __html: renderedReasoning }} />
              </div>
            )}
          </div>
        )}
        {message.text && isGenerationResult ? (
          <AgentGenerationResult text={message.text} reasoning={message.reasoning} />
        ) : message.text ? (
          <div className={cn(
            'rounded-2xl px-3.5 py-2.5 text-sm',
            isUser ? 'min-w-0 max-w-full break-all rounded-tr-sm bg-primary text-primary-foreground whitespace-pre-wrap' : 'min-w-0 max-w-full break-words rounded-tl-sm bg-muted md-message'
          )}>
            {isUser ? message.text : <div ref={mdContentRef} dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />}
          </div>
        ) : null}
        {linkedImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {linkedImages.map((img, index) => (
              <div
                key={img.imgId}
                className="group relative h-24 w-24 overflow-hidden rounded-lg border border-border"
                title={img.description}
              >
                <button
                  type="button"
                  onClick={() => void openPreview(linkedImages, index)}
                  className="block h-full w-full"
                >
                  <img src={img.thumbnail} alt={img.imgId} className="h-full w-full object-cover" />
                </button>
                <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] text-white">
                  {img.imgId}
                </span>
                <ImageHoverActions
                  payload={makeActionPayload(img)}
                  onPreview={() => void openPreview(linkedImages, index)}
                  compact
                  showDownload
                  showCopy
                  showAddToAssets
                  showUseAsReference
                  extraActions={(
                    <button
                      type="button"
                      onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDescDialogImg({ imgId: img.imgId, description: img.description || 'AI 未生成描述' });
                      }}
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                      title="查看描述"
                    >
                      <FileText className="h-3 w-3" />
                    </button>
                  )}
                />
              </div>
            ))}
          </div>
        )}
        {!isUser && message.proposalData && (
          <button
            type="button"
            onClick={() => onReedit?.(message.id)}
            disabled={reeditDisabled}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors self-start disabled:pointer-events-none disabled:opacity-40"
            title={reeditDisabled ? '生成或提案确认进行中，结束后再重新编辑' : '重新编辑此轮生图请求'}
          >
            <Pencil className="h-3 w-3" />
            重新编辑
          </button>
        )}

        <div className={cn('mt-1 flex items-center gap-1.5 opacity-0 transition-opacity group-hover/message:opacity-100', isUser && 'self-end')}>
          <span className="text-[10px] text-muted-foreground/70 tabular-nums select-none">
            {new Date(message.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <span className="h-3 w-px bg-border/50" />
          <button
            type="button"
            onClick={() => {
              onCopy?.();
              setCopiedText(true);
              setTimeout(() => setCopiedText(false), 2000);
            }}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            title="复制文本"
          >
            {copiedText ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copiedText ? '已复制' : '复制'}
          </button>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title="用这条消息重新提问，丢弃它之后的回复"
            >
              <RefreshCw className="h-3 w-3" />
              重试
            </button>
          )}
          {onRollback && (
            <button
              type="button"
              onClick={onRollback}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title="删除此条及之后的所有消息"
            >
              <Undo2 className="h-3 w-3" />
              撤回以下所有
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="仅删除本条消息"
            >
              <Trash2 className="h-3 w-3" />
              仅删除本条
            </button>
          )}
        </div>
      </div>

      {previewImages && createPortal(
        <HistoryImagePreview
          images={previewImages}
          alt="agent 图片"
          initialIndex={previewIndex}
          onClose={closePreview}
          actionPayloads={previewSourceImages.map(makeActionPayload)}
        />,
        document.body
      )}

      {descDialogImg && (
        <Dialog open={!!descDialogImg} onOpenChange={(open) => { if (!open) setDescDialogImg(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>图片描述 — {descDialogImg.imgId}</DialogTitle>
            </DialogHeader>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {descDialogImg.description}
            </div>
            <div className="mt-2 flex items-center justify-end gap-2 border-t pt-3">
              {(!descDialogImg.description || descDialogImg.description === 'AI 未生成描述' || descDialogImg.description === '(无描述)' || descDialogImg.description === '(图片描述生成失败)') && onRedescribe && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={isRedescribing}
                  onClick={async () => {
                    setIsRedescribing(true);
                    try {
                      const newDesc = await onRedescribe(descDialogImg.imgId);
                      setDescDialogImg({ ...descDialogImg, description: newDesc });
                    } catch {
                      // redescribeImage 内部已处理异常
                    } finally {
                      setIsRedescribing(false);
                    }
                  }}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isRedescribing ? 'animate-spin' : ''}`} />
                  {isRedescribing ? '生成中…' : '重新生成描述'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  navigator.clipboard.writeText(descDialogImg.description).catch(() => {});
                  setDescCopied(true);
                  setTimeout(() => setDescCopied(false), 2000);
                }}
              >
                {descCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {descCopied ? '已复制' : '复制描述'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export const MemoizedAgentMessageBubble = memo(AgentMessageBubble);
