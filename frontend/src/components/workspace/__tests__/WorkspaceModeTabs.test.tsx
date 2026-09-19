import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { WorkspaceModeTabs } from '../WorkspaceModeTabs';

describe('WorkspaceModeTabs', () => {
  it('renders all default mode tabs and supports wide mode', () => {
    const { rerender } = render(
      <Tabs defaultValue="agent">
        <WorkspaceModeTabs wideMode={false} showPromptGallery={false} />
      </Tabs>
    );

    expect(screen.getByRole('tab', { name: /Agent/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /生图工作台/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /视频工作台/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /无限画布/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /UI设计模式/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /我的素材/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /反推提示词/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /动图生成/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /提示词广场/i })).toBeNull();

    // Rerender with prompt gallery
    rerender(
      <Tabs defaultValue="agent">
        <WorkspaceModeTabs wideMode={false} showPromptGallery={true} />
      </Tabs>
    );
    expect(screen.getByRole('tab', { name: /提示词广场/i })).toBeInTheDocument();

    // Rerender with wideMode
    rerender(
      <Tabs defaultValue="agent">
        <WorkspaceModeTabs wideMode={true} showPromptGallery={true} />
      </Tabs>
    );
    expect(screen.getByRole('tab', { name: /Agent/i })).toBeInTheDocument();
  });

  it('automatically enters compact mobile tab mode when available width cannot fit full text', async () => {
    // Mock getBoundingClientRect for tabs and container
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute?.('data-measure-tab')) {
        // Mock each tab needing ~110px
        return {
          width: 110,
          height: 40,
          top: 0,
          left: 0,
          bottom: 40,
          right: 110,
          x: 0,
          y: 0,
          toJSON: () => {},
        };
      }
      return originalGetBoundingClientRect.apply(this);
    };

    // Mock clientWidth on container to be narrow (e.g. 700px, where 8 tabs * 110px = 880px > 700px)
    let containerWidth = 700;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        if (this.classList?.contains('relative') && this.classList?.contains('w-full')) {
          return containerWidth;
        }
        return 700;
      },
    });

    const { container } = render(
      <Tabs defaultValue="agent">
        <WorkspaceModeTabs wideMode={false} showPromptGallery={false} />
      </Tabs>
    );

    // Initial effect should detect 700px < required width (~900px) and enter compact mode
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const tabsList = container.querySelector('[data-slot="tabs-list"]');
    expect(tabsList).not.toBeNull();
    // Compact mode applies flex + overflow-x-auto without sm:grid
    expect(tabsList?.className).toContain('overflow-x-auto');
    expect(tabsList?.className).not.toContain('sm:grid-cols-8');

    // Restore methods
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it('exits compact mode and restores grid layout when width is sufficient', async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute?.('data-measure-tab')) {
        return {
          width: 100,
          height: 40,
          top: 0,
          left: 0,
          bottom: 40,
          right: 100,
          x: 0,
          y: 0,
          toJSON: () => {},
        };
      }
      return originalGetBoundingClientRect.apply(this);
    };

    // Width is 1400px (well above 8 * 100px + padding)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 1400;
      },
    });

    const { container } = render(
      <Tabs defaultValue="agent">
        <WorkspaceModeTabs wideMode={false} showPromptGallery={false} />
      </Tabs>
    );

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const tabsList = container.querySelector('[data-slot="tabs-list"]');
    expect(tabsList?.className).toContain('sm:grid');
    expect(tabsList?.className).toContain('sm:grid-cols-8');

    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });
});
