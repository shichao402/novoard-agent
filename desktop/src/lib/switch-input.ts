/** 开关输入（ADR-0024）：候选恰好是 true、false 两项时，界面显示为开关，值仍是字符串 "true" / "false"。 */
export function isSwitchChoices(choices: ReadonlyArray<string | { value: string }> | undefined | null) {
  if (!Array.isArray(choices) || choices.length !== 2) return false;
  const values = new Set(choices.map((item) => (typeof item === "string" ? item : item.value)));
  return values.has("true") && values.has("false");
}
