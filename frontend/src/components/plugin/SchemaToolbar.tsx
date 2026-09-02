'use client';

import { useState, type ReactNode } from 'react';
import {
  Check,
  Clapperboard,
  Clock,
  Layers,
  Maximize,
  RectangleHorizontal,
  Settings2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { PluginPriceTag } from '@/components/plugin/PluginPriceTag';
import { SchemaFacetList, SchemaModelPicker } from '@/components/plugin/SchemaModelPicker';
import {
  availableFacetValues,
  buildScope,
  findFacetOption,
  findField,
  toolbarEntries,
  visibleOptions,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
  type PluginField,
} from '@/lib/plugin-schema';

/**
 * schema 里的 icon 名 → 图标组件。认不出来的名字回落到一个通用齿轮，
 * 而不是报错——插件写了个宿主还不支持的图标名，不该让整个 tab 白屏。
 */
const ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  layers: Layers,
  maximize: Maximize,
  ratio: RectangleHorizontal,
  clock: Clock,
  clapperboard: Clapperboard,
};

function iconFor(name?: string): LucideIcon {
  return (name && ICONS[name]) || Settings2;
}

/**
 * 直接渲染 schema 指定的图标。
 * 写成 switch 而不是 `const Icon = ICONS[name]` 再 `<Icon />`，是为了不在渲染期
 * 动态产出组件类型——那样每次渲染都是一个「新组件」，React 会丢掉它的状态。
 */
export function SchemaIcon({ name, className }: { name?: string; className?: string }) {
  switch (name) {
    case 'sparkles': return <Sparkles className={className} />;
    case 'layers': return <Layers className={className} />;
    case 'maximize': return <Maximize className={className} />;
    case 'ratio': return <RectangleHorizontal className={className} />;
    case 'clock': return <Clock className={className} />;
    case 'clapperboard': return <Clapperboard className={className} />;
    default: return <Settings2 className={className} />;
  }
}

interface SchemaToolbarProps {
  plugin: InstalledPlugin;
  facets: FacetValues;
  fields: FieldValues;
  model: string | null;
  onFacetChange: (key: string, value: string | number) => void;
  onFieldChange: (key: string, value: string | number | boolean) => void;
  size?: 'xs' | 'sm';
  className?: string;
  /** 并发请求数 */
  parallelCount?: number;
  onParallelChange?: (n: number) => void;
}

/**
 * 插件工作台的工具栏：一排 outline 小按钮 + Popover，与生图工作台的
 * GenerationParamsBar 结构一致。按钮顺序由 ui.schema 的 layout.toolbar 决定。
 */
