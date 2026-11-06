//! relkit-updater 进程调用（relkit ADR 0026，协议 5）。
//!
//! relkit 不提供客户端库，这里就是宿主自己的全部胶水：每次调用起一个引擎
//! 进程，stdin 写一个 ProtoJSON `UpdaterRequest` 后关闭，stdout 按行读
//! `UpdaterEvent`。类型由 build.rs 从仓内 `proto/updater/v2/updater.proto`
//! 生成（副本由 `relkit-updater proto` 导出，stage-relkit.mjs 校验不漂移），
//! 两侧严格解析，未知字段即报错。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub mod proto {
    #![allow(clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/relkit.updater.v2.rs"));
    include!(concat!(env!("OUT_DIR"), "/relkit.updater.v2.serde.rs"));
}

use proto::{
    apply_result, check_result, download_result, updater_event, updater_request, ApplyOp,
    ApplyResult, CheckOp, CheckPolicy, CheckResult, ClientProfile, DownloadOp, DownloadResult,
    Error, ErrorCode, Failed, Runtime, StatusOp, StatusSnapshot, UpdaterEvent, UpdaterRequest,
};

/// 本宿主说的协议版本。引擎不协商：不一致就以 UPDATER_TOO_OLD/NEW 停下。
pub const PROTOCOL: u32 = 5;

/// 一个产品的调用上下文：引擎路径 + 每次请求都带的 profile 与 runtime。
#[derive(Clone)]
pub struct Updater {
    bin: PathBuf,
    profile: ClientProfile,
    runtime: Runtime,
}

impl Updater {
    /// 只确认引擎文件在；协议在每次调用的首行 Capabilities 上校验。
    pub fn open_at(bin: PathBuf, profile: ClientProfile, runtime: Runtime) -> Result<Self, Error> {
        if !bin.is_file() {
            return Err(error(
                ErrorCode::SidecarNotFound,
                format!("relkit-updater not found at {}", bin.display()),
                false,
            ));
        }
        Ok(Self {
            bin,
            profile,
            runtime,
        })
    }

    fn call(
        &self,
        op: updater_request::Op,
        on_event: &mut dyn FnMut(&UpdaterEvent),
    ) -> Result<Vec<UpdaterEvent>, Error> {
        let request = UpdaterRequest {
            protocol: PROTOCOL,
            profile: Some(self.profile.clone()),
            runtime: Some(self.runtime.clone()),
            op: Some(op),
        };
        let body = serde_json::to_vec(&request).map_err(|e| {
            error(ErrorCode::ProtocolMismatch, format!("encode request: {e}"), false)
        })?;
        run(&self.bin, &body, on_event)
    }

    pub fn check(&self, force: bool, exact_code: i64, policy: Option<CheckPolicy>) -> CheckResult {
        let op = updater_request::Op::Check(CheckOp {
            force,
            exact_code,
            policy,
        });
        let found = self.call(op, &mut |_| {}).and_then(|events| {
            terminal(events, |kind| match kind {
                updater_event::Kind::Check(result) => Some(result),
                _ => None,
            })
        });
        found.unwrap_or_else(|err| CheckResult {
            kind: Some(check_result::Kind::Failed(Failed { error: Some(err) })),
        })
    }

    pub fn download<F>(&self, plan_id: impl Into<String>, mut on_event: F) -> DownloadResult
    where
        F: FnMut(&UpdaterEvent),
    {
        let op = updater_request::Op::Download(DownloadOp {
            plan_id: plan_id.into(),
        });
        let found = self.call(op, &mut on_event).and_then(|events| {
            terminal(events, |kind| match kind {
                updater_event::Kind::Download(result) => Some(result),
                _ => None,
            })
        });
        found.unwrap_or_else(|err| DownloadResult {
            kind: Some(download_result::Kind::Failed(Failed { error: Some(err) })),
        })
    }

    /// 宿主不自绘交接界面，进度窗口交给引擎（`hide_progress` 恒为 false）。
    pub fn apply<F>(&self, plan_id: impl Into<String>, mut on_event: F) -> ApplyResult
    where
        F: FnMut(&UpdaterEvent),
    {
        let op = updater_request::Op::Apply(ApplyOp {
            plan_id: plan_id.into(),
            install_only: false,
            hide_progress: false,
        });
        let found = self.call(op, &mut on_event).and_then(|events| {
            terminal(events, |kind| match kind {
                updater_event::Kind::Apply(result) => Some(result),
                _ => None,
            })
        });
        found.unwrap_or_else(|err| ApplyResult {
            kind: Some(apply_result::Kind::Failed(Failed { error: Some(err) })),
        })
    }

