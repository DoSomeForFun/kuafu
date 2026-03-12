import { telemetry } from '../telemetry.js';
import type { KernelContext, LLMCallOptions, LLMCallResult } from './types.js';

/** Max chars of a single retrieved item included in contextBlock */
const MAX_ITEM_CHARS = 400;

/**
 * Handle PERCEIVING state — retrieve relevant context and build contextBlock
 */
export async function handlePerceiving(context: KernelContext): Promise<KernelContext> {
  const span = telemetry.startSpan('Kernel.handlePerceiving');

  try {
    let embedding = context.promptEmbedding;
    let retrievedContext = context.retrievedContext ?? [];
    let lessons = Array.isArray(context.lessons) ? context.lessons : [];

    // Generate embedding on demand if embedFn is available and not pre-supplied
    if (!embedding && context.embedFn) {
      try {
        embedding = await context.embedFn(context.originalPrompt);
      } catch {
        // non-fatal — fall back to recency retrieval
      }
    }

    // Vector or recency retrieval via store
    if (context.store?.searchRelevant && (embedding || retrievedContext.length === 0)) {
      try {
        const hits = context.store.searchRelevant({
          embedding: embedding ?? new Float32Array(0),
          filterByTaskId: context.taskId,
          limit: 6,
        });
        if (hits.length > 0) retrievedContext = hits;
      } catch {
        // non-fatal
      }
    }

    if (context.perception?.gather) {
      try {
        const perceptionResult = await context.perception.gather({
          prompt: context.originalPrompt,
          task: context.task,
          retrievedContext,
          sessionId: context.sessionId,
          taskId: context.taskId,
          isSimpleChat: context.forceSimpleChat
        });
        if (Array.isArray(perceptionResult?.retrievedContext) && perceptionResult.retrievedContext.length > 0) {
          retrievedContext = perceptionResult.retrievedContext;
        }
        if (Array.isArray(perceptionResult?.lessons)) {
          lessons = perceptionResult.lessons;
        }
      } catch {
        // non-fatal
      }
    }

    // Build contextBlock from retrieved items
    const contextBlock = context.perception?.formatToContext
      ? context.perception.formatToContext({ lessons, retrievedContext })
      : buildContextBlock(retrievedContext, lessons);

    span.end({ retrievedCount: retrievedContext.length, lessonCount: lessons.length });
    return {
      ...context,
      promptEmbedding: embedding,
      retrievedContext,
      lessons,
      contextBlock,
      state: 'THINKING',
    };
  } catch (error: any) {
    span.end({ error: error.message });
    throw error;
  }
}

