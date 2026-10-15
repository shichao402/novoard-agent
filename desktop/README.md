# Novoard Agent desktop host

该目录只包含 Windows/macOS 的 Tauri 2 宿主，不包含 Agent 业务逻辑或第二套产品页面。

运行关系：

1. Tauri 从安装包启动 `novoard-agent` SEA sidecar；
2. sidecar 以应用数据目录为工作目录，通过 stdout NDJSON 返回 setup/面板 URL；
3. Tauri WebView 导航到该 `127.0.0.1` URL；
4. 关窗只隐藏，托盘“退出”通过 stdin 请求 sidecar 完整停机。

`src-tauri/binaries/` 中的平台二进制由 `npm run desktop:stage` 生成并被 git 忽略。不要手工提交 sidecar，也不要把 Hub/UI token 放进桌面资源。

本地验证：

```bash
npm run build
npm run desktop:stage
npm run desktop:check
cd desktop && npx tauri build
```

本地 Node 若缺少 SEA fuse，先把 `NODE_SEA_BASE` 指向官方 Node 发行二进制。
