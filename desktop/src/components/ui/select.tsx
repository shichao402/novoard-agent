import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Children, createContext, isValidElement, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { filterSelectOptions, type SelectOption } from "@/lib/select-options.mjs";
import { cn } from "@/lib/utils";

export const SelectLabelContext = createContext("");

type OptionProps = ComponentProps<"option"> & { "data-search"?: string; "data-hint"?: string; "data-usage-count"?: number };
type SelectProps = Omit<ComponentProps<"select">, "multiple" | "size"> & { allowCustom?: boolean; searchPlaceholder?: string };

function textOf(node: ReactNode): string {
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : String(child)).join("");
}

function optionsOf(children: ReactNode, disabled = false): SelectOption[] {
  return Children.toArray(children).flatMap((child): SelectOption[] => {
    if (!isValidElement<OptionProps>(child)) return [];
    if (child.type === "option") {
      const label = child.props.label || textOf(child.props.children);
      return [{
        value: String(child.props.value ?? label), label,
        hint: child.props["data-hint"],
        searchText: [child.props["data-search"], child.props.title].filter(Boolean).join(" "),
        disabled: disabled || child.props.disabled,
        usageCount: child.props["data-usage-count"],
      }];
    }
    return optionsOf(child.props.children, disabled || (child.type === "optgroup" && child.props.disabled === true));
  });
}

