import { telemetry, runWithTrace } from '../telemetry.js';
import { KernelFSM } from './fsm.js';
import { handlePerceiving, handleThinking, handleDeciding, handleActing, handleReflecting } from './handlers.js';
import type { KernelContext, KernelRunOptions, KernelRunResult, KernelState, LLMProvider, LLMCallOptions, LLMCallResult } from './types.js';

/**
 * The Unified Kernel - Agent execution orchestrator
 * 
 * FSM States:
 * PERCEIVING → THINKING → DECIDING → ACTING → REFLECTING → (loop or DONE)
 */
export class Kernel {
  private store: any;
  private action: any;
  private llmProvider: LLMProvider;
  private progressSink: any;

  constructor(options: {
    store?: any;
    backend?: any;
    action?: any;
    llmProvider?: LLMProvider;
    workdir?: string;
    progressSink?: any;
    [key: string]: any;
  } = {}) {
    this.store = options.store || options.backend;
    this.action = options.action || null;
    this.llmProvider = options.llmProvider || new StubLLMProvider();
    this.progressSink = options.progressSink || null;
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
      promptEmbedding
    } = options;

    const traceId = `task-${taskId}-sess-${sessionId}-${Date.now()}`;
    const resolvedProgressSink = progressSink || this.progressSink;

    return runWithTrace(traceId, async () => {
      const span = telemetry.startSpan('Kernel.run');
      
      try {
        const task = await this.store.getTaskById(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        const currentBranchId = task.current_branch_id || (await this.store.pivotBranch(taskId));
        await this.saveUserPrompt(taskId, currentBranchId, originalPrompt);

        const context: KernelContext = {
          taskId, sessionId, originalPrompt,
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
          task, currentBranchId, retrievedContext,
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
        const kernelResult: KernelRunResult = {
          success: context.state === 'DONE',
          status: context.state as 'DONE' | 'FAILED',
          content: context.finalResult?.content || '',
          steps: context.stepCount,
          durationMs,
          stopReason: context.finalResult?.stopReason,
          meta: { loop: { stopReason: context.finalResult?.stopReason, durationMs } }
        };

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
