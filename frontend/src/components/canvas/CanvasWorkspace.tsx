"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FolderOpen, Frame, Layers, PanelLeftOpen, Plus, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CanvasEditor } from "./CanvasEditor";
import { CanvasThumbnail } from "./components/canvas-thumbnail";
import { useCanvasStore } from "./stores/use-canvas-store";
import { exportCanvasProjects, importCanvasProjectsFromZip } from "./utils/canvas-export";

type CanvasWorkspaceProps = {
  wideMode?: boolean;
  onConfigureApiKey: () => void;
  onEnableWideMode: () => void;
  showToast: (message: string, type: "success" | "error" | "info") => void;
  showPromptGallery?: boolean;
};

type SortMode = "updated" | "created" | "name";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "updated", label: "最近修改" },
  { value: "created", label: "创建时间" },
  { value: "name", label: "名称" },
];

export function CanvasWorkspace({ wideMode, onConfigureApiKey, onEnableWideMode, showToast, showPromptGallery }: CanvasWorkspaceProps) {
  const hydrated = useCanvasStore((state) => state.hydrated);
  const projects = useCanvasStore((state) => state.projects);
  const createProject = useCanvasStore((state) => state.createProject);
  const renameProject = useCanvasStore((state) => state.renameProject);
  const deleteProjects = useCanvasStore((state) => state.deleteProjects);
  const importProject = useCanvasStore((state) => state.importProject);

  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("updated");
  const [mounted, setMounted] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const sortedProjects = useMemo(() => {
    const list = [...projects];
    if (sortMode === "name") list.sort((a, b) => a.title.localeCompare(b.title, "zh"));
    else if (sortMode === "created") list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list;
  }, [projects, sortMode]);

  // 画布仅在宽屏模式下可用（按宽度模式判断，非检测设备），以降低适配成本。
  if (!wideMode) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-border py-20">
        <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          <Frame className="size-10 text-muted-foreground" />
          <h2 className="text-base font-semibold">无限画布需要宽屏模式</h2>
          <p className="text-sm text-muted-foreground">请使用电脑，或切换到宽屏模式（窗口宽度需 ≥ 1280px）。</p>
          <Button size="sm" onClick={onEnableWideMode}>
            <PanelLeftOpen className="size-4" />
            切换宽屏模式
          </Button>
        </div>
      </div>
    );
  }

  if (activeProjectId) {
    return (
      <div className="relative h-full min-h-[70vh] w-full overflow-hidden rounded-2xl border border-border bg-card">
        <CanvasEditor projectId={activeProjectId} onBack={() => setActiveProjectId(null)} onRequireApiKey={onConfigureApiKey} showToast={showToast} showPromptGallery={showPromptGallery} />
      </div>
    );
  }

  const handleImport = async (file: File) => {
    try {
      const imported = await importCanvasProjectsFromZip(file);
      imported.forEach((project) => importProject(project));
      showToast(`已导入 ${imported.length} 个画布`, "success");
    } catch {
      showToast("导入失败，请确认是导出的画布 zip", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">无限画布</h2>
          <p className="text-xs text-muted-foreground">节点式画布生图 · 连线引用 · 生成走任务队列</p>
        </div>
        <div className="flex items-center gap-2">
          {projects.length > 0 && (
            <Select<SortMode> value={sortMode} onValueChange={setSortMode} options={SORT_OPTIONS} size="sm" contentClassName="min-w-32" />
          )}
          <input ref={importInputRef} type="file" accept=".zip" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file); event.target.value = ""; }} />
          <Button variant="outline" size="sm" onClick={() => importInputRef.current?.click()}>
            <Upload className="size-4" />
            导入
          </Button>
          <Button size="sm" onClick={() => setActiveProjectId(createProject())}>
            <Plus className="size-4" />
            新建画布
          </Button>
        </div>
      </div>

      {!mounted || !hydrated ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border py-16 text-sm text-muted-foreground">加载中…</div>
      ) : projects.length === 0 ? (
        <button
          type="button"
          onClick={() => setActiveProjectId(createProject())}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-16 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Layers className="size-8" />
          还没有画布，点击新建第一个
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortedProjects.map((project) => (
            <div key={project.id} className={cn("group flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm transition-colors hover:border-primary/40")}>
              <button type="button" className="block w-full" aria-label="打开画布" onClick={() => setActiveProjectId(project.id)}>
                <CanvasThumbnail nodes={project.nodes} />
              </button>

              {editingId === project.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    renameProject(project.id, editingTitle);
                    setEditingId(null);
                  }}
                >
                  <Input autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} onBlur={() => { renameProject(project.id, editingTitle); setEditingId(null); }} />
                </form>
              ) : (
                <button type="button" className="w-full rounded-md text-left transition-colors hover:text-primary" title="点击重命名" onClick={() => { setEditingId(project.id); setEditingTitle(project.title); }}>
                  <span className="line-clamp-1 font-medium">{project.title}</span>
                </button>
              )}

              <p className="text-xs text-muted-foreground">
                {project.nodes.length} 个节点 · {new Date(project.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => setActiveProjectId(project.id)}>
                  <FolderOpen className="size-4" />
                  打开
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="导出" onClick={() => void exportCanvasProjects([project], project.title || "无限画布")}>
                  <Download className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="删除" onClick={() => setDeleteId(project.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={Boolean(deleteId)} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除画布</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">删除后无法恢复（未被其他画布引用的图片和媒体会从本地清理）。确定删除该画布吗？</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteId) deleteProjects([deleteId]);
                setDeleteId(null);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
