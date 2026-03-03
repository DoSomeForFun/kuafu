import { Kernel, Store } from '../src/index.js';
import type { LLMCallOptions, LLMCallResult } from '../src/index.js';

/**
 * Basic Agent Example
 *
 * 演示如何通过构造函数注入真实 LLM，创建最小可运行的 agent。
 * 流程：Store → createTask → Kernel({ store, llm }) → run()
 */

// 1. 实现 LLM 函数（这里用 mock，实际替换为 OpenAI / Anthropic 等）
async function myLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  console.log('[LLM] prompt length:', options.prompt.length);
  // 替换为真实调用，例如：
  // const res = await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
  return {
    content: `Echo: ${options.prompt.slice(0, 50)}...`,
    usage: { promptTokens: 100, completionTokens: 20 },
    latencyMs: 42
  };
}

async function main() {
  // 2. 创建 Store（':memory:' = 内存，不持久化）
  const store = new Store(':memory:');

  // 3. 任务必须先存在，Kernel.run() 会从 store 读取
  const taskId = 'example-task-001';
  await store.createTask({
    id: taskId,
    title: 'Hello from kuafu-framework',
    date: new Date().toISOString().slice(0, 10)
  });

  // 4. 创建 Kernel，注入 llm 函数
  const kernel = new Kernel({ store, llm: myLLM });

  // 5. 执行任务
  const result = await kernel.run({
    taskId,
    prompt: 'What is 1+1?',
    sessionId: 'session-001',
    maxSteps: 3
  });

  // 6. 打印结果
  console.log('Status  :', result.status);      // 'DONE' | 'FAILED'
  console.log('Steps   :', result.steps);
  console.log('Content :', result.content);
  console.log('Duration:', result.durationMs, 'ms');
}

main().catch(console.error);
