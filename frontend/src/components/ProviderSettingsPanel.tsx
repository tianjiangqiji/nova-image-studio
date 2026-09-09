'use client';

import { useState } from 'react';
import { Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { BUILTIN_IMAGE_PRESET_OPTIONS, resolveDerivedImagePreset } from '@/lib/nova-models';
import { fetchUpstreamModels } from '@/lib/provider-models-client';
import {
  MODEL_USE_OPTIONS,
  PROVIDER_KIND_OPTIONS,
  TEXT_PROTOCOL_OPTIONS,
  addManualProviderModel,
  createProviderDraft,
  guessTextProtocol,
  isCompleteProvider,
  listProtocolForKind,
  mergeFetchedModels,
  providerModelRowId,
  toggleProviderModelUse,
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
          <p className="text-xs text-muted-foreground">一把 Key 对应一个供应商。模型从上游拉取后勾选文本 / 图片 / 视频 / 音频。</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={handleAdd}>
          <Plus className="w-4 h-4" />
          新增供应商
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => onSelect(provider.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedProviderId === provider.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
            >
              <div className="font-medium">{provider.name || '未命名供应商'}</div>
              <div className="text-xs text-muted-foreground">
                {isCompleteProvider(provider) ? `${provider.models.length} 个模型` : '待补全'}
              </div>
            </button>
          ))}
        </div>

        {selected && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">名称</label>
                <Input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">协议</label>
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

            <div className="flex flex-wrap items-end gap-2">
              <Button variant="outline" size="sm" className="gap-2" onClick={handleFetch} disabled={fetching}>
                <RefreshCw className={`w-4 h-4 ${fetching ? 'animate-spin' : ''}`} />
                {fetching ? '读取中...' : '自动读取模型'}
              </Button>
              <Input
                className="max-w-xs"
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
              <Button variant="outline" size="sm" onClick={handleAddManual}>添加</Button>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto gap-2 text-destructive hover:text-destructive"
                onClick={() => handleDelete(selected.id)}
              >
                <Trash2 className="w-4 h-4" />
                删除供应商
              </Button>
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
                    {MODEL_USE_OPTIONS.map((option) => (
                      <th key={option.value} className="px-2 py-2 text-center font-medium">{option.label}</th>
                    ))}
                    <th className="px-3 py-2 text-left font-medium">文本协议</th>
                    <th className="px-3 py-2 text-left font-medium">图片模板</th>
                    <th className="sticky right-0 z-10 border-l bg-muted px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {selected.models.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-xs text-muted-foreground">
                        还没有模型。读取上游 /models，或手动填写模型 ID。
                      </td>
                    </tr>
                  )}
                  {selected.models.map((entry) => {
                    const rowId = providerModelRowId(entry);
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
                      {MODEL_USE_OPTIONS.map((option) => (
                        <td key={option.value} className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={entry.uses.includes(option.value)}
                            onChange={() => {
                              updateSelected((current) => toggleProviderModelUse(current, rowId, option.value as ModelUse));
                            }}
                          />
                        </td>
                      ))}
                      <td className="px-3 py-2 min-w-40">
                        {entry.uses.includes('text') ? (
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
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 min-w-40">
                        {entry.uses.includes('image') ? (
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
                          <span className="text-xs text-muted-foreground">—</span>
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
            <p className="text-[11px] text-muted-foreground">视频 / 音频目前只作标记，不会出现在生图或 Agent 模型列表里。</p>
          </div>
        )}
      </div>
    </div>
  );
}
