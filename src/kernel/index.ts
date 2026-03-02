import { telemetry, runWithTrace } from '../telemetry.js';
import { KernelFSM } from './fsm.js';
import type { KernelContext, KernelRunOptions, KernelRunResult, KernelState } from './types.js';
import type { OutcomeSink } from '../types.js';

/**
 * The Unified Kernel - Agent execution orchestrator
 * 
 * FSM States:
 * PERCEIVING → THINKING → DECIDING → ACTING → REFLECTING → (loop or DONE)
 */
export class Kernel {
  private store: any;
  private action: any;
  private progressSink: any;
  private outcomeSink: OutcomeSink | null;

  constructor(options: {
    store?: any;
    backend?: any;
    action?: any;
    workdir?: string;
    progressSink?: any;
    outcomeSink?: OutcomeSink;
    [key: string]: any;
  } = {}) {
    this.store = options.store || options.backend;
    this.action = options.action || null;
    this.progressSink = options.progressSink || null;
    this.outcomeSink = options.outcomeSink || null;
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
      promptEmbedding
    } = options;
    const resolvedOutcomeSink = perCallOutcomeSink || this.outcomeSink;

    const traceId = `task-${taskId}-sess-${sessionId}-${Date.now()}`;
    const resolvedProgressSink = progressSink || this.progressSink;

