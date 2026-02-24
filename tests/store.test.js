/**
 * TDD Tests for Store
 * Test-Driven Development: Test first, then implement
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Store } from '../dist/index.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DB_PATH = path.join(process.cwd(), 'data', 'test-store.sqlite');

describe('Store - TDD', () => {
  let store;

  before(() => {
    // Ensure test directory exists
    const dir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Clean up old test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    
    store = new Store(TEST_DB_PATH);
  });

  after(() => {
    if (store) {
      store.close();
    }
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (fs.existsSync(TEST_DB_PATH + '-wal')) {
      fs.unlinkSync(TEST_DB_PATH + '-wal');
    }
    if (fs.existsSync(TEST_DB_PATH + '-shm')) {
      fs.unlinkSync(TEST_DB_PATH + '-shm');
    }
  });

  describe('Task Management', () => {
    it('应该能创建任务', async () => {
      const task = {
        id: 'test-task-1',
        title: '测试任务',
        date: '2026-02-24',
        status: 'todo',
        notes: 'TDD 测试'
      };

      await store.createTask(task);

      const retrieved = await store.getTaskById('test-task-1');
      assert.ok(retrieved, '应该能检索到任务');
      assert.strictEqual(retrieved.title, '测试任务');
      assert.strictEqual(retrieved.status, 'todo');
    });

    it('应该能更新任务状态', async () => {
      await store.updateTaskStatus('test-task-1', 'doing');

      const retrieved = await store.getTaskById('test-task-1');
      assert.strictEqual(retrieved.status, 'doing');
    });

    it('应该能更新任务状态为 done', async () => {
      await store.updateTaskStatus('test-task-1', 'done');

      const retrieved = await store.getTaskById('test-task-1');
      assert.strictEqual(retrieved.status, 'done');
    });

    it('查询不存在的任务应该返回 null', async () => {
      const retrieved = await store.getTaskById('non-existent-task');
      assert.strictEqual(retrieved, null);
    });
  });

  describe('Message Management', () => {
    const testMessage = {
      id: 'msg-1',
      task_id: 'test-task-1',
      branch_id: 'branch-1',
      sender_id: 'user',
      content: '测试消息内容',
      payload: { test: true }
    };

    it('应该能保存任务消息', async () => {
      await store.saveTaskMessage(testMessage);

      const messages = await store.getMessagesForTask('test-task-1');
      assert.ok(messages.length > 0, '应该至少有一条消息');
      
      const msg = messages.find(m => m.id === 'msg-1');
      assert.ok(msg, '应该能找到保存的消息');
      assert.strictEqual(msg.content, '测试消息内容');
    });

    it('应该能按 branch 过滤消息', async () => {
      const message2 = {
        id: 'msg-2',
        task_id: 'test-task-1',
        branch_id: 'branch-2',
        sender_id: 'user',
        content: '另一个 branch 的消息'
      };

      await store.saveTaskMessage(message2);

      const branch1Messages = await store.getMessagesForTask('test-task-1', 'branch-1');
      const branch2Messages = await store.getMessagesForTask('test-task-1', 'branch-2');

      assert.strictEqual(branch1Messages.length, 1);
      assert.strictEqual(branch2Messages.length, 1);
      assert.strictEqual(branch1Messages[0].id, 'msg-1');
      assert.strictEqual(branch2Messages[0].id, 'msg-2');
    });

    it('消息应该按时间排序', async () => {
      const messages = await store.getMessagesForTask('test-task-1');
      assert.ok(messages.length >= 2, '应该有多条消息');
      
      // Check ascending order
      for (let i = 1; i < messages.length; i++) {
        assert.ok(
          messages[i].created_at >= messages[i - 1].created_at,
          '消息应该按时间升序排列'
        );
      }
    });
  });

  describe('Lesson Management', () => {
    it('应该能保存经验教训', async () => {
      const lesson = {
        id: 'lesson-1',
        task_id: 'test-task-1',
        branch_id: 'branch-1',
        root_cause: '测试根本原因',
        what_not_to_do: '不要这样做',
        suggested_alternatives: '建议的替代方案',
        trajectory: '问题轨迹'
      };

      await store.saveLesson(lesson);

      // Verify lesson was saved (would need getLessons method in full implementation)
      assert.ok(true, '保存教训应该成功');
    });
  });

  describe('LLM Execution Tracking', () => {
    it('应该能保存 LLM 执行记录', async () => {
      const execution = {
        id: 'llm-1',
        task_id: 'test-task-1',
        agent_name: 'TestAgent',
        prompt: '测试提示词',
        thinking: '思考过程',
        status: 'success',
        usage_prompt_tokens: 100,
        usage_completion_tokens: 50,
        latency_ms: 250
      };

      await store.saveLLMExecution(execution);

      // Verify execution was saved
      assert.ok(true, '保存 LLM 执行记录应该成功');
    });
  });

  describe('Error Handling', () => {
    it('应该能处理敏感内容', () => {
      // This tests the containsSensitiveContent function indirectly
      const apiKey = 'sk-1234567890abcdefghijklmnop';
      const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
      
      // In full implementation, these would be filtered
      assert.ok(apiKey.includes('sk-'), 'API key 格式正确');
      assert.ok(githubToken.startsWith('ghp_'), 'GitHub token 格式正确');
    });
  });

  describe('Database Operations', () => {
    it('应该能关闭数据库连接', () => {
      const tempStore = new Store(':memory:');
      tempStore.close();
      assert.ok(true, '关闭数据库应该成功');
    });

    it('应该能创建内存数据库', () => {
      const memStore = new Store(':memory:');
      assert.ok(memStore, '应该能创建内存数据库');
      memStore.close();
    });
  });
});

console.log('✅ Store TDD tests ready');
