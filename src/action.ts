import fs from 'node:fs';
import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);

/**
 * Tool call interface
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}

/**
 * Tool result interface
 */
export interface ToolResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  retryInfo?: {
    retried: number;
    attempts: number;
    exhausted: boolean;
  };
}

/**
 * Tool specification interface
 */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
      additionalProperties: boolean;
    };
  };
}

/**
 * Action Layer - Basic physical operation capabilities
 */
export class Action {
  public projectRoot: string;
  public sandboxBase: string;
  public cwd: string;
  public sandboxPath: string | null;
  public timeoutMs: number;
  public bashRetryMax: number;
  public bashRetryBaseDelayMs: number;
  public bashRetryMaxDelayMs: number;

  constructor(options: {
    projectRoot?: string;
    sandboxBase?: string;
    cwd?: string;
    timeoutMs?: number;
    bashRetryMax?: number;
    bashRetryBaseDelayMs?: number;
    bashRetryMaxDelayMs?: number;
  } = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.sandboxBase = options.sandboxBase || path.join(this.projectRoot, '.huluwa/sandboxes');
    this.cwd = options.cwd || this.projectRoot;
    this.sandboxPath = null;
    this.timeoutMs = options.timeoutMs ?? (this._getEnvInt('KUAFU_TOOL_TIMEOUT_MS', 120000) || this._getEnvInt('AGENT_TOOL_TIMEOUT_MS', 120000));
    this.bashRetryMax = this._toSafeInt(options.bashRetryMax ?? this._getEnvInt('TELEGRAM_BASH_RETRY_MAX', 1));
    this.bashRetryBaseDelayMs = this._toSafeInt(options.bashRetryBaseDelayMs ?? this._getEnvInt('TELEGRAM_BASH_RETRY_BASE_DELAY_MS', 800));
    this.bashRetryMaxDelayMs = this._toSafeInt(options.bashRetryMaxDelayMs ?? this._getEnvInt('TELEGRAM_BASH_RETRY_MAX_DELAY_MS', 4000));
  }

  /**
   * Convert to safe integer
   */
  private _toSafeInt(value: any, defaultValue: number): number {
    const num = parseInt(value, 10);
    return Number.isFinite(num) && num > 0 ? num : defaultValue;
  }

  /**
   * Get environment variable as safe integer
   */
  private _getEnvInt(envVar: string, defaultValue: number): number {
    const value = process.env[envVar] || String(defaultValue);
    return this._toSafeInt(value, defaultValue);
  }

  /**
   * Get tool specifications
   */
  getSpecs(): ToolSpec[] {
    return [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Execute shell command in the current working directory.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The complete shell command to execute.' }
            },
            required: ['command'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read file content.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path.' }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write',
          description: 'Create or overwrite file in sandbox.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path.' },
              content: { type: 'string', description: 'File content.' }
            },
            required: ['path', 'content'],
            additionalProperties: false
          }
        }
      }
    ];
  }

  /**
   * Execute bash command
   */
  async bash(command: string): Promise<ToolResult> {
    const startTime = Date.now();
    
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        shell: '/bin/bash'
      });

      return {
        ok: true,
        stdout,
        stderr,
        retryInfo: {
          retried: 0,
          attempts: 1,
          exhausted: false
        }
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const isTimeout = error.code === 'ETIMEDOUT' || error.killed;
      
      return {
        ok: false,
        error: error.message || String(error),
        stderr: error.stderr,
        retryInfo: {
          retried: 0,
          attempts: 1,
          exhausted: !isTimeout
        }
      };
    }
  }

  /**
   * Read file content
   */
  async read(filePath: string): Promise<ToolResult> {
    const fullPath = path.join(this.cwd, filePath);
    
    try {
      if (!fs.existsSync(fullPath)) {
        return {
          ok: false,
          error: `File not found: ${filePath}`
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      
      return {
        ok: true,
        stdout: content
      };
    } catch (error: any) {
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  }

  /**
   * Write file content
   */
  async write(filePath: string, content: string): Promise<ToolResult> {
    const fullPath = path.join(this.cwd, filePath);
    
    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, content, 'utf-8');
      
      return {
        ok: true,
        stdout: `File written: ${filePath}`
      };
    } catch (error: any) {
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  }

  /**
   * Invoke tool by name
   */
  async invokeTool(toolCall: ToolCall): Promise<ToolResult> {
    const { name, arguments: args } = toolCall.function;

    switch (name) {
      case 'bash':
        return await this.bash(args.command);
      case 'read':
        return await this.read(args.path);
      case 'write':
        return await this.write(args.path, args.content);
      default:
        return {
          ok: false,
          error: `Unknown tool: ${name}`
        };
    }
  }
}

export default Action;
