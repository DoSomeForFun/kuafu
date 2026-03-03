import { Kernel, Store } from '../src/index.js';

/**
 * Basic Agent Example
 *
 * 演示如何使用 @kuafu/framework 创建最小可运行的 agent。
 * 流程：创建 Store → 创建任务 → 创建 Kernel → run() → 打印结果
 *
 * 注意：Kernel.callLLM() 是可覆盖的 stub。
 * 真实项目中继承 Kernel 并覆盖 callLLM 接入 OpenAI / Anthropic 等。
 */

const TASK_ID = 'example-task-001';
const SESSION_ID = 'example-session-001';

async function main() {
  // 1. 创建 Store（':memory:' = 内存数据库，不持久化）
  const store = new Store(':memory:');

  // 2. 任务必须先存在，Kernel.run() 会从 store 读取它
  await store.createTask({
    id: TASK_ID,
    title: 'Example: What is 1+1?',
    date: new Date().toISOString().slice(0, 10),
    notes: 'Basic framework demo'
  });

  // 3. 创建 Kernel，传入 store
  const kernel = new Kernel({ store });

  // 4. 执行任务
  const result = await kernel.run({
    taskId: TASK_ID,
    prompt: 'What is 1+1?',
    sessionId: SESSION_ID,
    maxSteps: 5,
    contextScope: 'isolated'
  });

  // 5. 打印结果
  console.log('Status :', result.status);     // 'DONE' | 'FAILED'
  console.log('Steps  :', result.steps);
  console.log('Content:', result.content);
  console.log('Duration:', result.durationMs, 'ms');
}

main().catch(console.error);
