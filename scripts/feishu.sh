#!/usr/bin/env bash
# feishu.sh - 飞书表格常用操作 CLI（读行 / 取图 / 写格）
#
# 存在的理由: 飞书表格有几个**静默踩坑点**, 每次现场推导都要烧一堆 token 且容易错.
# 这个脚本把它们固化下来, 直接用子命令, 不需要记接口细节:
#
#   1. `+csv-get` 对图片一律返回**空字符串** —— 想靠读 CSV 拿图 = 白忙, 且不报错.
#   2. 两种贴图要两个不同命令: cell 内嵌图走 `+cells-get`, 浮动图走 `+float-image-list`.
#   3. 下载图**只能**走 `api GET /open-apis/drive/v1/medias/{token}/download`;
#      `drive +download` 会 403 —— 那是给 Drive "文件"用的, 图是 media(素材).
#      **飞书的 403 常常是接口选错, 不是缺权限.**
#   4. `-o` 只接受**相对当前目录**的路径, 传绝对路径直接 validation error.
#   5. 浮动图定位用 `address`("G3", 1-based); `position.row` 是 0-based, 用它会错一行.
#   6. 读行范围必须到 BZ —— 只读到 Z 会漏掉 AA 之后手工贴的附件列.
#
# 用法:
#   feishu.sh row-get   --row 3 [--rows 3,4,5]
#   feishu.sh img-list  --row 3
#   feishu.sh img-get   --row 3 --dest ./imgs
#   feishu.sh cell-set  --row 3 --field "O=1"
#   feishu.sh sheet-list                       # 列出 spreadsheet 下所有 sheet
#   feishu.sh csv-clear --range A1:T60
#   feishu.sh csv-put --start-cell A1 < data.csv   # CSV 从 stdin 读
#   feishu.sh style-bold --range A1:I1 [--background #e8f0fe] [--font-size 13]
#   feishu.sh freeze-rows N
#
# 多列一次写 / 回写策略见 usage() —— 推荐用 feishu-board.ts write + --confirm,
# 而不是循环 cell-set（自动 read-back 断言, 防 server 静默失败）。
#
# --sheet 可传**名称**或**ID**（URL ?sheet=885c32 里的那种）。脚本内部统一解析为名称 + ID
#   两份, 后续按子命令的需要传 --sheet-name / --sheet-id.
#
# 依赖: lark-cli(已登录). 不需要 jq —— 用 lark-cli 内置的 -q.
# 配置: --url / --sheet 或环境变量 FEISHU_SHEET_URL / FEISHU_SHEET_NAME

set -euo pipefail

# 🔴 故意不设默认 URL: 曾经的硬编码默认表(1.6期)让没传 --url 的 agent 静默读
# 到**别的项目**的表(2026-08-16 task 75d4f0ad 实测）。未配置就报错退出,
# 让调用方(agent 或人)显式指定。任务派发时平台会按 version 绑定自动注入
# FEISHU_SHEET_URL / FEISHU_SHEET_NAME。
URL="${FEISHU_SHEET_URL:-}"
SHEET="${FEISHU_SHEET_NAME:-}"
SHEET_ID=""
ROWS=""
DEST="."
FIELD=""
LAST_COL="BZ"
START_CELL=""
RANGE=""
SCOPE=""
BACKGROUND=""
FONT_SIZE=""
FREEZE_N=""

