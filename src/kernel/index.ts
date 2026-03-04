import { randomUUID } from 'node:crypto';
import { Decision } from '../decision.js';
import { Perception } from '../perception.js';
import { telemetry, runWithTrace } from '../telemetry.js';
import { KernelFSM } from './fsm.js';
import type {
  KernelContext,
  KernelDependencies,
  KernelRunOptions,
  KernelRunResult,
  LLMCallOptions,
  LLMCallResult,
  LLMFunction,
  MemoryItem,
  MemoryProvider,
  ToolActionRecord,
  ToolEvidence
} from './types.js';
import type { ContextBlock, IAction, IDecision, IPerception, IProgressSink, IStore, OutcomeSink, TraceSink } from '../types.js';

/**
 * The Unified Kernel - Agent execution orchestrator
 *
 * FSM States:
 * PERCEIVING → THINKING → DECIDING → ACTING → REFLECTING → (loop or DONE)
 */
export class Kernel {
  private store: IStore;
  private action: IAction | null;
  private perception: IPerception;
  private decision: IDecision;
  private memory: MemoryProvider | null;
  private progressSink: IProgressSink | null;
  private outcomeSink: OutcomeSink | null;
  private actionSink: ((record: ToolActionRecord) => void) | null;
  private traceSink: TraceSink | null;
  private llmFn: LLMFunction | null;
  private maxRetries: number;

  constructor(options: KernelDependencies = {}) {
    const store = options.store ?? options.backend;
    if (!store) {
      throw new Error('Kernel requires a store/backend implementation.');
    }

    this.store = store;
    this.action = options.action ?? null;
    this.perception = options.perception ?? (new Perception() as IPerception);
    this.decision = options.decision ?? (new Decision() as IDecision);
    this.memory = options.memory ?? null;
    this.progressSink = options.progressSink ?? null;
    this.outcomeSink = options.outcomeSink ?? null;
    this.actionSink = options.actionSink ?? null;
    this.traceSink = options.traceSink ?? null;
    this.llmFn = options.llm ?? null;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /**
   * Run kernel with options
   */
  async run(options: KernelRunOptions): Promise<KernelRunResult> {
    const {
      taskId,
      prompt: originalPrompt,
      sessionId,
      maxSteps = 30,
      retrievedContext = [],
      onStep,
      maxHistory = 10,
      progressSink,
      outcomeSink: perCallOutcomeSink,
      isSimpleChat: forceSimpleChat,
      promptEmbedding,
      trigger = 'unknown',
      outcomeMeta
    } = options;

    const resolvedOutcomeSink = perCallOutcomeSink ?? this.outcomeSink;
    const resolvedProgressSink = progressSink ?? this.progressSink;
    const traceId = `task-${taskId}-sess-${sessionId}-${Date.now()}`;

    return runWithTrace(traceId, async () => {
      const span = telemetry.startSpan('Kernel.run');

      try {
        const task = await this.store.getTaskById(taskId);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        }

        const currentBranchId = task.current_branch_id || (await this.store.pivotBranch(taskId));
        await this.saveUserPrompt(taskId, currentBranchId, originalPrompt);

        const context: KernelContext = {
          // Config
          taskId,
          sessionId,
          originalPrompt,
          maxSteps,
          maxHistory,
          agentName: options.agentName,
          onStep,
          progressSink: resolvedProgressSink,
          progressHeartbeatMs: 6000,

          // Components
          decision: this.decision,
          perception: this.perception,

          // Runtime State
          state: 'PERCEIVING',
          stepCount: 0,
          turnHint: null,
          isWorkspaceReady: false,
          forceSimpleChat,
          promptEmbedding,

          // Data
          task,
          currentBranchId,
          retrievedContext,
          retrievedMemory: [],
          conversationHistory: [],
          sensoryData: null,
          contextBlock: '',
          contextBlocks: null,
          turnResult: null,
          advice: null,
          finalResult: null,
          lastToolEvidence: null,

          // Flags
          isReroute: false,

          // Metrics
          toolsUsed: [],
          toolFailures: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          runStartTime: Date.now()
        };

        this.emitProgress(context, 'RUN_STARTED', {
          status: 'RUNNING',
          maxSteps
        });

        const fsm = new KernelFSM(context);
        const finalContext = await fsm.run({
          handlePerceiving: async (ctx) => this.handlePerceiving(ctx),
          handleThinking: async (ctx) => this.handleThinking(ctx),
          handleDeciding: async (ctx) => this.handleDeciding(ctx),
          handleActing: async (ctx) => this.handleActing(ctx),
          handleReflecting: async (ctx) => this.handleReflecting(ctx)
        });

        const durationMs = Date.now() - finalContext.runStartTime;
        const kernelResult: KernelRunResult = {
          success: finalContext.state === 'DONE',
          status: finalContext.state === 'DONE' ? 'DONE' : 'FAILED',
          content: finalContext.finalResult?.content || '',
          steps: finalContext.stepCount,
          durationMs,
          stopReason: finalContext.finalResult?.stopReason,
          meta: {
            loop: {
              stopReason: finalContext.finalResult?.stopReason,
              durationMs
            },
            // Verifiable Tape: surface injected memory items so callers can store context traces
            retrievedMemory: finalContext.retrievedMemory
          }
        };

        // Fire-and-forget: let memory provider persist the assistant response for long-term memory
        if (finalContext.state === 'DONE' && this.memory?.store && finalContext.finalResult?.content) {
          const responseContent = finalContext.finalResult.content;
          this.memory.store({
            id: `kernel-${randomUUID()}`,
            content: responseContent,
            source: 'kernel-output',
            purpose: 'knowledge',
            // Pass routing context so bridge-side store() can scope by chat/thread
            // isHandoff=true triggers a separate handoff-summary row in kuafu_facts
            metadata: { taskId, sessionId, isHandoff: true }
          }).catch((err: unknown) => {
            console.warn('[Kernel] memory.store() failed:', err instanceof Error ? err.message : String(err));
          });
        }

        span.end({
          success: kernelResult.success,
          durationMs
        });

        if (resolvedOutcomeSink) {
          try {
            await resolvedOutcomeSink.onOutcome({
              taskId,
              sessionId,
              status: kernelResult.success ? 'completed' : 'failed',
              content: kernelResult.content,
              trigger,
              durationMs,
              error: kernelResult.error,
              metadata: outcomeMeta
            });
          } catch (sinkErr: unknown) {
            console.warn('[Kernel] outcomeSink.onOutcome failed:', this.getErrorMessage(sinkErr));
          }
        }

        return kernelResult;
      } catch (error: unknown) {
        const errorMessage = this.getErrorMessage(error);
        span.end({
          success: false,
          error: errorMessage
        });

        const failedResult: KernelRunResult = {
          success: false,
          status: 'FAILED',
          content: '',
          error: errorMessage,
          stopReason: 'error'
        };

        if (resolvedOutcomeSink) {
          try {
            await resolvedOutcomeSink.onOutcome({
              taskId,
              sessionId,
              status: 'failed',
              content: '',
              trigger,
              error: errorMessage
            });
          } catch {
            // ignore sink errors on failure path
          }
        }

        return failedResult;
      }
    });
  }

