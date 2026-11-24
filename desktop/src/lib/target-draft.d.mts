import type { PackTool, PackTools, TargetDef, ToolParam } from "./api";

export const ID_RE: RegExp;
export const DURATION_RE: RegExp;
export const TIME_RE: RegExp;

export type ParamValue = string | number | boolean | string[];

export type DraftStep =
  | { key: string; kind: "uses"; uses: string; with: Record<string, ParamValue | undefined>; cwd: string; retry: string; retryInterval: string; when: string }
  | { key: string; kind: "script"; script: string; cwd: string; when: string; env?: Record<string, string> }
  | { key: string; kind: "openApp"; value: string; when: string }
  | { key: string; kind: "openPath"; value: string; when: string }
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
  inputs: DraftInput[];
};

export type InputSource = "free" | "list" | "query";

export type DraftInput = {
  key: string;
  name: string;
  label: string;
  source: InputSource;
  /** 静态候选，一行一个（也接受逗号）。 */
  list: string;
  uses: string;
  /** 查询工具参数，表单不编辑，原样沿用。 */
  with?: Record<string, string | number | boolean | string[]>;
  cwd: string;
  default: string;
  allowCustom: boolean;
  required: boolean;
};

export const INPUT_NAME_RE: RegExp;
export const INPUT_SOURCE_LABELS: Record<InputSource, string>;
export function newInput(existingNames?: string[]): DraftInput;

export type IndexedTool = PackTool & { packId: string; packName: string };

export function newStep(kind: NewStepKind): DraftStep;
export function toDraft(id: string, target: TargetDef): Draft;
export function newDraft(existingIds: string[]): Draft;
export function cleanWith(input: Record<string, ParamValue | undefined>): Record<string, ParamValue>;
export function paramValue(spec: ToolParam, withValues: Record<string, ParamValue | undefined>): ParamValue | undefined;
export const RETIRED_PARAMS: string[];
export function retiredParams(withValues: Record<string, ParamValue | undefined>, tool?: IndexedTool | PackTool): string[];
export function toDef(draft: Draft, previous?: TargetDef, context?: { tools?: Map<string, IndexedTool> }): TargetDef;
export function indexTools(packs: PackTools["packs"]): Map<string, IndexedTool>;
export function paramLabel(spec: ToolParam): string;
export function validateDraft(draft: Draft, context?: { tools?: Map<string, IndexedTool>; timezone?: string }): string[];
export function validateDrafts(
  drafts: Draft[],
  context?: { tools?: Map<string, IndexedTool>; timezone?: string },
): Array<{ index: number; id: string; errors: string[] }>;
