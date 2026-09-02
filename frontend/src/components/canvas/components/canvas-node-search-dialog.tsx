"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CanvasNodeType, type CanvasNodeData } from "../types";

export function CanvasNodeSearchDialog({ open, onOpenChange, nodes, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; nodes: CanvasNodeData[]; onSelect: (node: CanvasNodeData) => void }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return nodes.slice(0, 30);
    return nodes.filter((node) => `${node.title}\n${node.metadata?.content || ""}\n${node.metadata?.composerContent || ""}\n${node.metadata?.mediaName || ""}`.toLocaleLowerCase("zh-CN").includes(normalized)).slice(0, 50);
  }, [nodes, query]);
  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setQuery(""); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>搜索节点</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus type="search" aria-label="搜索节点" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入节点标题或内容" className="pl-8" />
          </div>
          <div className="max-h-80 space-y-1 overflow-auto">
            {results.map((node) => (
              <button
                key={node.id}
                type="button"
                aria-label={`定位到 ${node.title}`}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-100 hover:bg-muted active:scale-[0.99]"
                onClick={() => { onSelect(node); onOpenChange(false); setQuery(""); }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{node.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{node.metadata?.content || node.metadata?.composerContent || node.metadata?.mediaName || nodeTypeLabel(node.type)}</span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{nodeTypeLabel(node.type)}</span>
              </button>
            ))}
            {results.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的节点</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function nodeTypeLabel(type: CanvasNodeType) {
  if (type === CanvasNodeType.Image) return "图片";
  if (type === CanvasNodeType.Video) return "视频";
  if (type === CanvasNodeType.Audio) return "音频";
  if (type === CanvasNodeType.Config) return "生成配置";
  if (type === CanvasNodeType.TextAnnotation) return "注释";
  return "文本";
}
