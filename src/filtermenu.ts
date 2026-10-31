// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

/**
 * 筛选菜单：左侧分类 tab、右侧选项列表，点选项即时生效。
 *
 * 高度上限是 8 个 tab 的高度；超出的部分在各自的列里滚动。
 */

import { icon } from "./icons";
import { t } from "./i18n";
import {
  attachOverlayScrollbar,
  detachOverlayScrollbar,
  refreshOverlayScrollbar,
} from "./scrollbar";

export type StyleKey = "single" | "multi" | "variable";
export type SizeKey = "lt1" | "1to5" | "5to10" | "10to20" | "20to50" | "gt50";
export type FeatureKey = "monospace" | "ligature";

export interface FilterState {
  languages: Set<string>;
  styles: Set<StyleKey>;
  sizes: Set<SizeKey>;
  features: Set<FeatureKey>;
}

export function createFilters(): FilterState {
  return {
    languages: new Set(),
    styles: new Set(),
    sizes: new Set(),
    features: new Set(),
  };
}

export function filtersActive(filters: FilterState): boolean {
  return (
    filters.languages.size > 0 ||
    filters.styles.size > 0 ||
    filters.sizes.size > 0 ||
    filters.features.size > 0
  );
}

export function resetFilters(filters: FilterState): void {
  filters.languages.clear();
  filters.styles.clear();
  filters.sizes.clear();
  filters.features.clear();
}

export interface FilterMenuOptions {
  filters: FilterState;
  /** 设备上出现过的语言（去重后按首字母/拼音排序）。 */
  languages: string[];
  onChange: () => void;
  onClose: () => void;
}

type TabKey = "language" | "style" | "size" | "feature";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "language", label: "filters.tabLanguage" },
  { key: "style", label: "filters.tabStyle" },
  { key: "size", label: "filters.tabSize" },
  { key: "feature", label: "filters.tabFeature" },
];

const SIZE_OPTIONS: SizeKey[] = ["lt1", "1to5", "5to10", "10to20", "20to50", "gt50"];

/** 大小区间与文案键尾的对应关系。 */
const SIZE_LABEL_SUFFIX: Record<SizeKey, string> = {
  lt1: "Lt1",
  "1to5": "1to5",
  "5to10": "5to10",
  "10to20": "10to20",
  "20to50": "20to50",
  gt50: "Gt50",
};

let menuEl: HTMLElement | null = null;
let activeTab: TabKey = "language";
let current: FilterMenuOptions | null = null;

export function isFilterMenuOpen(): boolean {
  // 菜单若已被移出文档（比如被别处清空），不能算作打开，否则按钮会卡在打开态
  if (menuEl && !menuEl.isConnected) {
    menuEl = null;
    current = null;
  }
  return menuEl !== null;
}

export function closeFilterMenu(): void {
  if (!menuEl) return;
  const menu = menuEl;
  menuEl = null;
  current = null;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  // 先播退场动画再移除
  detachOverlayScrollbar(menu.querySelector<HTMLElement>(".fmenu__panel"));
  menu.classList.add("is-closing");
  window.setTimeout(() => menu.remove(), 90);
}

function onOutside(event: PointerEvent): void {
  if (!menuEl) return;
  const target = event.target as Node | null;
  if (menuEl.contains(target)) return;
  // 浮层滚动条挂在 body 上，点击 / 拖动它不应关闭菜单
  if (target instanceof Element && target.closest(".ovl-scroll")) return;
  if (menuEl.dataset.anchor && document.getElementById(menuEl.dataset.anchor)?.contains(target)) {
    return;
  }
  const options = current;
  closeFilterMenu();
  options?.onClose();
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  const options = current;
  closeFilterMenu();
  options?.onClose();
}

