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
import { createRequire } from 'node:module';

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
  ProgressSink
} from './types.js';

export type {
  LLMProvider,
  LLMCallOptions,
  LLMCallResult
} from './kernel/types.js';

// Version — single source of truth from package.json
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
export const VERSION: string = pkg.version;

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
