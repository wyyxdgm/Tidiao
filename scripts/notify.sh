#!/usr/bin/env bash
# notify.sh - 通用通知出站 CLI (v47)
#
# 内部统一走 POST /api/notify, CLI 只负责: 鉴权 (login.sh) + 参数解析 + JSON 拼装
# + 输出渲染 + exit code. 其他项目可直接调,
# 也可以在 cron / shell 脚本里嵌套 (加 --json 给上层解析).
#
# 设计原则:
#   - 普通用户默认发给"自己" —— 邮件走 resolveNotifyTo(self), feishu 拿 self.feishu_webhook_url.
#   - admin 可 --user <id> 指定其他用户 (代发, 比如"某用户任务失败了通知一下").
#   - admin 可 --to <email> 覆盖 email 收件人字符串 (跳过 resolveNotifyTo, 直接发到那个邮箱).
#     注意: --to 不影响 feishu, feishu 仍走 user 的 webhook.
#   - 非 admin 传 --user / --to → CLI 立刻报错, 不发请求 (前置拦截, 避免浪费往返).
#
# 用法:
#   notify.sh --channel email  --subject "..." --body "..."              # 自己收件箱
#   notify.sh --channel feishu --message "..."                            # 自己的 webhook
#   notify.sh --channel both   --subject "..." --body "..." --message "..." # 两个一起发
#   notify.sh --channel feishu --user <id> --message "..."                # admin 代发
#   notify.sh --channel email  --to someone@else.com --subject "..." --body "..."  # admin 改 to
#   notify.sh ... --json                                                    # 原样回响应体
#
# Exit codes:
#   0 = all_ok        两渠道都成功
#   2 = partial       一边成功一边失败
#   3 = none          两边都失败 (渠道没配, SMTP 挂了, webhook 4xx 都在这里)
#   4 = 参数错        缺必填 / channel 非法 / 非 admin 传 --user/--to
#   5 = API 错误      网络/鉴权/4xx/5xx (CLI 调用 API 本身出问题)
#
# 依赖: curl, python3, jq (后者只用来拼 JSON, 没有也能跑但建议装)
# 鉴权: source login.sh (AO_TOKEN 优先, 否则 AO_EMAIL/AO_PASSWORD 登录)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env

BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"

CHANNEL=""
TARGET_USER_ID=""        # admin 才有权指定
TARGET_TO=""             # admin 才能覆盖 email 收件人字符串
SUBJECT=""
BODY=""
HTML=""
MESSAGE=""
MSG_TYPE="markdown"       # 默认 markdown, --msg-type text 切纯文本
POST_TITLE=""             # msg_type=post 时可选
POST_CONTENT=""           # msg_type=post 时必填, JSON 字符串 (二维数组)
WANTS_JSON=false

usage() {
  cat <<EOF
notify.sh - 通用通知 CLI (email + feishu)

当前环境: ${AO_CUR_ENV} -> ${BASE_URL}

必填:
  --channel email|feishu|both

可选:
  --subject "..."           邮件主题 (channel 含 email 时必填)
  --body "..."              邮件纯文本正文 (channel 含 email 时, 与 --html 至少其一)
  --html "..."              邮件 HTML 正文
  --message "..."           飞书消息内容 (channel 含 feishu 时必填)
  --msg-type text|markdown|post  飞书消息类型, 默认 markdown (post 是富文本)
  --post-title "..."         (msg-type=post) 富文本标题, 可选
  --post-content '<JSON>'     (msg-type=post) 富文本正文, JSON 二维数组, e.g.
                              '[[{"tag":"text","text":"hi"},{"tag":"a","text":"链接","href":"https://..."}]]'
  --user <id>               (admin-only) 指定收件人 user_id
  --to <email>              (admin-only) 覆盖 email 收件人字符串 (跳过 resolveNotifyTo)
  --json                    原样输出 API 响应体 (给上层脚本解析)

通用:
  --base URL --email E --password P   覆盖默认鉴权/地址 (或 AO_TOKEN)
  -h, --help

Exit codes: 0=all_ok / 2=partial / 3=none / 4=参数错 / 5=API 错误

示例:
  # 自己收一封邮件
  notify.sh --channel email --subject "早上好" --body "今日备份完成"

  # 自己的飞书机器人来一条 (markdown)
  notify.sh --channel feishu --message '**部署完成** v1.4.2'

  # 飞书 webhook 不支持 markdown 时, 切 text 兜底 (e.g. 老 webhook 返 code:10208)
  notify.sh --channel feishu --msg-type text --message '部署完成 v1.4.2'

  # 富文本 (post): 标题 + 二维数组 inline elements (text / a / at / img)
  notify.sh --channel feishu --msg-type post \
    --post-title '项目更新' \
    --post-content '[[{"tag":"text","text":"项目有更新: "},{"tag":"a","text":"请查看","href":"https://example.com"}]]'

  # 邮件 + 飞书并发, 消息可以不一样
  notify.sh --channel both \\
    --subject "数据库异常" \\
    --body "请检查 replication lag" \\
    --message '**DB 异常** replication lag 超阈值'

  # admin 代发给某个用户的飞书 (拿那个用户的 feishu webhook)
  notify.sh --channel feishu --user <user-uuid> --message "你的任务超时了"
EOF
  exit 0
}

