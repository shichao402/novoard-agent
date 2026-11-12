import type { PackTool, PackTools, TargetDef, ToolParam } from "./api";

export const ID_RE: RegExp;
export const DURATION_RE: RegExp;
export const TIME_RE: RegExp;

export type ParamValue = string | number | boolean | string[];

export type DraftStep =
  | { key: string; kind: "uses"; uses: string; with: Record<string, ParamValue | undefined>; cwd: string; retry: string; retryInterval: string }
  | { key: string; kind: "script"; script: string; cwd: string; env?: Record<string, string> }
  | { key: string; kind: "openApp"; value: string }
  | { key: string; kind: "openPath"; value: string }
  | { key: string; kind: "template"; template: string };

export type StepKind = DraftStep["kind"];
export type NewStepKind = Exclude<StepKind, "template">;

export const STEP_KIND_LABELS: Record<StepKind, string>;

export type Draft = {
  id: string;
  title: string;
  expose: "a2a" | "local";
  audit: "none" | "summary" | "full";
  notify: "always" | "on-failure" | "never";
  requiresApproval: boolean;
  offline: "reject" | "queue";
  offlineTtl: string;
  concurrency: string;
  timeout: string;
  lostTtl: string;
  approvalTtl: string;
  schedule: string;
  oncePerDay: boolean;
  deadline: string;
  template: string;
  steps: DraftStep[];
};

export type IndexedTool = PackTool & { packId: string; packName: string };

export function newStep(kind: NewStepKind): DraftStep;
export function toDraft(id: string, target: TargetDef): Draft;
export function newDraft(existingIds: string[]): Draft;
export function cleanWith(input: Record<string, ParamValue | undefined>): Record<string, ParamValue>;
export function paramValue(spec: ToolParam, withValues: Record<string, ParamValue | undefined>): ParamValue | undefined;
export function toDef(draft: Draft, previous?: TargetDef): TargetDef;
export function indexTools(packs: PackTools["packs"]): Map<string, IndexedTool>;
export function paramLabel(spec: ToolParam): string;
export function validateDraft(draft: Draft, context?: { tools?: Map<string, IndexedTool>; timezone?: string }): string[];
export function validateDrafts(
  drafts: Draft[],
  context?: { tools?: Map<string, IndexedTool>; timezone?: string },
): Array<{ index: number; id: string; errors: string[] }>;
