use serde::Deserialize;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

// Tauri bundler 将 externalBin 放到桌面主程序同目录；运行期只传最终 basename。
const SIDECAR_NAME: &str = "novoard-agent";
const MAX_RESTARTS: usize = 3;

#[derive(Default)]
struct UiUrls {
    current: Option<String>,
    panel: Option<String>,
    editor: Option<String>,
}

struct Supervisor {
    child: Mutex<Option<CommandChild>>,
    urls: Mutex<UiUrls>,
    quitting: AtomicBool,
    fatal: AtomicBool,
    restart_requested: AtomicBool,
    restart_attempts: AtomicUsize,
    open_on_ready: AtomicBool,
}

impl Supervisor {
    fn new(open_on_ready: bool) -> Arc<Self> {
        Arc::new(Self {
            child: Mutex::new(None),
            urls: Mutex::new(UiUrls::default()),
            quitting: AtomicBool::new(false),
            fatal: AtomicBool::new(false),
            restart_requested: AtomicBool::new(false),
            restart_attempts: AtomicUsize::new(0),
            open_on_ready: AtomicBool::new(open_on_ready),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostEvent {
    #[serde(rename = "type")]
    kind: String,
    view: Option<String>,
    url: Option<String>,
    panel_url: Option<String>,
    editor_url: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

pub fn run() {
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
                .app_name("Novoard Agent")
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .manage(supervisor.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let autostart_enabled = initialize_autostart(&handle);
            build_tray(&handle, state_for_setup.clone(), autostart_enabled)?;

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
                    #[cfg(target_os = "macos")]
                    let _ = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
        })
        .build(tauri::generate_context!())
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
        .env("NOVOARD_SETUP_PORT", "0");
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
                    eprintln!("[agent] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Error(error) => {
                    eprintln!("[agent] sidecar I/O error: {error}");
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
            eprintln!("[agent] 无法解析宿主事件：{error}: {line}");
            return;
        }
    };

    match event.kind.as_str() {
        "ui-ready" => {
            let Some(url) = event.url else {
                return;
            };
            {
                let mut urls = state.urls.lock().expect("UI URL 状态锁损坏");
                urls.current = Some(url.clone());
                if event.view.as_deref() == Some("panel") {
                    urls.panel = event.panel_url.or_else(|| Some(url.clone()));
                    urls.editor = event.editor_url;
                }
            }
            state.fatal.store(false, Ordering::SeqCst);
            state.restart_attempts.store(0, Ordering::SeqCst);
            navigate(app, &url);
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
    let editor = MenuItemBuilder::with_id("editor", "打开 Target 编辑器").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "登录时启动")
        .checked(autostart_enabled)
        .build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重启 Agent 服务").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &editor])
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
        .tooltip("Novoard Agent")
        // Windows 保留左键双击打开窗口；macOS 菜单栏沿用单击弹出菜单。
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => open_panel(app, &state_for_menu),
            "editor" => open_editor(app, &state_for_menu),
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
                    open_panel(app, &state);
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

fn open_panel(app: &AppHandle, state: &Arc<Supervisor>) {
    state.open_on_ready.store(true, Ordering::SeqCst);
    let url = state
        .urls
        .lock()
        .ok()
        .and_then(|urls| urls.panel.clone().or_else(|| urls.current.clone()));
    if let Some(url) = url {
        navigate(app, &url);
    }
    show_main_window(app);
}

fn open_editor(app: &AppHandle, state: &Arc<Supervisor>) {
    state.open_on_ready.store(true, Ordering::SeqCst);
    let url = state.urls.lock().ok().and_then(|urls| urls.editor.clone());
    if let Some(url) = url {
        navigate(app, &url);
    }
    show_main_window(app);
}

fn navigate(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match url.parse::<Url>() {
        Ok(url) => {
            if let Err(error) = window.navigate(url) {
                eprintln!("窗口导航失败：{error}");
            }
        }
        Err(error) => eprintln!("Agent 返回无效 URL：{error}"),
    }
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
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let message = serde_json::to_string(message).unwrap_or_else(|_| "\"Agent 状态未知\"".into());
    let _ = window.eval(format!(
        "window.setHostStatus && window.setHostStatus({message}, {is_error});"
    ));
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
                Err(error) => eprintln!("默认启用登录自启失败：{error}"),
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
            eprintln!("切换登录自启失败：{error}");
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
            r#"{"v":1,"type":"ui-ready","view":"panel","url":"http://127.0.0.1:1","panelUrl":"http://127.0.0.1:1","editorUrl":"http://127.0.0.1:1/editor"}"#,
        )
        .unwrap();
        assert_eq!(event.kind, "ui-ready");
        assert_eq!(event.view.as_deref(), Some("panel"));
        assert_eq!(
            event.editor_url.as_deref(),
            Some("http://127.0.0.1:1/editor")
        );
    }
}
