import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Field, Input, Select } from "../src/components/ui/input";
import { InputsDialog } from "../src/components/inputs-dialog";
import "../src/index.css";

const branchChoices = [
  { value: "OSTY_S2_20261116", hint: "常驻，就绪", usage: { count: 12, lastUsedAt: Date.now() } },
  { value: "trunk", hint: "常驻，就绪" },
  { value: "OSPub_S2_20261106", hint: "阻塞：Pre-existing SVN conflict in GameCore.stable preserved during adoption" },
  ...Array.from({ length: 80 }, (_, i) => ({ value: `OSDev_feature_${i}`, hint: "最近提交，需切换" })),
];
window.fetch = async () => new Response(JSON.stringify({ ok: true, inputs: [{ name: "branch", label: "分支", default: "OSTY_S2_20261116", required: true, allowCustom: true, dynamic: true, choices: branchChoices }] }), { headers: { "Content-Type": "application/json" } });
const launchTarget = { id: "open", title: "OSG 精简池 · 开分支" };

function Demo() {
  const [value, setValue] = useState("svn");
  const [target, setTarget] = useState<typeof launchTarget | null>(null);
  const [submitted, setSubmitted] = useState(0);
  return <main className="h-full overflow-auto p-8">
    <h1 className="mb-6 text-xl">统一可筛选下拉</h1>
    <form className="max-w-md space-y-4" onSubmit={(event) => { event.preventDefault(); setSubmitted((old) => old + 1); }}>
      <Field label="工具"><Select name="tool" value={value} allowCustom onChange={(event) => setValue(event.target.value)}>
        <option value="svn">SVN 更新</option><option value="disabled" disabled>禁用工具</option><option value="unity" title="打开工程">Unity</option><option value="rider">Rider</option>
      </Select></Field>
      <Field label="后续输入"><Input aria-label="后续输入" /></Field>
      <Field label="禁用下拉"><Select disabled><option value="x">不可选择</option></Select></Field>
      <Field label="非受控下拉"><Select name="plain" defaultValue="b"><option value="a">Alpha</option><option value="b">Beta</option></Select></Field>
      <div id="selected">当前值：{value}</div><div id="submitted">提交次数：{submitted}</div>
      <button type="button" id="open-dialog" className="rounded-lg border border-line-hi px-3 py-2" onClick={() => setTarget(launchTarget)}>打开分支参数弹窗</button>
    </form>
    <pre id="checks" role="status" aria-live="polite" className="mt-6 whitespace-pre-wrap text-sm text-good">正在自动验证…</pre>
    <InputsDialog base="http://test.invalid" target={target} onClose={() => setTarget(null)} onSubmit={() => { setSubmitted((old) => old + 1); setTarget(null); }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Demo />);

const results: string[] = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
function report(text: string) { const element = document.getElementById("checks")!; element.textContent = text; element.setAttribute("aria-label", text.split("\n").at(-1)!); }
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); results.push(`通过：${message}`); report(results.join("\n")); };
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="工具"]')!;
const search = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const key = (name: string) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
async function type(text: string) {
  const element = search();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
}
async function checks() {
  await pause();
  trigger().click(); await pause();
  assert(document.activeElement === search(), "打开后自动聚焦筛选输入");
  await type("uNiTy");
  assert(options().length === 1 && options()[0].textContent!.includes("Unity"), "大小写无关筛选普通下拉");
  options()[0].click(); await pause();
  assert(document.getElementById("selected")!.textContent === "当前值：unity", "原生 change 回调保留准确值");
  assert(new FormData(document.querySelector("form")!).get("tool") === "unity", "原生表单值保持一致");
  trigger().click(); await pause(); await type("custom-branch");
  assert(options().length === 0, "无匹配显示空列表");
  key("Enter"); await pause();
  assert(document.getElementById("selected")!.textContent === "当前值：custom-branch", "Enter 可选择自定义值");
  trigger().click(); await pause(); key("Escape"); await pause();
  assert(!search() && document.activeElement === trigger(), "Esc 关闭并还原触发器焦点");
  trigger().click(); await pause(); key("ArrowDown"); key("Enter"); await pause();
  assert(document.getElementById("selected")!.textContent !== "当前值：disabled", "键盘跳过禁用选项");
  trigger().click(); await pause(); key("Tab"); await pause();
  assert(document.activeElement?.getAttribute("aria-label") === "后续输入", "Tab 转移到后续字段");
  assert(document.getElementById("submitted")!.textContent === "提交次数：0", "选择和 Enter 不误提交表单");
  const plain = document.querySelector<HTMLButtonElement>('button[aria-label="非受控下拉"]')!;
  plain.click(); await pause(); options()[0].click(); await pause();
  assert(plain.textContent!.includes("Alpha") && new FormData(document.querySelector("form")!).get("plain") === "a", "非受控下拉保留默认值和选择行为");
  document.getElementById("open-dialog")!.click(); await pause(); await pause();
  document.querySelector<HTMLButtonElement>('button[aria-label="分支"]')!.click(); await pause();
  assert(options()[1].textContent!.includes("OSTY_S2") && options()[1].textContent!.includes("12 次"), "分支显示最近常用首项与次数");
  await type("feature 79");
  assert(options().length === 1 && options()[0].textContent!.includes("feature_79"), "大量候选支持多关键词交集筛选");
  options()[0].click(); await pause();
  assert(document.querySelector('[role="dialog"]') && !search(), "选中不会关闭外层参数弹窗");
  const branch = document.querySelector<HTMLButtonElement>('button[aria-label="分支"]')!;
  assert(branch.textContent!.includes("feature_79"), "参数选择回显准确");
  branch.click(); await pause(); await type("SVN conflict");
  assert(options().length === 1 && options()[0].textContent!.includes("阻塞"), "状态与长提示也可筛选");
  assert(document.querySelector('[role="listbox"]')!.getBoundingClientRect().bottom <= window.innerHeight, "列表在窗口内且可滚动");
  key("Escape"); await pause();
  document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button').forEach((button) => { if (button.textContent === "取消") button.click(); });
  await pause();
  assert(document.getElementById("submitted")!.textContent === "提交次数：0", "取消参数弹窗不触发运行");
  report(`${results.join("\n")}\n全部 ${results.length} 项通过`);
}
checks().catch((error) => { report(`${results.join("\n")}\n失败：${error.message}`); });
