import { telemetry } from '../telemetry.js';
import type { KernelContext, KernelState } from './types.js';

/**
 * FSM (Finite State Machine) handler for Kernel
 * States: PERCEIVING → THINKING → DECIDING → ACTING → REFLECTING → (loop or DONE)
 */
export class KernelFSM {
  private context: KernelContext;

  constructor(context: KernelContext) {
    this.context = context;
  }

  /**
   * Run FSM loop until DONE or FAILED
   */
  async run(
    handlers: {
      handlePerceiving: (ctx: KernelContext) => Promise<KernelContext>;
      handleThinking: (ctx: KernelContext) => Promise<KernelContext>;
      handleDeciding: (ctx: KernelContext) => Promise<KernelContext>;
      handleActing: (ctx: KernelContext) => Promise<KernelContext>;
      handleReflecting: (ctx: KernelContext) => Promise<KernelContext>;
    }
  ): Promise<KernelContext> {
    const span = telemetry.startSpan('KernelFSM.run');
    
    try {
      while (this.context.state !== 'DONE' && this.context.state !== 'FAILED') {
        telemetry.debug(`[FSM] State: ${this.context.state}`);
        
        try {
          // Increment turnCount when entering THINKING (one LLM round = one turn)
          if (this.context.state === 'THINKING') {
            this.context.turnCount++;
            if (this.context.turnCount > this.context.maxTurns) {
              this.context.state = 'DONE';
              this.context.finalResult = {
                content: this.context.finalResult?.content || '',
                stopReason: 'max_turns_exceeded'
              };
              break;
            }
          }

          switch (this.context.state) {
            case 'PERCEIVING':
              this.context = await handlers.handlePerceiving(this.context);
              break;
            
            case 'THINKING':
              this.context = await handlers.handleThinking(this.context);
              break;
            
            case 'DECIDING':
              this.context = await handlers.handleDeciding(this.context);
              break;
            
            case 'ACTING':
              this.context = await handlers.handleActing(this.context);
              break;
            
            case 'REFLECTING':
              this.context = await handlers.handleReflecting(this.context);
              break;
            
            default:
              throw new Error(`Unknown state: ${this.context.state}`);
          }
          
          // Step callback
          if (this.context.onStep) {
            this.context.onStep(this.context);
          }
          
          // Increment state transition count
          this.context.stepCount++;
          
        } catch (error: any) {
          telemetry.error(`[FSM] Error in state ${this.context.state}`, {
            error: error.message
          });
          this.context.state = 'FAILED';
          this.context.finalResult = {
            error: error.message
          };
        }
      }
      
      return this.context;
    } finally {
      span.end({
        finalState: this.context.state,
        steps: this.context.stepCount
      });
    }
  }

  /**
   * Transition to next state
   */
  transition(nextState: KernelState): void {
    telemetry.debug(`[FSM] Transition: ${this.context.state} → ${nextState}`);
    this.context.state = nextState;
  }

  /**
   * Get current state
   */
  getState(): KernelState {
    return this.context.state;
  }

  /**
   * Get current context
   */
  getContext(): KernelContext {
    return this.context;
  }

  /**
   * Update context
   */
  updateContext(updates: Partial<KernelContext>): void {
    this.context = { ...this.context, ...updates };
  }
}

export default KernelFSM;