usage() {
  cat <<'EOF'
feishu.sh — 飞书表格的省心工具：把踩过的坑固化成子命令，让你专心干活

命令 (常用在前 4 个, 后面是装修表用的):

  row-get <--row N | --rows 3,4,5>
      读一行/多行的文字内容（含 AA 之后的附件列, 范围到 BZ）
      ✅ 功能: 一行命令拿到所有列, 不用拼 +csv-get / -jq
      💡 好处: 回写前先读一遍 → 知道这行现在长啥样, 避免写到错行 / 错列
      ⚠️  图不在文本里 (csv-get 对图返回空) —— 要图请用 img-list / img-get

  img-list <--row N>
      列出指定行的所有图（行/列/贴法/image_token）
      ✅ 功能: 一次扫两种贴法（cell 内嵌 + 浮动图）, 不会漏
      💡 好处: 你说"这行有图吗"→ 一行命令知道有几张、在哪列、贴法

  img-get <--row N> [--dest DIR]
      把那一行的所有图下载到本地, 打印路径（文件名形如 R3-F.png）
      ✅ 功能: 自动识别 PNG/JPEG/GIF/WebP, 改名 + 落盘
      💡 好处: 拿到本地路径后可以用 Read 直接看图, 不用登飞书

  cell-set <--row N> --field "O=1"
      写一格内容（写一个值, 防写错列会先做格式校验）
      ✅ 功能: 自动 RFC-4180 转义（逗号/引号/换行都能写）, 不会错位
      💡 好处: 一次写一格, 适合小改动; 多列写看下面的"回写建议"

  sheet-list
      列出当前表格里所有 sheet (id<TAB>name<TAB>index)
      ✅ 功能: 不知道 sheet 名时拿一张清单
      💡 好处: 跨多 sheet 项目（GDM/AO/yidao ...）一眼看到全部 tab

  csv-clear <--range A1:T60> [--scope content|formats|all]
      清空一段范围（默认仅清内容, --scope all 同时清格式）
      ✅ 功能: 一键清空指定范围（测试 / 还原时用）
      💡 好处: 不用 --scope 时只清内容、保留格式, 不破坏表头样式

  csv-put <--start-cell A1>
      从 stdin 粘贴 RFC-4180 CSV 到 --start-cell 起始的位置
      ✅ 功能: 一次写一片格, 比 --field 循环快得多
      💡 好处: 批量回写（"能写的尽量写"——一次写一行的多列）首选这个

  style-bold <--range A1:I1> [--background HEX] [--font-size PX]
      给一段范围加粗（可选加底色 / 字号）
      💡 好处: 表头加粗 / 高亮重点列用

  freeze-rows N
      冻结前 N 行
      💡 好处: 滚到下百行时表头还在, 读起来不累

回写建议 (damo 0829 R80 + R40 拍板):

  当你处理完一个 R{行号} 任务要回写时, 不要只写一格 ——
  把能写的列尽量都写上 (M 处理结果 / N 疑问补充 / O 是否已修复 / U commit_ids
  / V 客户提炼), 补充完整。代码里有的列 (task_id / session_id / commit_ids)
  也顺手填上, 这样下游 (sheetwatch / 验收人) 一眼看到完整上下文。

  多列一次写的两种姿势:
    1. jiti scripts/feishu-board.ts write <row> --col L=... --col M=... --col O=1 --confirm
       (推荐: 自动 read-back 断言, 防静默失败)
    2. jiti scripts/feishu-board.ts write <row> --from-json result.json --confirm
       (列多 / 值长时更省事; result.json 是 {"L":"...", "M":"..."} 形式)

参数:
  --row N            行号（1-based, 同 R{row}）
  --rows 3,4,5       多行, 逗号分隔（与 --row 二选一）；freeze-rows 用作 N
  --dest DIR         img-get 的落盘目录, 默认当前目录
  --field "O=1"      cell-set 的 列=值
  --start-cell A1    csv-put 的锚点（左上角）
  --range A1:T60     csv-clear / style-bold 的范围
  --scope SCOPE      csv-clear: content(默认)|formats|all
  --background HEX   style-bold 额外加底色（#e8f0fe）
  --font-size PX     style-bold 改字号
  --url URL          表格 URL（必填: --url 或环境变量 FEISHU_SHEET_URL, 无默认）
  --sheet NAME_OR_ID sheet 名或 ID（从 URL ?sheet= 自动取）；不指定时必须有 env
  --last-col COL     扫内嵌图/读行的右边界, 默认 BZ
  -h, --help

示例:
  export FEISHU_SHEET_URL='https://my.feishu.cn/wiki/xxxx' FEISHU_SHEET_NAME='AO-DEV'
  feishu.sh img-list --row 3
  feishu.sh img-get  --row 3 --dest /tmp/r3
  feishu.sh row-get  --rows 3,4
  # URL 带 ?sheet= 时 --sheet 可省
  feishu.sh --url 'https://my.feishu.cn/wiki/xxx?sheet=885c32' sheet-list
  feishu.sh --url '...同上' csv-clear --range A1:T60
  feishu.sh --url '...同上' csv-put --start-cell A1 < data.csv
  feishu.sh --url '...同上' style-bold --range A1:I1 --background '#e8f0fe'
  feishu.sh --url '...同上' freeze-rows 1

  (编排平台派发的任务会按项目 version 绑定自动注入 FEISHU_SHEET_URL /
  FEISHU_SHEET_NAME, 直接用即可)
EOF
}

