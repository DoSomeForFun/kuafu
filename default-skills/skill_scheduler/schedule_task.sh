#!/bin/bash
# schedule_task.sh
# 用于登记定时任务, 利用 cron 调度任意技能（支持 Telegram 提醒消息等）

set -euo pipefail

usage() {
  echo "Usage: $0 --cron 'CRON_EXPR' --skill SKILL_NAME --params 'JSON_PARAMS'"
  exit 1
}

CRON_EXPR=""
SKILL_NAME=""
PARAMS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --cron)
      CRON_EXPR="$2"
      shift 2
      ;;
    --skill)
      SKILL_NAME="$2"
      shift 2
      ;;
    --params)
      PARAMS="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

if [[ -z "$CRON_EXPR" || -z "$SKILL_NAME" || -z "$PARAMS" ]]; then
  usage
fi

TASKS_DIR="/app/skills/skill_scheduler/tasks"
mkdir -p "$TASKS_DIR"

task_id=$(date +%s%N | cut -c1-13)
task_script="$TASKS_DIR/task_${task_id}.sh"

cat <<EOF > "$task_script"
#!/bin/bash
# 定时触发：$SKILL_NAME
/app/skills/$SKILL_NAME/run.sh --params '$PARAMS'
EOF
chmod +x "$task_script"

# 写入临时 crontab 文件（定向调度脚本）
(crontab -l 2>/dev/null; echo "$CRON_EXPR bash $task_script > /dev/null 2>&1 # $SKILL_NAME $task_id") | crontab -

echo "已注册定时任务，ID: $task_id, 表达式: $CRON_EXPR, 技能: $SKILL_NAME"
