'use client';

import { useState } from 'react';
import { Download, Film, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadImagePayload } from '@/lib/image-actions';
import type { GifReviewPanelProps } from './GifReviewPanel';

export function NativeGifResultPanel(props: GifReviewPanelProps) {
  const [downloadError, setDownloadError] = useState('');
  const generating = props.status === 'generating_grid';
  const format = props.job?.resultMimeType?.split('/')[1]?.toUpperCase() || '原始文件';
  const download = async () => {
    setDownloadError('');
    try {
      if (props.gridActionPayload) await downloadImagePayload(props.gridActionPayload);
    } catch (error) { setDownloadError(error instanceof Error ? error.message : '下载失败'); }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-md">
      <header className="flex items-center gap-2 text-sm font-medium"><Film className="h-4 w-4 text-primary" />原生 GIF 结果</header>
      {props.status === 'idle' && <p className="py-20 text-center text-sm text-muted-foreground">填写动画描述后，点击「生成原生 GIF」。</p>}
      {generating && <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p>正在生成原生 GIF，已用 {props.elapsedSeconds} 秒…</p>
      </div>}
      {props.status === 'failed' && <p role="alert" className="text-sm text-destructive">{props.job?.error || '生成失败'}</p>}
      {props.gridImageUrl && <button type="button" onClick={props.onOpenPreview} className="block w-full rounded-lg bg-muted">
        <img src={props.gridImageUrl} alt="原生 GIF 生成结果" className="mx-auto max-h-[480px] max-w-full object-contain" />
      </button>}
      {props.job?.resultMimeType && <p className="text-xs text-muted-foreground">返回格式：{format}{props.job.resultFrameCount ? ` · ${props.job.resultFrameCount} 帧` : ''}</p>}
      {props.job?.warning && <p role="status" className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">{props.job.warning}</p>}
      {downloadError && <p role="alert" className="text-sm text-destructive">{downloadError}</p>}
      <div className="flex flex-wrap gap-2">
        {props.gridActionPayload && <Button onClick={() => void download()}><Download className="mr-1 h-4 w-4" />下载 {format}</Button>}
        {props.job?.serverTaskId && (generating || props.status === 'failed' || !props.gridImageUrl) && <Button variant="outline" onClick={props.onRefreshFromServer} disabled={props.isSyncing || props.refreshCooldownActive}>
          <RefreshCw className="mr-1 h-4 w-4" />主动同步状态
        </Button>}
        {props.job && !generating && <Button variant="outline" onClick={props.onRetryRegenerate}>重新生成</Button>}
        {props.job && !generating && <Button variant="ghost" onClick={props.onReset}>清空</Button>}
      </div>
    </section>
  );
}