[[ $# -eq 0 ]] && { usage; exit 1; }
# -h/--help 优先: 让它当子命令也能 work（"feishu.sh -h" / "feishu.sh --help"）
if [[ "$1" == "-h" || "$1" == "--help" ]]; then usage; exit 0; fi
CMD="$1"; shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --row)           ROWS="$2"; shift 2 ;;
    --rows)          ROWS="$2"; shift 2 ;;
    --dest)          DEST="$2"; shift 2 ;;
    --field)         FIELD="$2"; shift 2 ;;
    --start-cell)    START_CELL="$2"; shift 2 ;;
    --range)         RANGE="$2"; shift 2 ;;
    --scope)         SCOPE="$2"; shift 2 ;;
    --background)    BACKGROUND="$2"; shift 2 ;;
    --font-size)     FONT_SIZE="$2"; shift 2 ;;
    --url)           URL="$2"; shift 2 ;;
    --sheet)         SHEET="$2"; shift 2 ;;
    --last-col)      LAST_COL="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$URL" ]] || { echo "没拿到表格 URL -- 需要 --url 或环境变量 FEISHU_SHEET_URL（故意没有默认表, 防止静默读到别的项目）" >&2; exit 1; }
# sheet 允许从 URL ?sheet= 自动取; 都没有才退出
if [[ -z "$SHEET" ]]; then
  SHEET="$(printf '%s' "$URL" | sed -nE 's|.*[?&]sheet=([^&]+).*|\1|p')"
fi
[[ -n "$SHEET" ]] || { echo "没拿到 sheet 名 -- 需要 --sheet 或环境变量 FEISHU_SHEET_NAME, 或者 URL 自带 ?sheet=ID（飞书复制表格链接 → ?sheet= 后那串就是 ID）" >&2; exit 1; }

# lark-cli 不在 PATH 时**必须显式报错**, 不能让它表现成"这行没有图".
# 实测踩过: WSL 上 lark-cli 装在 node v24 的 bin 下, 而服务跑 node v18 ->
# 命令找不到, 而 img-list 只打了个表头就退出, 看起来像"该行无图"(静默).
if ! command -v lark-cli >/dev/null 2>&1; then
  echo "❌ lark-cli 没装好 -- 没它就调不通飞书 API" >&2
  echo "   它可能装在**另一个 node 版本**的 bin 下（WSL 实测如此）。找一下再 export:" >&2
  echo "   ls ~/.nvm/versions/node/*/bin/lark-cli" >&2
  echo "   export PATH=\$PATH:~/.nvm/versions/node/<版本>/bin" >&2
  echo "   安装: npm i -g @larksuite/cli (前置: npm config set prefix ~/.npm-global)" >&2
  exit 127
fi

# 功能: 从 URL 抽出 spreadsheet_token (wiki/<token>?... 形式)
# 关注点: 飞书 wiki 链接的 token 就是 spreadsheet_token, 直接拿; sheet 维度在 URL ?sheet=.
url_token() {
  printf '%s' "$1" | sed -nE 's|^https://[^/]+/wiki/([^?#/]+).*|\1|p'
}