    return runWithTrace(traceId, async () => {
      const span = telemetry.startSpan('Kernel.run');
      
      try {
        // Get task
        const task = await this.store.getTaskById(taskId);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        }

        // Get or create branch
        const currentBranchId = task.current_branch_id || (await this.store.pivotBranch(taskId));

        // Save user prompt to history
        await this.saveUserPrompt(taskId, currentBranchId, originalPrompt);

        // Initialize context
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
          
          // Runtime State
          state: 'PERCEIVING' as KernelState,
          stepCount: 0,
          turnHint: null,
          isWorkspaceReady: false,
          forceSimpleChat,
          promptEmbedding,
          
          // Data
          task,
          currentBranchId,
          retrievedContext,
          sensoryData: null,
          contextBlock: '',
          turnResult: null,
          advice: null,
          finalResult: null,
          
          // Flags
          isReroute: false,
          
          // Metrics
          toolsUsed: [],
          toolFailures: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          runStartTime: Date.now()
        };

        // Emit start event
        this.emitProgress(context, 'RUN_STARTED', {
          status: 'RUNNING',
          maxSteps
        });

        // Create FSM and handlers
        const fsm = new KernelFSM(context);
        
        const result = await fsm.run({
          handlePerceiving: async (ctx) => await this.handlePerceiving(ctx),
          handleThinking: async (ctx) => await this.handleThinking(ctx),
          handleDeciding: async (ctx) => await this.handleDeciding(ctx),
          handleActing: async (ctx) => await this.handleActing(ctx),
          handleReflecting: async (ctx) => await this.handleReflecting(ctx)
        });

        const durationMs = Date.now() - context.runStartTime;
        
        // Build result
        const kernelResult: KernelRunResult = {
          success: context.state === 'DONE',
          status: context.state as 'DONE' | 'FAILED',
          content: context.finalResult?.content || '',
          steps: context.stepCount,
          durationMs,
          stopReason: context.finalResult?.stopReason,
          meta: {
            loop: {
              stopReason: context.finalResult?.stopReason,
              durationMs
            }
          }
        };

        span.end({
          success: kernelResult.success,
          durationMs
        });

        // Notify outcome sink (fire-and-forget, never throws)
        if (resolvedOutcomeSink) {
          try {
            await resolvedOutcomeSink.onOutcome({
              taskId,
              sessionId,
              status: kernelResult.success ? 'completed' : 'failed',
              content: kernelResult.content,
              trigger: (options as any).trigger || 'unknown',
              durationMs,
              error: kernelResult.error,
              metadata: (options as any).outcomeMeta
            });
          } catch (sinkErr: any) {
            console.warn('[Kernel] outcomeSink.onOutcome failed:', sinkErr.message);
          }
        }

        return kernelResult;
      } catch (error: any) {
        span.end({
          success: false,
          error: error.message
        });

        const failedResult = {
          success: false,
          status: 'FAILED' as const,
          content: '',
          error: error.message,
          stopReason: 'error'
        };

        if (resolvedOutcomeSink) {
          try {
            await resolvedOutcomeSink.onOutcome({
              taskId,
              sessionId,
              status: 'failed',
              content: '',
              trigger: (options as any).trigger || 'unknown',
              error: error.message
            });
          } catch (_) { /* ignore */ }
        }

        return failedResult;
      }
    });
  }

  /**
   * Save user prompt to history
   */
  private async saveUserPrompt(
    taskId: string,
    branchId: string,
    prompt: string
  ): Promise<void> {
    const existingMsgs = await this.store.getActiveMessages(taskId, branchId);
    const lastMsg = existingMsgs[existingMsgs.length - 1];
    
    if (!lastMsg || lastMsg.senderId !== 'user' || lastMsg.content !== prompt) {
      await this.store.saveTaskMessage({
        taskId,
        branchId,
        senderId: 'user',
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
      // Gather perception data
      const perceptionData = await context.perception.gather({
        prompt: context.originalPrompt,
        task: context.task,
        retrievedContext: context.retrievedContext,
        sessionId: context.sessionId,
        taskId: context.taskId,
        isSimpleChat: context.forceSimpleChat
      });

      context = {
        ...context,
        sensoryData: perceptionData,
        contextBlock: perceptionData.state?.contextBlock || '',
        state: 'THINKING'
      };

      span.end();
      return context;
    } catch (error: any) {
      span.end({ error: error.message });
      throw error;
    }
  }

  /**
   * Handle THINKING state
   */
  private async handleThinking(context: KernelContext): Promise<KernelContext> {
    const span = telemetry.startSpan('Kernel.handleThinking');
    
    try {
      // Build prompt and call LLM
      // Simplified - full implementation would build system prompt + history
      const llmResult = await this.callLLM({
        prompt: context.originalPrompt,
        systemPrompt: context.contextBlock
      });

      context = {
        ...context,
        turnResult: llmResult,
        totalPromptTokens: context.totalPromptTokens + (llmResult.usage?.promptTokens || 0),
        totalCompletionTokens: context.totalCompletionTokens + (llmResult.usage?.completionTokens || 0),
        state: 'DECIDING'
      };

      span.end();
      return context;
    } catch (error: any) {
      span.end({ error: error.message });
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
      
      // Check if LLM returned tool calls
      if (turnResult?.toolCalls && turnResult.toolCalls.length > 0) {
        context = {
          ...context,
          toolsUsed: [...context.toolsUsed, ...turnResult.toolCalls.map((tc: any) => tc.function?.name)],
          state: 'ACTING'
        };
      } else {
        // No tool calls, task is complete
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
    } catch (error: any) {
      span.end({ error: error.message });
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

      // Execute tools
      const toolResults = [];
      for (const toolCall of turnResult.toolCalls) {
        const result = await this.action.invokeTool(toolCall);
        toolResults.push(result);
        
        if (!result.ok) {
          context.toolFailures++;
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
    } catch (error: any) {
      span.end({ error: error.message });
      throw error;
    }
  }

  /**
   * Handle REFLECTING state
   */
  private async handleReflecting(context: KernelContext): Promise<KernelContext> {
    const span = telemetry.startSpan('Kernel.handleReflecting');
    
    try {
      // Process tool results and prepare for next iteration
      context = {
        ...context,
        state: 'THINKING'
      };

      span.end();
      return context;
    } catch (error: any) {
      span.end({ error: error.message });
      throw error;
    }
  }

  /**
   * Call LLM
   */
  private async callLLM(options: {
    prompt: string;
    systemPrompt?: string;
    model?: string;
  }): Promise<any> {
    // Simplified - full implementation would call actual LLM
    return {
      content: 'LLM response',
      usage: {
        promptTokens: 0,
        completionTokens: 0
      }
    };
  }

  /**
   * Emit progress event
   */
  private emitProgress(context: KernelContext, type: string, data: any): void {
    if (context.progressSink) {
      context.progressSink.emit({
        type,
        taskId: context.taskId,
        sessionId: context.sessionId,
        ...data
      });
    }
  }
}

export default Kernel;