export function SchemaToolbar({
  plugin,
  facets,
  fields,
  model,
  onFacetChange,
  onFieldChange,
  size = 'xs',
  className,
  parallelCount,
  onParallelChange,
}: SchemaToolbarProps) {
  const schema = plugin.uiSchema;
  const entries = toolbarEntries(schema);
  const [parallelOpen, setParallelOpen] = useState(false);
  const showParallel = typeof parallelCount === 'number' && typeof onParallelChange === 'function';

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {entries.map(entry => {
        if (entry === '$model') {
          return (
            <ModelTrigger
              key={entry}
              plugin={plugin}
              facets={facets}
              size={size}
              onSelectFacet={onFacetChange}
            />
          );
        }
        if (entry.startsWith('$')) {
          return (
            <FacetTrigger
              key={entry}
              plugin={plugin}
              facetKey={entry.slice(1)}
              facets={facets}
              size={size}
              onSelectFacet={onFacetChange}
            />
          );
        }
        const field = findField(schema, entry);
        if (!field) return null;
        // 工具栏只放选项类控件。switch / 文本 / 素材即使被写进 layout.toolbar 也跳过，
        // 否则会渲染出一个空 Popover——它们在正文区有各自的控件。
        if (field.type !== 'select' && field.type !== 'select-grid') return null;
        return (
          <FieldTrigger
            key={entry}
            field={field}
            facets={facets}
            fields={fields}
            size={size}
            onFieldChange={onFieldChange}
          />
        );
      })}

      {/* 并发请求数 */}
      {showParallel && (
        <Popover open={parallelOpen} onOpenChange={setParallelOpen}>
          <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1')} title="并发请求数">
            <Layers className="h-3 w-3" />
            <span className="text-[11px]">并发 {parallelCount}</span>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="start">
            <div className="grid grid-cols-5 gap-1">
              {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    onParallelChange!(n);
                    setParallelOpen(false);
                  }}
                  className={cn(
                    'rounded-md px-2 py-1.5 text-center text-xs tabular-nums transition-colors hover:bg-muted',
                    parallelCount === n && 'bg-muted font-medium',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {model && (
        <span className="ml-auto inline-flex items-center gap-1 pl-1">
          <PluginPriceTag plugin={plugin} modelId={model} />
        </span>
      )}
    </div>
  );
}

function TriggerShell({
  title,
  icon: Icon,
  label,
  size,
  children,
  width = 'w-60',
}: {
  title: string;
  icon: LucideIcon;
  label: ReactNode;
  size: 'xs' | 'sm';
  children: ReactNode;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1')} title={title}>
        <Icon className="h-3 w-3" />
        <span className="shrink-0 truncate text-[11px]">{label}</span>
      </PopoverTrigger>
      <PopoverContent className={cn(width, 'p-1')} align="start">
        <div onClick={() => setOpen(false)}>{children}</div>
      </PopoverContent>
    </Popover>
  );
}

function ModelTrigger({
  plugin,
  facets,
  size,
  onSelectFacet,
}: {
  plugin: InstalledPlugin;
  facets: FacetValues;
  size: 'xs' | 'sm';
  onSelectFacet: (key: string, value: string | number) => void;
}) {
  const schema = plugin.uiSchema;
  const primary = schema.modelSelector.facets[0];
  const option = primary ? findFacetOption(schema, primary.key, facets[primary.key]) : undefined;
  const family = schema.modelSelector.familyLabel || plugin.name;

  return (
    <TriggerShell
      title={schema.modelSelector.label || '模型'}
      icon={iconFor(primary?.icon)}
      size={size}
      label={
        <>
          {family}
          {option && <span className="text-muted-foreground">（{option.fullLabel || option.label}）</span>}
        </>
      }
    >
      <SchemaModelPicker plugin={plugin} facets={facets} onSelectFacet={onSelectFacet} />
    </TriggerShell>
  );
}

function FacetTrigger({
  plugin,
  facetKey,
  facets,
  size,
  onSelectFacet,
}: {
  plugin: InstalledPlugin;
  facetKey: string;
  facets: FacetValues;
  size: 'xs' | 'sm';
  onSelectFacet: (key: string, value: string | number) => void;
}) {
  const schema = plugin.uiSchema;
  const facet = schema.modelSelector.facets.find(item => item.key === facetKey);
  if (!facet) return null;

  const available = availableFacetValues(schema, facetKey, facets);
  // 只有一个可选值时这个按钮点开也只有一行，藏掉更清爽
  if (available.length <= 1 && facet.hideWhenSingle) return null;

  const option = findFacetOption(schema, facetKey, facets[facetKey]);

  return (
    <TriggerShell
      title={facet.label}
      icon={iconFor(facet.icon)}
      size={size}
      width="w-44"
      label={option?.label ?? String(facets[facetKey] ?? '')}
    >
      <SchemaFacetList
        plugin={plugin}
        facetKey={facetKey}
        facets={facets}
        onSelectFacet={onSelectFacet}
      />
    </TriggerShell>
  );
}

function FieldTrigger({
  field,
  facets,
  fields,
  size,
  onFieldChange,
}: {
  field: PluginField;
  facets: FacetValues;
  fields: FieldValues;
  size: 'xs' | 'sm';
  onFieldChange: (key: string, value: string | number | boolean) => void;
}) {
  const scope = buildScope(facets, fields);
  const options = field.options || [];
  const usable = visibleOptions(field, scope);
  if (field.hideWhenSingle && usable.length <= 1) return null;

  const current = options.find(option => String(option.value) === String(fields[field.key]));
  const label = current
    ? `${current.label}${field.suffix && !current.label.endsWith(field.suffix) ? field.suffix : ''}`
    : String(fields[field.key] ?? '');

  if (field.type === 'select-grid') {
    const columns = field.columns || 3;
    return (
      <TriggerShell
        title={field.label || field.key}
        icon={iconFor(field.icon)}
        size={size}
        width={columns >= 3 ? 'w-40' : 'w-52'}
        label={label}
      >
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {options.map(option => {
            const available = usable.includes(option);
            const selected = String(fields[field.key]) === String(option.value);
            return (
              <button
                key={String(option.value)}
                type="button"
                disabled={!available}
                title={option.description}
                onClick={() => available && onFieldChange(field.key, option.value)}
                className={cn(
                  'rounded-md px-2 py-1.5 text-center text-xs tabular-nums transition-colors hover:bg-muted',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                  selected && 'bg-muted font-medium',
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </TriggerShell>
    );
  }

  return (
    <TriggerShell
      title={field.label || field.key}
      icon={iconFor(field.icon)}
      size={size}
      label={label}
    >
      <div className="space-y-0.5">
        {options.map(option => {
          const available = usable.includes(option);
          const selected = String(fields[field.key]) === String(option.value);
          return (
            <button
              key={String(option.value)}
              type="button"
              disabled={!available}
              title={available ? option.description : '当前组合下不支持'}
              onClick={() => available && onFieldChange(field.key, option.value)}
              className={cn(
                'flex w-full items-start justify-between gap-2 rounded-md px-2.5 py-1.5 text-left',
                'transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                selected && 'bg-muted font-medium',
              )}
            >
              <span className="min-w-0">
                <span className="block text-sm">{option.label}</span>
                {option.description && (
                  <span className="block text-[11px] leading-tight text-muted-foreground">
                    {available ? option.description : '当前档位不支持'}
                  </span>
                )}
              </span>
              {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            </button>
          );
        })}
      </div>
    </TriggerShell>
  );
}

export { iconFor };
