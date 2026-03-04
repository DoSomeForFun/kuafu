/**
 * basic-agent.js — Standalone kuafu-framework example
 *
 * Run with: node examples/basic-agent.js
 * No compilation needed. Uses a mock LLM so no API key required.
 */
import { Kernel, Store, ConsoleSink } from '../dist/index.js';

// ── 1. Mock LLM (replace with real OpenAI/Anthropic call) ──────────────────
async function mockLLM(options) {
  const prompt = options.prompt || '';
  await new Promise((r) => setTimeout(r, 50)); // simulate latency

  // Simulate agent deciding it's done after seeing the prompt
  return {
    content: JSON.stringify({
      thinking: `I need to answer: ${prompt.slice(0, 80)}`,
      decision: 'DONE',
      response: `Answer: The result is 42. (mock response to: "${prompt.slice(0, 60)}")`
    }),
    model: 'mock-llm-v1',
    usage: { promptTokens: prompt.length, completionTokens: 60 },
    latencyMs: 50
  };
}

// ── 2. Setup ────────────────────────────────────────────────────────────────
const store = new Store(':memory:');

await store.createTask({
  id: 'task-001',
  title: 'Demo Task',
  date: new Date().toISOString().slice(0, 10),
});

// ── 3. Kernel with ConsoleSink (traces every LLM call to stdout) ────────────
const kernel = new Kernel({
  store,
  llm: mockLLM,
  traceSink: new ConsoleSink(),
  maxRetries: 1,
});

// ── 4. Run ──────────────────────────────────────────────────────────────────
console.log('▶ Running agent...\n');

const result = await kernel.run({
  taskId: 'task-001',
  prompt: 'What is the meaning of life?',
  sessionId: 'demo-session',
  maxSteps: 3,
});

// ── 5. Output ───────────────────────────────────────────────────────────────
console.log('\n── Result ──────────────────────────────');
console.log('Status  :', result.status);
console.log('Steps   :', result.steps);
console.log('Content :', result.content?.slice(0, 200));
console.log('Duration:', result.durationMs, 'ms');
