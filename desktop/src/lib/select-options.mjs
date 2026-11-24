/** 所有下拉共用：大小写 / 全半角无关，多关键词同时匹配名称、值与提示。 */
export function filterSelectOptions(options, query) {
  const normalize = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return options;
  return options.filter((option) => {
    const text = normalize([option.value, option.label, option.hint, option.searchText].filter(Boolean).join(" "));
    return terms.every((term) => text.includes(term));
  });
}
