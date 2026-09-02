'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Eye, EyeOff, FolderOpen, Package, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  getCredentialVersion,
  getPluginCredential,
  getPluginRegistryServerSnapshot,
  getPluginRegistrySnapshot,
  loadPluginRegistry,
  setPluginCredential,
  subscribePluginCredentials,
  subscribePluginRegistry,
} from '@/lib/plugin-registry-client';
import type { InstalledPlugin } from '@/lib/plugin-schema';

/**
 * 设置 → 插件。
 *
 * 这一页是只读的清单：装、删、改插件包都要管理员上服务器操作插件目录，
 * 前端提供安装入口只会给出一条巨大的任意文件写入面。唯一可编辑的是凭据，
 * 因为凭据属于用户而不属于部署——和开源版图片模型「每个模型各存一份 key」一致。
 */
export function PluginsSettings() {
  const registry = useSyncExternalStore(
    subscribePluginRegistry,
    getPluginRegistrySnapshot,
    getPluginRegistryServerSnapshot,
  );
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void loadPluginRegistry();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadPluginRegistry(true);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-medium">已安装的视频插件</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="h-8 rounded-xl px-2.5 text-xs"
          >
            <RotateCw className={cn('mr-1 size-3.5', refreshing && 'animate-spin')} />
            重新读取
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          视频能力由插件包提供，安装与卸载插件需要管理员在服务器上操作插件目录。
        </p>
        {registry.pluginsDir && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <FolderOpen className="mt-0.5 size-3.5 shrink-0" />
            <code className="break-all font-mono">{registry.pluginsDir}</code>
          </p>
        )}
      </div>

      {registry.plugins.length === 0 && registry.failures.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
          <Package className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">还没有安装任何插件</p>
          <p className="mt-1 text-xs text-muted-foreground">
            把插件目录放进上面的路径后重启后端，这里就会出现它。
            开发方式见仓库中的 <code className="font-mono">docs/plugins/</code>。
          </p>
        </div>
      )}

      <div className="space-y-3">
        {registry.plugins.map(plugin => (
          <PluginCard key={plugin.id} plugin={plugin} />
        ))}
      </div>

      {registry.failures.length > 0 && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4" />
            加载失败的插件目录（{registry.failures.length}）
          </h4>
          {registry.failures.map(failure => (
            <div key={failure.id} className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/10 p-3">
              <p className="font-mono text-xs text-foreground">{failure.id}</p>
              <p className="text-[11px] leading-relaxed text-destructive/90">{failure.error}</p>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            校验错误会精确到具体字段，按提示改完对应的 JSON 后重启后端即可。
          </p>
        </div>
      )}
    </div>
  );
}

function PluginCard({ plugin }: { plugin: InstalledPlugin }) {
  const credentialVersion = useSyncExternalStore(
    subscribePluginCredentials,
    getCredentialVersion,
    () => 0,
  );
  const [showKey, setShowKey] = useState(false);
  // 直接以 store 为唯一数据源，不另存一份草稿：草稿要用 effect 回填，
  // 而那会在另一个标签页改凭据时打断正在输入的内容。
  const credential = useMemo(
    () => getPluginCredential(plugin),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- credentialVersion 是外部 store 的变更信号
    [plugin, credentialVersion],
  );

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card/60 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            <span
              className={cn(
                'inline-flex size-2 rounded-full',
                credential.apiKey ? 'bg-emerald-500' : 'bg-amber-500',
              )}
              aria-hidden
            />
            {plugin.name}
            <span className="font-mono text-[11px] font-normal text-muted-foreground">v{plugin.version}</span>
            {!credential.apiKey && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                待填写凭据
              </span>
            )}
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{plugin.description}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/80">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{plugin.id}</span>
            <span>{plugin.models.length} 个模型</span>
            {plugin.author && <span>· {plugin.author}</span>}
            {plugin.homepage && (
              <a
                href={plugin.homepage}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                主页
              </a>
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-foreground">{plugin.credential.label}</span>
          <span className="relative block">
            <Input
              type={showKey ? 'text' : 'password'}
              value={credential.apiKey}
              placeholder="填写后即可在视频工作台提交任务"
              autoComplete="off"
              onChange={event => setPluginCredential(plugin.id, { apiKey: event.target.value })}
              className="h-8 rounded-xl pr-8 text-xs"
            />
            <button
              type="button"
              onClick={() => setShowKey(prev => !prev)}
              aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </span>
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium text-foreground">API 基地址</span>
          <Input
            type="text"
            value={credential.baseUrl}
            placeholder={plugin.credential.defaultBaseUrl || 'https://...'}
            onChange={event => setPluginCredential(plugin.id, { baseUrl: event.target.value })}
            className="h-8 rounded-xl text-xs"
          />
        </label>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        凭据只保存在当前浏览器，不会写入服务器数据库；提交任务时随请求转发，服务端仅用于调用该插件
        在 <code className="font-mono">manifest.permissions.hosts</code> 里申报过的主机。
      </p>
    </div>
  );
}
