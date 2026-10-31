// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

/** 设置里的自定义下拉：按钮外观与菜单一致，展开层复用 `.ctx` 的描边 / 圆角 / 阴影 / 淡入。 */

import { icon } from "./icons";

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownHandle {
  readonly el: HTMLElement;
  readonly value: string;
  setOptions(options: DropdownOption[]): void;
  setValue(value: string): void;
}

let closeOpen: (() => void) | null = null;

export function createDropdown(
  options: DropdownOption[],
  initial: string,
  onChange: (value: string) => void,
): DropdownHandle {
  let current = initial;
  let items = [...options];

  const wrap = document.createElement("div");
  wrap.className = "dropdown";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dropdown__button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "dropdown__label";
  button.append(label, icon("chevron-down", "dropdown__chev"));
  wrap.appendChild(button);

  const labelFor = (value: string): string =>
    items.find((item) => item.value === value)?.label ?? value;

  const syncLabel = (): void => {
    label.textContent = labelFor(current);
  };

  let menu: HTMLElement | null = null;

  const close = (): void => {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    closeOpen = null;
  };

  const onOutside = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && (menu?.contains(target) || wrap.contains(target))) return;
    close();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      button.focus();
    }
  };

  const choose = (value: string): void => {
    if (value === current) {
      close();
      return;
    }
    current = value;
    syncLabel();
    close();
    onChange(value);
  };

  const open = (): void => {
    if (menu) {
      close();
      return;
    }
    closeOpen?.();
    const box = document.createElement("div");
    box.className = "ctx dropdown__menu";
    box.setAttribute("role", "listbox");
    for (const option of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ctx__item dropdown__item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.value === current));
      const check = document.createElement("span");
      check.className = "dropdown__check";
      if (option.value === current) check.appendChild(icon("check"));
      const text = document.createElement("span");
      text.textContent = option.label;
      item.append(check, text);
      item.addEventListener("click", () => choose(option.value));
      box.appendChild(item);
    }
    document.body.appendChild(box);
    const rect = button.getBoundingClientRect();
    box.style.minWidth = `${Math.round(rect.width)}px`;
    box.style.left = `${Math.max(4, Math.round(rect.left))}px`;
    const top = Math.round(rect.bottom + 2);
    box.style.top = `${top}px`;
    if (top + box.offsetHeight > window.innerHeight - 4) {
      box.style.top = `${Math.max(4, Math.round(rect.top - box.offsetHeight - 2))}px`;
    }
    menu = box;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    closeOpen = close;
  };

  button.addEventListener("click", () => (menu ? close() : open()));

  syncLabel();
  return {
    el: wrap,
    get value() {
      return current;
    },
    setOptions(next: DropdownOption[]): void {
      items = [...next];
      if (!items.some((item) => item.value === current) && items.length > 0) {
        current = items[0].value;
      }
      syncLabel();
    },
    setValue(value: string): void {
      current = value;
      syncLabel();
    },
  };
}