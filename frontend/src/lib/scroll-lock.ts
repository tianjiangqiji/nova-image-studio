'use client';

import { useEffect } from 'react';

let lockCount = 0;
let originalOverflow = '';
let originalPaddingRight = '';

/**
 * 锁定 document.body 滚动，并通过 paddingRight 补偿 Windows/桌面端系统滚动条宽度，
 * 避免弹窗打开/关闭时发生 15~17px 的整屏横向抖动（CLS）与 window.scrollTo 视口跳帧。
 */
export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') {
    return () => {};
  }

  if (lockCount === 0) {
    originalOverflow = document.body.style.overflow;
    originalPaddingRight = document.body.style.paddingRight;

    // 检查是否已存在稳定滚动条占位槽（如 CSS scrollbar-gutter: stable），避免双重宽度补偿导致画面位移
    const hasStableGutter = typeof window !== 'undefined' &&
      Boolean(window.getComputedStyle(document.documentElement).scrollbarGutter?.includes('stable') ||
              window.getComputedStyle(document.body).scrollbarGutter?.includes('stable'));

    document.body.style.overflow = 'hidden';

    if (!hasStableGutter) {
      // 计算当前真实系统滚动条宽度（Windows 桌面端通常为 15-17px）
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
    }
  }

  lockCount++;
  let unlocked = false;

  return () => {
    if (unlocked) return;
    unlocked = true;
    lockCount--;

    if (lockCount <= 0) {
      lockCount = 0;
      if (originalOverflow) {
        document.body.style.overflow = originalOverflow;
      } else {
        document.body.style.removeProperty('overflow');
      }

      if (originalPaddingRight) {
        document.body.style.paddingRight = originalPaddingRight;
      } else {
        document.body.style.removeProperty('padding-right');
      }
    }
  };
}

/**
 * React Hook：在组件挂载时锁定 body 滚动，卸载时平滑恢复。
 */
export function useBodyScrollLock(enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;
    return lockBodyScroll();
  }, [enabled]);
}
