/**
 * TDD Tests for Decision
 * Test-Driven Development: Test first, then implement
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Decision } from '../dist/index.js';

describe('Decision - TDD', () => {
  describe('构造函数', () => {
    it('应该能创建默认配置的 Decision', () => {
      const decision = new Decision();
      assert.ok(decision, '应该能创建 Decision 实例');
      assert.strictEqual(decision.getMaxSteps(), 30, '默认最大步数应该是 30');
    });

    it('应该能创建自定义配置的 Decision', () => {
      const decision = new Decision({ maxSteps: 50 });
      assert.strictEqual(decision.getMaxSteps(), 50, '应该能设置最大步数');
    });
  });

  describe('shouldContinue - 步数限制', () => {
    it('应该在达到最大步数时停止', () => {
      const decision = new Decision({ maxSteps: 5 });
      const history = [];
      
      const result = decision.shouldContinue(history, 5);
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
      assert.strictEqual(result.stopReason, 'max_steps_exceeded', '停止原因应该是步数超限');
    });

    it('应该在未达到最大步数时继续', () => {
      const decision = new Decision({ maxSteps: 10 });
      const history = [];
      
      const result = decision.shouldContinue(history, 3);
      
      assert.strictEqual(result.shouldContinue, true, '应该继续');
    });
  });

  describe('shouldContinue - 空响应检测', () => {
    it('应该在响应为空时停止', () => {
      const decision = new Decision();
      const history = [
        { sender_id: 'agent', content: '' }
      ];
      
      const result = decision.shouldContinue(history, 1);
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
      assert.strictEqual(result.stopReason, 'empty_response', '停止原因应该是空响应');
    });

    it('应该在响应不为空时继续', () => {
      const decision = new Decision();
      const history = [
        { sender_id: 'agent', content: '这是有效的响应内容' }
      ];
      
      const result = decision.shouldContinue(history, 1);
      
      assert.strictEqual(result.shouldContinue, true, '应该继续');
    });
  });

  describe('shouldContinue - 工具调用检测', () => {
    it('应该在有工具调用时继续', () => {
      const decision = new Decision();
      const history = [
        { sender_id: 'agent', content: '让我调用工具' }
      ];
      const toolCalls = [
        { function: { name: 'bash', arguments: { command: 'ls' } } }
      ];
      
      const result = decision.shouldContinue(history, 1, toolCalls);
      
      assert.strictEqual(result.shouldContinue, true, '应该继续执行工具');
    });
  });

  describe('shouldContinue - 任务完成检测', () => {
    it('应该在内容表明完成时停止', () => {
      const decision = new Decision();
      const history = [
        { sender_id: 'agent', content: '任务完成了！' }
      ];
      
      const result = decision.shouldContinue(history, 1);
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
      assert.strictEqual(result.stopReason, 'task_completed', '停止原因应该是任务完成');
    });

    it('应该在内容包含 done 时停止', () => {
      const decision = new Decision();
      const history = [
        { sender_id: 'agent', content: 'I have done the task.' }
      ];
      
      const result = decision.shouldContinue(history, 1);
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
    });

    it('应该在内容包含已完成时停止', () => {
      const decision = new Decision();
      const history = [
        { sender_id: 'agent', content: '已完成所有工作' }
      ];
      
      const result = decision.shouldContinue(history, 1);
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
    });
  });

  describe('shouldContinue - 循环检测', () => {
    it('应该检测到重复循环', () => {
      const decision = new Decision();
      const repetitiveContent = '重复的内容';
      const history = [
        { sender_id: 'agent', content: repetitiveContent },
        { sender_id: 'agent', content: repetitiveContent },
        { sender_id: 'agent', content: repetitiveContent },
        { sender_id: 'agent', content: repetitiveContent },
        { sender_id: 'agent', content: repetitiveContent },
        { sender_id: 'agent', content: repetitiveContent }
      ];
      
      const result = decision.shouldContinue(history, 6);
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
      assert.strictEqual(result.stopReason, 'loop_detected', '停止原因应该是检测到循环');
    });

    it('应该在没有循环时继续', () => {
      const decision = new Decision();
      const history = [
        { sender_id: 'agent', content: '内容 1' },
        { sender_id: 'agent', content: '内容 2' },
        { sender_id: 'agent', content: '内容 3' }
      ];
      
      const result = decision.shouldContinue(history, 3);
      
      assert.strictEqual(result.shouldContinue, true, '应该继续');
    });
  });

  describe('semanticCheck - 语义验证', () => {
    it('应该通过非空响应的语义检查', () => {
      const decision = new Decision();
      
      const result = decision.semanticCheck('测试提示', '这是有效的响应');
      
      assert.strictEqual(result.shouldContinue, true, '应该继续');
      assert.strictEqual(result.intercept, undefined, '不应该拦截');
    });

    it('应该拦截空响应', () => {
      const decision = new Decision();
      
      const result = decision.semanticCheck('测试提示', '');
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
      assert.strictEqual(result.intercept, true, '应该拦截');
      assert.ok(result.interceptMessage, '应该有拦截消息');
    });

    it('应该拦截只有空格的响应', () => {
      const decision = new Decision();
      
      const result = decision.semanticCheck('测试提示', '   ');
      
      assert.strictEqual(result.shouldContinue, false, '应该停止');
      assert.strictEqual(result.intercept, true, '应该拦截');
    });
  });

  describe('配置管理', () => {
    it('应该能更新最大步数', () => {
      const decision = new Decision({ maxSteps: 20 });
      decision.setMaxSteps(50);
      
      assert.strictEqual(decision.getMaxSteps(), 50, '最大步数应该已更新');
    });

    it('应该能获取当前最大步数', () => {
      const decision = new Decision({ maxSteps: 25 });
      
      assert.strictEqual(decision.getMaxSteps(), 25, '应该能获取最大步数');
    });
  });
});

console.log('✅ Decision TDD tests ready');
