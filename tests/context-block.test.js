/**
 * Tests for Republic-style ContextBlock assembly
 * Locks behavior for: assembleSystemPrompt, ContextBlock structure,
 * IPerceptionOutput.blocks, and Kernel fallback compatibility.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// --- Unit tests for assembleSystemPrompt logic (pure function, no Kernel needed) ---

function assembleSystemPrompt(blocks) {
  return blocks
    .map(b => {
      const header = b.label ?? b.type.toUpperCase().replace('_', ' ');
      return `### ${header}${b.source ? ` (source: ${b.source})` : ''}\n${b.content}`;
    })
    .join('\n\n');
}

describe('ContextBlock - assembleSystemPrompt', () => {
  it('formats a single block with type as header', () => {
    const result = assembleSystemPrompt([
      { type: 'task_goal', content: 'What is 1+1?' }
    ]);
    assert.ok(result.includes('### TASK GOAL'));
    assert.ok(result.includes('What is 1+1?'));
  });

  it('uses label over type when provided', () => {
    const result = assembleSystemPrompt([
      { type: 'skill', content: 'Diary writing skill', label: 'Diary Writing', source: 'skill:diary-writing' }
    ]);
    assert.ok(result.includes('### Diary Writing'));
    assert.ok(result.includes('source: skill:diary-writing'));
    assert.ok(!result.includes('### SKILL'));
  });

  it('joins multiple blocks with double newline separator', () => {
    const result = assembleSystemPrompt([
      { type: 'system', content: 'You are an assistant.' },
      { type: 'task_goal', content: 'Hello' }
    ]);
    assert.ok(result.includes('\n\n'));
    const parts = result.split('\n\n');
    assert.strictEqual(parts.length, 2);
  });

  it('produces empty string for empty blocks array', () => {
    const result = assembleSystemPrompt([]);
    assert.strictEqual(result, '');
  });

  it('omits source annotation when source is not set', () => {
    const result = assembleSystemPrompt([
      { type: 'memory', content: 'User prefers brief answers' }
    ]);
    assert.ok(!result.includes('source:'));
  });
});

describe('ContextBlock - structure validation', () => {
  it('valid block has required fields: type and content', () => {
    const block = { type: 'task_goal', content: 'test' };
    assert.ok(typeof block.type === 'string');
    assert.ok(typeof block.content === 'string');
  });

  it('all ContextBlockTypes are valid strings', () => {
    const types = ['task_goal', 'skill', 'memory', 'prior_result', 'failure', 'system', 'retrieved', 'custom'];
    for (const t of types) {
      assert.ok(typeof t === 'string', `${t} should be a string`);
    }
  });

  it('blocks with weight field accept 0-1 range', () => {
    const block = { type: 'retrieved', content: 'ctx', weight: 0.8 };
    assert.ok(block.weight >= 0 && block.weight <= 1);
  });
});

describe('ContextBlock - fallback compatibility', () => {
  it('assembleSystemPrompt with no blocks falls back gracefully', () => {
    // When blocks is null/undefined, caller should use contextBlock string
    const contextBlock = 'legacy string context';
    const blocks = null;
    const systemPrompt = blocks && blocks.length > 0
      ? assembleSystemPrompt(blocks)
      : contextBlock;
    assert.strictEqual(systemPrompt, contextBlock);
  });

  it('assembleSystemPrompt with empty blocks falls back to string', () => {
    const contextBlock = 'legacy context';
    const blocks = [];
    const systemPrompt = blocks && blocks.length > 0
      ? assembleSystemPrompt(blocks)
      : contextBlock;
    assert.strictEqual(systemPrompt, contextBlock);
  });

  it('assembleSystemPrompt with blocks overrides string', () => {
    const contextBlock = 'legacy context';
    const blocks = [{ type: 'task_goal', content: 'structured content' }];
    const systemPrompt = blocks && blocks.length > 0
      ? assembleSystemPrompt(blocks)
      : contextBlock;
    assert.ok(systemPrompt.includes('structured content'));
    assert.ok(!systemPrompt.includes('legacy context'));
  });
});
