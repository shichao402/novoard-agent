//! 桌面壳自动更新：relkit-updater sidecar 的薄客户端（ADR-0017）。
//!
//! 宿主只做三件事：拼 ClientProfile/Runtime、把结果投影给 UI、在引擎要求时退出。
//! 协议解析、验签、版本比较、文件替换与重启全部由 relkit-updater 完成。
//! 只有 CI 发布构建（build.rs 同时拿到 bootstrap 与 releaseCode）才启用；
//! 本地构建与 ~/Applications 部署档显示“此构建未接入更新”。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::relkit_sidecar::{
    proto::{
        self, apply_result, check_result, download_result, updater_event, ErrorCode, Placement,
        SessionPhase,
    },
    Updater,
};
use serde::Serialize;
use tauri::{menu::MenuItem, AppHandle, Emitter, Manager, Wry};

use crate::{edition, Supervisor};

const PRODUCT: &str = "novoard-agent";
const BOOTSTRAP: &str = include_str!(concat!(env!("OUT_DIR"), "/relkit-bootstrap.json"));
const RELEASE_CODE: Option<&str> = option_env!("NOVOARD_RELEASE_CODE");
const RELEASE_VERSION: Option<&str> = option_env!("NOVOARD_RELEASE_VERSION");
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(250);

pub const EVENT: &str = "update-status";
pub const MENU_ID: &str = "check-update";
const MENU_IDLE_TEXT: &str = "检查更新";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Disabled,
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Downloaded,
    Applying,
    Fallback,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    plan_id: String,
    version: String,
    code: i64,
    mandatory: bool,
    release_notes: String,
    release_notes_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressView {
    received: i64,
    total: i64,
    bytes_per_second: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingView {
    running: usize,
    pending_approval: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    enabled: bool,
    channel: String,
    current_version: String,
    current_code: i64,
    phase: Phase,
    message: Option<String>,
    available: Option<Available>,
    progress: Option<ProgressView>,
    manual_url: Option<String>,
    checked_at: Option<u64>,
    /// 已下载、用户已点安装，但 sidecar 还有在途任务：等它们结束后自动安装（ADR-0018）。
    waiting_for_tasks: Option<WaitingView>,
}

pub struct UpdateState {
    updater: Mutex<Option<Updater>>,
    busy: AtomicBool,
    install_when_idle: AtomicBool,
    view: Mutex<UpdateView>,
    menu_item: Mutex<Option<MenuItem<Wry>>>,
}

impl UpdateState {
    pub fn new(app: &AppHandle) -> Arc<Self> {
        let current_code = release_code().unwrap_or(0);
        let disabled = disabled_reason();
        let view = UpdateView {
            enabled: disabled.is_none(),
            channel: channel().to_string(),
            current_version: RELEASE_VERSION
                .map(str::to_string)
                .unwrap_or_else(|| app.package_info().version.to_string()),
            current_code,
            phase: if disabled.is_some() {
                Phase::Disabled
            } else {
                Phase::Idle
            },
            message: disabled,
            available: None,
            progress: None,
            manual_url: None,
            checked_at: None,
            waiting_for_tasks: None,
        };
        Arc::new(Self {
            updater: Mutex::new(None),
            busy: AtomicBool::new(false),
            install_when_idle: AtomicBool::new(false),
            view: Mutex::new(view),
            menu_item: Mutex::new(None),
        })
    }

    pub fn attach_menu_item(&self, item: MenuItem<Wry>) {
        if let Ok(mut slot) = self.menu_item.lock() {
            *slot = Some(item);
        }
    }

    fn snapshot(&self) -> UpdateView {
        self.view.lock().map(|view| view.clone()).unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut UpdateView)) -> UpdateView {
        let view = {
            let mut guard = self.view.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            change(&mut guard);
            guard.clone()
        };
        let _ = app.emit(EVENT, &view);
        self.refresh_menu(&view);
        view
    }

    fn refresh_menu(&self, view: &UpdateView) {
        let text = match (&view.phase, &view.available) {
            (Phase::Downloaded, Some(next)) if view.waiting_for_tasks.is_some() => {
                format!("v{} 将在任务结束后安装", next.version)
            }
            (Phase::Available, Some(next)) => format!("有可用更新 v{}", next.version),
            (Phase::Downloaded, Some(next)) => format!("安装更新 v{}", next.version),
            (Phase::Downloading, _) => "正在下载更新…".to_string(),
            (Phase::Applying, _) => "正在安装更新…".to_string(),
            _ => MENU_IDLE_TEXT.to_string(),
        };
        if let Ok(slot) = self.menu_item.lock() {
            if let Some(item) = slot.as_ref() {
                let _ = item.set_text(text);
            }
        }
    }

    fn updater(&self, app: &AppHandle) -> Result<Updater, String> {
        let mut slot = self.updater.lock().map_err(|_| "更新器状态已损坏".to_string())?;
        if let Some(updater) = slot.as_ref() {
            return Ok(updater.clone());
        }
        let updater = open_updater(app)?;
        *slot = Some(updater.clone());
        Ok(updater)
    }
}