# --- 参数解析 ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)   CHANNEL="$2"; shift 2 ;;
    --subject)   SUBJECT="$2"; shift 2 ;;
    --body)      BODY="$2"; shift 2 ;;
    --html)      HTML="$2"; shift 2 ;;
    --message)   MESSAGE="$2"; shift 2 ;;
    --msg-type)  MSG_TYPE="$2"; shift 2 ;;
    --post-title)   POST_TITLE="$2"; shift 2 ;;
    --post-content) POST_CONTENT="$2"; shift 2 ;;
    --user)      TARGET_USER_ID="$2"; shift 2 ;;
    --to)        TARGET_TO="$2"; shift 2 ;;
    --json)      WANTS_JSON=true; shift ;;
    --base)      BASE_URL="$2"; shift 2 ;;
    --email)     EMAIL="$2"; shift 2 ;;
    --password)  PASSWORD="$2"; shift 2 ;;
    -h|--help)   usage ;;
    *) echo "❌ 未知参数: $1" >&2; exit 4 ;;
  esac
done

# --- 校验 ---
[[ -z "$CHANNEL" ]] && { echo "❌ 必须传 --channel (email|feishu|both)" >&2; exit 4; }
case "$CHANNEL" in
  email|feishu|both) ;;
  *) echo "❌ --channel 必须是 email|feishu|both, 收到: $CHANNEL" >&2; exit 4 ;;
esac

WANT_EMAIL=false
WANT_FEISHU=false
case "$CHANNEL" in
  email) WANT_EMAIL=true ;;
  feishu) WANT_FEISHU=true ;;
  both) WANT_EMAIL=true; WANT_FEISHU=true ;;
esac

if $WANT_EMAIL; then
  [[ -z "$SUBJECT" ]] && { echo "❌ channel 含 email 时必须 --subject" >&2; exit 4; }
  if [[ -z "$BODY" && -z "$HTML" ]]; then
    echo "❌ channel 含 email 时必须 --body 或 --html 至少其一" >&2; exit 4
  fi
fi
if $WANT_FEISHU; then
  case "$MSG_TYPE" in
    text|markdown)
      [[ -z "$MESSAGE" ]] && { echo "❌ channel 含 feishu (msg-type=text/markdown) 时必须 --message" >&2; exit 4; }
      ;;
    post)
      [[ -z "$POST_CONTENT" ]] && { echo "❌ msg-type=post 时必须 --post-content (JSON 二维数组字符串)" >&2; exit 4; }
      # 顺手验一下 JSON 是否合法
      if command -v python3 >/dev/null 2>&1; then
        if ! echo "$POST_CONTENT" | python3 -c 'import sys,json; json.loads(sys.stdin.read())' 2>/dev/null; then
          echo "❌ --post-content 不是合法 JSON" >&2; exit 4
        fi
      fi
      ;;
    *) echo "❌ --msg-type 必须是 text|markdown|post, 收到: $MSG_TYPE" >&2; exit 4 ;;
  esac
fi

# --user / --to 留到 API 侧再校验 admin 权限, 这里不前置拦截 (CLI 不知道 caller 角色,
# API 会返 403). 但拼 JSON 时如果传了就把字段加上, 没传就不加 (避免 server 看到空字段歧义).

