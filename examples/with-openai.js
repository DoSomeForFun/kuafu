/**
 * with-openai.js — kuafu-framework + real OpenAI example
 *
 * Prerequisites:
 *   export OPENAI_API_KEY=sk-...
 *   export OPENAI_MODEL=gpt-4o-mini   # optional, defaults to gpt-4o-mini
 *
 * Run with: node examples/with-openai.js
 */
import { Kernel, Store, ConsoleSink } from '../dist/index.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

if (!OPENAI_API_KEY) {
  console.error('❌ Set OPENAI_API_KEY environment variable first.');
  process.exit(1);
}

// ── 1. Real OpenAI LLM function ─────────────────────────────────────────────
async function openaiLLM(options) {
  const messages = [];
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
  if (options.conversationHistory?.length) messages.push(...options.conversationHistory);
  messages.push({ role: 'user', content: options.prompt });

  const startMs = Date.now();
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => resp.statusText);
    throw new Error(`OpenAI error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  const usage = data.usage;

  return {
    content: choice?.message?.content ?? '',
    model: data.model ?? MODEL,
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    },
    latencyMs: Date.now() - startMs,
  };
}

// ── 2. Setup ─────────────────────────────────────────────────────────────────
const store = new Store(':memory:');

await store.createTask({
  id: 'task-openai-001',
  title: 'OpenAI Demo',
  date: new Date().toISOString().slice(0, 10),
});

// ── 3. Kernel with ConsoleSink + retry ────────────────────────────────────────
const kernel = new Kernel({
  store,
  llm: openaiLLM,
  traceSink: new ConsoleSink(),
  maxRetries: 2,
});

// ── 4. Run ────────────────────────────────────────────────────────────────────
console.log(`▶ Running agent with ${MODEL}...\n`);

const result = await kernel.run({
  taskId: 'task-openai-001',
  prompt: 'Explain what a state machine is in 2 sentences.',
  sessionId: 'openai-demo-session',
  maxSteps: 3,
});

// ── 5. Output ─────────────────────────────────────────────────────────────────
console.log('\n── Result ──────────────────────────────');
console.log('Status  :', result.status);
console.log('Steps   :', result.steps);
console.log('Content :', result.content);
console.log('Duration:', result.durationMs, 'ms');
