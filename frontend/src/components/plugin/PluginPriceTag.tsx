'use client';

import { cn } from '@/lib/utils';
import { findModel, type InstalledPlugin } from '@/lib/plugin-schema';

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€' };

function symbolFor(currency?: string): string {
  if (!currency) return '¥';
  return CURRENCY_SYMBOL[currency] || `${currency} `;
}

/**
 * 单价标签。价格来自插件 manifest 的申报值——开源版不代理任何上游价格接口。
 * 未申报时整个标签不渲染：显示「未申报」既占地方又像是出了错，不如让这一处安静消失。
 */
export function PluginPriceTag({
  plugin,
  modelId,
  className,
}: {
  plugin: InstalledPlugin;
  modelId: string;
  className?: string;
}) {
  const price = findModel(plugin, modelId)?.price;
  if (!price) return null;
  const unit = price.unit === 'per-second' ? '/秒' : '/次';
  return (
    <span className={cn('font-mono text-[10px] tabular-nums text-muted-foreground', className)}>
      {symbolFor(price.currency)}{price.amount}{unit}
    </span>
  );
}

/** 合计价格。cost 为 null（未申报价格或数量字段缺失）时不渲染。 */
export function PluginTotalPrice({
  plugin,
  modelId,
  cost,
  parallelCount = 1,
  className,
}: {
  plugin: InstalledPlugin;
  modelId: string;
  cost: number | null;
  /** 并发请求数。>1 时总价乘以此数 */
  parallelCount?: number;
  className?: string;
}) {
  const price = findModel(plugin, modelId)?.price;
  if (cost === null) return null;
  const total = cost * Math.max(1, parallelCount);
  return (
    <span className={cn('font-mono text-sm font-semibold tabular-nums text-primary', className)}>
      {symbolFor(price?.currency)}{total.toFixed(2)}
      {parallelCount > 1 && (
        <span className="ml-1 text-[11px] text-muted-foreground/80">
          ({symbolFor(price?.currency)}{cost.toFixed(2)} × {parallelCount}个)
        </span>
      )}
    </span>
  );
}
