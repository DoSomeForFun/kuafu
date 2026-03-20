import {
  Store
} from "./chunk-XMYDHPEE.js";
import {
  Kernel,
  Perception
} from "./chunk-EC7WO3F2.js";
import {
  Action
} from "./chunk-QLSCUPWE.js";
import {
  runWithTrace,
  telemetry
} from "./chunk-ZAG7FYAZ.js";

// src/decision.ts
var Decision = class {
  maxSteps;
  constructor(options = {}) {
    this.maxSteps = options.maxSteps ?? 30;
  }
  /**
   * Check if agent should continue
   */
  shouldContinue(history, currentStep, lastToolCalls) {
    const span = telemetry.startSpan("Decision.shouldContinue");
    try {
      if (currentStep >= this.maxSteps) {
        return {
          shouldContinue: false,
          stopReason: "max_steps_exceeded"
        };
      }
      if (lastToolCalls && lastToolCalls.length > 0) {
        return {
          shouldContinue: true
        };
      }
      const lastTurn = history[history.length - 1];
      if (!lastTurn || !lastTurn.content) {
        return {
          shouldContinue: false,
          stopReason: "empty_response"
        };
      }
      const content = lastTurn.content.toLowerCase();
      if (this.isCompletionIndicated(content)) {
        return {
          shouldContinue: false,
          stopReason: "task_completed"
        };
      }
      if (this.detectLoop(history)) {
        return {
          shouldContinue: false,
          stopReason: "loop_detected"
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
  isCompletionIndicated(content) {
    const englishPatterns = [
      /\b(done|finished|completed|complete)\b/i,
      /\b(success|succeeded)\b/i
    ];
    const chinesePatterns = [
      /任务完成/i,
      /已完成/i,
      /完成工作/i,
      /完成了/i,
      /做完/i,
      /搞定/i,
      /结束/i
    ];
    for (const pattern of englishPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
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
  detectLoop(history) {
    if (history.length < 6) {
      return false;
    }
    const recentTurns = history.slice(-6);
    const firstHalf = recentTurns.slice(0, 3);
    const secondHalf = recentTurns.slice(3, 6);
    const firstHalfContent = firstHalf.map((t) => t.content).join("|");
    const secondHalfContent = secondHalf.map((t) => t.content).join("|");
    return firstHalfContent === secondHalfContent;
  }
  /**
   * Check semantic self-verification
   */
  semanticCheck(prompt, response) {
    if (!response || response.trim().length === 0) {
      return {
        shouldContinue: false,
        stopReason: "empty_response",
        intercept: true,
        interceptMessage: "Response is empty"
      };
    }
    return {
      shouldContinue: true
    };
  }
  /**
   * Update max steps
   */
  setMaxSteps(maxSteps) {
    this.maxSteps = maxSteps;
  }
  /**
   * Get current max steps
   */
  getMaxSteps() {
    return this.maxSteps;
  }
};

// src/index.ts
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
var pkg = require2("../package.json");
var VERSION = pkg.version;
var kuafuFramework = {
  VERSION,
  Store,
  Action,
  Perception,
  Decision,
  Kernel,
  telemetry,
  runWithTrace
};
var src_default = kuafuFramework;
export {
  Action,
  Decision,
  Kernel,
  Perception,
  Store,
  VERSION,
  src_default as default,
  runWithTrace,
  telemetry
};
//# sourceMappingURL=index.js.map