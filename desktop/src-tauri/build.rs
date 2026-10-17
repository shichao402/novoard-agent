use std::{fs, path::PathBuf};

fn main() {
    println!("cargo::rustc-check-cfg=cfg(novoard_dev)");
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let edition_file = manifest_dir.join("../../edition.json");
    println!("cargo:rerun-if-changed={}", edition_file.display());
    println!("cargo:rerun-if-env-changed=NOVOARD_EDITION");

    let editions: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&edition_file).expect("读取 edition.json 失败"))
            .expect("edition.json 不是合法 JSON");
    let id = match std::env::var("NOVOARD_EDITION").ok().as_deref() {
        Some("dev") => "dev",
        None | Some("") | Some("release") => "release",
        Some(other) => panic!("NOVOARD_EDITION 只能是 release 或 dev，当前是 {other}"),
    };
    let edition = editions
        .get(id)
        .unwrap_or_else(|| panic!("edition.json 缺少 {id}"));
    let local_port = local_port(edition);
    let product_name = field(edition, "productName");
    let window_title = field(edition, "windowTitle");
    let identifier = field(edition, "identifier");
    let icons = edition
        .get("icons")
        .and_then(|value| value.as_array())
        .unwrap_or_else(|| panic!("edition.json 的 {id} 缺少 icons"));
    let icon32 = icon_path(&manifest_dir, icons, "32x32.png");
    let icon128 = icon_path(&manifest_dir, icons, "128x128.png");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let tray_icon = out_dir.join("tray-icon.png");
    let window_icon = out_dir.join("window-icon.png");
    fs::copy(&icon32, &tray_icon).expect("复制托盘图标失败");
    fs::copy(&icon128, &window_icon).expect("复制窗口图标失败");

    println!("cargo:rustc-env=NOVOARD_EDITION_ID={id}");
    println!("cargo:rustc-env=NOVOARD_PRODUCT_NAME={product_name}");
    println!("cargo:rustc-env=NOVOARD_WINDOW_TITLE={window_title}");
    println!("cargo:rustc-env=NOVOARD_IDENTIFIER={identifier}");
    println!("cargo:rustc-env=NOVOARD_LOCAL_PORT={local_port}");
    println!(
        "cargo:rustc-env=NOVOARD_TRAY_ICON={}",
        tray_icon.display().to_string().replace('\\', "/")
    );
    println!(
        "cargo:rustc-env=NOVOARD_WINDOW_ICON={}",
        window_icon.display().to_string().replace('\\', "/")
    );
    if id == "dev" {
        println!("cargo:rustc-cfg=novoard_dev");
    }
    println!("cargo:rerun-if-changed={}", icon32.display());
    println!("cargo:rerun-if-changed={}", icon128.display());

    tauri_build::build()
}

fn local_port(edition: &serde_json::Value) -> u16 {
    let port = edition
        .get("localPort")
        .and_then(|value| value.as_u64())
        .unwrap_or_else(|| panic!("edition.json 缺少 localPort"));
    if !(10000..=65535).contains(&port) {
        panic!("localPort 必须是 10000–65535 的固定端口，当前是 {port}");
    }
    port as u16
}

fn field(edition: &serde_json::Value, name: &str) -> String {
    edition
        .get(name)
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| panic!("edition.json 缺少 {name}"))
        .to_string()
}

fn icon_path(manifest_dir: &std::path::Path, icons: &[serde_json::Value], file_name: &str) -> PathBuf {
    let relative = icons
        .iter()
        .filter_map(|value| value.as_str())
        .find(|path| path.ends_with(file_name))
        .unwrap_or_else(|| panic!("edition.json 的 icons 缺少 {file_name}"));
    let path = manifest_dir.join(relative);
    if !path.exists() {
        panic!("图标不存在：{}", path.display());
    }
    path
}
