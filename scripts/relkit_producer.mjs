/**
 * relkit artifact-producer（relkit.project.json → artifactProducer）。
 *
 * stdin ：relkit.artifact-producer-input/2（product / version / channel / target / outputDirectory）
 * stdout：relkit.artifact-set/1，且只能输出这一份 JSON；所有构建日志走 stderr。
 *
 * 每个 target 产出一对制品：
 *   installer：Windows NSIS setup.exe / macOS dmg（首次安装与手动兜底）
 *   payload  ：安装后目录树的 relkit payload（IN_PLACE 自动更新用，payloadOf → installer）
 *     Windows：NSIS 静默装到临时目录，去掉 uninstall.exe 后打包（只允许在 CI 跑，会写 HKCU）
 *     macOS  ：直接把 .app 打包，相对路径即 Contents/...
 *
 * 渠道决定档位：stable → release 档，dev → dev 档（不同 identifier / 端口 / 安装目录）。
 * releaseCode 取 version 末尾的 +N，与 bootstrap 一起经环境变量编进桌面壳（build.rs）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseMatches, bakeEdition, tauriOverlay } from "./edition.mjs";
import { nsisSilentCommand } from "./nsis-silent.mjs";
import { editionForChannel, releaseCodeFromVersion } from "./relkit-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");
const SRC_TAURI = join(DESKTOP, "src-tauri");
const PRODUCT = "novoard-agent";
const INPUT_SCHEMA = "relkit.artifact-producer-input/2";
const OUTPUT_SCHEMA = "relkit.artifact-set/1";

export const TARGETS = {
  "windows-amd64": { triple: "x86_64-pc-windows-msvc", platform: "win32", arch: "x64", bundles: "nsis" },
  "darwin-arm64": { triple: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", bundles: "app,dmg" },
  "darwin-amd64": { triple: "x86_64-apple-darwin", platform: "darwin", arch: "x64", bundles: "app,dmg" },
};

export function validateInput(input) {
  if (input?.schema !== INPUT_SCHEMA) throw new Error(`输入 schema 应为 ${INPUT_SCHEMA}，实际 ${input?.schema}`);
  if (input.product !== PRODUCT) throw new Error(`product 应为 ${PRODUCT}，实际 ${input.product}`);
  const target = TARGETS[input.target];
  if (!target) throw new Error(`不支持的 target ${input.target}（可选：${Object.keys(TARGETS).join("、")}）`);
  if (!input.outputDirectory) throw new Error("缺少 outputDirectory");
  return {
    ...target,
    target: input.target,
    version: input.version,
    channel: input.channel,
    edition: editionForChannel(input.channel),
    code: releaseCodeFromVersion(input.version),
    outputDirectory: input.outputDirectory,
  };
}

/** 制品文件名不带空格和 `+`，并带上 target，merge 后全局唯一。 */
export function artifactNames({ semver, code, target, edition }) {
  const stem = `${edition === "dev" ? "novoard-agent-dev" : "novoard-agent"}-${semver}-${code}-${target}`;
  return {
    installer: target.startsWith("windows") ? `${stem}-setup.exe` : `${stem}.dmg`,
    payload: `${stem}.payload.zip`,
  };
}

function log(message) {
  process.stderr.write(`[relkit-producer] ${message}\n`);
}