/** 所有单选下拉均可筛选。隐藏的原生 select 保留表单值与真实 change 事件，不伪造事件对象。 */
export function Select({ className, children, value, defaultValue, disabled, autoFocus, id, allowCustom = false, searchPlaceholder = "输入文字筛选…", ...props }: SelectProps) {
  const fieldLabel = useContext(SelectLabelContext);
  const label = props["aria-label"] || fieldLabel || "选项";
  const uid = useId();
  const listId = `${uid}-list`;
  const options = useMemo(() => optionsOf(children), [children]);
  const [ownValue, setOwnValue] = useState(() => String(defaultValue ?? options.find((item) => !item.disabled)?.value ?? ""));
  const selectedValue = String(value ?? ownValue);
  const selected = options.find((item) => item.value === selectedValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const customOption = useRef<HTMLOptionElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => filterSelectOptions(options, query), [options, query]);
  const customValue = query.trim();
  const canCreate = allowCustom && customValue !== "" && !options.some((item) => item.value === customValue);

  function close(restoreFocus = false) {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) trigger.current?.focus();
  }

  function show() {
    if (disabled) return;
    setQuery("");
    setOpen(true);
  }

  function choose(next: string) {
    const element = native.current;
    if (!element) return;
    if (allowCustom && customOption.current && !options.some((item) => item.value === next)) customOption.current.value = next;
    element.value = next;
    if (value === undefined) setOwnValue(next);
    element.dispatchEvent(new Event("change", { bubbles: true }));
    close(true);
  }

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const selectedIndex = filtered.findIndex((item) => item.value === selectedValue && !item.disabled);
    setActive(selectedIndex >= 0 ? selectedIndex : filtered.findIndex((item) => !item.disabled));
  }, [open, filtered, selectedValue]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < 220 && above > below;
      const maxHeight = Math.min(360, Math.max(100, upwards ? above : below));
      const height = Math.min(maxHeight, panel.current?.scrollHeight || maxHeight);
      setPosition({ width, maxHeight, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: upwards ? Math.max(8, rect.top - height - 4) : rect.bottom + 4 });
    }
    place();
    const onScroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) place(); };
    const onPointer = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!panel.current?.contains(node) && !trigger.current?.contains(node)) close();
    };
    const onFocus = (event: FocusEvent) => {
      const node = event.target as Node;
      if (!panel.current?.contains(node) && !trigger.current?.contains(node)) close();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open, filtered.length, canCreate]);

  useEffect(() => {
    if (open && position) search.current?.focus();
  }, [open, position !== null]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  function move(direction: number) {
    if (!filtered.length) return;
    let next = active;
    for (let count = 0; count < filtered.length; count++) {
      next = (next + direction + filtered.length) % filtered.length;
      if (!filtered[next].disabled) { setActive(next); return; }
    }
  }

  return (
    <div className="relative min-w-0">
      <button
        ref={trigger}
        id={id}
        type="button"
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={selected ? [selected.label, selected.hint].filter(Boolean).join(" · ") : selectedValue}
        className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line-hi bg-surface px-3 text-left text-[13px] text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-45", className)}
        onClick={() => open ? close(true) : show()}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); }
          else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); show(); setQuery(event.key); }
        }}
      >
        <span className="min-w-0 truncate">{selected?.label || selectedValue || "请选择"}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
      </button>
      <select
        {...props}
        ref={native}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only pointer-events-none"
        onInvalid={(event) => { event.preventDefault(); trigger.current?.focus(); props.onInvalid?.(event); }}
      >
        {children}
        {allowCustom ? <option ref={customOption} value={!selected && selectedValue ? selectedValue : "\u0000custom"} hidden>{selectedValue}</option> : null}
      </select>
      {open && position ? createPortal(
        <div
          ref={panel}
          className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-line-hi bg-panel shadow-2xl"
          style={position}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); move(event.key === "ArrowDown" ? 1 : -1); }
            else if (event.key === "Home" || event.key === "End") {
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                const indices = filtered.map((item, index) => !item.disabled ? index : -1).filter((index) => index >= 0);
                setActive(event.key === "Home" ? indices[0] ?? -1 : indices.at(-1) ?? -1);
              }
            } else if (event.key === "Enter") {
              event.preventDefault(); event.stopPropagation();
              const choice = filtered[active];
              if (choice && !choice.disabled) choose(choice.value);
              else if (canCreate) choose(customValue);
            } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
            else if (event.key === "Tab") {
              event.preventDefault(); close(true);
              const form = trigger.current?.closest("form");
              const controls = Array.from((form ?? document).querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex='0']"))
                .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !panel.current?.contains(element));
              const index = controls.indexOf(trigger.current!);
              controls[index + (event.shiftKey ? -1 : 1)]?.focus();
            }
          }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
            <Search className="size-4 shrink-0 text-faint" aria-hidden="true" />
            <input
              ref={search}
              role="combobox"
              aria-label={`筛选${label}`}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? <button type="button" aria-label="清空筛选" className="text-faint hover:text-ink" onClick={() => { setQuery(""); search.current?.focus(); }}><X className="size-3.5" /></button> : null}
          </div>
          <div id={listId} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto overscroll-contain p-1">
            {filtered.map((item, index) => (
              <div
                id={`${listId}-${index}`}
                key={`${item.value}-${index}`}
                role="option"
                aria-selected={item.value === selectedValue}
                aria-disabled={item.disabled || undefined}
                title={[item.label, item.value, item.hint].filter(Boolean).join(" · ")}
                className={cn("flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-[13px]", active === index ? "bg-panel-hi text-ink" : "text-muted", item.disabled && "cursor-not-allowed opacity-40")}
                onMouseEnter={() => !item.disabled && setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => !item.disabled && choose(item.value)}
              >
                <Check className={cn("mt-0.5 size-3.5 shrink-0", item.value !== selectedValue && "invisible")} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{item.label}</div>
                  {item.hint ? <div className="mt-0.5 line-clamp-2 break-words text-[11px] leading-4 text-faint">{item.hint}</div> : null}
                  {item.usageCount ? <div className="mt-0.5 text-[10px] text-accent">已使用 {item.usageCount} 次</div> : null}
                </div>
              </div>
            ))}
            {!filtered.length ? <p className="px-3 py-5 text-center text-xs text-faint" role="status">没有匹配的选项</p> : null}
          </div>
          {allowCustom ? (
            <div className="shrink-0 border-t border-line p-1">
              {canCreate ? <button type="button" className="w-full truncate rounded-lg px-3 py-2 text-left text-xs text-accent hover:bg-panel-hi" onClick={() => choose(customValue)}>使用「{customValue}」</button> : <p className="px-3 py-2 text-[11px] text-faint">也可输入列表外的值</p>}
            </div>
          ) : null}
          <div className="shrink-0 border-t border-line px-3 py-1.5 text-[10px] text-faint">{filtered.length} / {options.length} 项 · ↑↓ 选择 · Enter 确认 · Esc 关闭</div>
        </div>, document.body,
      ) : null}
    </div>
  );
}
