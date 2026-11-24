export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  searchText?: string;
  disabled?: boolean;
  usageCount?: number;
};
export function filterSelectOptions<T extends SelectOption>(options: T[], query: string): T[];
