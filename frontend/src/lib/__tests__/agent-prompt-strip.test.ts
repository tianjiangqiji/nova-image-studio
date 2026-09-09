import { describe, expect, it } from 'vitest';
import { stripAgentPromptBatchLanguage } from '@/lib/agent-chat-config';

describe('stripAgentPromptBatchLanguage', () => {
  it('把「生成 3 张」收成单张画面描述，避免绘图模型拼宫格', () => {
    const stripped = stripAgentPromptBatchLanguage('生成 3 张淘宝美妆电商主图，正方形1:1构图');
    expect(stripped).toContain('生成一张');
    expect(stripped).not.toMatch(/3\s*张/);
  });

  it('剥掉拼接/宫格措辞', () => {
    const stripped = stripAgentPromptBatchLanguage('一组3张拼接成一张的三宫格主图');
    expect(stripped).not.toContain('拼接');
    expect(stripped).not.toContain('三宫格');
    expect(stripped).not.toMatch(/3\s*张/);
  });

  it('不动模型写的比例文字：比例只走参数，不进 prompt', () => {
    const stripped = stripAgentPromptBatchLanguage('淘宝美妆电商主图，画面比例 3:4');
    expect(stripped).toContain('3:4');
  });
});