    pub fn status(&self) -> Result<StatusSnapshot, Error> {
        let events = self.call(updater_request::Op::Status(StatusOp {}), &mut |_| {})?;
        terminal(events, |kind| match kind {
            updater_event::Kind::Status(status) => Some(status),
            _ => None,
        })
    }
}

/// 取这次运行的终止事件：要找的那一种，或顶层 Failed。
fn terminal<T>(
    events: Vec<UpdaterEvent>,
    pick: impl Fn(updater_event::Kind) -> Option<T>,
) -> Result<T, Error> {
    for event in events {
        match event.kind {
            Some(updater_event::Kind::Failed(failed)) => {
                return Err(failed
                    .error
                    .unwrap_or_else(|| error(ErrorCode::Unspecified, "failed", false)))
            }
            Some(kind) => {
                if let Some(found) = pick(kind) {
                    return Ok(found);
                }
            }
            None => {}
        }
    }
    Err(error(
        ErrorCode::ProtocolMismatch,
        "relkit-updater ended without a result",
        true,
    ))
}

/// 一次进程运行。首行必须是协议相符的 Capabilities；之后每行一个事件，
/// 边读边回调（下载进度要实时转给页面）。
fn run(
    bin: &Path,
    body: &[u8],
    on_event: &mut dyn FnMut(&UpdaterEvent),
) -> Result<Vec<UpdaterEvent>, Error> {
    let mut command = Command::new(bin);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| {
        error(
            ErrorCode::SidecarNotFound,
            format!("start {}: {e}", bin.display()),
            false,
        )
    })?;
    if let Some(mut input) = child.stdin.take() {
        // 写完即关：引擎读到 EOF 才开始解码。
        let written = input.write_all(body);
        drop(input);
        if let Err(e) = written {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error(ErrorCode::Unspecified, format!("write request: {e}"), true));
        }
    }
    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = stderr {
            let _ = std::io::Read::read_to_string(&mut pipe, &mut text);
        }
        text
    });

    let stdout = child.stdout.take().expect("stdout is piped");
    let mut events = Vec::new();
    let mut fault: Option<Error> = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(e) => {
                fault = Some(error(ErrorCode::Unspecified, format!("read events: {e}"), true));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let event: UpdaterEvent = match serde_json::from_str(&line) {
            Ok(event) => event,
            Err(e) => {
                fault = Some(error(
                    ErrorCode::ProtocolMismatch,
                    format!("event is not relkit.updater.v2: {e}"),
                    false,
                ));
                break;
            }
        };
        if events.is_empty() {
            if let Err(e) = check_handshake(&event) {
                fault = Some(e);
                break;
            }
        }
        on_event(&event);
        events.push(event);
    }
    if fault.is_some() {
        let _ = child.kill();
    }
    let status = child.wait();
    let diagnostics = stderr_reader.join().unwrap_or_default();
    if let Some(err) = fault {
        return Err(err);
    }
    // 非零退出但已写出结构化结果（例如请求被拒）时，以结果为准。
    let has_result = events.iter().skip(1).any(|e| e.kind.is_some());
    match status {
        Ok(code) if code.success() || has_result => Ok(events),
        Ok(code) => Err(error(
            ErrorCode::Unspecified,
            format!("relkit-updater exited with {code}: {}", diagnostics.trim()),
            true,
        )),
        Err(e) => Err(error(ErrorCode::Unspecified, format!("wait: {e}"), true)),
    }
}

fn check_handshake(event: &UpdaterEvent) -> Result<(), Error> {
    let Some(updater_event::Kind::Capabilities(caps)) = &event.kind else {
        return Err(error(
            ErrorCode::ProtocolMismatch,
            "first event is not Capabilities",
            false,
        ));
    };
    if caps.protocol < PROTOCOL {
        return Err(error(
            ErrorCode::UpdaterTooOld,
            format!("relkit-updater speaks protocol {}, host needs {PROTOCOL}", caps.protocol),
            false,
        ));
    }
    if caps.protocol > PROTOCOL {
        return Err(error(
            ErrorCode::UpdaterTooNew,
            format!("relkit-updater speaks protocol {}, host knows {PROTOCOL}", caps.protocol),
            false,
        ));
    }
    Ok(())
}