export function openFilterMenu(
  anchor: HTMLElement,
  options: FilterMenuOptions,
): void {
  closeFilterMenu();
  current = options;

  const menu = document.createElement("div");
  menu.className = "fmenu";
  menu.dataset.anchor = anchor.id;
  menu.setAttribute("role", "dialog");

  const side = document.createElement("div");
  side.className = "fmenu__side";

  const tabs = document.createElement("div");
  tabs.className = "fmenu__tabs";

  // 底部的「清除筛选」：任何分类有勾选才可用
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "fmenu__clear";
  clear.textContent = t("filters.clear");
  clear.addEventListener("click", () => {
    if (!filtersActive(options.filters)) return;
    resetFilters(options.filters);
    renderTabs();
    renderPanel();
    options.onChange();
  });

  const panel = document.createElement("div");
  panel.className = "fmenu__panel";
  // 浮窗里的滚动条常驻显示，方便一眼看出还有更多项
  attachOverlayScrollbar(panel)?.setInset(4).setPinned(true);

  const renderTabs = (): void => {
    clear.disabled = !filtersActive(options.filters);
    clear.classList.toggle("is-active", filtersActive(options.filters));
    tabs.replaceChildren();
    for (const tab of TABS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        tab.key === activeTab ? "fmenu__tab is-active" : "fmenu__tab";
      button.appendChild(
        Object.assign(document.createElement("span"), {
          className: "fmenu__tab-label",
          textContent: t(tab.label),
        }),
      );
      // 当前分类已选了几项：0 时不显示
      const selected = selectedCount(tab.key, options.filters);
      if (selected > 0) {
        button.appendChild(
          Object.assign(document.createElement("span"), {
            className: "fmenu__tab-count",
            textContent: String(selected),
          }),
        );
      }
      button.addEventListener("click", () => {
        if (activeTab === tab.key) return;
        activeTab = tab.key;
        renderTabs();
        renderPanel();
      });
      tabs.appendChild(button);
    }
  };

  const renderPanel = (): void => {
    panel.replaceChildren();
    // 内容变化后重新计算悬浮滚动条长度
    window.requestAnimationFrame(() => refreshOverlayScrollbar(panel));
    for (const option of optionsFor(activeTab, options)) {
      panel.appendChild(
        optionRow(option.label, option.checked, () => {
          option.toggle();
          renderTabs();
          renderPanel();
          options.onChange();
        }),
      );
    }
  };

  renderTabs();
  renderPanel();
  side.append(tabs, clear);
  menu.append(side, panel);
  document.body.appendChild(menu);
  position(menu, anchor);

  menuEl = menu;
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
}

interface MenuOption {
  label: string;
  checked: boolean;
  toggle: () => void;
}

function optionsFor(tab: TabKey, options: FilterMenuOptions): MenuOption[] {
  const { filters } = options;
  if (tab === "language") {
    if (options.languages.length === 0) {
      return [{ label: t("filters.noLanguage"), checked: false, toggle: () => undefined }];
    }
    return options.languages.map((language) => ({
      label: language,
      checked: filters.languages.has(language),
      toggle: () => {
        if (filters.languages.has(language)) filters.languages.delete(language);
        else filters.languages.add(language);
      },
    }));
  }
  if (tab === "style") {
    const styles: Array<[StyleKey, string]> = [
      ["single", "filters.styleSingle"],
      ["multi", "filters.styleMulti"],
      ["variable", "filters.styleVariable"],
    ];
    return styles.map(([key, label]) => ({
      label: t(label),
      checked: filters.styles.has(key),
      toggle: () => {
        if (filters.styles.has(key)) filters.styles.delete(key);
        else filters.styles.add(key);
      },
    }));
  }
  if (tab === "size") {
    return SIZE_OPTIONS.map((key) => ({
      label: t(`filters.size${SIZE_LABEL_SUFFIX[key]}`),
      checked: filters.sizes.has(key),
      toggle: () => {
        if (filters.sizes.has(key)) filters.sizes.delete(key);
        else filters.sizes.add(key);
      },
    }));
  }
  const features: Array<[FeatureKey, string]> = [
    ["monospace", "filters.featureMonospace"],
    ["ligature", "filters.featureLigature"],
  ];
  return features.map(([key, label]) => ({
    label: t(label),
    checked: filters.features.has(key),
    toggle: () => {
      if (filters.features.has(key)) filters.features.delete(key);
      else filters.features.add(key);
    },
  }));
}

function optionRow(label: string, checked: boolean, onClick: () => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = checked ? "fmenu__opt is-checked" : "fmenu__opt";
  button.setAttribute("role", "menuitemcheckbox");
  button.setAttribute("aria-checked", String(checked));

  const mark = document.createElement("span");
  mark.className = "fmenu__check";
  if (checked) mark.appendChild(icon("check", "fmenu__check-icon"));
  button.appendChild(mark);
  button.appendChild(Object.assign(document.createElement("span"), { textContent: label, className: "fmenu__label" }));
  button.addEventListener("click", onClick);
  return button;
}

/** 贴在按钮下方左对齐；越界时向左/向上翻转。 */
function position(menu: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  menu.style.left = "0px";
  menu.style.top = "0px";
  const box = menu.getBoundingClientRect();
  const margin = 4;

  let left = rect.left;
  if (left + box.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - margin - box.width);
  }
  let top = rect.bottom + margin;
  if (top + box.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - margin - box.height);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

/** 某个分类里已勾选的数量。 */
function selectedCount(tab: TabKey, filters: FilterState): number {
  if (tab === "language") return filters.languages.size;
  if (tab === "style") return filters.styles.size;
  if (tab === "size") return filters.sizes.size;
  return filters.features.size;
}