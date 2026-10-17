import { useState } from "react";
import { EditionMark } from "@/components/edition-mark";
import { edition } from "@/lib/edition";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { saveSetup, testHub } from "@/lib/api";

export function SetupPage({ base }: { base: string }) {
  const [hubUrl, setHubUrl] = useState("novoard.firoyang.com");
  const [agentId, setAgentId] = useState("");
  const [agentToken, setAgentToken] = useState("");
  const [status, setStatus] = useState("填写 Hub 上签发的成员信息。令牌只在这里输入，不会再要求改配置文件。");
  const [tone, setTone] = useState<"info" | "ok" | "err">("info");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ hubUrl?: string; agentId?: string; agentToken?: string }>({});

  function validate() {
    const next: { hubUrl?: string; agentId?: string; agentToken?: string } = {};
    if (!hubUrl.trim()) next.hubUrl = "填写 Hub 域名，例如 novoard.firoyang.com";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId.trim())) next.agentId = "使用小写字母、数字或连字符，并与 Hub 签发时的 ID 一致";
    if (agentToken.trim().length < 8) next.agentToken = "粘贴 Hub 签发的令牌";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function test() {
    if (!validate()) return;
    setBusy(true);
    setTone("info");
    setStatus("正在测试连接…");
    try {
      const result = await testHub(base, hubUrl, agentToken);
      if (!result.ok) throw new Error(result.reason || "连接失败");
      setTone("ok");
      setStatus("连接成功。可以保存并启动。");
    } catch (error) {
      setTone("err");
      setStatus(error instanceof Error ? error.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!validate()) return;
    setBusy(true);
    setTone("info");
    setStatus("正在保存…");
    try {
      const result = await saveSetup(base, { hubUrl, agentId, agentToken });
      if (!result.ok) throw new Error("保存失败");
      setTone("ok");
      setStatus(`已接入 ${result.agentId}。正在打开控制台…`);
      if (result.panelUrl && !("__TAURI_INTERNALS__" in window)) {
        window.location.assign(result.panelUrl);
      }
    } catch (error) {
      setTone("err");
      setStatus(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid h-full place-items-center px-6">
      <section className="w-full max-w-[440px] rounded-2xl border border-line bg-panel p-7">
        <div className="mb-5 flex items-center gap-3">
          <EditionMark className="size-11 rounded-xl text-lg" />
          <div>
            <h1 className="text-lg font-semibold">接入 {edition.shortName}</h1>
            <p className="text-xs text-muted">这台电脑会作为 Hub 的一个成员在线</p>
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Hub 地址" hint="填域名即可，例如 novoard.firoyang.com" error={errors.hubUrl}>
            <Input value={hubUrl} onChange={(event) => setHubUrl(event.target.value)} autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label="成员 ID" hint="与 Hub 签发令牌时的 agentId 完全一致" error={errors.agentId}>
            <Input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="win-dev" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label="Agent Token" error={errors.agentToken}>
            <Input value={agentToken} onChange={(event) => setAgentToken(event.target.value)} type="password" placeholder="nva_…" />
          </Field>
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => void test()}>测试连接</Button>
          <Button variant="accent" className="flex-1" disabled={busy} onClick={() => void save()}>保存并启动</Button>
        </div>
        <p className={`mt-4 min-h-10 text-xs leading-5 ${tone === "ok" ? "text-good" : tone === "err" ? "text-bad" : "text-muted"}`}>{status}</p>
      </section>
    </main>
  );
}