pub fn error(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Error {
    Error {
        code: code as i32,
        retryable,
        message: message.into(),
        attempts: Vec::new(),
        recovery: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proto::Capabilities;

    fn caps_line(protocol: u32) -> String {
        serde_json::to_string(&UpdaterEvent {
            kind: Some(updater_event::Kind::Capabilities(Capabilities {
                protocol,
                ..Default::default()
            })),
        })
        .unwrap()
    }

    #[test]
    fn handshake_rejects_other_protocols() {
        for (protocol, code) in [(4, ErrorCode::UpdaterTooOld), (6, ErrorCode::UpdaterTooNew)] {
            let event: UpdaterEvent = serde_json::from_str(&caps_line(protocol)).unwrap();
            assert_eq!(check_handshake(&event).unwrap_err().code, code as i32);
        }
        let event: UpdaterEvent = serde_json::from_str(&caps_line(PROTOCOL)).unwrap();
        assert!(check_handshake(&event).is_ok());
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let line = r#"{"capabilities":{"protocol":5,"ipc":3}}"#;
        assert!(serde_json::from_str::<UpdaterEvent>(line).is_err());
    }

    #[test]
    fn engine_style_json_decodes() {
        // 引擎用 Go protojson：lowerCamelCase、枚举写名字、int64 写字符串。
        let line = r#"{"status":{"hostMustExit":true,"lastSeenSequence":"3","activeSession":{"phase":"SESSION_PHASE_WAITING_FOR_EXIT"}}}"#;
        let event: UpdaterEvent = serde_json::from_str(line).unwrap();
        let Some(updater_event::Kind::Status(status)) = event.kind else {
            panic!("not a status");
        };
        assert!(status.host_must_exit);
        assert_eq!(status.last_seen_sequence, 3);
        assert_eq!(
            status.active_session.unwrap().phase,
            proto::SessionPhase::WaitingForExit as i32
        );
    }

    #[test]
    fn request_carries_protocol_and_install_spec() {
        let request = UpdaterRequest {
            protocol: PROTOCOL,
            runtime: Some(Runtime {
                install: Some(proto::InstallSpec {
                    display_name: "Novoard Agent".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            op: Some(updater_request::Op::Status(StatusOp {})),
            ..Default::default()
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains(r#""protocol":5"#), "{json}");
        assert!(json.contains(r#""status":{}"#), "{json}");
        assert!(json.contains(r#""displayName":"Novoard Agent""#), "{json}");
    }

    #[test]
    fn terminal_prefers_failed() {
        let events = vec![
            serde_json::from_str::<UpdaterEvent>(&caps_line(PROTOCOL)).unwrap(),
            UpdaterEvent {
                kind: Some(updater_event::Kind::Failed(Failed {
                    error: Some(error(ErrorCode::ProfileInvalid, "bad", false)),
                })),
            },
        ];
        let err = terminal(events, |kind| match kind {
            updater_event::Kind::Status(s) => Some(s),
            _ => None,
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ProfileInvalid as i32);
    }

    /// 真实引擎联调：设 RELKIT_UPDATER_BIN 与 RELKIT_BOOTSTRAP 才跑，
    /// 验证本仓生成的类型与引擎在 status / check 上互通。
    #[test]
    fn real_engine_round_trip() {
        let (Some(bin), Some(bootstrap)) = (
            std::env::var_os("RELKIT_UPDATER_BIN"),
            std::env::var_os("RELKIT_BOOTSTRAP"),
        ) else {
            return;
        };
        let data = std::env::temp_dir().join(format!("novoard-relkit-rt-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        let profile = ClientProfile {
            bootstrap: std::fs::read_to_string(bootstrap).unwrap(),
            expected_product: "novoard-agent".into(),
            ..Default::default()
        };
        let runtime = Runtime {
            channel: "dev".into(),
            current_code: 1,
            client_selectors: std::collections::HashMap::from([(
                "os-arch".to_string(),
                crate::updater::platform_selector().unwrap().to_string(),
            )]),
            data_dir: data.to_string_lossy().into_owned(),
            install: Some(proto::InstallSpec {
                placement: proto::Placement::InPlace as i32,
                install_root: data.join("Novoard Agent Dev.app").to_string_lossy().into_owned(),
                executable_relpath: "Contents/MacOS/novoard-agent-desktop".into(),
                sidecar_relpath: "Contents/MacOS/relkit-updater".into(),
                relaunch: true,
                display_name: "Novoard Agent Dev".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let updater = Updater::open_at(PathBuf::from(bin), profile, runtime).unwrap();
        let status = updater.status().expect("status");
        assert!(!status.host_must_exit);
        let result = updater.check(true, 0, None);
        eprintln!("check: {result:?}");
        assert!(
            !matches!(result.kind, Some(check_result::Kind::Failed(_)) | None),
            "{result:?}"
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn missing_binary_fails_open() {
        let result = Updater::open_at(
            PathBuf::from("/definitely/not/here/relkit-updater"),
            ClientProfile::default(),
            Runtime::default(),
        );
        assert_eq!(
            result.err().map(|err| err.code),
            Some(ErrorCode::SidecarNotFound as i32)
        );
    }
}
