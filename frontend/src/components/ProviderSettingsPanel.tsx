'use client';

import { useState } from 'react';
import { Eye, EyeOff, HelpCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BUILTIN_IMAGE_PRESET_OPTIONS, resolveDerivedImagePreset } from '@/lib/nova-models';
import { fetchUpstreamModels } from '@/lib/provider-models-client';
import {
  PROVIDER_KIND_OPTIONS,
  TEXT_PROTOCOL_OPTIONS,
  addManualProviderModel,
  createProviderDraft,
  guessTextProtocol,
  isCompleteProvider,
  listProtocolForKind,
  mergeFetchedModels,
  providerModelRowId,
  setProviderModelUse,
  type ModelUse,
  type ProviderConfig,
  type ProviderKind,
} from '@/lib/provider-registry';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

interface ProviderSettingsPanelProps {
  providers: ProviderConfig[];
  selectedProviderId: string;
  onChange: (providers: ProviderConfig[] | ((prev: ProviderConfig[]) => ProviderConfig[])) => void;
  onSelect: (id: string) => void;
}

export function ProviderSettingsPanel({
  providers,
  selectedProviderId,
  onChange,
  onSelect,
}: ProviderSettingsPanelProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [manualModelId, setManualModelId] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [providerToDelete, setProviderToDelete] = useState<ProviderConfig | null>(null);
  const selected = providers.find((provider) => provider.id === selectedProviderId) || null;

  const updateSelected = (patch: Partial<ProviderConfig> | ((current: ProviderConfig) => ProviderConfig)) => {
    if (!selected) return;
    const id = selected.id;
    onChange((prev) => prev.map((provider) => {
      if (provider.id !== id) return provider;
      return typeof patch === 'function' ? patch(provider) : { ...provider, ...patch };
    }));
  };

  const handleAdd = () => {
    const draft = createProviderDraft();
    onChange((prev) => [...prev, draft]);
    onSelect(draft.id);
  };

  const handleDelete = (id: string) => {
    onChange((prev) => {
      const next = prev.filter((provider) => provider.id !== id);
      if (selectedProviderId === id) onSelect(next[0]?.id || '');
      return next;
    });
  };

  const handleFetch = async () => {
    if (!selected) return;
    if (!selected.apiKey.trim() || !selected.baseUrl.trim()) {
      setFetchError('请先填写 Base URL 和 API Key');
      return;
    }
    setFetching(true);
    setFetchError(null);
    try {
      const ids = await fetchUpstreamModels({
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        protocol: listProtocolForKind(selected.kind),
      });
      updateSelected((current) => ({
        ...current,
        models: mergeFetchedModels(current.models, ids),
      }));
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : '读取模型列表失败');
    } finally {
      setFetching(false);
    }
  };

  const handleAddManual = () => {
    if (!selected) return;
    updateSelected((current) => addManualProviderModel(current, manualModelId));
    setManualModelId('');
  };

  return (
    <div className="rounded-xl border p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium">供应商</p>
          <p className="text-xs text-muted-foreground">一把 Key 对应一个供应商。模型从上游拉取后配置为文本或图片模型。</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={handleAdd}>
          <Plus className="w-4 h-4" />
          新增供应商
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          {providers.map((provider) => {
            const isSelected = selectedProviderId === provider.id;
            return (
              <div
                key={provider.id}
                className={`group flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(provider.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="font-medium truncate">{provider.name || '未命名供应商'}</div>
                  <div className="text-xs text-muted-foreground">
                    {isCompleteProvider(provider) ? `${provider.models.length} 个模型` : '待补全'}
                  </div>
                </button>
                <button
                  type="button"
                  title="删除供应商"
                  aria-label="删除供应商"
                  onClick={(e) => {
                    e.stopPropagation();
                    setProviderToDelete(provider);
                  }}
                  className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>

        {selected && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">供应商名称</label>
                <Input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-muted-foreground">供应商协议</label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                        title="供应商协议说明"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-3 text-xs leading-relaxed text-muted-foreground shadow-md" align="start">
                      供应商协议决定获取模型的基准协议，不参与模型调用，模型调用以下方模型协议为准
                    </PopoverContent>
                  </Popover>
                </div>
                <Select
                  value={selected.kind}
                  onValueChange={(value) => updateSelected({ kind: value as ProviderKind })}
                  options={PROVIDER_KIND_OPTIONS}
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Base URL</label>
                <Input
                  value={selected.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => updateSelected({ baseUrl: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">API Key</label>
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={selected.apiKey}
                    onChange={(event) => updateSelected({ apiKey: event.target.value })}
                    className="pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    tabIndex={-1}
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="default" className="h-8 gap-2" onClick={handleFetch} disabled={fetching}>
                <RefreshCw className={`w-4 h-4 ${fetching ? 'animate-spin' : ''}`} />
                {fetching ? '读取中...' : '自动读取模型'}
              </Button>
              <Input
                className="h-8 max-w-xs"
                value={manualModelId}
                placeholder="手动添加模型 ID"
                onChange={(event) => setManualModelId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleAddManual();
                  }
                }}
              />
              <Button variant="outline" size="default" className="h-8" onClick={handleAddManual}>添加</Button>
            </div>

            {fetchError && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{fetchError}</div>
            )}

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">模型 ID</th>
                    <th className="px-3 py-2 text-left font-medium">别名</th>
                    <th className="px-3 py-2 text-center font-medium">类型</th>
                    <th className="px-3 py-2 text-left font-medium">协议 / 模板</th>
                    <th className="sticky right-0 z-10 border-l bg-muted px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {selected.models.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">
                        还没有模型。读取上游 /models，或手动填写模型 ID。
                      </td>
                    </tr>
                  )}
                  {selected.models.map((entry) => {
                    const rowId = providerModelRowId(entry);
                    const isImage = entry.uses.includes('image');
                    return (
                    <tr key={rowId} className="border-t">
                      <td className="px-3 py-2">
                        <div className="font-medium">{entry.modelId}</div>
                        {entry.manual && <div className="text-[11px] text-muted-foreground">手动添加</div>}
                      </td>
                      <td className="px-3 py-2 min-w-36">
                        <Input
                          value={entry.name}
                          placeholder={entry.modelId}
                          onChange={(event) => {
                            const name = event.target.value;
                            updateSelected((current) => ({
                              ...current,
                              models: current.models.map((item) => (
                                providerModelRowId(item) === rowId ? { ...item, name } : item
                              )),
                            }));
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <div className="inline-flex items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => updateSelected((current) => setProviderModelUse(current, rowId, 'text'))}
                            className={`text-xs select-none transition-colors ${
                              !isImage ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            文本
                          </button>
                          <Switch
                            checked={isImage}
                            onCheckedChange={(checked) => {
                              const nextUse: ModelUse = checked ? 'image' : 'text';
                              updateSelected((current) => setProviderModelUse(current, rowId, nextUse));
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => updateSelected((current) => setProviderModelUse(current, rowId, 'image'))}
                            className={`text-xs select-none transition-colors ${
                              isImage ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            图片
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 min-w-44">
                        {isImage ? (
                          <Select
                            value={resolveDerivedImagePreset(selected.kind, entry.modelId, entry.builtinPreset)}
                            onValueChange={(value) => {
                              updateSelected((current) => ({
                                ...current,
                                models: current.models.map((item) => (
                                  providerModelRowId(item) === rowId ? { ...item, builtinPreset: value as typeof entry.builtinPreset } : item
                                )),
                              }));
                            }}
                            options={BUILTIN_IMAGE_PRESET_OPTIONS}
                          />
                        ) : (
                          <Select
                            value={entry.textProtocol || guessTextProtocol(selected.kind, entry.modelId)}
                            onValueChange={(value) => {
                              updateSelected((current) => ({
                                ...current,
                                models: current.models.map((item) => (
                                  providerModelRowId(item) === rowId ? { ...item, textProtocol: value as TextProviderProtocol } : item
                                )),
                              }));
                            }}
                            options={TEXT_PROTOCOL_OPTIONS}
                          />
                        )}
                      </td>
                      <td className="sticky right-0 z-10 border-l bg-background px-2 py-2 text-right">
                        <button
                          type="button"
                          className="text-xs text-destructive"
                          onClick={() => updateSelected((current) => ({
                            ...current,
                            models: current.models.filter((item) => providerModelRowId(item) !== rowId),
                          }))}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Dialog open={Boolean(providerToDelete)} onOpenChange={(open) => { if (!open) setProviderToDelete(null); }}>
        <DialogContent className="sm:max-w-md z-[60]" overlayClassName="bg-black/30">
          <DialogHeader>
            <DialogTitle>删除供应商</DialogTitle>
            <DialogDescription>
              确定要删除供应商「{providerToDelete?.name || '未命名供应商'}」吗？删除后该供应商及其下的 {providerToDelete?.models.length || 0} 个模型配置都将被移除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="default" onClick={() => setProviderToDelete(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="default"
              onClick={() => {
                if (providerToDelete) {
                  handleDelete(providerToDelete.id);
                  setProviderToDelete(null);
                }
              }}
            >
              确定删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
