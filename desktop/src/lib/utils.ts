import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function hubLabel(hubUrl: string) {
  try {
    const url = new URL(hubUrl);
    if (url.pathname === "/tunnel" || url.pathname === "/tunnel/") return url.host;
    return hubUrl;
  } catch {
    return hubUrl;
  }
}

export function formatTime(value?: string | null) {
  if (!value) return "还没有运行";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
