// PRD-7 A8：能力包仓库 git 凭据（只在 agent 本机，按 URL 前缀匹配）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitAuth, defaultUsername, matchCredential, normalizePrefix } from "../src/packs/git-auth.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const tmp = () => mkdtempSync(join(tmpdir(), "novoard-gitauth-"));

test("前缀规范化：只收 https/http，去尾 / 与 .git，host 小写，拒绝内嵌账号", () => {
  assert.equal(normalizePrefix("https://Git.Example.com/Team/"), "https://git.example.com/Team");
  assert.equal(normalizePrefix("https://github.com/x/repo.git"), "https://github.com/x/repo");
  for (const bad of ["git@github.com:x/repo.git", "ssh://git@h/x", "https://u:p@h/x", "not a url", ""]) {
    assert.throws(() => normalizePrefix(bad), (e) => e.code === "invalid-git-credential", bad);
  }
  assert.equal(defaultUsername("https://github.com/x"), "x-access-token");
  assert.equal(defaultUsername("https://git.woa.com/x"), "oauth2");
});

test("匹配：按路径段前缀、取最长；不同 host 或半段不命中；ssh 地址不命中", () => {
  const entries = [
    { url: "https://git.example.com", username: "u", token: "host" },
    { url: "https://git.example.com/team", username: "u", token: "team" },
    { url: "https://git.example.com/team/special", username: "u", token: "repo" },
  ];
  const hit = (u) => matchCredential(entries, u)?.token ?? null;
  assert.equal(hit("https://git.example.com/team/special.git"), "repo");
  assert.equal(hit("https://GIT.example.com/team/other.git"), "team");
  assert.equal(hit("https://git.example.com/teamx/r.git"), "host", "teamx 不是 team 的子路径");
  assert.equal(hit("https://other.example.com/team/r.git"), null);
  assert.equal(hit("git@git.example.com:team/r.git"), null);
});

test("存储：0600、列表脱敏、留空 token 沿用、改地址、删除", () => {
  const file = join(tmp(), "git-credentials.json");
  const auth = createGitAuth({ file, log: quiet });
  assert.throws(() => auth.upsert({ url: "https://h/x" }), /token 不能为空/);
  assert.deepEqual(auth.upsert({ url: "https://h/x/", token: "abcdef1234" }), { url: "https://h/x", username: "oauth2", tokenLastFour: "1234" });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  auth.upsert({ url: "https://h/x", username: "bot", token: "" });
  const reopened = createGitAuth({ file, log: quiet });
  assert.deepEqual(reopened.list(), [{ url: "https://h/x", username: "bot", tokenLastFour: "1234" }]);
  assert.ok(!JSON.stringify(reopened.list()).includes("abcdef"), "列表不含 token");
  reopened.upsert({ url: "https://h/y", originalUrl: "https://h/x", token: "" });
  assert.deepEqual(reopened.list().map((c) => c.url), ["https://h/y"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).credentials[0].token, "abcdef1234");
  assert.equal(reopened.remove("https://h/y"), true);
  assert.equal(reopened.remove("https://h/y"), false);
});

test("envFor：总是清空本机 helper 并禁止交互；接在已有 GIT_CONFIG_COUNT 之后；未命中不带头", () => {
  const auth = createGitAuth({ log: quiet });
  auth.upsert({ url: "https://github.com/me", token: "t0k" });
  const env = auth.envFor("https://github.com/me/packs.git", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" });
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "a.b");
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
  assert.equal(env.GIT_CONFIG_KEY_2, "http.https://github.com/me/packs.git.extraHeader");
  assert.equal(env.GIT_CONFIG_VALUE_2, `Authorization: Basic ${Buffer.from("x-access-token:t0k").toString("base64")}`);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
  const miss = auth.envFor("https://github.com/someone-else/r.git", {});
  assert.equal(miss.GIT_CONFIG_COUNT, "1");
  assert.equal(miss.GIT_CONFIG_KEY_0, "credential.helper");
});

test("控制台接口：GET 脱敏列表，PUT 保存，DELETE 删除，跨源写被拒", async () => {
  const { createLocalA2A } = await import("../src/local-a2a.mjs");
  const gitAuth = createGitAuth({ file: join(tmp(), "git-credentials.json"), log: quiet });
  const audits = [];
  const local = createLocalA2A({ targets: {}, runtime: { launch: () => ({ ok: true }) }, audit: (e) => audits.push(e), log: quiet, gitAuth });
  const { port } = await local.start();
  const base = `http://127.0.0.1:${port}/api/git-credentials`;
  try {
    const put = (body, headers = {}) => fetch(base, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await put({ url: "https://h/x", token: "secret99" }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await put({ url: "git@h:x", token: "secret99" })).status, 400);
    const saved = await (await put({ url: "https://h/x", token: "secret99" })).json();
    assert.deepEqual(saved.credential, { url: "https://h/x", username: "oauth2", tokenLastFour: "et99" });
    const listed = await (await fetch(base)).json();
    assert.deepEqual(listed.credentials, [saved.credential]);
    const del = await (await fetch(`${base}?url=${encodeURIComponent("https://h/x")}`, { method: "DELETE" })).json();
    assert.equal(del.removed, true);
    assert.ok(!JSON.stringify(audits).includes("secret99"), "审计不含 token");
  } finally {
    await local.close();
  }
});
