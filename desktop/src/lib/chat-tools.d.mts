export type ToolStatus = "running" | "ok" | "error" | "denied";

export type ToolCall = {
  key: string;
  toolUseId?: string;
  name: string;
  title: string;
  input?: unknown;
  status: ToolStatus;
  summary: string;
  detail: string;
};

export type ToolEvent = {
  kind: string;
  name?: string;
  input?: unknown;
  text?: string;
  toolUseId?: string;
  isError?: boolean;
};

export function toolTitle(name: string | undefined, input: unknown): string;

export function toolResultText(raw: unknown, depth?: number): string;

export function classifyToolResult(
  name: string,
  raw: unknown,
  isError?: boolean,
): { status: Exclude<ToolStatus, "running">; summary: string; detail: string };

export function applyToolEvent(calls: ToolCall[], event: ToolEvent): ToolCall[];

export function settleCalls(calls: ToolCall[]): ToolCall[];

export function groupTitle(calls: ToolCall[]): string;