function buildContextBlock(items: any[], lessons: any[] = []): string {
  const blocks: string[] = [];
  if (Array.isArray(lessons) && lessons.length > 0) {
    const lessonLines = ['## Lessons Learned'];
    for (const lesson of lessons) {
      const rootCause = String(lesson?.root_cause || '').trim();
      const avoid = String(lesson?.what_not_to_do || '').trim();
      const alternative = String(lesson?.suggested_alternatives || '').trim();
      if (rootCause) lessonLines.push(`- Root cause: ${rootCause}`);
      if (avoid) lessonLines.push(`- Avoid: ${avoid}`);
      if (alternative) lessonLines.push(`- Alternative: ${alternative}`);
    }
    if (lessonLines.length > 1) {
      blocks.push(lessonLines.join('\n'));
    }
  }

  const lines = items
    .filter(item => item?.content)
    .map(item => {
      const sender = item.senderId || item.sender_id || 'unknown';
      const text = String(item.content).slice(0, MAX_ITEM_CHARS);
      return `[${sender}]: ${text}`;
    });
  if (lines.length > 0) {
    blocks.push(`## Relevant Context\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Handle THINKING state
 */
export async function handleThinking(
  context: KernelContext,
  deps: { buildHistory: (ctx: KernelContext) => Promise<Array<{ role: string; content: string }>>; callLLM: (opts: LLMCallOptions) => Promise<LLMCallResult> }
): Promise<KernelContext> {
  const span = telemetry.startSpan('Kernel.handleThinking');
  
  try {
    const history = await deps.buildHistory(context);

    const llmResult = await deps.callLLM({
      prompt: context.originalPrompt,
      systemPrompt: context.contextBlock,
      history
    });

    span.end();
    return {
      ...context,
      turnResult: llmResult,
      totalPromptTokens: context.totalPromptTokens + (llmResult.usage?.promptTokens || 0),
      totalCompletionTokens: context.totalCompletionTokens + (llmResult.usage?.completionTokens || 0),
      state: 'DECIDING'
    };
  } catch (error: any) {
    span.end({ error: error.message });
    throw error;
  }
}

/**
 * Handle DECIDING state
 */
export async function handleDeciding(context: KernelContext): Promise<KernelContext> {
  const span = telemetry.startSpan('Kernel.handleDeciding');
  
  try {
    const turnResult = context.turnResult;
    
    if (turnResult?.toolCalls && turnResult.toolCalls.length > 0) {
      span.end();
      return {
        ...context,
        toolsUsed: [...context.toolsUsed, ...turnResult.toolCalls.map((tc: any) => tc.function?.name)],
        state: 'ACTING'
      };
    }

    span.end();
    return {
      ...context,
      finalResult: {
        content: turnResult?.content || '',
        stopReason: 'task_completed'
      },
      state: 'DONE'
    };
  } catch (error: any) {
    span.end({ error: error.message });
    throw error;
  }
}

/**
 * Handle ACTING state — executes all tool calls in parallel
 */
export async function handleActing(
  context: KernelContext,
  action: any
): Promise<KernelContext> {
  const span = telemetry.startSpan('Kernel.handleActing');
  
  try {
    const turnResult = context.turnResult;
    
    if (!turnResult?.toolCalls) {
      span.end();
      return { ...context, state: 'THINKING' };
    }

    const toolCalls = turnResult.toolCalls;
    const total = toolCalls.length;
    const actingStart = Date.now();

    context.progressSink?.emit({
      type: 'tool_parallel_start',
      taskId: context.taskId,
      sessionId: context.sessionId,
      toolTotal: total,
      step: context.stepCount,
    });

    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall: any, index: number) => {
        const toolStart = Date.now();
        context.progressSink?.emit({
          type: 'tool_start',
          taskId: context.taskId,
          sessionId: context.sessionId,
          toolName: toolCall.function?.name,
          toolIndex: index,
          toolTotal: total,
          step: context.stepCount,
        });

        const result = await action.invokeTool(toolCall);

        context.progressSink?.emit({
          type: 'tool_end',
          taskId: context.taskId,
          sessionId: context.sessionId,
          toolName: toolCall.function?.name,
          toolIndex: index,
          toolTotal: total,
          ok: result.ok,
          durationMs: Date.now() - toolStart,
          step: context.stepCount,
        });

        return result;
      })
    );

    const toolFailures = context.toolFailures + toolResults.filter((r: any) => !r.ok).length;

    span.end({ toolTotal: total, durationMs: Date.now() - actingStart });
    return {
      ...context,
      toolFailures,
      turnResult: { ...turnResult, toolResults },
      state: 'REFLECTING'
    };
  } catch (error: any) {
    span.end({ error: error.message });
    throw error;
  }
}

/**
 * Handle REFLECTING state — persist tool results, optionally save embedding for future recall
 */
export async function handleReflecting(
  context: KernelContext,
  store: any
): Promise<KernelContext> {
  const span = telemetry.startSpan('Kernel.handleReflecting');
  
  try {
    const toolResults: any[] = context.turnResult?.toolResults || [];

    const parts: string[] = [];
    for (const result of toolResults) {
      if (result.ok) {
        parts.push(result.stdout || 'ok');
      } else {
        parts.push(`[error] ${result.error || 'unknown'}`);
      }
    }
    const reflectionContent = parts.join('\n---\n');

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await store.saveTaskMessage({
      id: messageId,
      task_id: context.taskId,
      branch_id: context.currentBranchId,
      sender_id: context.agentName || 'agent',
      content: reflectionContent,
      payload: { toolResults }
    });

    // Persist embedding for future semantic recall (non-blocking)
    if (reflectionContent.trim() && context.embedFn && store.upsertVector) {
      context.embedFn(reflectionContent).then(embedding => {
        store.upsertVector({
          messageId,
          taskId: context.taskId,
          senderId: context.agentName || 'agent',
          content: reflectionContent,
          embedding,
        });
      }).catch(() => { /* non-fatal */ });
    }

    const allFailed = toolResults.length > 0 && toolResults.every((r: any) => !r.ok);
    
    span.end();
    if (allFailed) {
      return {
        ...context,
        finalResult: { content: reflectionContent, stopReason: 'all_tools_failed' },
        state: 'DONE'
      };
    }
    return { ...context, state: 'THINKING' };
  } catch (error: any) {
    span.end({ error: error.message });
    throw error;
  }
}