fn channel() -> &'static str {
    if edition::DEV {
        "dev"
    } else {
        "stable"
    }
}

/// 上报给 Hub 的应用身份（契约 v2.3 agent.hello.app）：版本与渠道。
/// 未接入更新的本地构建渠道记为 local，与 relkit 渠道区分。
pub fn app_identity(app: &AppHandle) -> (String, &'static str) {
    let version = RELEASE_VERSION
        .map(str::to_string)
        .unwrap_or_else(|| app.package_info().version.to_string());
    let channel = if release_code().is_some() { channel() } else { "local" };
    (version, channel)
}

fn release_code() -> Option<i64> {
    RELEASE_CODE.and_then(|code| code.parse::<i64>().ok()).filter(|code| *code > 0)
}

fn disabled_reason() -> Option<String> {
    if BOOTSTRAP.trim().is_empty() || release_code().is_none() {
        return Some("此构建未接入更新（只有 CI 发布构建启用自动更新）。".into());
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => return Some(format!("无法定位当前程序：{error}")),
    };
    let layout = match install_layout(&exe, cfg!(target_os = "macos")) {
        Ok(layout) => layout,
        Err(reason) => return Some(reason),
    };
    if cfg!(target_os = "macos") {
        return macos_location_problem(&layout.install_root);
    }
    None
}

/// relkit ADR 0027：.app 处于 App Translocation、在 DMG 里直接运行或所在目录
/// 不可写时，原地替换必然失败，不发起更新，提示用户先拖进“应用程序”。
fn macos_location_problem(bundle: &Path) -> Option<String> {
    let text = bundle.to_string_lossy();
    const HINT: &str = "请先把应用拖进“应用程序”文件夹再打开，之后才能自动更新。";
    if text.contains("/AppTranslocation/") {
        return Some(format!("应用正在 macOS 隔离位置运行（App Translocation），已停用自动更新。{HINT}"));
    }
    if text.starts_with("/Volumes/") {
        return Some(format!("应用正在安装盘映像（DMG）中运行，已停用自动更新。{HINT}"));
    }
    let parent = bundle.parent()?;
    if !dir_writable(parent) {
        return Some(format!("安装位置 {} 不可写，已停用自动更新。{HINT}", parent.display()));
    }
    None
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".novoard-write-probe-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 当前平台在 artifact 上声明的 `os-arch` 选择器，与 producer 的 target 同名。
pub fn platform_selector() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("windows-amd64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-amd64"),
        _ => None,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct InstallLayout {
    install_root: PathBuf,
    executable_relpath: String,
    sidecar_relpath: String,
}

/// IN_PLACE 安装根：Windows 是主程序所在目录；macOS 是整个 .app 包。
fn install_layout(exe: &Path, macos: bool) -> Result<InstallLayout, String> {
    let name = exe
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("无法解析程序名：{}", exe.display()))?
        .to_string();
    if macos {
        let macos_dir = exe.parent();
        let contents = macos_dir.and_then(Path::parent);
        let bundle = contents.and_then(Path::parent);
        let shaped = macos_dir.and_then(Path::file_name).is_some_and(|value| value == "MacOS")
            && contents.and_then(Path::file_name).is_some_and(|value| value == "Contents")
            && bundle
                .and_then(Path::extension)
                .is_some_and(|value| value == "app");
        if !shaped {
            return Err("当前不是以 .app 安装形态运行，已停用自动更新。".into());
        }
        return Ok(InstallLayout {
            install_root: bundle.unwrap().to_path_buf(),
            executable_relpath: format!("Contents/MacOS/{name}"),
            sidecar_relpath: "Contents/MacOS/relkit-updater".into(),
        });
    }
    let root = exe
        .parent()
        .ok_or_else(|| format!("无法确定安装目录：{}", exe.display()))?;
    Ok(InstallLayout {
        install_root: root.to_path_buf(),
        executable_relpath: name,
        sidecar_relpath: "relkit-updater.exe".into(),
    })
}

