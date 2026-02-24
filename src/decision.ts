import { telemetry } from './telemetry.js';

/**
 * Decision result interface
 */
export interface DecisionResult {
  shouldContinue: boolean;
  stopReason?: string;
  intercept?: boolean;
  interceptMessage?: string;
}

/**
 * Agent turn interface
 */
export interface AgentTurn {
  sender_id: string;
  content: string;
  tool_calls?: any[];
  [key: string]: any;
}

/**
 * Decision Layer - Anti-hallucination, loop detection, stop policies
 */
export class Decision {
  private maxSteps: number;

  constructor(options: { maxSteps?: number } = {}) {
    this.maxSteps = options.maxSteps ?? 30;
  }

  /**
   * Check if agent should continue
   */
  shouldContinue(
    history: AgentTurn[],
    currentStep: number,
    lastToolCalls?: any[]
  ): DecisionResult {
    const span = telemetry.startSpan('Decision.shouldContinue');
    
    try {
      // 1. Check step limit
      if (currentStep >= this.maxSteps) {
        return {
          shouldContinue: false,
          stopReason: 'max_steps_exceeded'
        };
      }

      // 2. Check for tool calls (priority - if tools need to be executed)
      if (lastToolCalls && lastToolCalls.length > 0) {
        return {
          shouldContinue: true
        };
      }

      // 3. Check for empty response
      const lastTurn = history[history.length - 1];
      if (!lastTurn || !lastTurn.content) {
        return {
          shouldContinue: false,
          stopReason: 'empty_response'
        };
      }

      // 4. Check if content indicates completion
      const content = lastTurn.content.toLowerCase();
      if (this.isCompletionIndicated(content)) {
        return {
          shouldContinue: false,
          stopReason: 'task_completed'
        };
      }

      // 5. Check for loop detection
      if (this.detectLoop(history)) {
        return {
          shouldContinue: false,
          stopReason: 'loop_detected'
        };
      }

      return {
        shouldContinue: true
      };
    } finally {
      span.end();
    }
  }

  /**
   * Check if content indicates task completion
   */
  private isCompletionIndicated(content: string): boolean {
    // English patterns with word boundaries
    const englishPatterns = [
      /\b(done|finished|completed|complete)\b/i,
      /\b(success|succeeded)\b/i
    ];
    
    // Chinese patterns without word boundaries (\b doesn't work for Chinese)
    const chinesePatterns = [
      /任务完成/i,
      /已完成/i,
      /完成工作/i,
      /完成了/i,
      /做完/i,
      /搞定/i,
      /结束/i
    ];
    
    // Check English patterns
    for (const pattern of englishPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
    
    // Check Chinese patterns
    for (const pattern of chinesePatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Detect repetitive loops in history
   */
  private detectLoop(history: AgentTurn[]): boolean {
    if (history.length < 6) {
      return false;
    }

    // Check last 3 turns for repetition
    const recentTurns = history.slice(-6);
    const firstHalf = recentTurns.slice(0, 3);
    const secondHalf = recentTurns.slice(3, 6);

    // Simple content comparison
    const firstHalfContent = firstHalf.map(t => t.content).join('|');
    const secondHalfContent = secondHalf.map(t => t.content).join('|');

    return firstHalfContent === secondHalfContent;
  }

  /**
   * Check semantic self-verification
   */
  semanticCheck(prompt: string, response: string): DecisionResult {
    // Simplified semantic check
    // In full implementation, would use LLM to verify response quality
    
    if (!response || response.trim().length === 0) {
      return {
        shouldContinue: false,
        stopReason: 'empty_response',
        intercept: true,
        interceptMessage: 'Response is empty'
      };
    }

    return {
      shouldContinue: true
    };
  }

  /**
   * Update max steps
   */
  setMaxSteps(maxSteps: number): void {
    this.maxSteps = maxSteps;
  }

  /**
   * Get current max steps
   */
  getMaxSteps(): number {
    return this.maxSteps;
  }
}

export default Decision;