# 功能: 把 $SHEET (用户传的名称或 ID) 解析为「规范名 + ID」两份, 写到全局 SHEET / SHEET_ID.
# 关注点: 🔴 这是脚本从「只接受名字」升级为「名字/ID 都接受」的关键. 不解析直接传
#   给 lark-cli, 用户传 ID 就会得到 "sheet 名写错" 错误 + 空响应, 静默失败.
resolve_sheet() {
  local token input="$SHEET"
  token="$(url_token "$URL")"
  [[ -n "$token" ]] || { echo "❌ 无法从 URL 抽 spreadsheet token: $URL" >&2; exit 1; }
  # 一次性拉所有 sheet 元数据, 同时拿 id+name+index, 后续命令也可复用.
  local json
  json="$(lark-cli api GET "/open-apis/sheets/v3/spreadsheets/${token}/sheets/query" 2>&1)" || true
  if ! printf '%s' "$json" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    # token 不对 / 无权限 — 直接把错误透出
    echo "❌ 列举 sheet 失败: $URL" >&2
    printf '%s\n' "$json" | grep -v '"_notice"' | head -10 >&2
    exit 1
  fi
  # 同时按 id 和 name 匹配, 命中后取第一行 (sheet_id<TAB>title<TAB>index)
  local match
  match="$(lark-cli api GET "/open-apis/sheets/v3/spreadsheets/${token}/sheets/query" \
            -q '.data.sheets[] | select(.sheet_id=="'"$input"'" or .title=="'"$input"'") | "\(.sheet_id)\t\(.title)\t\(.index // 0)"' \
            2>/dev/null | head -1 || true)"
  if [[ -z "$match" ]]; then
    echo "❌ 在 spreadsheet 里找不到 sheet '$input'" >&2
    echo "   可选: $(lark-cli api GET "/open-apis/sheets/v3/spreadsheets/${token}/sheets/query" \
            -q '.data.sheets[] | .title' 2>/dev/null | tr '\n' ',' | sed 's/,$//')" >&2
    exit 1
  fi
  SHEET_ID="${match%%	*}"
  local rest="${match#*	}"
  SHEET="${rest%%	*}"
}

resolve_sheet

BASE=(--url "$URL" --sheet-name "$SHEET")

need_rows() {
  [[ -n "$ROWS" ]] || { echo "需要 --row N（单行）或 --rows 3,4,5（多行, 逗号分隔）" >&2; exit 1; }
}

# 功能: 跑一条 lark-cli 读命令, 失败时把原因透出来并**中止整个脚本**.
# 关注点: 原本这里是 `2>/dev/null || true`, 于是未登录/token 过期/表名写错
#   全都退化成"0 张图" —— 与"该行确实没图"不可区分. 宁可吵, 不可静默.
#   🔴 光看 exit code 不够: lark-cli 遇到 API 错误(如 sheet 名写错)会**退出 0**
#   并打印 `"ok": false` 的 JSON. 所以两个都要判.
run_read() {
  local out rc
  out=$(lark-cli "$@" 2>&1); rc=$?
  if [[ $rc -ne 0 ]] || printf '%s' "$out" | grep -q '"ok"[[:space:]]*:[[:space:]]*false'; then
    echo "❌ lark-cli $1 $2 失败了 (exit $rc), 报错如下:" >&2
    printf '%s\n' "$out" | grep -v '"_notice"' | head -20 >&2
    echo "   三个最常见原因: 1) 没登录 → 跑 lark-cli auth status 看看; 2) sheet 名写错 → 当前 '$SHEET'; 3) 这张表没权限 → 联系表 owner 加权限" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

# 功能: 列出一行的 cell 内嵌图, 输出 "行<TAB>列<TAB>embed<TAB>token".
# 关注点: 行列必须取 row_indices/col_indices, 不能按数组下标数 —— 截断或隐藏行时会错位.
list_embed() {
  local row="$1"
  run_read sheets +cells-get "${BASE[@]}" \
    --range "A${row}:${LAST_COL}${row}" --include value \
    -q '.data.ranges[] | . as $rg | $rg.cells | to_entries[] | .key as $i | .value
        | to_entries[] | select(.value.rich_text) | .key as $j | .value.rich_text[]
        | select(.type=="embed-image")
        | "\($rg.row_indices[$i])\t\($rg.col_indices[$j])\tembed\t\(.image_token)"'
}

# 功能: 列出整表浮动图并过滤到目标行, 输出 "行<TAB>列<TAB>float<TAB>token".
# 关注点: 用 address 拆行列(1-based); 这个接口一次返回整表, 无分页.
list_float() {
  local want="$1"   # 逗号分隔的行号
  run_read sheets +float-image-list "${BASE[@]}" \
    -q '.data.sheets[] | select(.sheet_name=="'"$SHEET"'") | .float_images[]
        | "\(.address)\t\(.image_token)"' \
  | while IFS=$'\t' read -r address token; do
      [[ -n "$address" ]] || continue
      local col="${address//[0-9]/}"
      local row="${address//[!0-9]/}"
      case ",$want," in *",$row,"*) printf '%s\t%s\tfloat\t%s\n' "$row" "$col" "$token" ;; esac
    done
}

