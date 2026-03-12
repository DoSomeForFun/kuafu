import { telemetry, runWithTrace } from '../telemetry.js';
import { Perception } from '../perception.js';
import { KernelFSM } from './fsm.js';
import { handlePerceiving, handleThinking, handleDeciding, handleActing, handleReflecting } from './handlers.js';
import type { KernelContext, KernelRunOptions, KernelRunResult, KernelState, LLMProvider, LLMCallOptions, LLMCallResult, EmbedFn } from './types.js';
import type { AfterRunHook, BeforeRunHook, ContextScope, RuntimeEvent, RuntimeHookDecision } from '../runtime.js';

function normalizeRuntimeScope(
  runtimeScope: ContextScope | undefined,
  contextScope: KernelRunOptions['contextScope']
): ContextScope {
  if (runtimeScope) return runtimeScope;
  if (contextScope === 'conversation') return 'conversation';
  if (contextScope === 'linked') return 'global';
  return 'local';
}

function buildDefaultRuntimeEvent(options: {
  taskId: string;
  sessionId: string;
  prompt: string;
  scope: ContextScope;
  runtimeEvent?: RuntimeEvent;
}): RuntimeEvent {
  if (options.runtimeEvent) {
    return {
      ...options.runtimeEvent,
      taskId: options.runtimeEvent.taskId || options.taskId,
      sessionId: options.runtimeEvent.sessionId || options.sessionId,
      content: options.runtimeEvent.content ?? options.prompt,
      scope: options.runtimeEvent.scope || options.scope,
      createdAt: options.runtimeEvent.createdAt || Date.now()
    };
  }
  return {
    type: 'user_message',
    scope: options.scope,
    actorId: 'user',
    taskId: options.taskId,
    sessionId: options.sessionId,
    content: options.prompt,
    createdAt: Date.now()
  };
}

async function runBeforeHooks(
  hooks: BeforeRunHook[],
  input: {
    event: RuntimeEvent;
    prompt: string;
    taskId: string;
    sessionId: string;
    scope: ContextScope;
  }
): Promise<RuntimeHookDecision> {
  for (const hook of hooks) {
    const decision = await hook(input);
    if (decision && decision.action !== 'allow') {
      return decision;
    }
  }
  return { action: 'allow' };
}

async function runAfterHooks(
  hooks: AfterRunHook[],
  input: {
    event: RuntimeEvent;
    prompt: string;
    content: string;
    success: boolean;
    taskId: string;
    sessionId: string;
    scope: ContextScope;
  }
): Promise<RuntimeHookDecision> {
  for (const hook of hooks) {
    const decision = await hook(input);
    if (decision && decision.action !== 'allow') {
      return decision;
    }
  }
  return { action: 'allow' };
}

/**
 * The Unified Kernel - Agent execution orchestrator
 * 
 * FSM States:
 * PERCEIVING → THINKING → DECIDING → ACTING → REFLECTING → (loop or DONE)
 */
export class Kernel {
  private store: any;
  private action: any;
  private perception: any;
  private llmProvider: LLMProvider;
  private progressSink: any;
  private embedFn?: EmbedFn;

  constructor(options: {
    store?: any;
    backend?: any;
    action?: any;
    llmProvider?: LLMProvider;
    workdir?: string;
    progressSink?: any;
    embedFn?: EmbedFn;
    [key: string]: any;
  } = {}) {
    this.store = options.store || options.backend;
    this.action = options.action || null;
    this.perception = options.perception || new Perception({ store: this.store });
    this.llmProvider = options.llmProvider || new StubLLMProvider();
    this.progressSink = options.progressSink || null;
    this.embedFn = options.embedFn;
  }

