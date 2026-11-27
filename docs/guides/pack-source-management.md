# 来源管理与主动同步

## 使用入口

外部编码会话使用生成的 `skills/novoard-manage/SKILL.md` 和同目录 `scripts/novoard.py`。来源管理调用 Hub API，使用 `NOVOARD_HUB_PAT_FILE`（优先）或 `NOVOARD_HUB_PAT` 中已授权的具名 PAT，需要显式 `pack-sources.read` / `pack-sources.manage`。不读取浏览器凭据，不签发新令牌，不改 agent 的 Hub 地址或接入令牌。

```powershell
python <skill>/scripts/novoard.py pack-sources list
python <skill>/scripts/novoard.py pack-sources add --git git@git.example.com:team/my-packs.git --branch main
python <skill>/scripts/novoard.py pack-sources update --key <ps-key> --git git@git.example.com:team/my-packs.git
python <skill>/scripts/novoard.py pack-sources remove --key <ps-key> --confirm
python <skill>/scripts/novoard.py sync-pack-sources
python <skill>/scripts/novoard.py packs
```

`--hub` 可显式指定管理地址，否则从 `NOVOARD_HUB_URL` 或已运行本机控制台的 `/api/settings` 读取。全部命令支持 `--dev`。Git 来源不能包含 URL 凭据、查询参数或 fragment。有本机 SSH 权限的私有仓优先 SSH。`update` 先读取现有条目，只覆盖已给 git/branch，保留已有覆盖名 id/subdir；源已改变导致冲突时报告 `409`，不自动删除。删除必须先获用户同意并传 `--confirm`。

`ps-...` 是 Hub 管理 key；`packs` 中 `src-...` installKey 是本机扫描发现的安装入口，不能混用。来源登记与包安装是两个授权动作；同步成功也不等于已装包。

## 本机 API

`POST /api/pack-sources/sync` 只接受 `{}`，沿用本机同源检查和既有远程 UI 的独立鉴权。调用方不能提交 Hub URL/token。服务内部以现有连接地址与成员接入令牌只读请求 Hub 的 `GET /api/agent/pack-sources`，不获得来源写管理权限。

```json
{"ok":true,"count":1,"repos":[{"key":"src-...","git":"git@example.com:group/pack.git","branch":"main","autoAdd":false}],"note":"来源已同步，无需重连；使用 packs 查看扫描结果，安装需另行授权"}
```

外部 CLI 的 `sync-pack-sources` 走这个本机接口。内置会话通过 `novoard_sync_pack_sources` 走相同入口；工具声明、授权白名单、dispatch 与共享规则一致，内置会话不借成员令牌写 Hub 来源。

未装配返回 `503`，调用参数错误 `400`，跨站请求 `403`，同步失败 `422`，未预期本机异常 `500`。不同版本服务可能返回 `404`，报告版本能力缺失，不以强杀重启绕过。

## 失败保护

固定使用已配置 origin，只接受 HTTPS/WSS（HTTP/WS 限回环），拒绝重定向，不接外部凭据。请求超时 15 秒，同步 single-flight；响应最多 512 KiB、512 条来源，必须是合法 UTF-8 JSON。整个来源清单字段及唯一性均有效才替换缓存，空数组明确清空。非法清单、网络失败不覆盖旧数据。缓存落盘先于内存发布，写盘失败保留旧内存。

同步只 reconcile 来源，不调用 autoAdd/addAll，不重启服务，不安装能力包；`packs` 保留原后台扫描流程。现有 hello.ack 来源同步保留，无新增 WebSocket 帧或契约版本变化。

## 验证与发布

```powershell
npm run skill:gen
npm run skill:check
node --test test/pack-source-sync.test.mjs test/pack-source-cli.test.mjs test/chat-session.test.mjs test/chat-approval.test.mjs
npm test
```

Hub 仓 `docs/guides/pack-source-api.md` 是服务端权限与 HTTP 说明；跨仓集成通过 `NOVOARD_AGENT_SOURCE_DIR` 显式指定本仓运行。

共享行为规则修改 `src/novoard-skill-rules.mjs`，外部专用章节修改 `scripts/gen-manage-skill.mjs`，然后重新生成。发布生成的技能正文和 CLI 到 Dec 的 novoard bundle，使用逐文件编辑和 revision 乐观锁，保留其他文件、manifest 和 CLI 可执行位，不直接改本机落点副本。

部署前提：Hub 必须先升级支持专用 PAT 和成员只读接口，agent 必须升级支持同步入口。发布技能本身不升级已安装服务。用户无需发送密钥到对话；只需一次性在本机准备最小来源 PAT，之后智能体可在授权范围内完成来源查增改删与同步。
