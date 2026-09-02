'use client';

import { useCallback, useState } from 'react';

/**
 * 拖拽上传区。沿用 ImageToImageForm 里已有的 onDrop/onDragOver/onDragLeave 写法，
 * 抽出来是因为视频工作台有图片、视频、音频三个区域都要支持拖入。
 */
export function useMediaDropZone(onFiles: (files: File[]) => void, disabled = false) {
  const [isDragOver, setIsDragOver] = useState(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    setIsDragOver(true);
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  }, [disabled, onFiles]);

  return {
    isDragOver,
    dropProps: { onDragOver, onDragLeave, onDrop },
  };
}