# --- 拼装 JSON ---
# 优先 jq (安全), 没有就 python3 (也在), 都没有才退回裸字符串拼接 (webhook URL/body
# 含特殊字符会炸, 但 fallback 路径仅在两个常用工具都没装的极端环境触发).
if command -v jq >/dev/null 2>&1; then
  build_payload() {
    jq -n \
      --arg channel "$CHANNEL" \
      --arg subject "$SUBJECT" \
      --arg body "$BODY" \
      --arg html "$HTML" \
      --arg message "$MESSAGE" \
      --arg msgType "$MSG_TYPE" \
      --arg userId "$TARGET_USER_ID" \
      --arg to "$TARGET_TO" \
      --arg postTitle "$POST_TITLE" \
      --arg postContent "$POST_CONTENT" \
      '
      {
        channel: $channel,
        msg_type: $msgType
      }
      + (if $subject != "" then {subject: $subject} else {} end)
      + (if $body    != "" then {text:   $body}    else {} end)
      + (if $html    != "" then {html:   $html}    else {} end)
      + (if $message != "" then {message:$message} else {} end)
      + (if $userId  != "" then {user_id:$userId}  else {} end)
      + (if $to      != "" then {to:     $to}      else {} end)
      + (if $msgType == "post" and $postContent != ""
         then {post: ({content: ($postContent | fromjson)} + (if $postTitle != "" then {title: $postTitle} else {} end))}
         else {} end)
      '
  }
elif command -v python3 >/dev/null 2>&1; then
  build_payload() {
    python3 - "$CHANNEL" "$SUBJECT" "$BODY" "$HTML" "$MESSAGE" "$MSG_TYPE" "$TARGET_USER_ID" "$TARGET_TO" "$POST_TITLE" "$POST_CONTENT" <<'PYEOF'
import json, sys
channel, subject, body, html, message, msg_type, user_id, to, post_title, post_content = sys.argv[1:]
payload = {"channel": channel, "msg_type": msg_type}
if subject: payload["subject"] = subject
if body:    payload["text"] = body
if html:    payload["html"] = html
if message: payload["message"] = message
if user_id: payload["user_id"] = user_id
if to:      payload["to"] = to
if msg_type == "post" and post_content:
    post_obj = {"content": json.loads(post_content)}
    if post_title:
        post_obj["title"] = post_title
    payload["post"] = post_obj
print(json.dumps(payload, ensure_ascii=False))
PYEOF
  }
else
  echo "❌ 需要 jq 或 python3 来拼 JSON, 当前机器两者都没装" >&2
  exit 4
fi

PAYLOAD="$(build_payload)"

# --- 调用 API ---
ao_resolve_auth

if $WANTS_JSON; then
  # 原样回响应体, exit code 由 summary 推导
  RAW="$(ao_curl POST /api/notify -d "$PAYLOAD")" || { echo "❌ API 调用失败" >&2; exit 5; }
  echo "$RAW"
  SUMMARY="$(echo "$RAW" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("summary","none"))' 2>/dev/null || echo "none")"
  case "$SUMMARY" in
    all_ok) exit 0 ;;
    partial) exit 2 ;;
    none) exit 3 ;;
    *) exit 5 ;;
  esac
fi

# --- 人类可读输出 ---
RAW="$(ao_curl POST /api/notify -d "$PAYLOAD")" || {
  echo "❌ API 调用失败 (网络/鉴权/4xx)" >&2
  exit 5
}

# 解析 + 渲染
SUMMARY="$(echo "$RAW" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("summary","none"))' 2>/dev/null || echo "none")"

echo "$RAW" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("❌ 响应不是合法 JSON")
    sys.exit(1)
for r in d.get("results", []):
    ch = r.get("channel")
    if r.get("sent"):
        extra = ""
        if ch == "email":
            to = r.get("to", "?")
            resp = r.get("response", "")
            extra = f" → {to}" + (f"  [{resp}]" if resp else "")
        elif ch == "feishu":
            status = r.get("status", "")
            extra = f"  [HTTP {status}]" if status else ""
        print(f"✅ {ch}{extra}")
    else:
        reason = r.get("reason", "unknown")
        print(f"❌ {ch}: {reason}")
summary = d.get("summary", "none")
emoji = {"all_ok":"✅","partial":"⚠️","none":"❌"}.get(summary,"❓")
print(f"{emoji} summary: {summary}")
' || {
  echo "$RAW" >&2
  echo "❌ 解析响应失败" >&2
  exit 5
}

case "$SUMMARY" in
  all_ok) exit 0 ;;
  partial) exit 2 ;;
  none) exit 3 ;;
  *) exit 5 ;;
esac