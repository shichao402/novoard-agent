use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

mod edition;

// Tauri bundler 将 externalBin 放到桌面主程序同目录；运行期只传最终 basename。
const SIDECAR_NAME: &str = "novoard-agent";
const MAX_RESTARTS: usize = 3;

struct Supervisor {
    child: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
    fatal: AtomicBool,
    restart_requested: AtomicBool,
    restart_attempts: AtomicUsize,
    open_on_ready: AtomicBool,
    /// 最近一次 ui-ready 事件。WebView 挂载晚于 sidecar 就绪时，靠它补发，避免永久卡在启动中。
    last_ready: Mutex<Option<HostEvent>>,
}

impl Supervisor {
    fn new(open_on_ready: bool) -> Arc<Self> {
        Arc::new(Self {
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
            fatal: AtomicBool::new(false),
            restart_requested: AtomicBool::new(false),
            restart_attempts: AtomicUsize::new(0),
            open_on_ready: AtomicBool::new(open_on_ready),
            last_ready: Mutex::new(None),
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEvent {
    #[serde(rename = "type")]
    kind: String,
    view: Option<String>,
    url: Option<String>,
    panel_url: Option<String>,
    code: Option<String>,
    message: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
}

pub fn run() {
    let context = tauri::generate_context!();
    let start_hidden = std::env::args().any(|arg| arg == "--autostart");
    let supervisor = Supervisor::new(!start_hidden);
    let state_for_setup = supervisor.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(state) = app.try_state::<Arc<Supervisor>>() {
                state.open_on_ready.store(true, Ordering::SeqCst);
            }
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--autostart")
                .app_name(edition::PRODUCT_NAME)
                .build(),
        )
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([Target::new(TargetKind::LogDir {
                    file_name: Some("host".into()),
                })])
                .rotation_strategy(RotationStrategy::KeepSome(5))
                .max_file_size(4_000_000)
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(supervisor.clone())
        .invoke_handler(tauri::generate_handler![
            read_logs,
            restart_agent,
            agent_endpoint,
            autostart_enabled,
            set_autostart,
            open_log_dir
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.set_title(edition::WINDOW_TITLE);
                if let Ok(icon) = tauri::image::Image::from_bytes(edition::WINDOW_ICON_PNG) {
                    let _ = window.set_icon(icon);
                }
            }
            let autostart_enabled = initialize_autostart(&handle);
            build_tray(&handle, state_for_setup.clone(), autostart_enabled)?;
            if !start_hidden {
                show_main_window(&handle);
            }

            #[cfg(target_os = "macos")]
            if start_hidden {
                let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            set_host_status(&handle, "正在启动本机 Agent 服务…", false);
            if let Err(error) = spawn_sidecar(handle.clone(), state_for_setup.clone()) {
                set_host_status(&handle, &error, true);
                show_main_window(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let quitting = window
                    .app_handle()
                    .state::<Arc<Supervisor>>()
                    .quitting
                    .load(Ordering::SeqCst);
                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                    static HINTED: AtomicBool = AtomicBool::new(false);
                    if !HINTED.swap(true, Ordering::SeqCst) {
                        if let Some(tray) = window.app_handle().tray_by_id("main") {
                            let _ = tray.set_tooltip(Some(format!(
                                "{} 仍在托盘里，双击图标打开",
                                edition::PRODUCT_NAME
                            )));
                        }
                    }
                    #[cfg(target_os = "macos")]
                    let _ = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
        })
        .build(context)
        .expect("构建 Novoard Agent 桌面壳失败");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let state = app.state::<Arc<Supervisor>>();
            if !state.quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                begin_quit(app.clone(), state.inner().clone());
            }
        }
    });
}

/// 安装包内随附的控制台静态资源（tauri.conf.json 的 resources["../dist/"] = "console-ui/"）。
/// 命中时由 sidecar 通过 NOVOARD_UI_DIST 指向它，浏览器直连控制台才有页面。
fn console_ui_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let staged = dir.join("console-ui");
        if staged.join("index.html").is_file() {
            return Some(staged);
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        if dev.join("index.html").is_file() {
            return Some(dev);
        }
    }
    None
}

fn chat_worker_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let staged = dir.join("agent-runtime").join("chat-worker.mjs");
        if staged.is_file() {
            return Some(staged);
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/chat-worker.mjs");
        if dev.is_file() {
            return Some(dev);
        }
    }
    None
}