fn open_updater(app: &AppHandle) -> Result<Updater, String> {
    if let Some(reason) = disabled_reason() {
        return Err(reason);
    }
    let selector = platform_selector().ok_or("当前平台没有发布更新包")?;
    let exe = std::env::current_exe().map_err(|error| format!("无法定位当前程序：{error}"))?;
    let layout = install_layout(&exe, cfg!(target_os = "macos"))?;
    let data_dir = crate::desktop_data_dir(app)?.join("relkit");
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建更新数据目录 {}：{error}", data_dir.display()))?;
    let profile = proto::ClientProfile {
        bootstrap: BOOTSTRAP.to_string(),
        expected_product: PRODUCT.to_string(),
        ..Default::default()
    };
    let sidecar = layout.install_root.join(&layout.sidecar_relpath);
    let runtime = proto::Runtime {
        channel: channel().to_string(),
        current_code: release_code().unwrap_or(0),
        client_selectors: HashMap::from([("os-arch".to_string(), selector.to_string())]),
        data_dir: data_dir.to_string_lossy().into_owned(),
        install: Some(proto::InstallSpec {
            placement: Placement::InPlace as i32,
            install_root: layout.install_root.to_string_lossy().into_owned(),
            executable_relpath: layout.executable_relpath,
            sidecar_relpath: layout.sidecar_relpath,
            relaunch: true,
            display_name: edition::PRODUCT_NAME.to_string(),
            ..Default::default()
        }),
    };
    Updater::open_at(sidecar, profile, runtime).map_err(|error| describe_error(Some(&error)))
}

/// 启动交接（relkit ADR 0026）：引擎的 apply worker 仍要占用安装目录时，
/// 新启动的宿主必须立刻退出。问不到引擎（未接入、缺组件、引擎异常）一律放行。
pub fn host_must_exit(app: &AppHandle) -> bool {
    let Ok(updater) = open_updater(app) else {
        return false;
    };
    match updater.status() {
        Ok(status) => status.host_must_exit,
        Err(error) => {
            log::warn!("启动时查询更新状态失败，放行：{}", describe_error(Some(&error)));
            false
        }
    }
}

