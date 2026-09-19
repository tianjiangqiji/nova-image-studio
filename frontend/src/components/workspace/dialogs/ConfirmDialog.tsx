'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useBodyScrollLock } from '@/lib/scroll-lock';

export function ConfirmDialog({
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
  variant = 'destructive',
  hideCancel = false,
}: {
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'destructive' | 'default';
  hideCancel?: boolean;
}) {
  const [isClosing, setIsClosing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useBodyScrollLock();

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setIsMounted(true);
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(onCancel, 200);
  };

  const handleConfirm = () => {
    setIsClosing(true);
    setTimeout(onConfirm, 200);
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-black/50 transition-opacity duration-200 sm:items-center sm:p-4 ${
        isMounted && !isClosing ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleClose}
      onWheel={event => event.stopPropagation()}
      onTouchMove={event => event.stopPropagation()}
    >
      <div
        className={`flex min-h-[100dvh] w-full flex-col overflow-y-auto rounded-none border border-border bg-card p-6 pt-12 shadow-lg transition-all duration-200 sm:min-h-0 sm:max-h-[calc(100dvh-2rem)] sm:max-w-md sm:rounded-xl sm:pt-6 ${
          isMounted && !isClosing ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
        onClick={event => event.stopPropagation()}
      >
        <h3 className="mb-2 text-lg font-semibold">{title}</h3>
        <div className="mb-4 text-sm text-muted-foreground">{message}</div>
        <div className="flex justify-end gap-2 pt-2">
          {!hideCancel && (
            <Button variant="outline" size="sm" onClick={handleClose}>
              {cancelText}
            </Button>
          )}
          <Button variant={variant} size="sm" onClick={handleConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