function run(file, args, { cwd = ROOT, env = process.env } = {}) {
  log(`$ ${[file, ...args].join(" ")}`);
  const result = spawnSync(file, args, { cwd, env, stdio: ["ignore", 2, 2] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`命令失败（退出码 ${result.status}）：${file} ${args.join(" ")}`);
}

function capture(file, args) {
  const result = spawnSync(file, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", 2] });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function single(dir, predicate, label) {
  const hits = existsSync(dir) ? readdirSync(dir).filter(predicate) : [];
  if (hits.length !== 1) throw new Error(`${dir} 下应恰有一个${label}，实际：${hits.join("、") || "无"}`);
  return join(dir, hits[0]);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function describe(outputDirectory, name, fields) {
  const path = join(outputDirectory, name);
  return { ...fields, path: name, sha256: await sha256(path), size: statSync(path).size };
}

function changelog(channel, version) {
  let range = ["-20"];
  if (channel === "stable") {
    const previous = capture("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD^"]);
    if (previous) range = [`${previous}..HEAD`];
  }
  const lines = capture("git", ["log", "--no-merges", "--format=- %s", ...range]);
  return lines || `- ${version}`;
}

function relkitCli() {
  const cli = process.env.RELKIT_CLI || join(ROOT, ".relkit", "tools", process.platform === "win32" ? "relkit.exe" : "relkit");
  if (!existsSync(cli)) throw new Error(`缺少 relkit CLI：${cli}（CI 先用 scripts/relkit_tool.py 取回）`);
  return cli;
}

function buildPayload(cli, tree, out) {
  run(cli, ["payload", "build", "--tree", tree, "--out", out]);
}

function installNsisForPayload(installer) {
  if (!process.env.CI) {
    throw new Error("Windows payload 需要静默安装 NSIS（会改写 HKCU 安装记录），只允许在 CI 中运行");
  }
  const destination = mkdtempSync(join(tmpdir(), "novoard-payload-"));
  log(`静默安装到 ${destination}`);
  const result = spawnSync(process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", nsisSilentCommand(installer, destination)], {
    stdio: ["ignore", 2, 2],
    windowsVerbatimArguments: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`NSIS 静默安装失败，退出码 ${result.status ?? "无"}`);
  // uninstall.exe 属于安装器，不属于应用文件；交给 NSIS 自己维护。
  rmSync(join(destination, "uninstall.exe"), { force: true });
  return destination;
}

export async function produce(input) {
  const job = validateInput(input);
  if (process.platform !== job.platform) {
    throw new Error(`target ${job.target} 必须在 ${job.platform} 上构建，当前是 ${process.platform}`);
  }
  const bootstrap = join(ROOT, ".relkit", "runtime-bootstrap.json");
  if (!existsSync(bootstrap)) {
    throw new Error(`缺少 ${bootstrap}；先执行 relkit bootstrap build`);
  }
  const cli = relkitCli();
  mkdirSync(job.outputDirectory, { recursive: true });

  const env = {
    ...process.env,
    NOVOARD_EDITION: job.edition,
    NOVOARD_RELEASE_CODE: String(job.code),
    NOVOARD_RELEASE_VERSION: job.version,
    NOVOARD_RELKIT_BOOTSTRAP: bootstrap,
    NOVOARD_RELKIT_OFFLINE: "1",
    NOVOARD_BUILD_PLATFORM: job.platform,
    NOVOARD_BUILD_ARCH: job.arch,
    TAURI_TARGET_TRIPLE: job.triple,
  };

  const tauriConf = JSON.parse(readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8"));
  assertReleaseMatches(tauriConf);
  const semver = tauriConf.version;
  const names = artifactNames({ semver, code: job.code, target: job.target, edition: job.edition });
  const bundleRoot = join(SRC_TAURI, "target", job.triple, "release", "bundle");

  try {
    const edition = bakeEdition({ NOVOARD_EDITION: job.edition });
    const tauriArgs = [join(DESKTOP, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build", "--ci", "--target", job.triple, "--bundles", job.bundles];
    if (job.edition === "dev") {
      const overlayPath = join(SRC_TAURI, "target", "edition-overlay.json");
      mkdirSync(dirname(overlayPath), { recursive: true });
      writeFileSync(overlayPath, JSON.stringify(tauriOverlay(edition, tauriConf), null, 2));
      tauriArgs.push("--config", "src-tauri/target/edition-overlay.json");
    }
    log(`构建 ${edition.productName} ${job.version}（${job.channel} / ${job.target}）`);
    run(process.execPath, ["scripts/build-agent.mjs"], { env });
    run(process.execPath, ["scripts/stage-agent-runtime.mjs"], { env });
    run(process.execPath, ["scripts/stage-desktop-sidecar.mjs"], { env });
    rmSync(bundleRoot, { recursive: true, force: true });
    run(process.execPath, tauriArgs, { cwd: DESKTOP, env });

    const installerPath = join(job.outputDirectory, names.installer);
    const payloadPath = join(job.outputDirectory, names.payload);
    if (job.platform === "win32") {
      const setup = single(join(bundleRoot, "nsis"), (name) => name.endsWith("-setup.exe"), " NSIS 安装包");
      writeFileSync(installerPath, readFileSync(setup));
      const tree = installNsisForPayload(setup);
      try {
        buildPayload(cli, tree, payloadPath);
      } finally {
        rmSync(tree, { recursive: true, force: true });
      }
    } else {
      const dmg = single(join(bundleRoot, "dmg"), (name) => name.endsWith(".dmg"), " dmg");
      const app = single(join(bundleRoot, "macos"), (name) => name.endsWith(".app"), " .app");
      writeFileSync(installerPath, readFileSync(dmg));
      buildPayload(cli, app, payloadPath);
    }
  } finally {
    bakeEdition({ NOVOARD_EDITION: "release" });
  }

  const selectors = { "os-arch": job.target };
  const installerId = `installer-${job.target}`;
  const artifacts = [
    await describe(job.outputDirectory, names.installer, {
      id: installerId,
      kind: "installer",
      platform: job.target,
      selectors,
    }),
    await describe(job.outputDirectory, names.payload, {
      id: `payload-${job.target}`,
      kind: "payload",
      platform: job.target,
      selectors,
      relations: { payloadOf: installerId },
    }),
  ];
  return {
    schema: OUTPUT_SCHEMA,
    product: PRODUCT,
    version: job.version,
    releaseCode: job.code,
    channel: job.channel,
    changelog: changelog(job.channel, job.version),
    artifacts,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = await produce(JSON.parse(await readStdin()));
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    log(`失败：${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