fn describe_error(error: Option<&proto::Error>) -> String {
    let Some(error) = error else {
        return "更新失败（未知错误）".into();
    };
    let code = ErrorCode::try_from(error.code).unwrap_or(ErrorCode::Unspecified);
    let hint = match code {
        ErrorCode::Network => "网络不可用或服务器无响应",
        ErrorCode::Signature => "更新签名校验失败",
        ErrorCode::SelectorNoMatch => "没有适用于本机平台的更新包",
        ErrorCode::Disk => "磁盘写入失败",
        ErrorCode::PermissionDenied => "没有写入安装目录的权限",
        ErrorCode::Occupied => "安装目录中的文件正被占用",
        ErrorCode::PlanExpired | ErrorCode::PlanUnknown | ErrorCode::PlanTampered => {
            "更新计划已失效，请重新检查更新"
        }
        ErrorCode::PlanNotDownloaded => "更新包尚未下载",
        ErrorCode::SidecarNotFound => "安装包中缺少更新组件 relkit-updater",
        ErrorCode::UpdaterTooOld | ErrorCode::UpdaterTooNew | ErrorCode::ProtocolMismatch => {
            "内置更新组件与本程序版本不一致，请下载完整安装包重新安装"
        }
        ErrorCode::LayoutUnsupported => "当前安装形态不支持自动更新",
        ErrorCode::InstallerFailed => "安装程序执行失败",
        ErrorCode::ChannelNotAllowed => "服务器未开放当前更新渠道",
        ErrorCode::ProfileInvalid => "内置的更新配置无效",
        ErrorCode::Canceled => "已取消",
        _ => "更新失败",
    };
    if error.message.is_empty() {
        hint.to_string()
    } else {
        format!("{hint}：{}", error.message)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn state(app: &AppHandle) -> Arc<UpdateState> {
    app.state::<Arc<UpdateState>>().inner().clone()
}

/// 独占一次引擎调用；已有操作在跑时直接返回当前快照。
struct BusyGuard(Arc<UpdateState>);

impl BusyGuard {
    fn acquire(state: &Arc<UpdateState>) -> Option<Self> {
        if state.busy.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(Self(state.clone()))
        }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| format!("更新任务异常结束：{error}"))?
}

pub async fn check(app: AppHandle, force: bool) -> UpdateView {
    let state = state(&app);
    if !state.snapshot().enabled {
        return state.snapshot();
    }
    let Some(_guard) = BusyGuard::acquire(&state) else {
        return state.snapshot();
    };
    state.update(&app, |view| {
        view.phase = Phase::Checking;
        view.message = None;
    });
    let (worker_state, worker_app) = (state.clone(), app.clone());
    let result = blocking(move || {
        let updater = worker_state.updater(&worker_app)?;
        Ok(updater.check(force, 0, None))
    })
    .await;
    state.update(&app, |view| {
        view.checked_at = Some(now_ms());
        view.progress = None;
        match result {
            Err(message) => {
                view.phase = Phase::Error;
                view.message = Some(message);
            }
            Ok(result) => apply_check_result(view, result.kind),
        }
    })
}

fn apply_check_result(view: &mut UpdateView, kind: Option<check_result::Kind>) {
    match kind {
        Some(check_result::Kind::UpToDate(_)) => {
            view.phase = Phase::UpToDate;
            view.available = None;
            view.manual_url = None;
            view.message = None;
        }
        Some(check_result::Kind::UpdateAvailable(next)) => {
            view.phase = Phase::Available;
            view.manual_url = None;
            view.message = None;
            view.available = Some(Available {
                plan_id: next.plan_id,
                version: next.version,
                code: next.code,
                mandatory: next.mandatory,
                release_notes: next.release_notes_markdown,
                release_notes_url: next.release_notes_url,
            });
        }
        Some(check_result::Kind::FallbackRequired(fallback)) => {
            view.phase = Phase::Fallback;
            view.available = None;
            view.manual_url = Some(fallback.manual_url).filter(|url| !url.is_empty());
            view.message = Some(if fallback.message.is_empty() {
                "当前版本无法自动升级，请下载完整安装包手动安装。".into()
            } else {
                fallback.message
            });
        }
        Some(check_result::Kind::Throttled(_)) => {
            // 引擎节流：保留上一次的结论，只把“检查中”退回。
            view.phase = if view.available.is_some() {
                Phase::Available
            } else {
                Phase::Idle
            };
        }
        Some(check_result::Kind::Failed(failed)) => {
            view.phase = Phase::Error;
            view.message = Some(describe_error(failed.error.as_ref()));
        }
        None => {
            view.phase = Phase::Error;
            view.message = Some("更新引擎没有返回检查结果".into());
        }
    }
}

pub async fn download(app: AppHandle) -> UpdateView {
    let state = state(&app);
    let Some(plan) = state.snapshot().available.map(|next| next.plan_id) else {
        return state.update(&app, |view| {
            view.message = Some("没有可下载的更新，请先检查更新".into());
        });
    };
    let Some(_guard) = BusyGuard::acquire(&state) else {
        return state.snapshot();
    };
    state.update(&app, |view| {
        view.phase = Phase::Downloading;
        view.message = None;
        view.progress = None;
    });
    let (worker_state, worker_app) = (state.clone(), app.clone());
    let result = blocking(move || {
        let updater = worker_state.updater(&worker_app)?;
        let mut last_emit = Instant::now() - PROGRESS_EMIT_INTERVAL;
        Ok(updater.download(plan, |event| {
            if let Some(updater_event::Kind::Progress(progress)) = &event.kind {
                if last_emit.elapsed() < PROGRESS_EMIT_INTERVAL {
                    return;
                }
                last_emit = Instant::now();
                worker_state.update(&worker_app, |view| {
                    view.progress = Some(ProgressView {
                        received: progress.bytes_received,
                        total: progress.bytes_total,
                        bytes_per_second: progress.bytes_per_second,
                    });
                });
            }
        }))
    })
    .await;
    state.update(&app, |view| match result {
        Err(message) => {
            view.phase = Phase::Error;
            view.message = Some(message);
        }
        Ok(result) => match result.kind {
            Some(download_result::Kind::Downloaded(_)) => {
                view.phase = Phase::Downloaded;
                view.message = None;
            }
            Some(download_result::Kind::Failed(failed)) => {
                view.phase = Phase::Error;
                view.message = Some(describe_error(failed.error.as_ref()));
            }
            None => {
                view.phase = Phase::Error;
                view.message = Some("更新引擎没有返回下载结果".into());
            }
        },
    })
}

/// 在途任务文案：只在有任务时返回。
fn waiting_text(running: usize, pending_approval: usize) -> Option<String> {
    let mut parts = Vec::new();
    if running > 0 {
        parts.push(format!("{running} 个任务正在执行"));
    }
    if pending_approval > 0 {
        parts.push(format!("{pending_approval} 个任务等待审批"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(format!("{}，全部结束后自动安装。", parts.join("、")))
    }
}

/// 安装会退出 sidecar，内存里的任务表随之丢失（ADR-0011）。
/// 所以默认等到没有执行中、也没有审批挂起的任务再装；`force` 是用户明确选择“立即安装”。
pub async fn apply(app: AppHandle, force: bool) -> UpdateView {
    let state = state(&app);
    let snapshot = state.snapshot();
    let Some(plan) = snapshot.available.map(|next| next.plan_id) else {
        return state.update(&app, |view| {
            view.message = Some("没有可安装的更新，请先检查更新".into());
        });
    };
    if snapshot.phase != Phase::Downloaded {
        return state.update(&app, |view| {
            view.message = Some("请先下载更新包".into());
        });
    }
    let (running, pending_approval) = app.state::<Arc<Supervisor>>().activity();
    if !force {
        if let Some(text) = waiting_text(running, pending_approval) {
            state.install_when_idle.store(true, Ordering::SeqCst);
            log::info!("更新已就绪，等待在途任务结束：running={running} pendingApproval={pending_approval}");
            return state.update(&app, |view| {
                view.message = Some(text);
                view.waiting_for_tasks = Some(WaitingView { running, pending_approval });
            });
        }
    } else if running + pending_approval > 0 {
        log::warn!("用户选择立即安装，将中断在途任务：running={running} pendingApproval={pending_approval}");
    }
    state.install_when_idle.store(false, Ordering::SeqCst);
    let Some(_guard) = BusyGuard::acquire(&state) else {
        return state.snapshot();
    };
    state.update(&app, |view| {
        view.phase = Phase::Applying;
        view.waiting_for_tasks = None;
        view.message = Some("正在准备安装…".into());
    });
    let (worker_state, worker_app) = (state.clone(), app.clone());
    let result = blocking(move || {
        let updater = worker_state.updater(&worker_app)?;
        Ok(updater.apply(plan, |_| {}))
    })
    .await;
    let mut exit_now = false;
    let view = state.update(&app, |view| match result {
        Err(message) => {
            view.phase = Phase::Error;
            view.message = Some(message);
        }
        Ok(result) => match result.kind {
            Some(apply_result::Kind::Accepted(accepted)) => {
                exit_now = accepted.requires_host_exit;
                view.message = Some(if exit_now {
                    "正在退出并安装更新，完成后会自动重新打开。".into()
                } else {
                    "更新已安装，重新打开应用后生效。".into()
                });
            }
            Some(apply_result::Kind::Failed(failed)) => {
                view.phase = Phase::Error;
                view.message = Some(describe_error(failed.error.as_ref()));
            }
            None => {
                view.phase = Phase::Error;
                view.message = Some("更新引擎没有返回安装结果".into());
            }
        },
    });
    if exit_now {
        log::info!("relkit 已接受更新，宿主退出以完成原地替换");
        let supervisor = app.state::<Arc<Supervisor>>().inner().clone();
        crate::begin_quit(app.clone(), supervisor);
    }
    view
}

/// 托盘“检查更新”：打开设置页；已下载好则直接安装，否则强制检查。
pub fn on_menu(app: &AppHandle, supervisor: &Arc<Supervisor>) {
    crate::reveal(app, supervisor, "settings");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let phase = state(&app).snapshot().phase;
        match phase {
            Phase::Disabled | Phase::Downloading | Phase::Applying => {}
            Phase::Downloaded => {
                apply(app, false).await;
            }
            _ => {
                check(app, true).await;
            }
        }
    });
}

/// sidecar 在途任务数变化（lib.rs 收到 activity 事件或 sidecar 退出时调用）。
/// 用户已点过安装且现在空闲，就接着装；仍忙则刷新等待文案。
pub fn on_activity(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<UpdateState>>().map(|s| s.inner().clone()) else {
        return;
    };
    if !state.install_when_idle.load(Ordering::SeqCst) {
        return;
    }
    let (running, pending_approval) = app.state::<Arc<Supervisor>>().activity();
    if let Some(text) = waiting_text(running, pending_approval) {
        state.update(app, |view| {
            view.message = Some(text);
            view.waiting_for_tasks = Some(WaitingView { running, pending_approval });
        });
        return;
    }
    if !state.install_when_idle.swap(false, Ordering::SeqCst) {
        return;
    }
    log::info!("在途任务已清空，开始安装已下载的更新");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        apply(app, false).await;
    });
}