fn spawn_sidecar(app: AppHandle, state: Arc<Supervisor>) -> Result<(), String> {
    if state
        .child
        .lock()
        .map_err(|_| "sidecar 状态锁损坏")?
        .is_some()
    {
        return Ok(());
    }

    let data_dir = desktop_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;

    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| format!("无法定位 Agent sidecar：{error}"))?
        .current_dir(&data_dir)
        .env("NOVOARD_HOST_PROTOCOL", "ndjson")
        .env("NOVOARD_DATA_DIR", &data_dir)
        .env("NOVOARD_UI_HOST", "127.0.0.1")
        .env("NOVOARD_UI_TOKEN", "")
        .env("NOVOARD_SETUP_PORT", edition::LOCAL_PORT)
        .env("NOVOARD_LOCAL_PORT", edition::LOCAL_PORT);
    let command = match chat_worker_path(&app) {
        Some(worker) => command.env("NOVOARD_CHAT_WORKER", worker),
        None => command,
    };
    let command = match console_ui_path(&app) {
        Some(ui) => command.env("NOVOARD_UI_DIST", ui),
        None => command,
    };
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("无法启动 Agent sidecar：{error}"))?;
    *state.child.lock().map_err(|_| "sidecar 状态锁损坏")? = Some(child);

    let app_for_events = app.clone();
    let state_for_events = state.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    handle_host_line(&app_for_events, &state_for_events, line.trim());
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        log::info!(target: "agent", "{line}");
                    }
                }
                CommandEvent::Error(error) => {
                    log::error!("sidecar I/O error: {error}");
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut child) = state_for_events.child.lock() {
                        child.take();
                    }
                    handle_terminated(
                        app_for_events.clone(),
                        state_for_events.clone(),
                        payload.code,
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn handle_host_line(app: &AppHandle, state: &Arc<Supervisor>, line: &str) {
    let event: HostEvent = match serde_json::from_str(line) {
        Ok(event) => event,
        Err(error) => {
            log::warn!("无法解析宿主事件：{error}: {line}");
            return;
        }
    };

    match event.kind.as_str() {
        "ui-ready" => {
            if event.url.is_none() {
                return;
            }
            state.fatal.store(false, Ordering::SeqCst);
            state.restart_attempts.store(0, Ordering::SeqCst);
            if let Ok(mut slot) = state.last_ready.lock() {
                *slot = Some(event.clone());
            }
            let _ = app.emit("agent-endpoint", &event);
            if state.open_on_ready.load(Ordering::SeqCst) {
                show_main_window(app);
            }
        }
        "fatal" => {
            state.fatal.store(true, Ordering::SeqCst);
            let code = event.code.unwrap_or_else(|| "agent-fatal".into());
            let message = event
                .message
                .unwrap_or_else(|| "Agent 服务发生致命错误".into());
            set_host_status(app, &format!("{message}（{code}）"), true);
            show_main_window(app);
        }
        "protocol-error" => {
            let message = event.message.unwrap_or_else(|| "宿主协议错误".into());
            set_host_status(app, &message, true);
        }
        _ => {}
    }
}

async fn handle_terminated(app: AppHandle, state: Arc<Supervisor>, code: Option<i32>) {
    if state.quitting.load(Ordering::SeqCst) {
        app.exit(code.unwrap_or(0));
        return;
    }
    if state.restart_requested.swap(false, Ordering::SeqCst) {
        set_host_status(&app, "正在重新启动 Agent 服务…", false);
        if let Err(error) = spawn_sidecar(app.clone(), state.clone()) {
            set_host_status(&app, &error, true);
            show_main_window(&app);
        }
        return;
    }
    if state.fatal.load(Ordering::SeqCst) {
        set_host_status(&app, "Agent 服务已停止，请检查配置后重新启动应用。", true);
        return;
    }

    let attempt = state.restart_attempts.fetch_add(1, Ordering::SeqCst) + 1;
    if attempt > MAX_RESTARTS {
        set_host_status(&app, "Agent 服务连续退出，已停止自动重启。", true);
        show_main_window(&app);
        return;
    }
    set_host_status(
        &app,
        &format!("Agent 服务意外退出，正在重启（{attempt}/{MAX_RESTARTS}）…"),
        true,
    );
    tokio::time::sleep(Duration::from_secs(1_u64 << (attempt - 1))).await;
    if let Err(error) = spawn_sidecar(app.clone(), state.clone()) {
        set_host_status(&app, &error, true);
    }
}

fn build_tray(
    app: &AppHandle,
    state: Arc<Supervisor>,
    autostart_enabled: bool,
) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "打开 Novoard").build(app)?;
    let chat = MenuItemBuilder::with_id("chat", "对话").build(app)?;
    let actions = MenuItemBuilder::with_id("actions", "快捷操作").build(app)?;
    let targets = MenuItemBuilder::with_id("targets", "Target").build(app)?;
    let logs = MenuItemBuilder::with_id("logs", "日志").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "设置").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "登录时启动")
        .checked(autostart_enabled)
        .build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重启 Agent 服务").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &chat, &actions, &targets, &logs, &settings])
        .separator()
        .item(&autostart)
        .item(&restart)
        .separator()
        .item(&quit)
        .build()?;

    let autostart_item: CheckMenuItem<_> = autostart.clone();
    let state_for_menu = state.clone();
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .icon(tauri::image::Image::from_bytes(edition::TRAY_ICON_PNG)?)
        .tooltip(edition::PRODUCT_NAME)
        // Windows 保留左键双击打开窗口；macOS 菜单栏沿用单击弹出菜单。
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => reveal(app, &state_for_menu, "home"),
            "chat" => reveal(app, &state_for_menu, "chat"),
            "actions" => reveal(app, &state_for_menu, "actions"),
            "targets" => reveal(app, &state_for_menu, "targets"),
            "logs" => reveal(app, &state_for_menu, "logs"),
            "settings" => reveal(app, &state_for_menu, "settings"),
            "autostart" => toggle_autostart(app, &autostart_item),
            "restart" => restart_sidecar(app, &state_for_menu),
            "quit" => begin_quit(app.clone(), state_for_menu.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(state) = app.try_state::<Arc<Supervisor>>() {
                    reveal(app, &state, "home");
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn restart_sidecar(app: &AppHandle, state: &Arc<Supervisor>) {
    if state.restart_requested.swap(true, Ordering::SeqCst) {
        return;
    }
    state.fatal.store(false, Ordering::SeqCst);
    state.restart_attempts.store(0, Ordering::SeqCst);
    set_host_status(app, "正在重启 Agent 服务…", false);
    let mut child_to_kill = None;
    let mut spawn_now = false;
    let mut graceful_request = false;
    match state.child.lock() {
        Ok(mut slot) => match slot.as_mut() {
            Some(child) => {
                if child.write(b"{\"v\":1,\"type\":\"shutdown\"}\n").is_ok() {
                    graceful_request = true;
                } else {
                    child_to_kill = slot.take();
                }
            }
            None => spawn_now = true,
        },
        Err(_) => {
            state.restart_requested.store(false, Ordering::SeqCst);
            set_host_status(app, "无法锁定 Agent 服务状态，重启失败。", true);
            return;
        }
    }

    if let Some(child) = child_to_kill {
        if let Err(error) = child.kill() {
            state.restart_requested.store(false, Ordering::SeqCst);
            set_host_status(app, &format!("无法终止 Agent 服务：{error}"), true);
        }
    } else if spawn_now {
        state.restart_requested.store(false, Ordering::SeqCst);
        if let Err(error) = spawn_sidecar(app.clone(), state.clone()) {
            set_host_status(app, &error, true);
        }
    }

    if graceful_request {
        let app = app.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if !state.restart_requested.load(Ordering::SeqCst) {
                return;
            }
            let child = match state.child.lock() {
                Ok(mut slot) => slot.take(),
                Err(_) => {
                    state.restart_requested.store(false, Ordering::SeqCst);
                    set_host_status(&app, "无法锁定 Agent 服务状态，强制重启失败。", true);
                    return;
                }
            };
            if let Some(child) = child {
                if let Err(error) = child.kill() {
                    state.restart_requested.store(false, Ordering::SeqCst);
                    set_host_status(&app, &format!("强制重启 Agent 服务失败：{error}"), true);
                }
            }
        });
    }
}

