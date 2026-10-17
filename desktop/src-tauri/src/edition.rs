/// 构建时从 edition.json 写进二进制的版本宏。运行时只读这些常量。
#[allow(dead_code)]
pub const ID: &str = env!("NOVOARD_EDITION_ID");
pub const PRODUCT_NAME: &str = env!("NOVOARD_PRODUCT_NAME");
pub const WINDOW_TITLE: &str = env!("NOVOARD_WINDOW_TITLE");
#[allow(dead_code)]
pub const IDENTIFIER: &str = env!("NOVOARD_IDENTIFIER");
#[allow(dead_code)]
pub const DEV: bool = cfg!(novoard_dev);
pub const TRAY_ICON_PNG: &[u8] = include_bytes!(env!("NOVOARD_TRAY_ICON"));
pub const WINDOW_ICON_PNG: &[u8] = include_bytes!(env!("NOVOARD_WINDOW_ICON"));
