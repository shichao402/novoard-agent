import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getCodebuddy, getProfile, getSettings, saveCodebuddy, saveProfile, saveSettings, testHub, type CodebuddySettings } from "@/lib/api";
import { hubLabel } from "@/lib/utils";

export function SettingsPage({ base, onRestart }: { base: string; onRestart: () => void }) {
  const [hubUrl, setHubUrl] = useState("");
  const [agentId, setAgentId] = useState("");
  const [agentToken, setAgentToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [model, setModel] = useState("");
  const [environment, setEnvironment] = useState<CodebuddySettings["environment"]>("internal");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "ok" | "err">("info");
  const [modelStatus, setModelStatus] = useState("");
  const [modelTone, setModelTone] = useState<"info" | "ok" | "err">("info");
  const [role, setRole] = useState("");
  const [introduction, setIntroduction] = useState("");
  const [profileStatus, setProfileStatus] = useState("");
  const [profileTone, setProfileTone] = useState<"info" | "ok" | "err">("info");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSettings(base)
      .then((settings) => {
        if (cancelled) return;
        setHubUrl(hubLabel(settings.hubUrl));
        setAgentId(settings.agentId);
        setHasToken(settings.hasToken);
      })
      .catch((caught: unknown) => {
        setTone("err");
        setStatus(caught instanceof Error ? caught.message : "读取设置失败");
      });
    getCodebuddy(base)
      .then((settings) => {
        if (cancelled) return;
        setModel(settings.model);
        setEnvironment(settings.environment);
        setHasApiKey(settings.hasApiKey);
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    getProfile(base)
      .then((value) => {
        if (cancelled) return;
        setRole(value.role);
        setIntroduction(value.introduction);
      })
      .catch(() => {
        if (!cancelled) setIntroduction("");
      });
    invoke<boolean>("autostart_enabled").then(setAutostart).catch(() => setAutostart(false));
    return () => {
      cancelled = true;
    };
  }, [base]);

  async function test() {
    setBusy(true);
    try {
      const result = await testHub(base, hubUrl, agentToken);
      if (!result.ok) throw new Error(result.reason || "连接失败");
      setTone("ok");
      setStatus("Hub 接受了这个令牌。");
    } catch (caught) {
      setTone("err");
      setStatus(caught instanceof Error ? caught.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setTone("info");
    setStatus("正在保存并重新连接…");
    try {
      await saveSettings(base, { hubUrl, agentId, ...(agentToken ? { agentToken } : {}) });
      await invoke("restart_agent");
      onRestart();
      setAgentToken("");
      setHasToken(true);
      setTone("ok");
      setStatus("已保存。Agent 正在用新配置重新连接 Hub。");
    } catch (caught) {
      setTone("err");
      setStatus(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveIntroduction() {
    setBusy(true);
    setProfileTone("info");
    setProfileStatus("正在保存自我介绍…");
    try {
      await saveProfile(base, { role, introduction });
      setProfileTone("ok");
      setProfileStatus("已保存，并推给 Hub。其他成员可以按角色标签找到这台电脑。");
    } catch (caught) {
      setProfileTone("err");
      setProfileStatus(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveModel() {
    setBusy(true);
    setModelTone("info");
    setModelStatus("正在保存 CodeBuddy 配置…");
    try {
      const saved = await saveCodebuddy(base, { model, environment, ...(apiKey ? { apiKey } : {}) });
      setApiKey("");
      setHasApiKey(saved.hasApiKey);
      setModelTone("ok");
      setModelStatus("已保存。之后新建或继续的对话会使用这个模型、密钥和类型。");
    } catch (caught) {
      setModelTone("err");
      setModelStatus(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <section className="space-y-3 rounded-2xl border border-line bg-panel p-5">
        <h2 className="text-sm font-medium">Hub 接入</h2>
        <Field label="Hub 地址">
          <Input value={hubUrl} onChange={(event) => setHubUrl(event.target.value)} spellCheck={false} />
        </Field>
        <Field label="成员 ID">
          <Input value={agentId} onChange={(event) => setAgentId(event.target.value)} spellCheck={false} />
        </Field>
        <Field label="Agent Token" hint={hasToken ? "已保存过令牌。留空表示不更换。" : "还没有令牌。"}>
          <Input value={agentToken} onChange={(event) => setAgentToken(event.target.value)} type="password" placeholder={hasToken ? "留空则不修改" : "nva_…"} />
        </Field>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => void test()}>测试连接</Button>
          <Button variant="accent" disabled={busy} onClick={() => void save()}>保存并重新连接</Button>
        </div>
        {status ? <p className={`text-xs leading-5 ${tone === "ok" ? "text-good" : tone === "err" ? "text-bad" : "text-muted"}`}>{status}</p> : null}
      </section>
      <section className="space-y-3 rounded-2xl border border-line bg-panel p-5">
        <h2 className="text-sm font-medium">给其他成员的介绍</h2>
        <Field label="角色标签" hint="稳定短名，例如 office-pc。智脑按这个标签找出办公电脑。">
          <Input value={role} onChange={(event) => setRole(event.target.value)} placeholder="office-pc" spellCheck={false} />
        </Field>
        <Field label="自我介绍" hint="写给其他 agent：这台机器是谁的、平时负责什么。">
          <textarea
            value={introduction}
            onChange={(event) => setIntroduction(event.target.value)}
            className="min-h-20 w-full rounded-lg border border-line-hi bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
          />
        </Field>
        <Button variant="accent" disabled={busy} onClick={() => void saveIntroduction()}>保存介绍</Button>
        {profileStatus ? <p className={`text-xs leading-5 ${profileTone === "ok" ? "text-good" : profileTone === "err" ? "text-bad" : "text-muted"}`}>{profileStatus}</p> : null}
      </section>
      <section className="space-y-3 rounded-2xl border border-line bg-panel p-5">
        <h2 className="text-sm font-medium">CodeBuddy</h2>
        <Field label="类型" hint="国内版选国内，国际版选国际。IOA 和云托管按账号所在环境选择。">
          <Select value={environment} onChange={(event) => setEnvironment(event.target.value as CodebuddySettings["environment"])}>
            <option value="internal">国内</option>
            <option value="external">国际</option>
            <option value="ioa">IOA</option>
            <option value="cloudhosted">云托管</option>
          </Select>
        </Field>
        <Field label="默认模型" hint="留空则使用账号自己的默认模型。">
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 hy4-preview" spellCheck={false} />
        </Field>
        <Field label="API Key" hint={hasApiKey ? "已保存密钥。留空表示不更换。" : "没有密钥时，会话会要求先登录 CodeBuddy。"}>
          <Input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={hasApiKey ? "留空则不修改" : "粘贴 API Key"} spellCheck={false} />
        </Field>
        <Button variant="accent" disabled={busy} onClick={() => void saveModel()}>保存模型配置</Button>
        {modelStatus ? <p className={`text-xs leading-5 ${modelTone === "ok" ? "text-good" : modelTone === "err" ? "text-bad" : "text-muted"}`}>{modelStatus}</p> : null}
      </section>
      <section className="flex items-center justify-between rounded-2xl border border-line bg-panel px-5 py-4">
        <div>
          <h2 className="text-sm font-medium">登录时启动</h2>
          <p className="mt-1 text-xs text-muted">开机后驻留在系统托盘，不打开主窗口。</p>
        </div>
        <Switch
          checked={autostart}
          label="登录时启动"
          onChange={(next) => {
            setAutostart(next);
            void invoke<boolean>("set_autostart", { enabled: next }).then(setAutostart).catch(() => setAutostart(!next));
          }}
        />
      </section>
    </div>
  );
}