  /**
   * Run kernel with options
   */
  async run(options: KernelRunOptions): Promise<KernelRunResult> {
    const {
      taskId,
      prompt: originalPrompt,
      sessionId,
      maxTurns = options.maxSteps ?? 10,
      retrievedContext = [],
      onStep,
      maxHistory = 10,
      progressSink,
      isSimpleChat: forceSimpleChat,
      promptEmbedding,
      embedFn: runEmbedFn,
      runtimeScope,
      runtimeEvent,
      beforeRunHooks = [],
      afterRunHooks = [],
    } = options;

    const traceId = `task-${taskId}-sess-${sessionId}-${Date.now()}`;
    const resolvedProgressSink = progressSink || this.progressSink;
    const resolvedEmbedFn = runEmbedFn || this.embedFn;
    const resolvedScope = normalizeRuntimeScope(runtimeScope, options.contextScope);
    const resolvedRuntimeEvent = buildDefaultRuntimeEvent({
      taskId,
      sessionId,
      prompt: originalPrompt,
      scope: resolvedScope,
      runtimeEvent
    });

    return runWithTrace(traceId, async () => {
      const span = telemetry.startSpan('Kernel.run');
      
      try {
        const task = await this.store.getTaskById(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        const currentBranchId = task.current_branch_id || (await this.store.pivotBranch(taskId));
        const beforeRunDecision = await runBeforeHooks(beforeRunHooks, {
          event: resolvedRuntimeEvent,
          prompt: originalPrompt,
          taskId,
          sessionId,
          scope: resolvedScope
        });
        const effectivePrompt = beforeRunDecision.action === 'rewrite' && beforeRunDecision.prompt
          ? beforeRunDecision.prompt
          : originalPrompt;
        if (beforeRunDecision.action === 'capture' || beforeRunDecision.action === 'silence') {
          const durationMs = 0;
          return {
            success: true,
            status: 'DONE',
            content: '',
            steps: 0,
            durationMs,
            stopReason: beforeRunDecision.reason || beforeRunDecision.action,
            meta: {
              hooks: {
                beforeRun: beforeRunDecision,
                afterRun: null
              }
            }
          };
        }

        await this.saveUserPrompt(taskId, currentBranchId, effectivePrompt);

        const context: KernelContext = {
          taskId, sessionId, originalPrompt: effectivePrompt,
          maxSteps: 0, maxHistory,
          agentName: options.agentName,
          onStep,
          progressSink: resolvedProgressSink,
          progressHeartbeatMs: 6000,
          state: 'PERCEIVING' as KernelState,
          stepCount: 0, turnCount: 0, maxTurns,
          turnHint: null,
          isWorkspaceReady: false,
          forceSimpleChat, promptEmbedding,
          runtimeScope: resolvedScope,
          runtimeEvent: resolvedRuntimeEvent,
          lastHookDecision: beforeRunDecision,
          store: this.store,
          perception: this.perception,
          embedFn: resolvedEmbedFn,
          task, currentBranchId, retrievedContext,
          lessons: [],
          sensoryData: null, contextBlock: '',
          turnResult: null, advice: null, finalResult: null,
          isReroute: false,
          toolsUsed: [], toolFailures: 0,
          totalPromptTokens: 0, totalCompletionTokens: 0,
          runStartTime: Date.now()
        };

        this.emitProgress(context, 'RUN_STARTED', { status: 'RUNNING', maxTurns });

        const toolSpecs = this.action?.getSpecs?.() || [];

        const fsm = new KernelFSM(context);
        await fsm.run({
          handlePerceiving: (ctx) => handlePerceiving(ctx),
          handleThinking: (ctx) => handleThinking(ctx, {
            buildHistory: (c) => this.buildHistory(c),
            callLLM: (opts) => this.llmProvider.chat({ ...opts, tools: toolSpecs })
          }),
          handleDeciding: (ctx) => handleDeciding(ctx),
          handleActing: (ctx) => handleActing(ctx, this.action),
          handleReflecting: (ctx) => handleReflecting(ctx, this.store)
        });

        const durationMs = Date.now() - context.runStartTime;
        let kernelResult: KernelRunResult = {
          success: context.state === 'DONE',
          status: context.state as 'DONE' | 'FAILED',
          content: context.finalResult?.content || '',
          steps: context.stepCount,
          durationMs,
          stopReason: context.finalResult?.stopReason,
          meta: {
            loop: { stopReason: context.finalResult?.stopReason, durationMs },
            hooks: {
              beforeRun: beforeRunDecision,
              afterRun: null
            }
          }
        };

        const afterRunDecision = await runAfterHooks(afterRunHooks, {
          event: resolvedRuntimeEvent,
          prompt: effectivePrompt,
          content: kernelResult.content,
          success: kernelResult.success,
          taskId,
          sessionId,
          scope: resolvedScope
        });
        kernelResult.meta = {
          ...(kernelResult.meta || {}),
          hooks: {
            beforeRun: beforeRunDecision,
            afterRun: afterRunDecision
          }
        };
        if (afterRunDecision.action === 'silence' || afterRunDecision.action === 'capture') {
          kernelResult = {
            ...kernelResult,
            content: '',
            stopReason: afterRunDecision.reason || afterRunDecision.action
          };
        } else if (afterRunDecision.action === 'rewrite' && typeof afterRunDecision.content === 'string') {
          kernelResult = {
            ...kernelResult,
            content: afterRunDecision.content
          };
        }

        span.end({ success: kernelResult.success, durationMs });
        return kernelResult;
      } catch (error: any) {
        span.end({ success: false, error: error.message });
        return { success: false, status: 'FAILED', content: '', error: error.message, stopReason: 'error' };
      }
    });
  }

  private async saveUserPrompt(taskId: string, branchId: string, prompt: string): Promise<void> {
    const existingMsgs = await this.store.getActiveMessages(taskId, branchId);
    const lastMsg = existingMsgs[existingMsgs.length - 1];
    
    if (!lastMsg || lastMsg.sender_id !== 'user' || lastMsg.content !== prompt) {
      await this.store.saveTaskMessage({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        task_id: taskId,
        branch_id: branchId,
        sender_id: 'user',
        content: prompt,
        payload: {}
      });
    }
  }

  private async buildHistory(context: KernelContext): Promise<Array<{ role: string; content: string }>> {
    const messages = await this.store.getActiveMessages(context.taskId, context.currentBranchId);
    const recent = messages.slice(-context.maxHistory);
    return recent.map((msg: any) => ({
      role: msg.sender_id === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));
  }

  private emitProgress(context: KernelContext, type: string, data: any): void {
    if (context.progressSink) {
      context.progressSink.emit({ type, taskId: context.taskId, sessionId: context.sessionId, ...data });
    }
  }
}

/**
 * Fallback stub provider — logs a warning so callers know they need to inject a real one
 */
class StubLLMProvider implements LLMProvider {
  async chat(options: LLMCallOptions): Promise<LLMCallResult> {
    telemetry.warn('[Kernel] No LLMProvider injected, using stub. Inject a real provider via { llmProvider } option.');
    return { content: '', latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0 } };
  }
}

export default Kernel;
