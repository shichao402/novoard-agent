/**
 * 暴露给本机会话的 Novoard 工具。全部走本机 HTTP，执行只经 /a2a，不另开一条旁路。
 */
async function callJson(fetchImpl, origin, path, init) {
  const response = await fetchImpl(`${origin}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = body?.errors?.[0] || body?.reason || body?.error?.message || `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return body;
}

export async function dispatchNovoardTool(name, args, { origin, fetchImpl = globalThis.fetch } = {}) {
  if (!origin) throw new Error("本机 Agent 地址还没有就绪");
  const input = args ?? {};
  if (name === "novoard_status") {
    const runtime = await callJson(fetchImpl, origin, "/api/runtime");
    const tiles = await callJson(fetchImpl, origin, "/api/tiles");
    return JSON.stringify({
      agentId: runtime.agentId,
      hubConnected: runtime.hubConnected,
      hubRegistered: runtime.hubRegistered,
      targets: (tiles.tiles ?? []).map((tile) => ({ id: tile.id, title: tile.title, requiresApproval: tile.requiresApproval, last: tile.last })),
    });
  }
  if (name === "novoard_list_targets") {
    return JSON.stringify(await callJson(fetchImpl, origin, "/api/targets"));
  }
  if (name === "novoard_get_settings") {
    const settings = await callJson(fetchImpl, origin, "/api/settings");
    return JSON.stringify({
      agentId: settings.agentId,
      hubUrl: settings.hubUrl,
      hasToken: settings.hasToken,
      contractVersion: settings.contractVersion,
    });
  }
  if (name === "novoard_save_settings") {
    const saved = await callJson(fetchImpl, origin, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        hubUrl: input.hubUrl,
        agentId: input.agentId,
        ...(input.agentToken ? { agentToken: input.agentToken } : {}),
      }),
    });
    return JSON.stringify({ ...saved, note: "配置已写入。让用户在设置页重新连接后，Hub 才会改用新令牌。" });
  }
  if (name === "novoard_upsert_target") {
    const current = await callJson(fetchImpl, origin, "/api/targets");
    const targets = { ...(current.targets ?? {}) };
    targets[input.id] = input.target;
    const saved = await callJson(fetchImpl, origin, "/api/targets", {
      method: "PUT",
      body: JSON.stringify({ targets }),
    });
    return JSON.stringify({ ok: true, id: input.id, count: saved.count });
  }
  if (name === "novoard_delete_target") {
    const current = await callJson(fetchImpl, origin, "/api/targets");
    const targets = { ...(current.targets ?? {}) };
    delete targets[input.id];
    const saved = await callJson(fetchImpl, origin, "/api/targets", {
      method: "PUT",
      body: JSON.stringify({ targets }),
    });
    return JSON.stringify({ ok: true, id: input.id, count: saved.count });
  }
  if (name === "novoard_run_target") {
    const body = await callJson(fetchImpl, origin, "/a2a", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `agent-${Date.now()}`,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: input.id }] } },
      }),
    });
    if (body.error) throw new Error(body.error.message || "A2A 拒绝了这次执行");
    return JSON.stringify({ taskId: body.result?.id, status: body.result?.status, via: "a2a" });
  }
  if (name === "novoard_recent_activity") {
    return JSON.stringify(await callJson(fetchImpl, origin, "/api/activity?limit=20"));
  }
  if (name === "novoard_tail_logs") {
    return JSON.stringify(await callJson(fetchImpl, origin, "/api/logs?page=1"));
  }
  throw new Error(`未知工具：${name}`);
}
