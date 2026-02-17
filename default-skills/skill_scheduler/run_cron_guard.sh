#!/bin/bash
# run_cron_guard.sh
# 每分钟检查所有 skill_scheduler 任务脚本，若已过期未执行，自动补触发一次，确保不漏任务
TASKS_DIR="/app/skills/skill_scheduler/tasks"
NOW_TS=$(date +%s)
for task in "$TASKS_DIR"/*.sh; do
  [ -e "$task" ] || continue
  # 从任务脚本文件头部读取计划执行时间（假设以# SCHEDULED_TS=xxx方式存储）
  SCHEDULED_TS=$(grep '^# SCHEDULED_TS=' "$task" | cut -d'=' -f2)
  [ -z "$SCHEDULED_TS" ] && continue
  # 任务有计划时间且已经过期，但没被标记为已执行
  if [ "$NOW_TS" -ge "$SCHEDULED_TS" ] && ! grep -q '^# EXECUTED=1' "$task"; then
    bash "$task"
    # 执行完在文件中标记已执行
    echo "# EXECUTED=1" >> "$task"
    echo "[run_cron_guard] 补执行任务: $task ($(date)), SCHEDULED_TS=$SCHEDULED_TS, NOW_TS=$NOW_TS" >> /app/skills/skill_scheduler/cron_guard.log
  fi
done
