import { telemetry } from '../telemetry.js';
import type { KernelContext, LLMCallOptions, LLMCallResult } from './types.js';

/**
 * Handle PERCEIVING state
 */
export async function handlePerceiving(context: KernelContext): Promise<KernelContext> {
  const span = telemetry.startSpan('Kernel.handlePerceiving');
  
  try {
    const perceptionData = await context.perception.gather({
      prompt: context.originalPrompt,
      task: context.task,
      retrievedContext: context.retrievedContext,
      sessionId: context.sessionId,
      taskId: context.taskId,
      isSimpleChat: context.forceSimpleChat
    });

    span.end();
    return {
      ...context,
      sensoryData: perceptionData,
      contextBlock: perceptionData.state?.contextBlock || '',
      state: 'THINKING'
    };
  } catch (error: any) {
    span.end({ error: error.message });
    throw error;
  }
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
 * Handle ACTING state
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

    const toolResults = [];
    let toolFailures = context.toolFailures;
    for (const toolCall of turnResult.toolCalls) {
      const result = await action.invokeTool(toolCall);
      toolResults.push(result);
      if (!result.ok) toolFailures++;
    }

    span.end();
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
 * Handle REFLECTING state — evaluate tool results and persist to history
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

    await store.saveTaskMessage({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      task_id: context.taskId,
      branch_id: context.currentBranchId,
      sender_id: context.agentName || 'agent',
      content: reflectionContent,
      payload: { toolResults }
    });

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