  /**
   * Save user prompt to history
   */
  private async saveUserPrompt(taskId: string, branchId: string, prompt: string): Promise<void> {
    const existingMsgs = await this.store.getActiveMessages(taskId, branchId);
    const lastMsg = existingMsgs[existingMsgs.length - 1];

    if (!lastMsg || lastMsg.sender_id !== 'user' || lastMsg.content !== prompt) {
      await this.store.saveTaskMessage({
        id: randomUUID(),
        task_id: taskId,
        branch_id: branchId,
        sender_id: 'user',
        content: prompt,
        payload: {}
      });
    }
  }

  /**
   * Handle PERCEIVING state
   */
  private async handlePerceiving(context: KernelContext): Promise<KernelContext> {
    const span = telemetry.startSpan('Kernel.handlePerceiving');

    try {
      // Retrieve memory in parallel with perception
      const [perceptionData, memoryItems] = await Promise.all([
        context.perception.gather({
          prompt: context.originalPrompt,
          task: context.task,
          retrievedContext: context.retrievedContext,
          sessionId: context.sessionId,
          taskId: context.taskId,
          isSimpleChat: context.forceSimpleChat
        }),
        this.memory
          ? this.memory.retrieve(context.originalPrompt, {
              sessionId: context.sessionId,
              taskId: context.taskId,
              scope: 'global'
            }).catch((err: unknown) => {
              // Non-fatal: log and continue without memory
              console.warn('[Kernel] MemoryProvider.retrieve() failed:', err instanceof Error ? err.message : String(err));
              return [] as MemoryItem[];
            })
          : Promise.resolve([] as MemoryItem[])
      ]);

      // Split memory items by purpose:
      // - 'chat_history' → inject as multi-turn conversationHistory for the LLM
      // - 'knowledge' (default) → inject as <retrieved_memory> block in system prompt
      const conversationHistory = memoryItems
        .filter(m => m.purpose === 'chat_history' && m.content.trim())
        .map(m => ({
          role: (m.metadata?.['role'] === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant' | 'system',
          content: m.content
        }));
      const otherMemory = memoryItems.filter(m => m.purpose !== 'chat_history');

      context = {
        ...context,
        sensoryData: perceptionData,
        contextBlock: perceptionData.state.contextBlock || '',
        contextBlocks: perceptionData.blocks ?? null,
        retrievedMemory: otherMemory,
        conversationHistory,
        state: 'THINKING'
      };

      span.end();
      return context;
    } catch (error: unknown) {
      span.end({ error: this.getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Handle THINKING state
   */
  private async handleThinking(context: KernelContext): Promise<KernelContext> {
    const span = telemetry.startSpan('Kernel.handleThinking');

    try {
      // If the previous ACTING step had failures, append structured evidence
      // so the LLM knows what it tried, what failed, and why — not a blank slate.
      let prompt = context.originalPrompt;
      if (context.lastToolEvidence && context.lastToolEvidence.length > 0) {
        const failureBlock = context.lastToolEvidence
          .map(e => `[Tool Failed] ${e.toolName}\nError: ${e.error}${e.stderr ? `\nStderr: ${e.stderr}` : ''}`)
          .join('\n');
        prompt = `${prompt}\n\n[Previous Step Failures — do not retry the same approach]\n${failureBlock}`;
      }

      let systemPrompt =
        context.contextBlocks && context.contextBlocks.length > 0
          ? this.assembleSystemPrompt(context.contextBlocks)
          : context.contextBlock;

      // Inject retrieved memory items into the system prompt as a context block
      if (context.retrievedMemory && context.retrievedMemory.length > 0) {
        const memoryBlock = context.retrievedMemory
          .map(m => `[Memory:${m.source ?? 'unknown'}] ${m.content}`)
          .join('\n');
        systemPrompt = `${systemPrompt}\n\n<retrieved_memory>\n${memoryBlock}\n</retrieved_memory>`;
      }

      const llmResult = await this.callLLM({
        prompt,
        systemPrompt,
        conversationHistory: context.conversationHistory.length > 0 ? context.conversationHistory : undefined,
        tools: this.action?.getSpecs?.() ?? []
      });

      // Fire-and-forget: emit trace for Deterministic Context Assembly
      if (this.traceSink) {
        const traceId = `trace-${context.taskId}-step-${context.stepCount}-${Date.now()}`;
        // fire-and-forget: wrap in Promise.resolve so async rejections are also caught
        Promise.resolve(this.traceSink.onTrace({
          traceId,
          taskId: context.taskId,
          sessionId: context.sessionId,
          stepCount: context.stepCount,
          model: llmResult.model,
          prompt,
          systemPrompt,
          conversationHistory: context.conversationHistory,
          retrievedMemory: context.retrievedMemory.map(m => ({ id: m.id, content: m.content, source: m.source, purpose: m.purpose })),
          contextBlocks: context.contextBlocks,
          toolSpecs: this.action?.getSpecs?.() ?? [],
          llmResult: {
            content: llmResult.content,
            model: llmResult.model,
            thinking: llmResult.thinking,
            toolCalls: llmResult.toolCalls,
            usage: llmResult.usage,
            latencyMs: llmResult.latencyMs
          },
          timestamp: Date.now()
        })).catch((traceErr: unknown) => {
          console.warn('[Kernel] traceSink.onTrace failed:', this.getErrorMessage(traceErr));
        });
      }

      context = {
        ...context,
        turnResult: llmResult,
        totalPromptTokens: context.totalPromptTokens + (llmResult.usage?.promptTokens || 0),
        totalCompletionTokens: context.totalCompletionTokens + (llmResult.usage?.completionTokens || 0),
        state: 'DECIDING'
      };

      span.end();
      return context;
    } catch (error: unknown) {
      span.end({ error: this.getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Handle DECIDING state
   */
  private async handleDeciding(context: KernelContext): Promise<KernelContext> {
    const span = telemetry.startSpan('Kernel.handleDeciding');

    try {
      const turnResult = context.turnResult;

      if (turnResult?.toolCalls && turnResult.toolCalls.length > 0) {
        context = {
          ...context,
          toolsUsed: [...context.toolsUsed, ...turnResult.toolCalls.map((tc) => tc.function.name)],
          state: 'ACTING'
        };
      } else {
        context = {
          ...context,
          finalResult: {
            content: turnResult?.content || '',
            stopReason: 'task_completed'
          },
          state: 'DONE'
        };
      }

      span.end();
      return context;
    } catch (error: unknown) {
      span.end({ error: this.getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Handle ACTING state
   */
  private async handleActing(context: KernelContext): Promise<KernelContext> {
    const span = telemetry.startSpan('Kernel.handleActing');

    try {
      const turnResult = context.turnResult;
      if (!turnResult?.toolCalls) {
        context = {
          ...context,
          state: 'THINKING'
        };
        return context;
      }

      const toolResults = [];
      for (const toolCall of turnResult.toolCalls) {
        const toolStartMs = Date.now();

        if (!this.action) {
          const noActionResult = { ok: false as const, error: 'Action executor not configured' };
          toolResults.push(noActionResult);
          context.toolFailures++;
          if (this.actionSink) {
            try {
              this.actionSink({ id: randomUUID(), taskId: context.taskId, sessionId: context.sessionId, toolName: toolCall.function?.name ?? 'unknown', toolArgs: this.parseToolArgs(toolCall.function?.arguments), toolResult: noActionResult, durationMs: Date.now() - toolStartMs, createdAt: Date.now() });
            } catch { /* non-fatal */ }
          }
          continue;
        }

        const result = await this.action.invokeTool(toolCall).catch((err: unknown) => ({
          ok: false as const,
          error: this.getErrorMessage(err)
        }));
        toolResults.push(result);

        if (!result.ok) {
          context.toolFailures++;
        }

        // Fire-and-forget: record tool execution provenance (Verifiable Tape)
        if (this.actionSink) {
          try {
            this.actionSink({ id: randomUUID(), taskId: context.taskId, sessionId: context.sessionId, toolName: toolCall.function?.name ?? 'unknown', toolArgs: this.parseToolArgs(toolCall.function?.arguments), toolResult: result, durationMs: Date.now() - toolStartMs, createdAt: Date.now() });
          } catch { /* non-fatal */ }
        }
      }

      context = {
        ...context,
        turnResult: {
          ...turnResult,
          toolResults
        },
        state: 'REFLECTING'
      };

      span.end();
      return context;
    } catch (error: unknown) {
      span.end({ error: this.getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Handle REFLECTING state
   * Collects structured evidence from any failed tool calls and stores it in
   * lastToolEvidence, which the next THINKING step will inject into the LLM prompt.
   */
  private async handleReflecting(context: KernelContext): Promise<KernelContext> {
    const span = telemetry.startSpan('Kernel.handleReflecting');

    try {
      const toolCalls = context.turnResult?.toolCalls ?? [];
      const toolResults = context.turnResult?.toolResults ?? [];

      const lastToolEvidence: ToolEvidence[] = toolResults
        .map((result, i) => ({ result, toolCall: toolCalls[i] }))
        .filter(({ result }) => !result.ok)
        .map(({ result, toolCall }) => ({
          toolName: toolCall?.function?.name ?? 'unknown',
          error: result.error ?? 'unknown error',
          stdout: result.stdout,
          stderr: result.stderr
        }));

      context = {
        ...context,
        lastToolEvidence: lastToolEvidence.length > 0 ? lastToolEvidence : null,
        state: 'THINKING'
      };

      span.end();
      return context;
    } catch (error: unknown) {
      span.end({ error: this.getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Assemble a structured system prompt from context blocks.
   */
  private assembleSystemPrompt(blocks: ContextBlock[]): string {
    return blocks
      .map((block) => {
        const header = block.label ?? block.type.toUpperCase().replace('_', ' ');
        return `### ${header}${block.source ? ` (source: ${block.source})` : ''}\n${block.content}`;
      })
      .join('\n\n');
  }

  /**
   * Call LLM — uses injected llm function if provided, otherwise returns a no-op stub.
   * Override by passing `llm` to the constructor: `new Kernel({ store, llm: myLLMFn })`
   */
  private async callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
    if (this.llmFn) {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          return await this.llmFn(options);
        } catch (err: unknown) {
          lastErr = err;
          if (attempt < this.maxRetries) {
            const delayMs = 500 * Math.pow(2, attempt);
            console.warn(`[Kernel] LLM call failed (attempt ${attempt + 1}/${this.maxRetries + 1}), retrying in ${delayMs}ms:`, this.getErrorMessage(err));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
      throw new Error(`LLM call failed after ${this.maxRetries + 1} attempts: ${this.getErrorMessage(lastErr)}`);
    }
    // Stub: replace by injecting a real LLM via constructor `llm` option
    void options;
    return {
      content: '',
      usage: { promptTokens: 0, completionTokens: 0 },
      latencyMs: 0
    };
  }

  /**
   * Emit progress event
   */
  private emitProgress(context: KernelContext, type: string, data: Record<string, unknown>): void {
    if (context.progressSink) {
      context.progressSink.emit({
        type,
        taskId: context.taskId,
        sessionId: context.sessionId,
        ...data
      });
    }
  }

  private parseToolArgs(args: unknown): Record<string, unknown> {
    if (typeof args === 'object') return args as Record<string, unknown>;
    try { return JSON.parse(String(args)); } catch { return { _raw: String(args) }; }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export default Kernel;
