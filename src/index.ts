/**
 * @kuafu/framework - Channel-agnostic Agent Runtime Framework
 */

// Core modules
import { Store } from './store.js';
import { telemetry, runWithTrace } from './telemetry.js';
import { Action } from './action.js';
import { Perception } from './perception.js';
import { Decision } from './decision.js';

export { Store, Action, Perception, Decision, telemetry, runWithTrace };

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
  Action,
  Perception,
  Decision,
  telemetry,
  runWithTrace
};

export default kuafuFramework;
