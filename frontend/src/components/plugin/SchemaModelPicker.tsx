'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  availableFacetValues,
  allFacetOptions,
  findFacetOption,
  resolveModel,
  type FacetValues,
  type InstalledPlugin,
} from '@/lib/plugin-schema';
import { PluginPriceTag } from '@/components/plugin/PluginPriceTag';

interface SchemaModelPickerProps {
  plugin: InstalledPlugin;
  facets: FacetValues;
  onSelectFacet: (key: string, value: string | number) => void;
}

/**
 * 模型选择列表：第一个 facet（通常是「档位」）铺成一列带说明的条目，
 * 后续 facet 在工具栏里各自一个小按钮。
 *
 * 「哪些档位存在」「某档位下有哪些分辨率」都从 variants 表求出来，
 * 因此插件加一行 variant 就能多一个组合，宿主不用改代码。
 */
export function SchemaModelPicker({ plugin, facets, onSelectFacet }: SchemaModelPickerProps) {
  const schema = plugin.uiSchema;
  const primary = schema.modelSelector.facets[0];
  if (!primary) return null;

  const options = allFacetOptions(schema, primary.key);

  return (
    <div className="space-y-0.5">
      {schema.modelSelector.familyLabel && (
        <div className="px-2.5 pb-1 pt-1.5">
          <p className="text-xs font-semibold text-foreground">{schema.modelSelector.familyLabel}</p>
          {schema.modelSelector.familyDescription && (
            <p className="text-[11px] leading-tight text-muted-foreground">
              {schema.modelSelector.familyDescription}
            </p>
          )}
        </div>
      )}

      {options.map(option => {
        const candidate: FacetValues = { ...facets, [primary.key]: option.value };
        // 该档位下还有可用组合才让选。variants 表里没有的档位直接置灰。
        const usable = availableFacetValues(schema, primary.key, facets)
          .some(value => String(value) === String(option.value));
        const selected = String(facets[primary.key]) === String(option.value);
        // 用该档位下第一个可用组合的价格做代表，让用户在选之前就看到量级
        const previewModel = resolveModel(schema, candidate)
          ?? firstModelForFacet(plugin, primary.key, option.value);

        return (
          <button
            key={String(option.value)}
            type="button"
            disabled={!usable}
            title={usable ? option.description : `${option.fullLabel || option.label}当前不可用`}
            onClick={() => usable && onSelectFacet(primary.key, option.value)}
            className={cn(
              'flex w-full items-start justify-between gap-2 rounded-md px-2.5 py-1.5 text-left',
              'transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
              selected && 'bg-muted font-medium',
            )}
          >
            <span className="min-w-0">
              <span className="block text-sm">{option.fullLabel || option.label}</span>
              {option.description && (
                <span className="block text-[11px] leading-tight text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5">
              {selected && <Check className="h-3.5 w-3.5" />}
              {previewModel && <PluginPriceTag plugin={plugin} modelId={previewModel} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 该 facet 取值下的第一个模型，仅用于展示价格量级。 */
function firstModelForFacet(
  plugin: InstalledPlugin,
  facetKey: string,
  value: string | number,
): string | null {
  const variant = plugin.uiSchema.modelSelector.variants.find(
    item => String(item[facetKey]) === String(value));
  return variant ? variant.model : null;
}

/** 后续 facet（如分辨率）的下拉列表。 */
export function SchemaFacetList({
  plugin,
  facetKey,
  facets,
  onSelectFacet,
}: SchemaModelPickerProps & { facetKey: string }) {
  const schema = plugin.uiSchema;
  const available = availableFacetValues(schema, facetKey, facets);

  return (
    <div className="space-y-0.5">
      {available.map(value => {
        const option = findFacetOption(schema, facetKey, value);
        const selected = String(facets[facetKey]) === String(value);
        const model = resolveModel(schema, { ...facets, [facetKey]: value });
        return (
          <button
            key={String(value)}
            type="button"
            onClick={() => onSelectFacet(facetKey, value)}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
              'transition-colors hover:bg-muted',
              selected && 'bg-muted font-medium',
            )}
          >
            <span>{option?.label ?? String(value)}</span>
            {model && <PluginPriceTag plugin={plugin} modelId={model} />}
          </button>
        );
      })}
    </div>
  );
}
