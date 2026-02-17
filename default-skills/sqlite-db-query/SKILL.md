# sqlite-db-query

Use this skill when user asks to query database / sqlite / SQL / message ID / schema / records / 聊天记录 / 历史消息 / chat history / 对话记录 / 查消息.

Scope:
- Inspect SQLite files, schema, and rows safely.
- Run `sqlite3` via `bash` tool, then summarize key results.
- Prefer read-only SQL first (`.tables`, `.schema`, `SELECT ... LIMIT ...`).

Common DB files in this project:
- `.agent-tasks.sqlite` (Production Task/Message DB)
- `.bdd-test.sqlite` (Test DB)
- `.agent-context.sqlite` (Legacy/Vector DB)

**CRITICAL WARNING**:
- NEVER run `find /` or scan the entire filesystem. It is slow and dangerous.
- ALWAYS check the current directory (`.`) first.
- If no DB is found in CWD, ask the user for the path.

Recommended query flow:
1. Check file exists and type:
   - `ls -lah`
   - `file .agent-context.sqlite`
2. Load vec0 extension first (required for `context_vectors` virtual table):
   - `sqlite3 .agent-context.sqlite ".load /usr/lib/sqlite3/vec0.so" ".tables"`
   - If load fails, capture stderr and continue with JSON fallback (`.agent-core-local-backend.json`).
3. Inspect schema:
   - `sqlite3 .agent-context.sqlite \".tables\"`
   - `sqlite3 .agent-context.sqlite \".schema\"`
4. Query rows (with vec0 loaded in same command):
   - `sqlite3 -header -column .agent-context.sqlite ".load /usr/lib/sqlite3/vec0.so" "SELECT * FROM context_vectors LIMIT 20;"`
   - `sqlite3 -header -column .agent-context.sqlite ".load /usr/lib/sqlite3/vec0.so" "SELECT message_id, task_id, created_at FROM context_vectors ORDER BY created_at DESC LIMIT 50;"`
5. If user asks deletion, first preview target IDs with `SELECT`, then execute `DELETE`, then verify with another `SELECT COUNT(*)`.
6. If SQLite vec query is blocked (missing module/extension policy), fallback to local backend JSON:
   - `node -e "const fs=require('fs');const p='.agent-core-local-backend.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log((j.messages||[]).slice(-20).map(m=>[m.id,m.taskId,m.senderId,m.createdAt].join('\\t')).join('\\n'))"`
   - Then filter by keyword/taskId/messageId via Node one-liners and summarize results.

### Instructions
1. **优先检查默认文件**：在执行 `find` 之前，先检查 `.agent-tasks.sqlite` 是否存在。
2. **安全优先**：执行 SQL 前必须先用 `.tables` 确认表名。
3. **分页必选**：所有的 `SELECT` 语句必须带上 `LIMIT`，防止数据量过大撑爆缓冲区。
4. **环境适配**：在运行带有向量表的查询时，必须在同一条 bash 命令中通过 `.load` 加载扩展。

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
      "arguments": { "command": "sqlite3 -header -column .agent-tasks.sqlite \"SELECT * FROM messages ORDER BY created_at DESC LIMIT 5;\"" }
    }
  }
}

