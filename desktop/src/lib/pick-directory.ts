import { open } from "@tauri-apps/plugin-dialog";

/** 选目录；默认路径打不开时退回不带默认路径再试一次。取消返回 null。 */
export async function pickDirectory(defaultPath?: string, title = "选择目录") {
  const options = { directory: true as const, multiple: false as const, title };
  let selected: string | string[] | null;
  try {
    selected = await open(defaultPath ? { ...options, defaultPath } : options);
  } catch (error) {
    if (!defaultPath) throw error;
    selected = await open(options);
  }
  const path = Array.isArray(selected) ? selected[0] : selected;
  return typeof path === "string" && path ? path : null;
}