/// 启动后先汇报上次更新会话结果，再按间隔做非强制检查（引擎负责节流）。
pub fn start(app: &AppHandle) {
    if !state(app).snapshot().enabled {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        report_last_session(&app).await;
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let phase = state(&app).snapshot().phase;
            if !matches!(
                phase,
                Phase::Downloading | Phase::Downloaded | Phase::Applying
            ) {
                check(app.clone(), false).await;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn report_last_session(app: &AppHandle) {
    let state = state(app);
    let (worker_state, worker_app) = (state.clone(), app.clone());
    let Ok(status) = blocking(move || {
        let updater = worker_state.updater(&worker_app)?;
        updater.status().map_err(|error| describe_error(Some(&error)))
    })
    .await
    else {
        return;
    };
    let Some(session) = status.active_session else {
        return;
    };
    let phase = SessionPhase::try_from(session.phase).unwrap_or(SessionPhase::Unspecified);
    let message = match phase {
        SessionPhase::RolledBack => "上次更新安装失败，已回滚到当前版本。",
        SessionPhase::NeedsAttention => "上次更新未能完成，请重新下载安装或手动安装完整包。",
        _ => return,
    };
    let detail = describe_error(session.error.as_ref());
    log::warn!("{message} {detail}");
    state.update(app, |view| {
        view.phase = Phase::Error;
        view.message = Some(if session.error.is_some() {
            format!("{message}{detail}")
        } else {
            message.to_string()
        });
    });
}

#[tauri::command]
pub fn update_status(state: tauri::State<'_, Arc<UpdateState>>) -> UpdateView {
    state.snapshot()
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateView, String> {
    Ok(check(app, true).await)
}

#[tauri::command]
pub async fn update_download(app: AppHandle) -> Result<UpdateView, String> {
    Ok(download(app).await)
}

#[tauri::command]
pub async fn update_apply(app: AppHandle, force: Option<bool>) -> Result<UpdateView, String> {
    Ok(apply(app, force.unwrap_or(false)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_layout_uses_app_bundle_as_install_root() {
        let exe = Path::new("/Users/me/Applications/Novoard Agent.app/Contents/MacOS/novoard-agent-desktop");
        let layout = install_layout(exe, true).unwrap();
        assert_eq!(layout.install_root, PathBuf::from("/Users/me/Applications/Novoard Agent.app"));
        assert_eq!(layout.executable_relpath, "Contents/MacOS/novoard-agent-desktop");
        assert_eq!(layout.sidecar_relpath, "Contents/MacOS/relkit-updater");
    }

    #[test]
    fn macos_layout_rejects_loose_binary() {
        let exe = Path::new("/repo/desktop/src-tauri/target/debug/novoard-agent-desktop");
        assert!(install_layout(exe, true).is_err());
    }

    #[test]
    fn windows_layout_uses_exe_directory() {
        let exe = Path::new("/install/Novoard Agent/novoard-agent-desktop.exe");
        let layout = install_layout(exe, false).unwrap();
        assert_eq!(layout.install_root, PathBuf::from("/install/Novoard Agent"));
        assert_eq!(layout.executable_relpath, "novoard-agent-desktop.exe");
        assert_eq!(layout.sidecar_relpath, "relkit-updater.exe");
    }

    #[test]
    fn waiting_text_only_when_tasks_in_flight() {
        assert_eq!(waiting_text(0, 0), None);
        assert_eq!(
            waiting_text(1, 0).as_deref(),
            Some("1 个任务正在执行，全部结束后自动安装。")
        );
        assert_eq!(
            waiting_text(2, 1).as_deref(),
            Some("2 个任务正在执行、1 个任务等待审批，全部结束后自动安装。")
        );
        assert_eq!(
            waiting_text(0, 3).as_deref(),
            Some("3 个任务等待审批，全部结束后自动安装。")
        );
    }

    #[test]
    fn macos_location_rejects_translocation_and_dmg() {
        let translocated = Path::new(
            "/private/var/folders/x/T/AppTranslocation/ABC/d/Novoard Agent.app",
        );
        assert!(macos_location_problem(translocated).unwrap().contains("App Translocation"));
        let mounted = Path::new("/Volumes/Novoard Agent/Novoard Agent.app");
        assert!(macos_location_problem(mounted).unwrap().contains("DMG"));
    }

    #[test]
    fn macos_location_requires_writable_parent() {
        let dir = std::env::temp_dir().join(format!("novoard-loc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(macos_location_problem(&dir.join("Novoard Agent.app")).is_none());
        assert!(macos_location_problem(Path::new("/nonexistent-root/Novoard Agent.app")).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_builds_are_not_wired_to_updates() {
        if BOOTSTRAP.trim().is_empty() {
            assert!(disabled_reason().is_some());
        }
    }

    #[test]
    fn throttled_check_keeps_previous_offer() {
        let mut view = UpdateView {
            enabled: true,
            channel: "stable".into(),
            current_version: "1.0.0".into(),
            current_code: 1,
            phase: Phase::Checking,
            message: None,
            available: Some(Available {
                plan_id: "p".into(),
                version: "1.1.0".into(),
                code: 2,
                mandatory: false,
                release_notes: String::new(),
                release_notes_url: String::new(),
            }),
            progress: None,
            manual_url: None,
            checked_at: None,
            waiting_for_tasks: None,
        };
        apply_check_result(
            &mut view,
            Some(check_result::Kind::Throttled(proto::Throttled::default())),
        );
        assert_eq!(view.phase, Phase::Available);
        apply_check_result(
            &mut view,
            Some(check_result::Kind::UpToDate(proto::UpToDate::default())),
        );
        assert_eq!(view.phase, Phase::UpToDate);
        assert!(view.available.is_none());
    }
}