# 功能: 汇总一行/多行的所有图, 按 行→列→贴法 排序. 取图命令失败则整体退出.
# 关注点: 🔴 先收集到变量再 sort, **不要** `collect_images | sort` —— 管道左侧是
#   子 shell, run_read 的 `exit 1` 只杀得掉子 shell, 主脚本照常继续
#   (表现为"0 张图", 且报错信息被吞) —— 正是这个脚本要消灭的那类静默.
collect_sorted() {
  local out
  out=$(collect_images) || exit 1
  printf '%s' "$out" | sort -t$'\t' -k1,1n -k2,2 -k3,3
}

# 功能: 依次发两个取图命令(cell 内嵌 + 浮动图), 输出未排序的四列.
# 关注点: 两个命令都要发, 少发一个就静默漏掉一半的图.
collect_images() {
  local r
  for r in ${ROWS//,/ }; do list_embed "$r"; done
  list_float "$ROWS"
}

case "$CMD" in
  row-get)
    need_rows
    for r in ${ROWS//,/ }; do
      run_read sheets +csv-get "${BASE[@]}" --range "A${r}:${LAST_COL}${r}" --format json \
        -q '.data.annotated_csv'
    done
    echo "# ⚠️ 以上不含图片（csv-get 对图返回空）。要图: feishu.sh img-get --row ${ROWS}" >&2
    ;;

  img-list)
    need_rows
    printf 'row\tcol\tkind\timage_token\n'
    collect_sorted
    ;;

  img-get)
    need_rows
    mkdir -p "$DEST"
    DEST_ABS="$(cd "$DEST" && pwd)"
    n=0
    # 同一格多张图(浮动图允许)时用 seq 后缀区分, 不然文件名撞车互相覆盖.
    # 关注点: 靠"输入已按 行→列 排序"用 prev_key 计数, **不用关联数组** ——
    #   macOS 自带 bash 3.2 没有 declare -A, 用了直接语法错误.
    prev_key=""; s=0
    while IFS=$'\t' read -r row col kind token; do
      [[ -n "${token:-}" ]] || continue
      key="R${row}-${col}"
      if [[ "$key" == "$prev_key" ]]; then s=$((s+1)); else prev_key="$key"; s=1; fi
      base="$key"; [[ $s -gt 1 ]] && base="${key}-${s}"
      # -o 只接受相对路径 => cd 到目标目录再传裸文件名.
      # 关注点: `-q` 和 `-o` 互斥(lark-cli 会 validation error), 所以 content_type
      #   只能从它打印的 JSON 里 grep 出来, 不能用 -q 提取.
      out=$(cd "$DEST_ABS" && lark-cli api GET \
              "/open-apis/drive/v1/medias/${token}/download" -o "${base}.download" 2>&1) || {
        echo "下载 ${key} (${token}) 失败: $out" >&2; continue
      }
      ctype=$(printf '%s' "$out" | sed -n 's/.*"content_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      case "$ctype" in
        image/png)  ext=.png ;;
        image/jpeg|image/jpg) ext=.jpg ;;
        image/gif)  ext=.gif ;;
        image/webp) ext=.webp ;;
        image/bmp)  ext=.bmp ;;
        image/svg*) ext=.svg ;;
        *) ext=.png ;;   # 认不出就按 png（实测飞书表格图都是 png/jpeg）
      esac
      mv "$DEST_ABS/${base}.download" "$DEST_ABS/${base}${ext}"
      echo "$DEST_ABS/${base}${ext}"
      n=$((n+1))
    done < <(collect_sorted)
    echo "# 共下载 ${n} 张 -> ${DEST_ABS}（文件名 R{行}-{列} = 贴在哪格）" >&2
    [[ $n -eq 0 ]] && echo "# 提示: 这一行确实没图, 或行号错了（img-list 可核对）" >&2
    exit 0
    ;;

  cell-set)
    need_rows
    [[ -n "$FIELD" ]] || { echo "需要 --field \"列=值\"（例如 --field \"O=1\"）" >&2; exit 1; }
    # 坑: lark-cli 没有 `+csv-set` 这个子命令(本脚本原来就是这么写的, 一调就
    #   validation error)。写格子只有 `+csv-put --start-cell` 一条路。
    # 坑: --csv 不接受绝对路径(同 img-get 的 -o), 必须走 stdin `--csv -`。
    col="${FIELD%%=*}"; val="${FIELD#*=}"
    [[ "$col" =~ ^[A-Za-z]{1,2}$ ]] || { echo "--field 的列名格式不对: '$col'（必须是大写字母, 形如 O=1）" >&2; exit 1; }
    # 单格也要按 RFC-4180 转义: 值里有逗号/引号/换行时不裹起来会串列
    csv=""
    csv=$(printf '%s' "$val" | python3 -c 'import csv,sys; csv.writer(sys.stdout,lineterminator="").writerow([sys.stdin.read()])')
    printf '%s' "$csv" | lark-cli sheets +csv-put "${BASE[@]}" \
      --start-cell "$(printf '%s' "$col" | tr '[:lower:]' '[:upper:]')${ROWS}" --csv -
    ;;

  sheet-list)
    # 列出所有 sheet, 跳过飞书的 _notice 噪音行, 输出 id<TAB>name<TAB>index
    token="$(url_token "$URL")"
    [[ -n "$token" ]] || { echo "❌ 无法从 URL 抽 spreadsheet token" >&2; exit 1; }
    run_read api GET "/open-apis/sheets/v3/spreadsheets/${token}/sheets/query" \
      -q '.data.sheets[] | "\(.sheet_id)\t\(.title)\t\(.index // 0)"'
    ;;

  csv-clear)
    [[ -n "$RANGE" ]] || { echo "需要 --range A1:T60（清空范围, 含两端格）" >&2; exit 1; }
    lark-cli sheets +cells-clear --url "$URL" --sheet-id "$SHEET_ID" \
      --range "$RANGE" --scope "${SCOPE:-content}" --yes
    ;;

  csv-put)
    [[ -n "$START_CELL" ]] || { echo "需要 --start-cell A1（从这格起开始贴 CSV）" >&2; exit 1; }
    # CSV 走 stdin: `feishu.sh csv-put --start-cell A1 < data.csv`
    #   stdin 必读 (空 CSV 也允许, 等同空操作).
    cat | lark-cli sheets +csv-put "${BASE[@]}" --start-cell "$START_CELL" --csv -
    ;;

  style-bold)
    [[ -n "$RANGE" ]] || { echo "需要 --range A1:I1（要加粗的范围）" >&2; exit 1; }
    args=(sheets +cells-set-style --url "$URL" --sheet-id "$SHEET_ID" \
          --range "$RANGE" --font-weight bold)
    [[ -n "$BACKGROUND" ]] && args+=(--background-color "$BACKGROUND")
    [[ -n "$FONT_SIZE" ]]  && args+=(--font-size "$FONT_SIZE")
    lark-cli "${args[@]}"
    ;;

  freeze-rows)
    [[ -n "$ROWS" ]] || { echo "需要 --rows N（要冻结的前 N 行, 通常是表头）" >&2; exit 1; }
    lark-cli sheets +dim-freeze --url "$URL" --sheet-id "$SHEET_ID" --rows "$ROWS"
    ;;

  *) echo "❌ 不认识这个子命令: $CMD（看看 usage 找正确的命令名）" >&2; usage; exit 1 ;;
esac
