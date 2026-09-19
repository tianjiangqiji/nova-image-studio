import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lockBodyScroll } from '../scroll-lock';

describe('scroll-lock', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  });

  afterEach(() => {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  });

  it('locks body overflow and restores previous overflow on unlock', () => {
    document.body.style.overflow = 'auto';

    const unlock = lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');
    // Ensure position: fixed is NEVER used, to prevent window.scrollTo viewport flash
    expect(document.body.style.position).toBe('');
    expect(document.body.style.top).toBe('');

    unlock();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('compensates for scrollbar width using paddingRight when scrollbar exists', () => {
    // Mock window.innerWidth and document.documentElement.clientWidth
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(983); // 17px scrollbar

    const unlock = lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.paddingRight).toBe('17px');

    unlock();
    expect(document.body.style.paddingRight).toBe('');
  });

  it('handles nested locks gracefully with reference counting', () => {
    const unlock1 = lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');

    const unlock2 = lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');

    // First unlock should not restore yet because lock2 is still active
    unlock1();
    expect(document.body.style.overflow).toBe('hidden');

    // Second unlock should restore original styles
    unlock2();
    expect(document.body.style.overflow).toBe('');
  });

  it('is idempotent if unlock is called multiple times', () => {
    const unlock = lockBodyScroll();
    unlock();
    expect(document.body.style.overflow).toBe('');
    // Calling unlock again should not cause negative lockCount issues
    unlock();
    expect(document.body.style.overflow).toBe('');
  });
});
