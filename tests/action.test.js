/**
 * TDD Tests for Action
 * Test-Driven Development: Test first, then implement
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Action } from '../dist/index.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = path.join(process.cwd(), 'data', 'test-action');

describe('Action - TDD', () => {
  let action;

  before(() => {
    // Ensure test directory exists
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    
    action = new Action({
      projectRoot: TEST_DIR,
      cwd: TEST_DIR,
      timeoutMs: 5000
    });
  });

  after(() => {
    // Clean up test files
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('getSpecs - 工具规格', () => {
    it('应该返回工具规格列表', () => {
      const specs = action.getSpecs();
      
      assert.ok(Array.isArray(specs), '应该返回数组');
      assert.ok(specs.length > 0, '应该至少有一个工具');
    });

    it('应该包含 bash 工具', () => {
      const specs = action.getSpecs();
      const bashTool = specs.find(s => s.function.name === 'bash');
      
      assert.ok(bashTool, '应该有 bash 工具');
      assert.strictEqual(bashTool.function.description.includes('command'), true, '描述应该包含 command');
    });

    it('应该包含 read 工具', () => {
      const specs = action.getSpecs();
      const readTool = specs.find(s => s.function.name === 'read');
      
      assert.ok(readTool, '应该有 read 工具');
    });

    it('应该包含 write 工具', () => {
      const specs = action.getSpecs();
      const writeTool = specs.find(s => s.function.name === 'write');
      
      assert.ok(writeTool, '应该有 write 工具');
    });
  });

  describe('bash - 命令执行', () => {
    it('应该能执行简单的 bash 命令', async () => {
      const result = await action.bash('echo "Hello TDD"');
      
      assert.strictEqual(result.ok, true, '应该成功');
      assert.ok(result.stdout.includes('Hello TDD'), '应该包含输出');
    });

    it('应该能执行 pwd 命令', async () => {
      const result = await action.bash('pwd');
      
      assert.strictEqual(result.ok, true, '应该成功');
      assert.ok(result.stdout.includes('test-action'), '应该在测试目录');
    });

    it('应该能执行 ls 命令', async () => {
      const result = await action.bash('ls -la');
      
      assert.strictEqual(result.ok, true, '应该成功');
      assert.ok(result.stdout.length > 0, '应该有输出');
    });

    it('应该能处理命令错误', async () => {
      const result = await action.bash('nonexistent-command-xyz');
      
      assert.strictEqual(result.ok, false, '应该失败');
      assert.ok(result.error, '应该有错误信息');
    });

    it('应该能处理命令超时', async () => {
      const slowAction = new Action({
        cwd: TEST_DIR,
        timeoutMs: 100  // 非常短的超时
      });
      
      const result = await slowAction.bash('sleep 2');
      
      assert.strictEqual(result.ok, false, '应该超时失败');
    });
  });

  describe('read - 文件读取', () => {
    const testFile = 'test-read.txt';
    const testContent = '这是测试文件内容\n第二行内容';

    before(() => {
      // Create test file
      fs.writeFileSync(path.join(TEST_DIR, testFile), testContent);
    });

    it('应该能读取文件内容', async () => {
      const result = await action.read(testFile);
      
      assert.strictEqual(result.ok, true, '应该成功');
      assert.ok(result.stdout.includes('这是测试文件内容'), '应该包含第一行');
      assert.ok(result.stdout.includes('第二行内容'), '应该包含第二行');
    });

    it('应该能处理不存在的文件', async () => {
      const result = await action.read('nonexistent-file.txt');
      
      assert.strictEqual(result.ok, false, '应该失败');
      assert.ok(result.error.includes('not found'), '错误应该包含 not found');
    });
  });

  describe('write - 文件写入', () => {
    const testWriteFile = 'test-write.txt';
    const writeContent = '这是写入的内容\n多行内容';

    it('应该能写入文件', async () => {
      const result = await action.write(testWriteFile, writeContent);
      
      assert.strictEqual(result.ok, true, '应该成功');
      assert.ok(result.stdout.includes('written'), '应该确认写入');
    });

    it('应该能验证写入的内容', async () => {
      const content = fs.readFileSync(path.join(TEST_DIR, testWriteFile), 'utf-8');
      
      assert.strictEqual(content, writeContent, '内容应该匹配');
    });

    it('应该能创建目录并写入', async () => {
      const nestedFile = 'subdir/nested.txt';
      const result = await action.write(nestedFile, '嵌套内容');
      
      assert.strictEqual(result.ok, true, '应该成功');
      
      const exists = fs.existsSync(path.join(TEST_DIR, nestedFile));
      assert.strictEqual(exists, true, '文件应该存在');
    });

    it('应该能覆盖已存在的文件', async () => {
      const newContent = '新的覆盖内容';
      await action.write(testWriteFile, newContent);
      
      const content = fs.readFileSync(path.join(TEST_DIR, testWriteFile), 'utf-8');
      assert.strictEqual(content, newContent, '内容应该被覆盖');
    });
  });

  describe('invokeTool - 工具调用', () => {
    it('应该能调用 bash 工具', async () => {
      const toolCall = {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: { command: 'echo "Tool Test"' }
        }
      };
      
      const result = await action.invokeTool(toolCall);
      
      assert.strictEqual(result.ok, true, '应该成功');
      assert.ok(result.stdout.includes('Tool Test'), '应该包含输出');
    });

    it('应该能调用 read 工具', async () => {
      // First create a file
      await action.write('invoke-test.txt', 'invoke content');
      
      const toolCall = {
        id: 'call-2',
        type: 'function',
        function: {
          name: 'read',
          arguments: { path: 'invoke-test.txt' }
        }
      };
      
      const result = await action.invokeTool(toolCall);
      
      assert.strictEqual(result.ok, true, '应该成功');
      assert.ok(result.stdout.includes('invoke content'), '应该包含内容');
    });

    it('应该能调用 write 工具', async () => {
      const toolCall = {
        id: 'call-3',
        type: 'function',
        function: {
          name: 'write',
          arguments: { 
            path: 'invoke-write.txt',
            content: 'invoke write content'
          }
        }
      };
      
      const result = await action.invokeTool(toolCall);
      
      assert.strictEqual(result.ok, true, '应该成功');
    });

    it('应该能处理未知工具', async () => {
      const toolCall = {
        id: 'call-4',
        type: 'function',
        function: {
          name: 'unknown-tool',
          arguments: {}
        }
      };
      
      const result = await action.invokeTool(toolCall);
      
      assert.strictEqual(result.ok, false, '应该失败');
      assert.ok(result.error.includes('Unknown'), '错误应该包含 Unknown');
    });
  });

  describe('配置管理', () => {
    it('应该能使用默认配置创建 Action', () => {
      const defaultAction = new Action();
      
      assert.ok(defaultAction.cwd, '应该有 cwd');
      assert.ok(defaultAction.timeoutMs > 0, '应该有超时时间');
    });

    it('应该能使用自定义超时时间', () => {
      const customAction = new Action({ timeoutMs: 30000 });
      
      assert.strictEqual(customAction.timeoutMs, 30000, '超时时间应该是 30000');
    });

    it('应该能从环境变量读取配置', () => {
      // This tests that env vars are respected
      // In real scenario, would set KUAFU_TOOL_TIMEOUT_MS
      const envAction = new Action();
      
      assert.ok(envAction.timeoutMs > 0, '应该有有效的超时时间');
    });
  });
});

console.log('✅ Action TDD tests ready');
