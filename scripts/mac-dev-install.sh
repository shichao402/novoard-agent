#!/bin/bash
# 触发 CI 编译 Novoard Agent 开发版，并替换安装到本机 ~/Applications。
#
# 用法：
#   scripts/mac-dev-install.sh build      触发 dev 渠道发布并等待完成，记下 run id
#   scripts/mac-dev-install.sh install    下载上一步的 mac 包，替换安装并启动开发版
#   scripts/mac-dev-install.sh all        两步连着跑
#   scripts/mac-dev-install.sh check      只检查依赖（gh 登录、架构、安装位置），不做任何改动
#
# 设计为由正式版 agent（com.novoard.agent）调用：它装的是开发版（com.novoard.agent.dev），
# 两者是并排安装的两个应用，所以安装过程不会停掉正在执行本任务的 agent。
# 不要把这个 target 配在开发版 agent 上，否则安装时会把自己停掉，任务会丢。
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

REPO="shichao402/novoard-agent"
WORKFLOW="release-agent.yml"
REF="main"
APP_NAME="Novoard Agent Dev"
APP_ID="com.novoard.agent.dev"
DEST="$HOME/Applications/$APP_NAME.app"
STATE_DIR="$HOME/Library/Caches/novoard-dev-install"
RUN_FILE="$STATE_DIR/last-run-id"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

WORK=""
MNT=""
cleanup() {
  if [ -n "$MNT" ]; then hdiutil detach -quiet "$MNT" 2>/dev/null || true; fi
  if [ -n "$WORK" ]; then /bin/rm -rf "$WORK"; fi
}

artifact_name() {
  case "$(uname -m)" in
    x86_64) echo "relkit-out-darwin-amd64" ;;
    arm64) echo "relkit-out-darwin-arm64" ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac
}

cmd_check() {
  [ "$(uname -s)" = "Darwin" ] || die "只支持 macOS"
  command -v gh >/dev/null || die "找不到 gh（GitHub CLI）"
  gh auth status -h github.com >/dev/null 2>&1 || die "gh 未登录 github.com，先在终端运行 gh auth login"
  log "架构产物：$(artifact_name)"
  if [ -d "$DEST" ]; then
    log "当前开发版：$(defaults read "$DEST/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo 未知)"
  else
    log "当前未安装开发版，将全新安装到 $DEST"
  fi
  log "依赖检查通过"
}

cmd_build() {
  cmd_check
  mkdir -p "$STATE_DIR"
  local started
  started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  log "触发 dev 渠道发布（$REPO@$REF）"
  gh workflow run "$WORKFLOW" -R "$REPO" --ref "$REF"

  local run_id="" i
  for i in $(seq 1 20); do
    sleep 3
    run_id="$(gh run list -R "$REPO" -w "$WORKFLOW" -e workflow_dispatch -L 5 \
      --json databaseId,createdAt \
      -q "[.[] | select(.createdAt >= \"$started\")] | sort_by(.createdAt) | .[0].databaseId // empty")"
    [ -n "$run_id" ] && break
  done
  [ -n "$run_id" ] || die "触发后 60 秒内没看到新的 dev 构建"
  echo "$run_id" > "$RUN_FILE"
  log "构建已开始：https://github.com/$REPO/actions/runs/$run_id"

  if ! gh run watch "$run_id" -R "$REPO" --exit-status --interval 30 >/dev/null; then
    die "dev 构建失败：https://github.com/$REPO/actions/runs/$run_id"
  fi
  log "dev 构建完成，已发布到 relkit dev 渠道"
}

cmd_install() {
  cmd_check
  [ -f "$RUN_FILE" ] || die "没有找到上一次构建的 run id，先运行 build"
  local run_id art app version dmg
  run_id="$(cat "$RUN_FILE")"
  art="$(artifact_name)"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/novoard-dev-install.XXXXXX")"
  MNT=""
  trap cleanup EXIT

  log "下载构建产物 $art（run $run_id）"
  gh run download "$run_id" -R "$REPO" -n "$art" -D "$WORK"
  dmg="$(find "$WORK" -maxdepth 2 -name '*.dmg' | head -1)"
  [ -n "$dmg" ] || die "产物里没有 dmg"
  log "安装包：$(basename "$dmg")"

  MNT="$(hdiutil attach -nobrowse -readonly "$dmg" | grep -o '/Volumes/.*' | tail -1)"
  [ -n "$MNT" ] || die "挂载 dmg 失败"
  app="$MNT/$APP_NAME.app"
  [ -d "$app" ] || die "dmg 里没有 $APP_NAME.app"

  log "退出旧开发版"
  osascript -e "quit app id \"$APP_ID\"" >/dev/null 2>&1 || true
  for i in $(seq 1 10); do
    pgrep -f "$DEST/Contents/MacOS" >/dev/null || break
    sleep 1
  done
  pkill -f "$DEST/Contents/MacOS" 2>/dev/null || true
  sleep 1

  log "替换安装到 $DEST"
  /bin/rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  ditto "$app" "$DEST"
  hdiutil detach -quiet "$MNT" && MNT=""

  version="$(defaults read "$DEST/Contents/Info" CFBundleShortVersionString)"
  log "启动开发版 $version"
  open "$DEST"
  sleep 5
  pgrep -f "$DEST/Contents/MacOS" >/dev/null || die "开发版没有启动起来"
  log "完成：开发版 $version 已安装并启动"
}

case "${1:-}" in
  check) cmd_check ;;
  build) cmd_build ;;
  install) cmd_install ;;
  all) cmd_build; cmd_install ;;
  *) die "用法：$0 check|build|install|all" ;;
esac