fn reveal(app: &AppHandle, state: &Arc<Supervisor>, view: &str) {
    state.open_on_ready.store(true, Ordering::SeqCst);
    let _ = app.emit("client-nav", serde_json::json!({ "view": view }));
    show_main_window(app);
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_host_status(app: &AppHandle, message: &str, is_error: bool) {
    if is_error {
        log::error!("{message}");
    } else {
        log::info!("{message}");
    }
    let _ = app.emit(
        "agent-status",
        serde_json::json!({ "message": message, "error": is_error }),
    );
}

fn initialize_autostart(app: &AppHandle) -> bool {
    // 开发构建不污染开发机登录项；安装后的 release 构建首次运行默认开启。
    if cfg!(debug_assertions) || std::env::var_os("NOVOARD_SKIP_AUTOSTART").is_some() {
        return app.autolaunch().is_enabled().unwrap_or(false);
    }
    let marker = desktop_data_dir(app)
        .ok()
        .map(|dir| dir.join(".autostart-initialized"));
    if let Some(path) = marker.as_ref() {
        if !path.exists() {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match app.autolaunch().enable() {
                Ok(()) => {
                    let _ = fs::write(path, b"enabled-by-default\n");
                }
                Err(error) => log::error!("默认启用登录自启失败：{error}"),
            }
        }
    }
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let manager = app.autolaunch();
    let next = !manager.is_enabled().unwrap_or(false);
    let result = if next {
        manager.enable()
    } else {
        manager.disable()
    };
    match result {
        Ok(()) => {
            let _ = item.set_checked(next);
        }
        Err(error) => {
            log::error!("切换登录自启失败：{error}");
            let _ = item.set_checked(!next);
        }
    }
}

fn begin_quit(app: AppHandle, state: Arc<Supervisor>) {
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    set_host_status(&app, "正在停止 Agent 服务…", false);
    let wrote_shutdown = state
        .child
        .lock()
        .ok()
        .and_then(|mut child| {
            child
                .as_mut()
                .map(|child| child.write(b"{\"v\":1,\"type\":\"shutdown\"}\n").is_ok())
        })
        .unwrap_or(false);
    if !wrote_shutdown {
        app.exit(0);
        return;
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Ok(mut child) = state.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
        app.exit(0);
    });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogPage {
    page: u32,
    page_size: u32,
    max_pages: u32,
    total_pages: u32,
    total: u32,
    lines: Vec<LogRow>,
}

#[derive(serde::Serialize)]
struct LogRow {
    ts: String,
    level: String,
    msg: String,
}

const LOG_PAGE_SIZE: usize = 50;
const LOG_PAGE_SIZE_MAX: u32 = 200;
const LOG_MAX_PAGES: usize = 20;
const LOG_TAIL_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
fn read_logs(
    app: AppHandle,
    page: Option<u32>,
    page_size: Option<u32>,
    level: Option<String>,
    query: Option<String>,
) -> Result<LogPage, String> {
    let mut rows = Vec::new();
    if let Ok(dir) = desktop_data_dir(&app) {
        push_log_rows(&mut rows, &dir.join("logs").join("agent.jsonl"));
    }
    if let Ok(dir) = app.path().app_log_dir() {
        push_log_rows(&mut rows, &dir.join("host.log"));
    }
    page_log_rows(rows, page, page_size, level, query)
}

fn page_log_rows(
    mut rows: Vec<LogRow>,
    page: Option<u32>,
    page_size: Option<u32>,
    level: Option<String>,
    query: Option<String>,
) -> Result<LogPage, String> {
    let size = page_size.unwrap_or(LOG_PAGE_SIZE as u32).clamp(1, LOG_PAGE_SIZE_MAX) as usize;
    let wanted = level.unwrap_or_else(|| "all".into()).to_ascii_lowercase();
    let needle = query.unwrap_or_default().trim().to_ascii_lowercase();
    rows.retain(|row| {
        (wanted == "all" || row.level == wanted)
            && (needle.is_empty() || row.msg.to_ascii_lowercase().contains(&needle))
    });
    rows.sort_by(|left, right| match (left.ts.is_empty(), right.ts.is_empty()) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => right.ts.cmp(&left.ts),
    });
    let window = LOG_PAGE_SIZE * LOG_MAX_PAGES;
    rows.truncate(window);
    let total = rows.len();
    let total_pages = total.div_ceil(size).max(1);
    let mut current = page.unwrap_or(1).max(1) as usize;
    if current > total_pages {
        current = total_pages;
    }
    let start = (current - 1) * size;
    let lines = rows.into_iter().skip(start).take(size).collect();
    Ok(LogPage {
        page: current as u32,
        page_size: size as u32,
        max_pages: (LOG_PAGE_SIZE * LOG_MAX_PAGES).div_ceil(size) as u32,
        total_pages: total_pages as u32,
        total: total as u32,
        lines,
    })
}

