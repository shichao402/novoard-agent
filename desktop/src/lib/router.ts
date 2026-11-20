import { useEffect, useState } from "react";

/** 控制台 hash 路由（PRD-8）：#/targets、#/targets/:id/edit、#/runs/:taskId … */
export type Route =
  | { page: "home" }
  | { page: "chat" }
  | { page: "targets" }
  | { page: "target-new" }
  | { page: "target"; id: string; tab: "overview" | "runs" }
  | { page: "target-edit"; id: string }
  | { page: "runs" }
  | { page: "run"; taskId: string }
  | { page: "packs" }
  | { page: "logs" }
  | { page: "settings" };

export type Section = "home" | "chat" | "targets" | "runs" | "packs" | "logs" | "settings";

const SIMPLE = new Set(["home", "chat", "targets", "runs", "packs", "logs", "settings"]);

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const [head, second, third] = parts;
  if (!head) return { page: "home" };
  if (head === "actions") return { page: "targets" };
  if (head === "targets" && second === "new") return { page: "target-new" };
  if (head === "targets" && second) {
    if (third === "edit") return { page: "target-edit", id: second };
    return { page: "target", id: second, tab: third === "runs" ? "runs" : "overview" };
  }
  if (head === "runs" && second) return { page: "run", taskId: second };
  if (SIMPLE.has(head)) return { page: head } as Route;
  return { page: "home" };
}

export function sectionOf(route: Route): Section {
  switch (route.page) {
    case "target":
    case "target-new":
    case "target-edit":
      return "targets";
    case "run":
      return "runs";
    default:
      return route.page;
  }
}

export function href(path: string) {
  return `#/${path.replace(/^\/+/, "")}`;
}

export function navigate(path: string, replace = false) {
  const next = href(path);
  if (replace) {
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else if (window.location.hash !== next) {
    window.location.hash = next;
  }
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    if (window.location.hash.startsWith("#/actions")) navigate("targets", true);
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** 每秒触发一次重绘，用于在途耗时。 */
export function useNow(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
