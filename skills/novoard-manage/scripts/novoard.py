#!/usr/bin/env python3
"""在编码会话里操作本机 novoard-agent（只用标准库）。

本机写操作走 agent 控制台接口：保存 target 走 PUT /api/targets（校验 schema、备份、热替换、
向 Hub 上报 card.update），执行走本机 /a2a。来源管理走 Hub 专用 PAT 接口，不借成员令牌授权。
这里不碰 targets.yaml 等文件，直接改文件不会生效。

  看现场
    novoard.py status                      身份、Hub 连接、定时总开关、每个 target 的定时与上次结果
    novoard.py targets [<id>]              target 全文定义（JSON）
    novoard.py schedule                    定时详情：时区、总开关、每个定时 target 的 nextRun
    novoard.py packs                       已装能力包与可安装的来源
    novoard.py pack-tools [<包名>]         能力包工具清单与参数定义
    novoard.py inputs <id>                 target 运行时输入（候选项、默认值）
    novoard.py activity [--limit N]        最近执行记录
    novoard.py log <id> [--lines N]        该 target 最近一次运行日志

  改配置
    novoard.py add --file <片段.yaml> [--replace]   追加或替换一个 target，片段顶层只有一个 id
    novoard.py remove <id>                          撤下一个 target
    novoard.py install-pack <key> [--update]        安装（key 用 packs 返回的 installKey）或更新能力包
    novoard.py pack-sources list|add|update|remove  管理 Hub 来源，需来源专用 PAT
    novoard.py sync-pack-sources                   主动同步已配置 Hub 来源，无需重连

  执行
    novoard.py trigger <id> [--var k=v ...]   经本机 /a2a 触发一次
    novoard.py catch-up                        立即补跑错过的定时

所有子命令都接受 --dev：操作开发版 agent（com.novoard.agent.dev），默认正式版（com.novoard.agent）。

不提供：定时总开关、Hub 地址与令牌、Git 凭据、删除能力包。这些只在 agent 桌面端设置页操作。

片段格式（顶层就是 target id，不要写 targets:）：

  myapp-dev-install-imac5k2020:
    title: ...
    steps:
      - script: ./scripts/dev-install.sh
        cwd: /abs/path/to/repo
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def _support_root() -> Path:
    """Tauri app_data_dir 的上级：macOS ~/Library/Application Support，Windows %APPDATA%，Linux XDG_DATA_HOME。"""
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


SUPPORT = _support_root()
ID_LINE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*):\s*$")
TARGET_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PACK_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")


class Fail(RuntimeError):
    pass


def out(obj) -> None:
    print(json.dumps(_compact(obj), ensure_ascii=False, indent=2))


def _compact(obj):
    if isinstance(obj, dict):
        return {k: _compact(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [_compact(v) for v in obj]
    return obj


def data_dir(dev: bool) -> Path:
    d = SUPPORT / ("com.novoard.agent.dev" if dev else "com.novoard.agent")
    if not d.is_dir():
        raise Fail(f"没找到 agent 数据目录：{d}（{'开发版' if dev else '正式版'}没装或没跑过向导）")
    return d


def http(method: str, url: str, body: dict | None = None, timeout: float = 10.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw.decode("utf-8", "replace")


def locate(dev: bool) -> dict:
    """agent 身份与可用的控制台地址。端口先读 agent.json，再退回日志里最后一次的“控制台:”行。"""
    d = data_dir(dev)
    cfg = json.loads((d / "agent.json").read_text(encoding="utf-8"))
    agent_id = cfg.get("agentId", "")
    candidates = []
    if cfg.get("localPort"):
        candidates.append(int(cfg["localPort"]))
    log = d / "logs" / "agent.jsonl"
    if log.is_file():
        for m in re.finditer(r"控制台: http://127\.0\.0\.1:(\d+)", log.read_text(encoding="utf-8", errors="replace")):
            candidates.append(int(m.group(1)))
    seen = []
    for port in [*candidates[:1], *reversed(candidates[1:])]:
        if port in seen:
            continue
        seen.append(port)
        try:
            status, body = http("GET", f"http://127.0.0.1:{port}/api/targets", timeout=3)
        except (urllib.error.URLError, OSError):
            continue
        if status == 200 and isinstance(body, dict) and body.get("ok"):
            return {"dir": d, "agentId": agent_id, "port": port, "base": f"http://127.0.0.1:{port}", "targets": body}
    raise Fail(f"{'开发版' if dev else '正式版'} agent 控制台连不上（试过端口 {seen}）。确认 agent 正在运行。")


def api(info: dict, method: str, path: str, body: dict | None = None, timeout: float = 30.0, what: str = "") -> dict:
    """调控制台接口，非 2xx 时把服务端给的原因原样抛出，方便照着改。"""
    try:
        status, resp = http(method, f"{info['base']}{path}", body, timeout=timeout)
    except (urllib.error.URLError, OSError) as e:
        raise Fail(f"{what or path} 请求失败：{e}")
    if status == 404 and not isinstance(resp, dict):
        raise Fail(f"这台 agent 没有 {path} 接口，版本可能太旧，建议升级")
    if not (200 <= status < 300) or (isinstance(resp, dict) and resp.get("ok") is False):
        reason = resp
        if isinstance(resp, dict):
            reason = resp.get("errors") or resp.get("reason") or resp.get("error") or resp
        raise Fail(f"{what or path} 被拒绝（HTTP {status}）：{json.dumps(reason, ensure_ascii=False)}")
    return resp if isinstance(resp, dict) else {"result": resp}


def schedule_of(info: dict) -> dict | None:
    """GET /api/schedule；旧版 agent（0.3.6 及以前）没有这个接口，返回 None。"""
    try:
        status, body = http("GET", f"{info['base']}/api/schedule", timeout=5)
    except (urllib.error.URLError, OSError):
        return None
    if status != 200 or not isinstance(body, dict) or not body.get("ok"):
        return None
    return body


def runtime_of(info: dict) -> dict:
    try:
        status, body = http("GET", f"{info['base']}/api/runtime", timeout=5)
    except (urllib.error.URLError, OSError):
        return {}
    return body if status == 200 and isinstance(body, dict) else {}


def check_id(tid: str) -> str:
    if not TARGET_ID.match(tid):
        raise Fail(f"`{tid}` 不是合法的 target id（小写字母、数字、连字符）")
    return tid


def split_snippet(text: str) -> tuple[str, str]:
    lines = [l for l in text.replace("\t", "  ").splitlines() if l.strip() and not l.lstrip().startswith("#")]
    tops = [l for l in lines if not l[0].isspace()]
    if len(tops) != 1 or not ID_LINE.match(tops[0]):
        raise Fail("片段顶层必须恰好一行 `<target-id>:`，其余内容缩进在它下面（不要写 targets:）")
    tid = ID_LINE.match(tops[0]).group(1)
    body = "\n".join(("  " + l) if l.strip() else l for l in text.rstrip("\n").splitlines())
    return tid, body


def remove_block(yaml_text: str, tid: str) -> str:
    result, skipping = [], False
    for line in yaml_text.splitlines():
        if re.match(rf"^  {re.escape(tid)}:\s*$", line):
            skipping = True
            continue
        if skipping:
            indent = len(line) - len(line.lstrip(" "))
            if line.strip() and indent <= 2:
                skipping = False
            else:
                continue
        result.append(line)
    return "\n".join(result)


def wait_card_update(d: Path, since: float, timeout: float = 5.0) -> bool:
    log = d / "logs" / "agent.jsonl"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if log.is_file():
            for line in log.read_text(encoding="utf-8", errors="replace").splitlines()[-50:]:
                if "card.update 已上报" not in line:
                    continue
                try:
                    ts = json.loads(line).get("ts", "")
                    t = calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
                except (ValueError, json.JSONDecodeError):
                    continue
                if t >= since - 2:
                    return True
        time.sleep(0.5)
    return False


# ---------- 看现场 ----------

def cmd_status(a) -> int:
    info = locate(a.dev)
    sched = schedule_of(info)
    rt = runtime_of(info)
    by_id = {s.get("id"): s for s in (sched or {}).get("targets") or []}
    targets = {}
    for k, v in (info["targets"].get("targets") or {}).items():
        entry = {"title": v.get("title", ""), "expose": v.get("expose"), "requiresApproval": v.get("requiresApproval")}
        if v.get("inputs"):
            entry["inputs"] = True
        s = by_id.get(k)
        if s:
            entry["schedule"] = s.get("schedule")
            entry["nextRun"] = s.get("nextRun")
            if s.get("last"):
                entry["last"] = s.get("last")
        targets[k] = entry
    out({
        "edition": "dev" if a.dev else "stable",
        "agentId": info["agentId"],
        "console": info["base"],
        "hubConnected": rt.get("hubConnected"),
        "hubRegistered": rt.get("hubRegistered"),
        "schedule": None if sched is None else {"enabled": sched.get("enabled"), "timezone": sched.get("timezone")},
        "targets": targets,
    })
    if sched is None:
        print("提示：这台 agent 没有 /api/schedule（0.3.6 及以前），定时信息不可用，建议升级。", file=sys.stderr)
    return 0


def cmd_targets(a) -> int:
    info = locate(a.dev)
    all_targets = info["targets"].get("targets") or {}
    if a.id:
        if a.id not in all_targets:
            raise Fail(f"target `{a.id}` 不存在。已有：{', '.join(all_targets) or '（无）'}")
        out({a.id: all_targets[a.id]})
    else:
        out(all_targets)
    return 0


def cmd_schedule(a) -> int:
    info = locate(a.dev)
    sched = schedule_of(info)
    if sched is None:
        raise Fail("这台 agent 没有定时接口或调度还没启动")
    sched.pop("ok", None)
    out(sched)
    return 0


def cmd_packs(a) -> int:
    info = locate(a.dev)
    body = api(info, "GET", "/api/packs", what="读取能力包")
    out({
        "packs": [{
            "id": p.get("id"),
            "installKey": p.get("id") if p.get("installed") else p.get("sourceKey"),
            "installed": p.get("installed") is True,
            "displayName": p.get("displayName"),
            "version": p.get("version"),
            "git": (p.get("source") or {}).get("git"),
            "subdir": (p.get("source") or {}).get("subdir"),
            "depsReady": p.get("depsReady"),
            "problem": p.get("problem") or p.get("depsReason"),
            "credential": p.get("credential"),
            "busy": p.get("busy") is True or None,
        } for p in body.get("packs") or []],
        "repos": [{
            "git": r.get("git"),
            "branch": r.get("branch"),
            "scannedAt": r.get("scannedAt"),
            "found": [p.get("id") or f"（{p.get('subdir') or '仓库根'}：{p.get('problem') or '无效'}）" for p in r.get("packs") or []],
            "error": r.get("error"),
        } for r in body.get("repos") or []],
    })
    return 0


def cmd_pack_tools(a) -> int:
    info = locate(a.dev)
    body = api(info, "GET", "/api/packs/tools", what="读取能力包工具")
    packs = body.get("packs") or []
    if a.pack:
        packs = [p for p in packs if p.get("id") == a.pack]
        if not packs:
            raise Fail(f"本机没有装能力包 {a.pack}，先 `packs` 看来源，再 `install-pack`")
    out({"platform": body.get("platform"), "timezone": body.get("timezone"), "scheduleEnabled": body.get("scheduleEnabled"), "packs": packs})
    return 0


def cmd_inputs(a) -> int:
    info = locate(a.dev)
    body = api(info, "GET", f"/api/targets/{check_id(a.id)}/inputs", what="读取运行时输入")
    body.pop("ok", None)
    out(body)
    return 0


def cmd_activity(a) -> int:
    info = locate(a.dev)
    body = api(info, "GET", f"/api/activity?limit={max(1, min(a.limit, 200))}", what="读取执行记录")
    out(body.get("events") or [])
    return 0


def cmd_log(a) -> int:
    d = data_dir(a.dev) / "logs" / "shortcuts" / a.id
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime) if d.is_dir() else []
    if not files:
        raise Fail(f"没有运行日志：{d}")
    print(f"# {files[-1]}")
    for line in files[-1].read_text(encoding="utf-8", errors="replace").splitlines()[-a.lines:]:
        try:
            print(json.loads(line).get("msg", line))
        except json.JSONDecodeError:
            print(line)
    return 0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _hub_base(a) -> str:
    value = a.hub or os.environ.get("NOVOARD_HUB_URL", "")
    if not value:
        settings = api(locate(a.dev), "GET", "/api/settings", what="读取 Hub 地址")
        value = settings.get("hubUrl", "")
    try:
        url = urllib.parse.urlsplit(value)
        scheme = {"wss": "https", "ws": "http"}.get(url.scheme, url.scheme)
        if scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError()
        if scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError()
        if url.path.rstrip("/") not in ("", "/tunnel"):
            raise ValueError()
        return urllib.parse.urlunsplit((scheme, url.netloc, "", "", ""))
    except ValueError:
        raise Fail("Hub 地址必须是 HTTPS/WSS 根地址（或 /tunnel），不得含凭据/查询参数；HTTP 仅限回环调试")


def _hub_pat() -> str:
    file = os.environ.get("NOVOARD_HUB_PAT_FILE", "")
    try:
        token = Path(file).read_text(encoding="utf-8-sig").strip() if file else os.environ.get("NOVOARD_HUB_PAT", "").strip()
    except (OSError, UnicodeError):
        raise Fail("无法读取 NOVOARD_HUB_PAT_FILE；请由用户在本机准备凭据，不发送到对话")
    if not re.fullmatch(r"nvp_[0-9a-f]{16}_[A-Za-z0-9_-]{40,}", token):
        raise Fail("需要具名 Hub PAT：由用户准备 NOVOARD_HUB_PAT 或 NOVOARD_HUB_PAT_FILE，勿发送明文；不能复用 agentToken")
    return token


def _hub_api(base: str, token: str, method: str, path: str, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"})
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(req, timeout=30) as response:
            raw = response.read(512 * 1024 + 1)
            if len(raw) > 512 * 1024 or "application/json" not in response.headers.get("Content-Type", ""):
                raise Fail("Hub 返回非 JSON 或超大响应，停止处理")
            result = json.loads(raw.replace(token.encode("utf-8"), b"[REDACTED]"))
            if not isinstance(result, dict):
                raise Fail("Hub 返回无效对象，停止处理")
            if method == "GET" and (not isinstance(result.get("sources"), list) or any(not isinstance(s, dict) for s in result["sources"])):
                raise Fail("Hub 返回无效来源清单，停止处理")
            return result
    except urllib.error.HTTPError as error:
        # 不回显不可信服务器正文，也不跟随重定向携带 PAT。
        hints = {401: "PAT 无效、过期或已吊销", 403: "缺少来源专用 scope 或用户已降权", 404: "来源不存在或 Hub 尚未升级", 409: "来源或覆盖名冲突，请先查询现有条目"}
        raise Fail(f"Hub 来源接口被拒绝（HTTP {error.code}）：{hints.get(error.code, '请求失败；不会重定向或自动扩大权限')}")
    except (urllib.error.URLError, OSError, ValueError):
        raise Fail("Hub 来源请求失败，请检查网络和服务版本；不会输出 PAT 或自动重试写入")


def _source_git(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 512 or re.search(r"[\x00-\x20\x7f]", value) or value.startswith("-"):
        raise Fail("仓库地址不合法")
    if "://" in value:
        try:
            url = urllib.parse.urlsplit(value)
            if not url.hostname:
                raise ValueError()
        except ValueError:
            raise Fail("仓库 URL 不合法")
        if url.password or url.query or url.fragment or (url.scheme in ("http", "https") and url.username):
            raise Fail("来源不得嵌入凭据或查询参数；私有仓有本机 SSH 权限时优先用 SSH")
    return value


def cmd_pack_sources(a) -> int:
    # 参数先校验，错误请求不读取凭据、不访问服务。
    if a.action == "list" and (a.key or a.git or a.branch):
        raise Fail("list 不接受 --key/--git/--branch")
    if a.action == "add" and (not a.git or a.key):
        raise Fail("add 需要 --git，不能给 --key")
    if a.action in ("update", "remove") and (not a.key or not re.fullmatch(r"ps-[0-9a-f]{8,32}", a.key)):
        raise Fail("update/remove 需要从 list 获取合法的 --key（ps-…）")
    if a.action == "remove" and (a.git or a.branch or not a.confirm):
        raise Fail("remove 需要 --confirm，不能给 --git/--branch；先确认用户同意删除")
    if a.action == "update" and not (a.git or a.branch):
        raise Fail("update 至少给 --git 或 --branch，未指定字段原样保留")
    git = _source_git(a.git) if a.git else None
    if a.branch is not None and (not a.branch.strip() or re.search(r"[\s\x00-\x1f\x7f]", a.branch) or a.branch.startswith("-") or len(a.branch) > 512):
        raise Fail("branch 不合法")
    base, token = _hub_base(a), _hub_pat()
    if a.action == "list":
        out(_hub_api(base, token, "GET", "/api/pack-sources"))
        return 0
    if a.action == "add":
        result = _hub_api(base, token, "POST", "/api/pack-sources", {"git": git, "branch": a.branch or "main"})
    elif a.action == "remove":
        result = _hub_api(base, token, "DELETE", "/api/pack-sources/" + a.key)
    else:
        listed = _hub_api(base, token, "GET", "/api/pack-sources")
        current = next((s for s in listed.get("sources", []) if s.get("key") == a.key), None)
        if not current:
            raise Fail("来源不存在，请重新 list；未执行写入")
        body = {field: current[field] for field in ("git", "branch", "id", "subdir") if field in current}
        if git:
            body["git"] = git
        if a.branch:
            body["branch"] = a.branch
        result = _hub_api(base, token, "PUT", "/api/pack-sources/" + a.key, body)
    out(result)
    print("来源是 Hub 全局配置；写入后用 sync-pack-sources 同步本机，再 packs 查看扫描结果。", file=sys.stderr)
    return 0


def cmd_sync_pack_sources(a) -> int:
    info = locate(a.dev)
    out(api(info, "POST", "/api/pack-sources/sync", {}, timeout=45, what="同步已配置 Hub 的能力包来源"))
    return 0


# ---------- 改配置 ----------

def cmd_add(a) -> int:
    info = locate(a.dev)
    tid, block = split_snippet(Path(a.file).read_text(encoding="utf-8"))
    check_id(tid)
    current = info["targets"]
    yaml_text = current["yaml"]
    if tid in (current.get("targets") or {}):
        if not a.replace:
            raise Fail(f"target `{tid}` 已存在；确认要覆盖就加 --replace")
        yaml_text = remove_block(yaml_text, tid)
    if not re.search(r"^targets:\s*$", yaml_text, re.M):
        raise Fail("targets.yaml 里没有顶层 `targets:`，先在控制台编辑页确认文件结构")
    new_yaml = yaml_text.rstrip("\n") + "\n" + block + "\n"
    started = time.time()
    saved = api(info, "PUT", "/api/targets", {"yaml": new_yaml}, what="保存 target")
    after = api(info, "GET", "/api/targets")
    if tid not in (after.get("targets") or {}):
        raise Fail("保存返回成功，但重读后没有这个 target")
    reported = wait_card_update(info["dir"], started)
    result = {"ok": True, "id": tid, "agentId": info["agentId"], "count": saved.get("count"), "cardUpdateReported": reported}
    sched = schedule_of(info)
    if sched is not None:
        s = next((x for x in sched.get("targets") or [] if x.get("id") == tid), None)
        if s:
            result["schedule"] = {"cron": s.get("schedule"), "nextRun": s.get("nextRun"), "timezone": sched.get("timezone"), "enabled": sched.get("enabled")}
    out(result)
    if not reported:
        print("提示：5 秒内没在日志里看到 card.update 上报，可能 agent 当前没连上 Hub；连上后会随注册带上新卡片。", file=sys.stderr)
    if result.get("schedule") and not result["schedule"]["enabled"]:
        print("提示：这个 target 配了定时，但本机定时总开关是关的，到点不会跑。请用户在 agent 设置页打开。", file=sys.stderr)
    return 0


def cmd_remove(a) -> int:
    info = locate(a.dev)
    current = info["targets"]
    if a.id not in (current.get("targets") or {}):
        raise Fail(f"target `{a.id}` 不存在")
    saved = api(info, "PUT", "/api/targets", {"yaml": remove_block(current["yaml"], a.id) + "\n"}, what="保存 target")
    out({"ok": True, "removed": a.id, "count": saved.get("count")})
    return 0


def cmd_install_pack(a) -> int:
    if not PACK_KEY.match(a.key):
        raise Fail("key 应为包名，或未装来源的 installKey（src-…），用 `packs` 查")
    info = locate(a.dev)
    action = "update" if a.update else "install"
    body = api(info, "POST", f"/api/packs/{a.key}/{action}", {}, timeout=600, what=f"{'更新' if a.update else '安装'}能力包 {a.key}")
    out(body)
    return 0


# ---------- 执行 ----------

def parse_vars(items: list[str]) -> dict:
    result = {}
    for item in items or []:
        if "=" not in item:
            raise Fail(f"--var 需要写成 名=值：{item}")
        k, v = item.split("=", 1)
        result[k.strip()] = v
    return result


def cmd_trigger(a) -> int:
    info = locate(a.dev)
    parts = [{"kind": "text", "text": check_id(a.id)}]
    vars_ = parse_vars(a.var)
    if vars_:
        parts.append({"kind": "data", "data": vars_})
    msg = {"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": {
        "role": "user", "messageId": f"novoard-cli-{int(time.time() * 1000)}", "parts": parts}}}
    status, body = http("POST", f"{info['base']}/a2a", msg, timeout=30)
    if status != 200 or not isinstance(body, dict) or "result" not in body:
        err = body.get("error") if isinstance(body, dict) else body
        raise Fail(f"触发失败（HTTP {status}）：{json.dumps(err, ensure_ascii=False)}")
    r = body["result"]
    st = r.get("status") or {}
    out({"taskId": r.get("id"), "state": st.get("state"), "message": st.get("message")})
    if st.get("state") == "failed":
        return 1
    if st.get("state") == "input-required":
        print("提示：这个 target 需要审批或补输入，请用户在 agent 桌面端或 Hub 上处理。", file=sys.stderr)
    return 0


def cmd_catch_up(a) -> int:
    info = locate(a.dev)
    body = api(info, "POST", "/api/schedule/catch-up", {}, what="补跑定时")
    out(body)
    return 0


COMMANDS = {
    "status": cmd_status, "targets": cmd_targets, "schedule": cmd_schedule, "packs": cmd_packs,
    "pack-tools": cmd_pack_tools, "inputs": cmd_inputs, "activity": cmd_activity, "log": cmd_log,
    "add": cmd_add, "remove": cmd_remove, "install-pack": cmd_install_pack,
    "trigger": cmd_trigger, "catch-up": cmd_catch_up,
    "pack-sources": cmd_pack_sources, "sync-pack-sources": cmd_sync_pack_sources,
}


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="novoard.py", description="在编码会话里操作本机 novoard-agent",
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in COMMANDS:
        s = sub.add_parser(name)
        s.add_argument("--dev", action="store_true", help="操作开发版 agent（默认正式版）")
        if name == "pack-sources":
            s.add_argument("action", choices=["list", "add", "update", "remove"])
            s.add_argument("--hub", help="Hub HTTPS 地址；省略时从本机设置读取，不修改设置")
            s.add_argument("--key", help="Hub list 返回的管理 key（ps-…），不是 installKey")
            s.add_argument("--git", help="仓库地址，不得嵌入凭据")
            s.add_argument("--branch", help="分支，新增默认 main；修改时不传则保留")
            s.add_argument("--confirm", action="store_true", help="明确确认删除全局来源")
        if name == "targets":
            s.add_argument("id", nargs="?")
        if name == "pack-tools":
            s.add_argument("pack", nargs="?")
        if name in ("inputs", "log", "remove", "trigger"):
            s.add_argument("id")
        if name == "log":
            s.add_argument("--lines", type=int, default=40)
        if name == "activity":
            s.add_argument("--limit", type=int, default=20)
        if name == "add":
            s.add_argument("--file", required=True, help="target 片段 YAML")
            s.add_argument("--replace", action="store_true", help="同 id 已存在时覆盖")
        if name == "install-pack":
            s.add_argument("key")
            s.add_argument("--update", action="store_true", help="已装的包更新到最新")
        if name == "trigger":
            s.add_argument("--var", action="append", default=[], help="运行时输入，名=值，可重复")
    a = p.parse_args(argv)
    try:
        return COMMANDS[a.cmd](a)
    except Fail as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