fn push_log_rows(out: &mut Vec<LogRow>, path: &Path) {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut text = String::new();
    if file.read_to_string(&mut text).is_err() {
        return;
    }
    let mut chunk: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    if start > 0 {
        chunk.drain(..1.min(chunk.len()));
    }
    for line in chunk {
        if let Some(row) = parse_log_line(line) {
            out.push(row);
        }
    }
}

fn parse_log_line(line: &str) -> Option<LogRow> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
        if let Some(msg) = value
            .get("msg")
            .and_then(|item| item.as_str())
            .or_else(|| value.get("message").and_then(|item| item.as_str()))
        {
            return Some(LogRow {
                ts: value.get("ts").and_then(|item| item.as_str()).unwrap_or("").to_string(),
                level: value
                    .get("level")
                    .and_then(|item| item.as_str())
                    .unwrap_or("info")
                    .to_ascii_lowercase(),
                msg: msg.to_string(),
            });
        }
    }
    if let Some(row) = parse_host_line(line) {
        return Some(row);
    }
    Some(LogRow {
        ts: String::new(),
        level: "info".into(),
        msg: line.to_string(),
    })
}

fn parse_host_line(line: &str) -> Option<LogRow> {
    let rest = line.strip_prefix('[')?;
    let (date, rest) = rest.split_once("][")?;
    let (time, rest) = rest.split_once("][")?;
    let (level, msg) = rest.split_once(']')?;
    let level = level.trim().to_ascii_lowercase();
    if !matches!(level.as_str(), "info" | "warn" | "error" | "debug" | "trace") {
        return None;
    }
    Some(LogRow {
        ts: format!("{date} {time}"),
        level,
        msg: msg.trim().to_string(),
    })
}

