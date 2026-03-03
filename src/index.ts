/**
 * @kuafu/framework - Channel-agnostic Agent Runtime Framework
 */

// Core modules
import { Store } from './store.js';
import { telemetry, runWithTrace } from './telemetry.js';
import { Action } from './action.js';
import { Perception } from './perception.js';
import { Decision } from './decision.js';
import { Kernel } from './kernel/index.js';

export { Store, Action, Perception, Decision, Kernel, telemetry, runWithTrace };

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
  ProgressSink,
  OutcomePayload,
  OutcomeSink
} from './types.js';

export type {
  IStore,
  IAction,
  IProgressSink,
  SaveTaskMessageInput,
  IPerception,
  IDecision,
  IDecisionResult,
  IDecisionTurn,
  IPerceptionInput,
  IPerceptionOutput,
  IPerceptionState,
  ProgressEventLike,
  StoreTaskLike,
  StoreMessageLike
} from './interfaces.js';

// Version
export const VERSION = '1.2.0-ts';

const kuafuFramework = {
  VERSION,
  Store,
  Action,
  Perception,
  Decision,
  Kernel,
  telemetry,
  runWithTrace
};

export default kuafuFramework;
