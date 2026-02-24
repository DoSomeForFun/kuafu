/**
 * @kuafu/framework - Channel-agnostic Agent Runtime Framework
 */

// Core modules
import { Store } from './store.js';
import { telemetry, runWithTrace } from './telemetry.js';

export { Store, telemetry, runWithTrace };

// Types
export type {
  Task,
  TaskStatus,
  Message,
  AgentTurn,
  LLMExecution,
  ToolCall,
  KernelRunOptions,
  KernelRunResult,
  ProgressEvent,
  ProgressSink
} from './types.js';

// Version
export const VERSION = '1.2.0-ts';

const kuafuFramework = {
  VERSION,
  Store,
  telemetry,
  runWithTrace
};

export default kuafuFramework;