#[tauri::command]
fn restart_agent(app: AppHandle, state: tauri::State<'_, Arc<Supervisor>>) -> Result<(), String> {
    restart_sidecar(&app, state.inner());
    Ok(())
}

/// WebView 挂载时机可能晚于 sidecar 就绪。前端挂载后调用本命令补取已缓存的
/// ui-ready，避免事件丢失导致界面永久停在「正在启动」。
#[tauri::command]
fn agent_endpoint(state: tauri::State<'_, Arc<Supervisor>>) -> Option<HostEvent> {
    state.last_ready.lock().ok().and_then(|slot| slot.clone())
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    Ok(manager.is_enabled().unwrap_or(enabled))
}

#[tauri::command]
fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = desktop_data_dir(&app)?.join("logs");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建日志目录：{error}"))?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|error| format!("无法打开日志目录：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|error| format!("无法打开日志目录：{error}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|error| format!("无法打开日志目录：{error}"))?;
    }
    Ok(())
}

fn desktop_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("NOVOARD_DESKTOP_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ui_ready_event() {
        let event: HostEvent = serde_json::from_str(
            r#"{"v":1,"type":"ui-ready","view":"panel","url":"http://127.0.0.1:1","panelUrl":"http://127.0.0.1:1"}"#,
        )
        .unwrap();
        assert_eq!(event.kind, "ui-ready");
        assert_eq!(event.view.as_deref(), Some("panel"));
        assert_eq!(event.panel_url.as_deref(), Some("http://127.0.0.1:1"));
    }

    #[test]
    fn log_pages_stop_at_twenty_and_page_one_is_newest() {
        let first = page_log_rows(
            (0..1010)
                .map(|index| LogRow {
                    ts: format!("2026-01-01T00:00:00.{index:04}"),
                    level: "info".into(),
                    msg: format!("event {index}"),
                })
                .collect(),
            Some(99),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(first.max_pages, 20);
        assert_eq!(first.total_pages, 20);
        assert_eq!(first.page, 20);
        let newest = page_log_rows(
            (0..1010)
                .map(|index| LogRow {
                    ts: format!("2026-01-01T00:00:00.{index:04}"),
                    level: "info".into(),
                    msg: format!("event {index}"),
                })
                .collect(),
            Some(1),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(newest.lines[0].msg, "event 1009");
        let host = parse_log_line("[2026-10-17][03:00:00][WARN] host line").unwrap();
        assert_eq!(host.level, "warn");
        assert_eq!(host.msg, "host line");
    }
}
