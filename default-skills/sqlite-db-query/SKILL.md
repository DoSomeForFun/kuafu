# sqlite-db-query

Use this skill when user asks to query database / sqlite / SQL / message ID / schema / records / 聊天记录 / 历史消息 / chat history / 对话记录 / 查消息.

Scope:
- Inspect SQLite files, schema, and rows safely.
- Run `sqlite3` via `bash` tool, then summarize key results.
- Prefer read-only SQL first (`.tables`, `.schema`, `SELECT ... LIMIT ...`).
- Prefer bundled script first: `kuafu/default-skills/sqlite-db-query/run.sh`.

Script entry:
- Repo root: `kuafu/default-skills/sqlite-db-query/run.sh`
- Docker image: `/app/kuafu/default-skills/sqlite-db-query/run.sh`

Common DB files in this project (resolve via env first):
- `${TELEGRAM_TASKS_DB_PATH:-data/agent-tasks.sqlite}` (Production Task/Message DB)
- `${TELEGRAM_CONTEXT_VECTOR_DB_PATH:-data/.agent-context.sqlite}` (Vector/RAG DB)
- `.bdd-test.sqlite` (Test DB)

**CRITICAL WARNING**:
- NEVER run `find /` or scan the entire filesystem. It is slow and dangerous.
- ALWAYS check the current directory (`.`) first.
- If no DB is found in CWD, ask the user for the path.

Recommended query flow:
1. Resolve and inspect DB:
   - `bash kuafu/default-skills/sqlite-db-query/run.sh --mode info --target task`
   - `bash kuafu/default-skills/sqlite-db-query/run.sh --mode info --target vector`
2. Inspect schema/tables:
   - `bash kuafu/default-skills/sqlite-db-query/run.sh --mode tables --target task`
   - `bash kuafu/default-skills/sqlite-db-query/run.sh --mode schema --target task`
3. Query recent rows safely:
   - `bash kuafu/default-skills/sqlite-db-query/run.sh --mode recent-messages --limit 20`
   - `bash kuafu/default-skills/sqlite-db-query/run.sh --mode vector-recent --limit 20`
4. Custom query (read-only; helper blocks destructive SQL and auto-adds LIMIT when needed):
   - `bash kuafu/default-skills/sqlite-db-query/run.sh --mode query --target task --sql "SELECT task_id, sender_id, created_at FROM messages ORDER BY created_at DESC LIMIT 20;"`
5. If user asks deletion/update, first preview target IDs with `SELECT`, then explicitly ask for confirmation before running raw `sqlite3` manually (outside helper).
6. If vector query is blocked (missing vec extension), fallback to local backend JSON:
   - `node -e "const fs=require('fs');const p=process.env.TELEGRAM_LOCAL_BACKEND_PATH||'data/.agent-core-local-backend.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log((j.messages||[]).slice(-20).map(m=>[m.id,m.taskId,m.senderId,m.createdAt].join('\\t')).join('\\n'))"`

### Instructions
1. **优先使用脚本**：先调用 `kuafu/default-skills/sqlite-db-query/run.sh`，只有脚本不满足需求时才手写 `sqlite3`。
2. **优先检查环境变量路径**：在执行 `find` 之前，先检查 `TELEGRAM_TASKS_DB_PATH` / `TELEGRAM_CONTEXT_VECTOR_DB_PATH` 指向的文件是否存在。
3. **安全优先**：执行 SQL 前必须先用 `.tables` 确认表名。
4. **分页必选**：所有的 `SELECT` 语句必须带上 `LIMIT`，防止数据量过大撑爆缓冲区。
5. **环境适配**：向量查询需要 vec 扩展，脚本会自动处理加载路径。

### Examples
**场景：查询最近的任务消息**
爷爷: "查一下数据库里最近的 5 条消息"
你的回复: {
  "thought": "爷爷想看消息记录，我需要先查表名，然后执行带 LIMIT 的查询。",
  "message": "好嘞爷爷，本娃这就潜入数据库深处帮您打探一下！",
  "protocol": { 
    "status": "RUNNING", 
    "next_action": "query_recent_messages",
    "call_tool": {
      "name": "bash",
      "arguments": { "command": "bash kuafu/default-skills/sqlite-db-query/run.sh --mode recent-messages --limit 5" }
    }
  }
}
