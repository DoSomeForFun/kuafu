import fs from "node:fs";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

/**
 * Action Layer (HuluWa 2.0 - Clean & Generic)
 * 职责：提供最基础的物理操作能力，不包含业务逻辑。
 */
export class Action {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.sandboxBase = path.join(this.projectRoot, ".huluwa/sandboxes");
    this.cwd = this.projectRoot;
    this.sandboxPath = null;
    this.timeoutMs = options.timeoutMs || 120000;
  }

  getSpecs() {
    return [
      {
        type: "function",
        function: {
          name: "bash",
          description: "在当前工作目录下执行终端命令。",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "要执行的完整 shell 命令。" }
            },
            required: ["command"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "read",
          description: "读取文件内容。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "文件相对路径。" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write",
          description: "在沙盒内创建或覆盖文件。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "文件路径。" },
              content: { type: "string", description: "文件内容。" }
            },
            required: ["path", "content"],
            additionalProperties: false
          }
        }
      }
    ];
  }

  async setupWorkspace(taskId) {
    this.sandboxPath = path.join(this.sandboxBase, taskId.slice(0, 8));
    try {
      if (!fs.existsSync(this.sandboxPath)) fs.mkdirSync(this.sandboxPath, { recursive: true });
      this.cwd = this.sandboxPath;
      return { ok: true, sandbox: this.sandboxPath };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async bash(args) {
    try {
      const { stdout, stderr } = await execAsync(args.command, { cwd: this.cwd, timeout: this.timeoutMs });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      return { ok: false, error: error.message, stderr: error.stderr };
    }
  }

  async read(args) {
    let target = path.resolve(this.cwd, args.path);
    if (!fs.existsSync(target)) target = path.resolve(this.projectRoot, args.path);
    try {
      const content = fs.readFileSync(target, "utf-8");
      return { ok: true, content: content.slice(0, 5000) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async write(args) {
    const target = path.resolve(this.cwd, args.path);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, args.content, "utf-8");
      return { ok: true, bytes: args.content.length };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}