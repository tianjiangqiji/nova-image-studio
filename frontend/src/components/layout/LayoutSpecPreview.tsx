'use client';

// 构图规范只读预览：缩略线框 + 提示词段落文本

import { cn } from '@/lib/utils';
import { buildLayoutPromptSection, isLayoutSpecEmpty, parseAspectRatioValue, type LayoutSpec } from '@/lib/layout-spec';

import { getLayoutBoxColor } from './LayoutSketchCanvas';

interface LayoutSpecPreviewProps {
  spec: LayoutSpec;
  /** 是否展示生成的提示词段落 */
  showPromptSection?: boolean;
  className?: string;
}

export function LayoutSpecPreview({ spec, showPromptSection = true, className }: LayoutSpecPreviewProps) {
  const ratio = parseAspectRatioValue(spec.aspectRatio);
  const section = buildLayoutPromptSection(spec);
  const empty = isLayoutSpecEmpty(spec);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        className="relative w-full overflow-hidden rounded-lg border border-border bg-muted/30"
        style={{ aspectRatio: String(ratio) }}
      >
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">暂无构图</div>
        )}
        {spec.objects.map((object, index) => {
          const color = getLayoutBoxColor(index);
          return (
            <div
              key={object.id}
              className="absolute border-2"
              style={{
                left: `${object.box.x * 100}%`,
                top: `${object.box.y * 100}%`,
                width: `${object.box.w * 100}%`,
                height: `${object.box.h * 100}%`,
                borderColor: color,
                backgroundColor: `${color}1a`,
              }}
            >
              <span
                className="absolute -top-px left-0 max-w-full truncate rounded-br px-1 py-0.5 text-[10px] font-medium leading-tight text-white"
                style={{ backgroundColor: color }}
              >
                {object.label}
              </span>
            </div>
          );
        })}
      </div>

      {showPromptSection && section && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
          {section}
        </pre>
      )}
    </div>
  );
}
