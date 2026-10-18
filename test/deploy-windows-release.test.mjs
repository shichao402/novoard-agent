import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadEditions } from "../scripts/edition.mjs";
import { isDirectRun, nsisArch, nsisSetupFileName, nsisSilentArgs, nsisSilentCommand } from "../scripts/deploy-windows-release.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/deploy-windows-release.mjs", import.meta.url));

test("正式版安装包文件名与 Tauri NSIS 产物一致", () => {
  assert.equal(nsisArch("x64"), "x64");
  assert.equal(nsisArch("arm64"), "arm64");
  assert.equal(nsisArch("ia32"), "x86");
  assert.throws(() => nsisArch("ppc"), /不支持架构/);
  assert.equal(
    nsisSetupFileName("Novoard Agent", "0.3.2", "x64"),
    "Novoard Agent_0.3.2_x64-setup.exe",
  );
});

test("静默安装只传 /S，并用 /D 固定到正式版目录", () => {
  const destination = "C:\\Users\\me\\AppData\\Local\\Novoard Agent";
  const installer = "C:\\bundle\\Novoard Agent_0.3.2_x64-setup.exe";
  assert.deepEqual(nsisSilentArgs(destination), ["/S", `/D=${destination}`]);
  assert.equal(
    nsisSilentCommand(installer, destination),
    `""${installer}" /S /D=${destination}"`,
  );
});

test("开发版安装包用产品名，静默目录用目录名加 Dev", () => {
  const { release, dev } = loadEditions();
  const destination = `C:\\Users\\me\\AppData\\Local\\${dev.installDirName}`;
  assert.equal(dev.installDirName, `${release.installDirName}Dev`);
  assert.notEqual(dev.installDirName, dev.productName);
  assert.equal(
    nsisSetupFileName(dev.productName, "0.3.2", "x64"),
    "Novoard Agent Dev_0.3.2_x64-setup.exe",
  );
  assert.deepEqual(nsisSilentArgs(destination), ["/S", `/D=${destination}`]);
});

test("只有直接运行部署脚本时才安装", () => {
  assert.equal(isDirectRun(scriptPath), true);
  assert.equal(isDirectRun("test/deploy-windows-release.test.mjs"), false);
});
