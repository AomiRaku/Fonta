// SPDX-License-Identifier: Apache-2.0

import "./style.css";

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, errorText } from "./api";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type MenuItem, openContextMenu } from "./contextmenu";
import { createDropdown } from "./dropdown";
import logoUrl from "../docs/img/Logo.svg?url";
import wordmarkLightUrl from "../docs/img/Text_L.svg?url";
import wordmarkDarkUrl from "../docs/img/Text_D.svg?url";
import { icon, mountIcons, type IconName } from "./icons";
import { applyStaticTranslations, languageCode, languageLabel, setLanguagePack, t } from "./i18n";
import { renderDetail, renderFamilyDetail } from "./detail";
import { protectionLabel } from "./types";
import {
  closeFilterMenu,
  createFilters,
  filtersActive,
  isFilterMenuOpen,
  openFilterMenu,
} from "./filtermenu";
import { VirtualList, type VirtualRow } from "./list";
import { PreviewPool } from "./preview";
import {
  GROUP_H,
  buildFontVirtualRow,
  formatBytes,
  previewSample,
  buildFamilyRow,
  buildGroupRow,
  el,
  type RowContext,
} from "./rows";
import {
  DEFAULT_SETTINGS,
  DEFAULT_LIBRARY,
  MAX_COLLECTIONS,
  type Collection,
  type Library,
  type SidebarView,
  type DeleteReport,
  type FontEntry,
  type ResolvedTheme,
  type Settings,
  type ThemeMode,
  type DisableMode,
  type UpdateInfo,
  type UpdateProgress,
  type UpdateSource,
} from "./types";
import {
  attachOverlayScrollbar,
  detachOverlayScrollbar,
  refreshOverlayScrollbar,
} from "./scrollbar";

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const dom = {
  search: byId<HTMLInputElement>("search"),
  searchClear: byId<HTMLButtonElement>("search-clear"),
  previewText: byId<HTMLInputElement>("preview-text"),
  previewClear: byId<HTMLButtonElement>("preview-clear"),
  filter: byId<HTMLButtonElement>("filter"),
  filterLabel: byId<HTMLSpanElement>("filter-label"),
  searchCount: byId<HTMLSpanElement>("search-count"),
  theme: byId<HTMLButtonElement>("theme"),
  viewport: byId<HTMLDivElement>("viewport"),
  spacer: byId<HTMLDivElement>("spacer"),
  rows: byId<HTMLDivElement>("rows"),
  groupPin: byId<HTMLDivElement>("group-pin"),
  empty: byId<HTMLDivElement>("empty"),
  emptyTitle: byId<HTMLDivElement>("empty-title"),
  emptyHint: byId<HTMLDivElement>("empty-hint"),
  detail: byId<HTMLElement>("detail"),
  toastStack: byId<HTMLDivElement>("toast-stack"),
  collections: byId<HTMLDivElement>("collections"),
  collectionAdd: byId<HTMLButtonElement>("collection-add"),
  navAll: byId<HTMLButtonElement>("nav-all"),
  navFavorites: byId<HTMLButtonElement>("nav-favorites"),
  navHidden: byId<HTMLButtonElement>("nav-hidden"),
  collectionsEmpty: byId<HTMLDivElement>("collections-empty"),
  emptyArt: byId<HTMLDivElement>("empty-art"),
  titlebar: document.querySelector<HTMLElement>(".titlebar") as HTMLElement,
  winMin: byId<HTMLButtonElement>("win-min"),
  winMax: byId<HTMLButtonElement>("win-max"),
  winClose: byId<HTMLButtonElement>("win-close"),
  more: byId<HTMLButtonElement>("sidebar-more"),
  navMissing: byId<HTMLButtonElement>("nav-missing"),
  countAll: byId<HTMLSpanElement>("count-all"),
  countFavorites: byId<HTMLSpanElement>("count-favorites"),
  countHidden: byId<HTMLSpanElement>("count-hidden"),
  countMissing: byId<HTMLSpanElement>("count-missing"),
  detailToggle: byId<HTMLButtonElement>("detail-toggle"),
  groupButton: byId<HTMLButtonElement>("group"),

  viewButtons: Array.from(
    document.querySelectorAll<HTMLButtonElement>("button[data-view]"),
  ),
  sortButtons: Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-sort]"),
  ),
  segThumb: byId<HTMLSpanElement>("seg-thumb"),
};

/** 每个虚拟行对应的分组信息，用于吸顶标题。 */
interface RowMeta {
  kind: "group" | "font";
  groupKey: string;
  label: string;
  count: number;
  collapsed: boolean;
}

interface State {
  fonts: FontEntry[];
  filtered: FontEntry[];
  /** 当前视觉顺序（分组模式下系统字体在前），键盘导航与渲染共用。 */
  visible: FontEntry[];
  query: string;
  settings: Settings;
  selectedIds: Set<string>;
  /** Shift 范围选择的起点。 */
  anchorId: string | null;
  registryKeys: Record<string, string>;
  scanning: boolean;
  /** 已折叠的分组 key；默认收起“受保护的系统字体”。 */
  collapsed: Set<string>;
  /** 详情面板是否展开技术细节（注册表等）。 */
  detailsOpen: boolean;
  /** 当前排序：默认按名称升序。 */
  sort: { key: "name" | "enabled" | "language" | "size"; dir: 1 | -1 };
  /** 收藏与字体单。 */
  library: Library;
  /** 侧栏当前视图。 */
  view: SidebarView;
  /** 已展开的字族（`作用域:家族`）。默认全部折叠。 */
  expandedFamilies: Set<string>;
  /** 本次列表里每个字族包含的字体（折叠时不在 visible 里）。 */
  familyMembers: Map<string, FontEntry[]>;

  /** 筛选条件。 */
  filters: ReturnType<typeof createFilters>;

  /** 分组依据；默认不分组。 */
  groupBy: GroupMode;
}

const state: State = {
  fonts: [],
  filtered: [],
  visible: [],
  query: "",
  settings: { ...DEFAULT_SETTINGS },
  selectedIds: new Set<string>(),
  anchorId: null,
  registryKeys: {},

  scanning: false,
  collapsed: new Set<string>(),
  detailsOpen: false,
  sort: { key: "name", dir: 1 },
  library: { favorites: [], collections: [] },
  view: { kind: "all" },
  expandedFamilies: new Set<string>(),
  familyMembers: new Map<string, FontEntry[]>(),

  filters: createFilters(),
  groupBy: "none",
};

const appWindow = getCurrentWindow();
const pool = new PreviewPool();
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

let list: VirtualList;
let rowMeta: RowMeta[] = [];
let rowOffsets: number[] = [];
let rowKeys: string[] = [];
let rowHeights: number[] = [];


/* ───────────────────────────── 通用 UI ───────────────────────────── */

/** 右上角提示条：新提示置顶，计时结束后淡出。 */
function toast(message: string, danger = false): void {
  const node = el("div", danger ? "toast toast--danger" : "toast", message);
  const before = Array.from(dom.toastStack.children).map((child) =>
    child.getBoundingClientRect().top,
  );

  dom.toastStack.prepend(node);
  node.classList.add("toast--in");

  // 旧提示的下移用 transform 补间，避免瞬移
  Array.from(dom.toastStack.children)
    .slice(1)
    .forEach((child, index) => {
      const delta = (before[index] ?? 0) - child.getBoundingClientRect().top;
      if (delta === 0) return;
      const target = child as HTMLElement;
      target.style.transition = "none";
      target.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        target.style.transition = "transform 180ms ease-out";
        target.style.transform = "";
      });
    });

  window.setTimeout(() => {
    node.classList.add("toast--leaving");
    window.setTimeout(() => node.remove(), 180);
  }, danger ? 6500 : 3600);
}

let saveTimer = 0;
/** 重置流程中禁止任何延迟保存，避免配置目录被删后又被写回。 */
let suppressPersistence = false;
function scheduleSave(): void {
  if (suppressPersistence) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api.saveSettings(state.settings).catch(() => {
      /* 偏好写入失败不阻塞使用 */
    });
  }, 350);
}
/** 原生窗口主题（WebView2 的媒体查询不一定跟随系统，用它兜底）。 */
let nativeTheme: "light" | "dark" | null = null;


function resolveTheme(): ResolvedTheme {
  if (state.settings.theme === "system") {
    return nativeTheme ?? (systemTheme.matches ? "dark" : "light");
  }
  return state.settings.theme;
}

/** 上一次实际解析出的主题；只有真正变色时才重绘预览。 */
let appliedTheme: ResolvedTheme | null = null;

/** 先设置窗口底色再显示，避免首帧使用系统默认白底。 */
async function revealWindow(): Promise<void> {
  try {
    await appWindow.setBackgroundColor(resolveTheme() === "dark" ? "#111214" : "#F7F7F8");
  } catch {
    /* 权限或平台不支持时只影响首帧底色 */
  }
  try {
    await appWindow.show();
  } catch {
    /* 窗口已显示或平台不支持 */
  }
}
function applyTheme(): void {
  const resolved = resolveTheme();
  const changed = appliedTheme !== null && appliedTheme !== resolved;
  appliedTheme = resolved;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = state.settings.theme;
  try {
    localStorage.setItem("fontfox.themeMode", state.settings.theme);
  } catch {
    /* localStorage 不可用时只影响启动遮罩，不影响主题 */
  }
  // 让原生窗口边框跟随解析后的主题
  void appWindow.setTheme(resolved).catch(() => undefined);
  if (!changed) return;
  // 预览位图按当前主题文字色渲染：清缓存后重绘，让所有预览按新颜色重新请求
  pool.resetBitmaps();
  pool.clearLive();
  renderAll();
}

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark"];
function themeLabel(mode: ThemeMode): string {
  return t(`theme.${mode}`);
}

/** 应用字体列表行悬停设置。 */
function applyRowHover(): void {
  dom.rows.classList.toggle("rows--hover", state.settings.rowHover);
}

function syncThemeButton(): void {
  const mode = state.settings.theme;
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
  const label = t("theme.hint", { current: themeLabel(mode), next: themeLabel(next) });
  dom.theme.title = label;
  dom.theme.setAttribute("aria-label", label);
}

type SortKey = "name" | "enabled" | "language" | "size";

function applySort(key: SortKey): void {
  const current = state.sort;
  if (current.key === key) {
    state.sort = { key, dir: (current.dir === 1 ? -1 : 1) as 1 | -1 };
  } else {
    state.sort = { key, dir: 1 };
  }
  applyFilter();
  syncSortMarks();
  rebuild();
}

function syncSortMarks(): void {
  for (const button of dom.sortButtons) {
    const active = button.dataset.sort === state.sort.key;
    button.dataset.dir = active ? String(state.sort.dir) : "";
    button.classList.toggle("col--sorted", active);
  }
}

let segThumbReady = false;

/** 视图切换滑块：由 data-active 驱动 CSS 位移。 */
function syncSegThumb(): void {
  const cluster = dom.segThumb.parentElement;
  if (!cluster) return;

  if (!segThumbReady) {
    cluster.dataset.noAnim = "true";
    cluster.dataset.active = state.settings.viewMode;
    requestAnimationFrame(() => {
      delete cluster.dataset.noAnim;
    });
    segThumbReady = true;
    return;
  }
  cluster.dataset.active = state.settings.viewMode;
}

function syncToolbar(): void {
  for (const button of dom.viewButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.view === state.settings.viewMode),
    );
  }
  document.documentElement.dataset.view = state.settings.viewMode;
  dom.previewText.value = state.settings.previewText;
  syncThemeButton();
  syncSortMarks();
  // 布局完成后才能拿到按钮位置
  requestAnimationFrame(() => syncSegThumb());
}

/* ───────────────────────────── 过滤与统计 ───────────────────────────── */

function matches(entry: FontEntry, query: string): boolean {
  return (
    entry.family.toLowerCase().includes(query) ||
    entry.displayName.toLowerCase().includes(query) ||
    entry.fullName.toLowerCase().includes(query) ||
    entry.fileName.toLowerCase().includes(query) ||
    entry.valueName.toLowerCase().includes(query)
  );
}

const LANGUAGE_RANK: Record<string, number> = {
  中文: 0,
  日文: 1,
  韩文: 2,
  英语: 3,
  德语: 3,
  法语: 3,
  西班牙语: 3,
  葡萄牙语: 3,
  意大利语: 3,
  荷兰语: 3,
  瑞典语: 3,
  挪威语: 3,
  丹麦语: 3,
  芬兰语: 3,
  波兰语: 3,
  捷克语: 3,
  匈牙利语: 3,
  罗马尼亚语: 3,
  土耳其语: 3,
  越南语: 3,
  俄语: 4,
  乌克兰语: 4,
  阿拉伯语: 5,
  波斯语: 5,
  希伯来语: 6,
  希腊语: 7,
  泰语: 8,
  印地语: 9,
  其他: 10,
  未知: 11,
};

const NAME_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
/** 汉字按拼音排；引擎不支持该 collation 时退回默认中文排序。 */
const PINYIN_COLLATOR = (() => {
  try {
    return new Intl.Collator("zh-CN-u-co-pinyin", { sensitivity: "base" });
  } catch {
    return NAME_COLLATOR;
  }
})();

/** 名称排序类别：符号、数字、英文、拼音、其他文字。 */
function nameBucket(name: string): number {
  const first = Array.from(name.trim())[0];
  if (!first) return 5;
  if (/^[0-9]$/.test(first)) return 1;
  if (/^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]$/.test(first)) return 2;
  if (/^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/.test(first)) return 3;
  if (/^[\p{P}\p{S}]$/u.test(first)) return 0;
  return 4;
}

function byName(a: FontEntry, b: FontEntry): number {
  const bucketDiff = nameBucket(a.family) - nameBucket(b.family);
  if (bucketDiff !== 0) return bucketDiff;
  const collator =
    nameBucket(a.family) === 3 ? PINYIN_COLLATOR : NAME_COLLATOR;
  const byFamily = collator.compare(a.family, b.family);
  if (byFamily !== 0) return byFamily;
  // 同家族名时按字重兜底，保证顺序稳定
  return NAME_COLLATOR.compare(a.style, b.style);
}

/** 当前视图范围内的字体（全部 / 收藏 / 某个字体单）。 */
function scopedFonts(): FontEntry[] {
  const view = state.view;
  if (view.kind === "hidden") {
    return state.fonts.filter((entry) => entry.hidden);
  }
  if (view.kind === "missing") {
    return state.fonts.filter((entry) => !entry.exists);
  }
  if (view.kind === "favorites") {
    const ids = new Set(state.library.favorites);
    return state.fonts.filter((entry) => ids.has(entry.id));
  }
  if (view.kind === "collection") {
    const collection = state.library.collections.find((c) => c.id === view.id);
    const ids = new Set(collection?.fonts ?? []);
    return state.fonts.filter((entry) => ids.has(entry.id));
  }
  return state.fonts;
}

/** 每个家族的样式数量，用于「单样式 / 多样式」筛选。 */
function familyStyleCount(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of state.fonts) {
    const key = entry.family.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const SIZE_MB = 1024 * 1024;

function sizeBuckets(entry: FontEntry): string[] {
  const mb = entry.size / SIZE_MB;
  const out: string[] = [];
  if (mb < 1) out.push("lt1");
  if (mb >= 1 && mb < 5) out.push("1to5");
  if (mb >= 5 && mb < 10) out.push("5to10");
  if (mb >= 10 && mb < 20) out.push("10to20");
  if (mb >= 20 && mb < 50) out.push("20to50");
  if (mb >= 50) out.push("gt50");
  return out;
}

/** 当前筛选条件是否放行该字体。 */
function passesFilters(
  entry: FontEntry,
  styleFamilies: { single: Set<string>; multi: Set<string>; variable: Set<string> } | null,
): boolean {
  const filters = state.filters;

  if (filters.languages.size > 0) {
    const hit = entry.languages?.some((language) => filters.languages.has(language));
    if (!hit) return false;
  }

  if (filters.styles.size > 0 && styleFamilies) {
    // 样式按「家族」判定：命中就把整个家族都算进去
    const key = entry.family.trim().toLowerCase();
    const matched =
      (filters.styles.has("single") && styleFamilies.single.has(key)) ||
      (filters.styles.has("multi") && styleFamilies.multi.has(key)) ||
      (filters.styles.has("variable") && styleFamilies.variable.has(key));
    if (!matched) return false;
  }

  if (filters.sizes.size > 0) {
    const buckets = sizeBuckets(entry);
    if (!buckets.some((bucket) => filters.sizes.has(bucket as never))) return false;
  }

  if (filters.features.size > 0) {
    const ok =
      (filters.features.has("monospace") && entry.monospace) ||
      (filters.features.has("ligature") && entry.ligatures);
    if (!ok) return false;
  }

  return true;
}

/** 设备上出现过的语言（去重，按中文排序）。 */
function availableLanguages(): string[] {
  const set = new Set<string>();
  for (const entry of state.fonts) {
    for (const language of entry.languages ?? []) set.add(language);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/** 有筛选时按钮变成实心图标 + 「已筛选出 N 项」。 */
function updateFilterButton(): void {
  const active = filtersActive(state.filters);
  const iconName = active ? "filter-filled" : "filter";
  const slot = dom.filter.querySelector("svg");
  if (slot && slot.dataset.iconName !== iconName) {
    slot.replaceWith(icon(iconName, "icon-slot--filter"));
    const next = dom.filter.querySelector("svg");
    if (next) next.dataset.iconName = iconName;
  }
  dom.filter.classList.toggle("is-filtered", active);
  dom.filter.classList.toggle("icon-btn--labeled", active);
  dom.filterLabel.hidden = !active;
  if (active) {
    dom.filterLabel.textContent = t("filters.label", { count: state.filtered.length });
  }
}

/** 搜索时在筛选按钮右侧显示结果数量。 */
function updateSearchCount(): void {
  const query = state.query.trim();
  dom.searchCount.hidden = query.length === 0;
  if (query.length > 0) {
    dom.searchCount.textContent = t("toolbar.resultCount", {
      count: state.filtered.length,
    });
  }
}

function toggleFilterMenu(): void {  if (isFilterMenuOpen()) {
    closeFilterMenu();
    dom.filter.classList.remove("is-open");
    dom.filter.setAttribute("aria-expanded", "false");
    return;
  }
  dom.filter.classList.add("is-open");
  dom.filter.setAttribute("aria-expanded", "true");
  openFilterMenu(dom.filter, {
    filters: state.filters,
    languages: availableLanguages(),
    languageLabel,
    onChange: () => {
      applyFilter();
      rebuild();
      updateFilterButton();
    },
    onClose: () => {
      dom.filter.classList.remove("is-open");
      dom.filter.setAttribute("aria-expanded", "false");
    },
  });
}
function applyFilter(): void {
  const query = state.query.trim().toLowerCase();
  const source = scopedFonts();

  // 先算一次家族索引，避免每个条目重复统计
  const styleCounts = filtersActive(state.filters) ? familyStyleCount() : new Map<string, number>();
  const styleFamilies = (() => {
    if (!filtersActive(state.filters) || state.filters.styles.size === 0) return null;
    const single = new Set<string>();
    const multi = new Set<string>();
    const variable = new Set<string>();
    for (const [family, count] of styleCounts) {
      if (count === 1) single.add(family);
      else multi.add(family);
    }
    for (const entry of state.fonts) {
      if (entry.variable) variable.add(entry.family.trim().toLowerCase());
    }
    return { single, multi, variable };
  })();

  const rows = source.filter(
    (entry) =>
      (query.length === 0 || matches(entry, query)) &&
      passesFilters(entry, styleFamilies),
  );

  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    if (key === "enabled") {
      const delta = Number(a.hidden) - Number(b.hidden);
      if (delta !== 0) return delta * dir;
      return byName(a, b);
    }
    if (key === "language") {
      const delta =
        (LANGUAGE_RANK[a.language] ?? 11) - (LANGUAGE_RANK[b.language] ?? 11);
      if (delta !== 0) return delta * dir;
      return byName(a, b);
    }
    if (key === "size") {
      const delta = a.size - b.size;
      if (delta !== 0) return delta * dir;
      return byName(a, b);
    }
    return byName(a, b) * dir;
  });

  state.filtered = rows;
  // 计数随筛选结果变化，统一在过滤后刷新
  updateStats();
  updateFilterButton();
  updateSearchCount();
  syncSelectAllState();
}

/** 侧栏各分类的数量：总数 / 收藏 / 已停用 / 缺失。 */
function updateStats(): void {
  const favoriteIds = new Set(state.library.favorites);
  const hiddenCount = state.fonts.filter((f) => f.hidden).length;
  const missingCount = state.fonts.filter((f) => !f.exists).length;
  const favorites = state.fonts.filter((f) => favoriteIds.has(f.id)).length;

  dom.countAll.textContent = String(state.fonts.length);
  dom.countFavorites.textContent = String(favorites);
  dom.countHidden.textContent = String(hiddenCount);
  dom.countMissing.textContent = String(missingCount);

  // 没有缺失字体时整个入口隐藏
  dom.navMissing.hidden = missingCount === 0;
  if (missingCount === 0 && state.view.kind === "missing") {
    switchView({ kind: "all" });
  }
}

/* ───────────────────────────── 选择 ───────────────────────────── */

/** 多选：普通点击单选；Ctrl 增减；Shift 以锚点做范围选择。 */
/** 某个 scoped 字族行的成员（按分组拆开时各行为独立子集）。 */
function familyMembersOfKey(key: string): FontEntry[] {
  return state.familyMembers.get(key) ?? [];
}

/** 同名字族的并集（跨分组 / 跨作用域），用于选择归并与详情兜底。 */
function familyMembers(family: string): FontEntry[] {
  const out: FontEntry[] = [];
  const seen = new Set<string>();
  for (const members of state.familyMembers.values()) {
    for (const entry of members) {
      if (entry.family !== family || seen.has(entry.id)) continue;
      out.push(entry);
      seen.add(entry.id);
    }
  }
  return out;
}


interface SelectedFamily {
  family: string;
  members: FontEntry[];
  key: string;
}

/** 当前选择若恰好是某一个字族行（某个分组里的子集）的全部字体，返回该字族。 */
function soleSelectedFamily(): SelectedFamily | null {
  if (state.selectedIds.size === 0) return null;
  for (const [key, members] of state.familyMembers) {
    if (members.length < 2 || members.length !== state.selectedIds.size) continue;
    if (members.every((entry) => state.selectedIds.has(entry.id))) {
      return { family: members[0].family, members, key };
    }
  }
  return null;
}

/** 列表当前的可选中单元：字体行，或一个可整体选中的字族行。 */
interface SelectionUnit {
  key: string;
  ids: string[];
}

function selectionUnits(): SelectionUnit[] {
  const units: SelectionUnit[] = [];
  for (const key of rowKeys) {
    if (key.startsWith("group:")) continue;
    if (key.startsWith("family:")) {
      units.push({
        key,
        ids: familyMembersOfKey(key).map((entry) => entry.id),
      });
      continue;
    }
    units.push({ key, ids: [key] });
  }
  return units;
}

/** 某个字体属于哪一行字族（返回 scoped key）；单样式字体不属于任何字族。 */
function familyOfFont(id: string): string {
  for (const [key, members] of state.familyMembers) {
    if (members.some((entry) => entry.id === id)) return key;
  }
  return "";
}

/** Shift 范围：按当前行顺序取两个单元之间的全部字体 id。 */
function applyRange(targetKey: string): boolean {
  const anchor = state.anchorId;
  if (!anchor) return false;
  const units = selectionUnits();
  const from = units.findIndex((unit) => unit.key === anchor);
  const to = units.findIndex((unit) => unit.key === targetKey);
  if (from < 0 || to < 0) return false;
  const [start, end] = from <= to ? [from, to] : [to, from];

  // 范围终点落在某个字族行的子行上（没有完整覆盖该字族行）时，
  // 跳过这个字族行的标题单元，只选范围里的子行，避免整族被选中
  const skippedFamilies = new Set<string>();
  for (const endpoint of [anchor, targetKey]) {
    if (endpoint.startsWith("family:")) continue;
    const familyKey = familyOfFont(endpoint);
    if (!familyKey) continue;
    if (units.slice(start, end + 1).some((unit) => unit.key === familyKey)) {
      skippedFamilies.add(familyKey);
    }
  }

  const ids = new Set<string>();
  for (let i = start; i <= end; i += 1) {
    const unit = units[i];
    if (unit.key.startsWith("family:") && skippedFamilies.has(unit.key)) continue;
    for (const id of unit.ids) ids.add(id);
  }
  state.selectedIds.clear();
  for (const id of ids) state.selectedIds.add(id);
  return true;
}

/** 就地刷新行选中态（重建节点会丢掉双击的第二下）。 */
function syncRowSelection(): void {
  for (const node of dom.rows.querySelectorAll<HTMLElement>(".row")) {
    const id = node.dataset.id;
    if (id) {
      node.classList.toggle("row--selected", state.selectedIds.has(id));
      continue;
    }
    const members = node.dataset.familyKey
      ? familyMembersOfKey(node.dataset.familyKey)
      : [];
    node.classList.toggle(
      "row--selected",
      members.length > 0 && members.every((entry) => state.selectedIds.has(entry.id)),
    );
  }
  syncSelectAllState();
}

/** 选中单个字体行：普通点击替换，Ctrl 增减，Shift 按行顺序做范围选择。 */
function selectEntry(entry: FontEntry, event: MouseEvent): void {
  if (event.shiftKey && applyRange(entry.id)) {
    revealDetailForMultiSelection();
    renderAll();
    return;
  }
  const additive = event.ctrlKey || event.metaKey;
  if (additive) {
    if (state.selectedIds.has(entry.id)) {
      state.selectedIds.delete(entry.id);
    } else {
      state.selectedIds.add(entry.id);
    }
    state.anchorId = entry.id;
  } else {
    state.selectedIds = new Set([entry.id]);
    state.anchorId = entry.id;
  }
  revealDetailForMultiSelection();
  renderAll();
}
/** 选中字族行：整族等价于“全选族内字体”，Ctrl / Shift 语义与字体行一致。 */
function selectFamily(
  family: string,
  event?: MouseEvent,
  members: FontEntry[] = familyMembers(family),
  key = `family:${family}`,
): void {
  if (members.length === 0) return;

  if (event?.shiftKey && applyRange(key)) {
    syncRowSelection();
    renderDetailPane();
    return;
  }

  const additive = Boolean(event?.ctrlKey || event?.metaKey);
  const allSelected = members.every((member) => state.selectedIds.has(member.id));
  if (additive && allSelected) {
    for (const member of members) state.selectedIds.delete(member.id);
  } else if (additive) {
    for (const member of members) state.selectedIds.add(member.id);
  } else {
    state.selectedIds.clear();
    for (const member of members) state.selectedIds.add(member.id);
  }
  state.anchorId = key;
  syncRowSelection();
  renderDetailPane();
}

function selectedEntries(): FontEntry[] {
  if (state.selectedIds.size === 0) return [];
  const out: FontEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: FontEntry): void => {
    if (seen.has(entry.id)) return;
    out.push(entry);
    seen.add(entry.id);
  };

  for (const entry of state.visible) {
    if (state.selectedIds.has(entry.id)) push(entry);
  }
  for (const id of state.selectedIds) {
    if (seen.has(id)) continue;
    const entry = state.fonts.find((item) => item.id === id);
    if (entry) push(entry);
  }
  return out;
}

/** 同步表头全选方块：当前列表全部选中时点亮。 */
function syncSelectAllState(): void {
  const ids = state.filtered.map((entry) => entry.id);
  const all = ids.length > 0 && ids.every((id) => state.selectedIds.has(id));
  for (const button of document.querySelectorAll(".list-head__select-all")) {
    button.classList.toggle("is-all-selected", all);
  }
}

/** 表头左侧选中槽：全选当前列表，已全选时清空。 */
function toggleSelectAll(): void {
  const ids = state.filtered.map((entry) => entry.id);
  if (ids.length === 0) return;
  const allSelected = ids.every((id) => state.selectedIds.has(id));
  state.selectedIds = allSelected ? new Set() : new Set(ids);
  state.anchorId = null;
  revealDetailForMultiSelection();
  renderAll();
}

/** Ctrl+A：全选当前列表内容；已全选时保持选中，不反选。 */
function selectAllVisible(): void {
  const ids = state.filtered.map((entry) => entry.id);
  if (ids.length === 0) return;
  state.selectedIds = new Set(ids);
  state.anchorId = null;
  revealDetailForMultiSelection();
  renderAll();
}

function clearSelection(): void {
  state.selectedIds.clear();
  state.anchorId = null;
  renderAll();
}

/** 反向选择：当前列表里未选中的选上、已选中的取消。 */
function invertSelection(): void {
  const next = new Set<string>();
  for (const entry of state.filtered) {
    if (!state.selectedIds.has(entry.id)) next.add(entry.id);
  }
  state.selectedIds = next;
  state.anchorId = null;
  revealDetailForMultiSelection();
  renderAll();
}

/* ───────────────────────────── 渲染 ───────────────────────────── */

function makeRowContext(): RowContext {
  return {
    settings: state.settings,
    pool,
    selectedIds: state.selectedIds,
    favoriteIds: new Set(state.library.favorites),
    handlers: {
      select: (entry, event) => selectEntry(entry, event),
      toggleHidden: (entry) => {
        void toggleHidden([entry]);
      },
      cleanMissing: (entry) => {
        void cleanMissing(entry);
      },
      toggleGroup: (key) => {
        if (state.collapsed.has(key)) {
          state.collapsed.delete(key);
        } else {
          state.collapsed.add(key);
        }
        rebuild();
      },
    },
  };
}

type GroupMode = "none" | "enabled" | "style" | "modifiable" | "location" | "added";

interface GroupSpec {
  key: string;
  label: string;
  entries: FontEntry[];
}

/** 分组：受保护系统字体 / 第三方系统字体 / 用户字体。 */
/** 时间分组的标签与顺序（对齐资源管理器的「今天 / 昨天 / …」）。 */
function addedBucket(addedAt: number): { key: string; label: string; order: number } {
  const dayMs = 86_400_000;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const when = addedAt > 0 ? new Date(addedAt * 1000) : null;
  if (!when) return { key: "older", label: t("groups.older"), order: 8 };
  const day = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const days = Math.round((today - day) / dayMs);
  const sameYear = when.getFullYear() === now.getFullYear();
  const sameMonth = sameYear && when.getMonth() === now.getMonth();
  if (days <= 0) return { key: "today", label: t("groups.today"), order: 0 };
  if (days === 1) return { key: "yesterday", label: t("groups.yesterday"), order: 1 };
  if (days === 2) return { key: "before-yesterday", label: t("groups.beforeYesterday"), order: 2 };
  if (days < 7) return { key: "this-week", label: t("groups.thisWeek"), order: 3 };
  if (sameMonth) return { key: "this-month", label: t("groups.thisMonth"), order: 4 };
  const lastMonth = sameYear && when.getMonth() === now.getMonth() - 1;
  if (lastMonth) return { key: "last-month", label: t("groups.lastMonth"), order: 5 };
  if (sameYear) return { key: "this-year", label: t("groups.thisYear"), order: 6 };
  if (when.getFullYear() === now.getFullYear() - 1) {
    return { key: "last-year", label: t("groups.lastYear"), order: 7 };
  }
  return { key: "older", label: t("groups.older"), order: 8 };
}

/** 当前分组依据下的分桶；不分组时返回空数组（列表直接平铺）。 */
function buildGroups(): GroupSpec[] {
  if (state.groupBy === "none") return [];

  const buckets = new Map<string, { order: number; label: string; entries: FontEntry[] }>();
  const styleCounts = state.groupBy === "style" ? familyStyleCount() : null;


  const add = (entry: FontEntry, key: string, order: number, label: string): void => {
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.entries.push(entry);
      return;
    }
    buckets.set(key, { order, label, entries: [entry] });
  };

  for (const entry of state.filtered) {
    switch (state.groupBy) {
      case "enabled":
        if (!entry.exists) add(entry, "missing", 2, t("groups.missing"));
        else if (entry.hidden) add(entry, "disabled", 1, t("groups.disabled"));
        else add(entry, "enabled", 0, t("groups.enabled"));
        break;
      case "style": {
        if (entry.variable) {
          add(entry, "variable", 2, t("groups.variable"));
          break;
        }
        const family = entry.family.trim().toLowerCase();
        const count = styleCounts?.get(family) ?? 1;
        if (count <= 1) add(entry, "single", 0, t("groups.single"));
        else add(entry, "multi", 1, t("groups.multi"));
        break;
      }
      case "modifiable":
        if (entry.protected) add(entry, "protected", 0, t("groups.protected"));
        else add(entry, "normal", 1, t("groups.normal"));
        break;
      case "location": {
        const path = entry.path.toLowerCase();
        if (path.includes("\\microsoft\\windows\\fonts\\")) {
          add(entry, "user-dir", 1, t("groups.userDir"));
        } else if (path.includes("\\windows\\fonts\\")) {
          add(entry, "system-dir", 0, t("groups.systemDir"));
        } else {
          add(entry, "other-dir", 2, t("groups.other"));
        }
        break;
      }
      case "added": {
        const bucket = addedBucket(entry.addedAt);
        add(entry, bucket.key, bucket.order, bucket.label);
        break;
      }
      default:
        break;
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([key, bucket]) => ({ key, label: bucket.label, entries: bucket.entries }));
}

/** 把一组字体按家族聚拢，保持原有顺序。 */
function groupByFamily(entries: FontEntry[]): Map<string, FontEntry[]> {
  const families = new Map<string, FontEntry[]>();
  for (const entry of entries) {
    const key = entry.family.trim().toLowerCase() || entry.family;
    const bucket = families.get(key);
    if (bucket) bucket.push(entry);
    else families.set(key, [entry]);
  }
  return families;
}

function familyKey(scopeKey: string, family: string): string {
  return `${scopeKey}:${family.trim().toLowerCase()}`;
}

/** 展开 / 收起一个字族。 */
function toggleFamily(scopeKey: string, family: string): void {
  const key = familyKey(scopeKey, family);
  const expanding = !state.expandedFamilies.has(key);
  if (expanding) {
    state.expandedFamilies.add(key);
    state.collapsed.delete(scopeKey);
  } else {
    state.expandedFamilies.delete(key);
  }
  animateNextRebuild = expanding ? "expand" : "collapse";
  spinFamily = { key, dir: expanding ? "expand" : "collapse" };
  rebuild();
}

/** 双击字族标题行：详情收起时先打开详情，已展开时才切换字族展开状态。 */
function activateFamily(
  scopeKey: string,
  displayName: string,
  family: string,
  members: FontEntry[],
  rowKey: string,
): void {
  if (!state.settings.detailOpen) {
    selectFamily(displayName, undefined, members, rowKey);
    applyDetailOpen(true);
    scheduleSave();
    return;
  }
  toggleFamily(scopeKey, family);
}


/** 下一次 rebuild 是否播放展开/收起动画（只有用户点展开/收起时才播）。 */
let animateNextRebuild: false | "expand" | "collapse" = false;
/** 本次重建要播放箭头旋转的字族（切换展开 / 收起时设置）。 */
let spinFamily: { key: string; dir: "expand" | "collapse" } | null = null;

function rebuild(): void {

  const ctx = makeRowContext();
  const listMode = state.settings.viewMode;
  const rows: VirtualRow[] = [];
  const ordered: FontEntry[] = [];
  const meta: RowMeta[] = [];
  const familyMap = new Map<string, FontEntry[]>();

  /** 一个字族内的字体行（展开时才有）。 */
  const pushFamily = (
    entries: FontEntry[],
    scopeKey: string,
    alternateBase: number,
  ): void => {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      ordered.push(entry);
      rows.push(
        buildFontVirtualRow(
          entry,
          ctx,
          listMode,
          (alternateBase + i) % 2 === 1,
          entries.length > 1,
          i === 0,
          i === entries.length - 1,
        ),
      );
      meta.push({
        kind: "font",
        groupKey: scopeKey,
        label: "",
        count: entries.length,
        collapsed: false,
      });
    }
  };

  const pushFamilies = (entries: FontEntry[], scopeKey: string): void => {
    let alternate = 0;
    for (const [family, members] of groupByFamily(entries)) {
      const displayName = members[0].family;
      const key = familyKey(scopeKey, family);
      const expanded = state.expandedFamilies.has(key);
      // 只有一个样式的「字族」直接按普通字体行显示，不做可折叠标题
      if (members.length === 1) {
        pushFamily(members, scopeKey, alternate);
        alternate += 1;
        continue;
      }

      const total = members.reduce((sum, item) => sum + item.size, 0);
      // 只要还有一个样式是启用的，总控开关就保持开启
      const enabled = members.some((item) => !item.hidden);

      const rowKey = `family:${key}`;
      familyMap.set(rowKey, [...members]);

      rows.push(
        buildFamilyRow(displayName, members.length, {
          expanded,
          alternate: alternate % 2 === 1,
          animateChevron: spinFamily?.key === key ? spinFamily.dir : null,
          animateMeta: spinFamily?.key === key ? spinFamily.dir : null,
          favorite: members.every((entry) => ctx.favoriteIds.has(entry.id)),
          isSelected: () =>
            members.length > 0 && members.every((entry) => state.selectedIds.has(entry.id)),
          preview: listMode === "preview",
          sample: () => previewSample(members[0], ctx),
          language: members[0].language || t("language.unknown"),
          totalSize: formatBytes(total),
          enabled,
          // 整族都不可操作（受保护或文件缺失）时显示锁
          lockedLabel: members.some((item) => item.exists && !item.protected)
            ? undefined
            : protectionLabel(members[0].protection) || t("detail.protected"),
          rowKey,
          onSelect: (event) => selectFamily(displayName, event, members, rowKey),
          onActivate: () => activateFamily(scopeKey, displayName, family, members, rowKey),
          onToggleExpand: () => toggleFamily(scopeKey, family),
          onToggleHidden: () => {
            void toggleHidden(members);
          },
        }),
      );
      meta.push({
        kind: "font",
        groupKey: scopeKey,
        label: family,
        count: members.length,
        collapsed: !expanded,
      });

      alternate += 1; // 标题行本身也占一格
      if (!expanded) continue;
      pushFamily(members, scopeKey, alternate);
      alternate += members.length;
    }
  };

  const groups = buildGroups();
  if (groups.length > 0) {
    let firstGroup = true;
    for (const group of groups) {
      const collapsed = state.collapsed.has(group.key);
      const toggle = (): void => toggleGroup(group.key);
      const spin =
        spinChevron && spinChevron.key === group.key ? spinChevron.dir : null;
      rows.push(
        buildGroupRow(group.label, group.entries.length, `group:${group.key}`, {
          collapsed,
          divided: !firstGroup,
          onToggle: toggle,
          spin,
        }),
      );
      meta.push({
        kind: "group",
        groupKey: group.key,
        label: group.label,
        count: group.entries.length,
        collapsed,
      });
      firstGroup = false;

      if (collapsed) continue;
      pushFamilies(group.entries, group.key);
    }
  } else {
    pushFamilies(state.filtered, "view");
  }

  spinChevron = null;
  state.familyMembers = familyMap;
  state.visible = ordered;
  rowMeta = meta;
  rowKeys = rows.map((row) => row.key);
  rowHeights = rows.map((row) => row.height);
  rowOffsets = [];
  let offset = 0;
  for (const row of rows) {
    rowOffsets.push(offset);
    offset += row.height;
  }

  list.setRows(rows, animateNextRebuild !== false, animateNextRebuild || "expand");
  animateNextRebuild = false;
  spinFamily = null;
  refreshOverlayScrollbar(dom.viewport);
  updateGroupPin();
  updateEmptyState(rows.length === 0);
  syncSwitchPending();

}

/** 空态文案随场景变化：扫描中 / 无匹配 / 无字体。 */
function updateEmptyState(empty: boolean): void {
  dom.empty.hidden = !empty;
  if (!empty) return;
  dom.emptyArt.hidden = state.scanning;
  if (state.scanning) {
    dom.emptyTitle.textContent = t("list.emptyScanning");
    dom.emptyHint.textContent = "";
    return;
  }
  if (state.query.trim()) {
    dom.emptyTitle.textContent = t("list.emptyNoMatch");
    dom.emptyHint.textContent = t("list.emptyNoMatchHint", { query: state.query.trim() });
    return;
  }
  if (state.view.kind === "collection") {
    dom.emptyTitle.textContent = t("list.emptyCollection");
    dom.emptyHint.textContent = t("list.emptyCollectionHint");
    return;
  }
  if (state.view.kind === "missing") {
    dom.emptyTitle.textContent = t("list.emptyMissing");
    dom.emptyHint.textContent = t("list.emptyMissingHint");
    return;
  }
  if (state.view.kind === "favorites") {
    dom.emptyTitle.textContent = t("list.emptyFavorites");
    dom.emptyHint.textContent = t("list.emptyFavoritesHint");
    return;
  }
  if (state.view.kind === "hidden") {
    dom.emptyTitle.textContent = t("list.emptyHidden");
    dom.emptyHint.textContent = t("list.emptyHiddenHint");
    return;
  }
  dom.emptyTitle.textContent = t("list.emptyNone");
  dom.emptyHint.textContent = t("list.emptyNoneHint");
}

/* ─────────────────────── 吸顶分组标题 ─────────────────────── */

interface PinBand {
  band: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  toggle: HTMLButtonElement;
  groupKey: string;
}

let pinBand: PinBand | null = null;
let pinVisible = false;

/** 吸顶标题只创建一次，之后原地改文字，避免切换分组时闪一下。 */
function ensurePinBand(): PinBand {
  if (pinBand) return pinBand;

  const toggle = el("button", "group__toggle");
  toggle.type = "button";
  // 与列表内的分组带一致：红色加号 / 减号
  toggle.appendChild(el("span", "group__sign"));

  const label = el("span", "group__label");
  const count = el("span", "group__count");
  toggle.appendChild(label);
  toggle.appendChild(count);

  const band = el("div", "group");
  band.appendChild(toggle);
  band.appendChild(el("span", "group__line"));
  dom.groupPin.appendChild(band);

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const key = pinBand?.groupKey;
    if (!key) return;
    toggleGroup(key);
  });

  band.addEventListener("click", () => {
    const key = pinBand?.groupKey;
    if (key) toggleGroup(key);
  });

  pinBand = { band, label, count, toggle, groupKey: "" };
  return pinBand;
}

/** 本次切换要旋转三角的分组，rebuild 时消费一次。 */
let spinChevron: { key: string; dir: "expand" | "collapse" } | null = null;

function toggleGroup(key: string): void {
  const expanding = state.collapsed.has(key);
  if (expanding) state.collapsed.delete(key);
  else state.collapsed.add(key);

  // 收起前先看本组标题是否已经被顶出视口：这种情况下行高骤减会让
  // 浏览器把 scrollTop 夹到新的最大值，视觉上会跳到下一组去
  const headerIndex = rowKeys.indexOf(`group:${key}`);
  const headerOffset = headerIndex >= 0 ? (rowOffsets[headerIndex] ?? 0) : 0;
  const wasAboveViewport = dom.viewport.scrollTop > headerOffset + 1;

  spinChevron = { key, dir: expanding ? "expand" : "collapse" };
  animateNextRebuild = expanding ? "expand" : "collapse";
  spinFamily = { key, dir: expanding ? "expand" : "collapse" };
  rebuild();

  if (!expanding && wasAboveViewport) {
    // 把这一组的标题重新贴回顶部，不让它闪到下一组
    const index = rowKeys.indexOf(`group:${key}`);
    if (index >= 0) {
      dom.viewport.scrollTop = Math.max(0, rowOffsets[index] ?? 0);
    }
    updateGroupPin();
  }
}

interface PinState {
  meta: RowMeta;
  /** 下一个分组头相对视口顶部的距离，用于"把标题顶上去"。 */
  nextDistance: number | null;
}

function computePin(): PinState | null {
  const scrollTop = dom.viewport.scrollTop;
  if (rowMeta.length === 0) return null;

  // 最后一个「顶端已滚出视口」的分组头就是当前分组
  let current = -1;
  for (let i = 0; i < rowMeta.length; i += 1) {
    if (rowMeta[i].kind !== "group") continue;
    if (rowOffsets[i] <= scrollTop) current = i;
    else break;
  }
  if (current < 0) return null;
  // 真实标题刚好还在视口顶部时，不画副本
  if (rowOffsets[current] >= scrollTop) return null;

  let next = -1;
  for (let i = current + 1; i < rowMeta.length; i += 1) {
    if (rowMeta[i].kind === "group") {
      next = i;
      break;
    }
  }

  return {
    meta: rowMeta[current],
    nextDistance: next >= 0 ? rowOffsets[next] - scrollTop : null,
  };
}

function updateGroupPin(): void {
  const pin = computePin();

  // 宽度与列表内分组带完全一致：右侧让出滚动条
  const scrollbar = dom.viewport.offsetWidth - dom.viewport.clientWidth;
  dom.groupPin.style.right = `${scrollbar}px`;

  if (!pin) {
    if (pinVisible) {
      dom.groupPin.hidden = true;
      if (pinBand) pinBand.band.style.transform = "";
      pinVisible = false;
    }
    return;
  }

  const band = ensurePinBand();
  // 文字只在切换分组时更新
  if (band.groupKey !== pin.meta.groupKey) {
    band.groupKey = pin.meta.groupKey;
    band.label.textContent = pin.meta.label;
    band.count.textContent = String(pin.meta.count);
  }
  // 展开状态每次都要同步：吸顶状态下点开 / 收起也要更新加号减号
  band.toggle.setAttribute("aria-expanded", String(!pin.meta.collapsed));
  band.toggle.title = pin.meta.collapsed ? t("list.expandGroup") : t("list.collapseGroup");
  band.band.classList.toggle("group--collapsed", pin.meta.collapsed);

  // 下一个标题逼近时把当前吸顶标题顶出去，而不是硬切
  let push = 0;
  if (pin.nextDistance !== null && pin.nextDistance < GROUP_H) {
    push = pin.nextDistance - GROUP_H;
  }
  band.band.style.transform = push === 0 ? "" : `translateY(${push}px)`;

  if (!pinVisible) {
    dom.groupPin.hidden = false;
    pinVisible = true;
  }
}

/* ───────────────────────────── 分组菜单 ───────────────────────────── */

interface GroupOption {
  mode: GroupMode;
  label: string;
}

function groupOptions(): GroupOption[] {
  return [
    { mode: "none", label: t("groups.none") },
    { mode: "enabled", label: t("groups.byEnabled") },
    { mode: "style", label: t("groups.byStyle") },
    { mode: "modifiable", label: t("groups.byModifiable") },
    { mode: "location", label: t("groups.byLocation") },
    { mode: "added", label: t("groups.byAdded") },
  ];
}

/** 分组按钮的激活态：选中任何分组依据时保持按下样式。 */
function syncGroupButton(): void {
  const active = state.groupBy !== "none";
  dom.groupButton.classList.toggle("is-active", active);
  dom.groupButton.setAttribute("aria-pressed", String(active));
}

let groupMenu: HTMLDivElement | null = null;

function onGroupMenuOutside(event: PointerEvent): void {
  if (!groupMenu) return;
  const target = event.target as Node | null;
  if (target && (groupMenu.contains(target) || dom.groupButton.contains(target))) return;
  closeGroupMenu();
}

function onGroupMenuKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeGroupMenu();
}

function closeGroupMenu(): void {
  if (!groupMenu) return;
  const menu = groupMenu;
  groupMenu = null;
  document.removeEventListener("pointerdown", onGroupMenuOutside, true);
  document.removeEventListener("keydown", onGroupMenuKey, true);
  dom.groupButton.classList.remove("is-open");
  window.setTimeout(() => menu.remove(), 60);
}

function toggleGroupMenu(): void {
  if (groupMenu) {
    closeGroupMenu();
    return;
  }

  const menu = el("div", "group-menu");
  menu.setAttribute("role", "menu");

  for (const option of groupOptions()) {
    const item = el("button", "group-menu__item") as HTMLButtonElement;
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    const active = state.groupBy === option.mode;
    item.setAttribute("aria-checked", String(active));
    if (active) item.classList.add("is-active");
    const check = el("span", "group-menu__check");
    if (active) check.appendChild(icon("check"));
    item.appendChild(check);
    item.appendChild(el("span", "group-menu__label", option.label));
    item.addEventListener("click", () => {
      closeGroupMenu();
      if (state.groupBy === option.mode) return;
      state.groupBy = option.mode;
      state.collapsed.clear();
      syncGroupButton();
      rebuild();
      renderDetailPane();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  const anchor = dom.groupButton.getBoundingClientRect();
  const width = menu.getBoundingClientRect().width;
  const left = Math.min(anchor.left, window.innerWidth - width - 8);
  menu.style.left = `${Math.round(Math.max(8, left))}px`;
  menu.style.top = `${Math.round(anchor.bottom + 4)}px`;
  groupMenu = menu;
  dom.groupButton.classList.add("is-open");
  document.addEventListener("pointerdown", onGroupMenuOutside, true);
  document.addEventListener("keydown", onGroupMenuKey, true);
}

/* ───────────────────────────── 「更多」菜单 ───────────────────────────── */

let moreMenu: HTMLDivElement | null = null;

function onMoreOutside(event: PointerEvent): void {
  if (!moreMenu) return;
  const target = event.target as Node | null;
  if (target && (moreMenu.contains(target) || dom.more.contains(target))) return;
  closeMoreMenu();
}

function onMoreKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeMoreMenu();
}

function closeMoreMenu(): void {
  if (!moreMenu) return;
  const menu = moreMenu;
  moreMenu = null;
  document.removeEventListener("pointerdown", onMoreOutside, true);
  document.removeEventListener("keydown", onMoreKey, true);
  dom.more.classList.remove("is-open");
  menu.remove();
}

function toggleMoreMenu(): void {
  if (moreMenu) {
    closeMoreMenu();
    return;
  }
  const menu = el("div", "more-menu");
  menu.setAttribute("role", "menu");

  const items: Array<{ label: string; icon: IconName; disabled?: boolean; run?: () => void }> = [
    { label: t("more.settings"), icon: "cogwheel", run: () => openSettings() },
    { label: t("more.refresh"), icon: "refresh", run: () => void rescanWithToast() },
    { label: t("more.about"), icon: "about", run: () => void openAbout() },
  ];

  for (const item of items) {
    const button = el("button", "more-menu__item") as HTMLButtonElement;
    button.append(icon(item.icon, "more-menu__icon"), document.createTextNode(item.label));
    button.type = "button";
    button.setAttribute("role", "menuitem");
    if (item.disabled) {
      button.disabled = true;
    } else {
      button.addEventListener("click", () => {
        closeMoreMenu();
        item.run?.();
      });
    }
    menu.appendChild(button);
  }

  document.body.appendChild(menu);
  const anchor = dom.more.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.round(anchor.left))}px`;
  menu.style.bottom = `${Math.round(window.innerHeight - anchor.top + 6)}px`;
  menu.style.minWidth = `${Math.min(280, Math.max(196, Math.round(width)))}px`;

  moreMenu = menu;
  dom.more.classList.add("is-open");
  document.addEventListener("pointerdown", onMoreOutside, true);
  document.addEventListener("keydown", onMoreKey, true);
}
/* ───────────────────────────── 详情面板 ───────────────────────────── */

/** 已经请求过附加字段的字体（避免重复拉取 / 递归渲染） */
const extrasFetched = new Set<string>();

/** 详情面板的版权 / 版本 / TTC 家族名按需拉取，拉回后合并并重渲染一次。 */
function requestExtras(entries: FontEntry[]): void {
  const ids = entries.filter((entry) => !extrasFetched.has(entry.id)).map((entry) => entry.id);
  if (ids.length === 0) return;
  for (const id of ids) extrasFetched.add(id);
  void api
    .fontExtras(ids)
    .then((list) => {
      for (const extra of list) {
        const entry = state.fonts.find((font) => font.id === extra.id);
        if (!entry) continue;
        entry.families = extra.families;
        entry.version = extra.version;
        entry.copyright = extra.copyright;
      }
      renderDetailPane();
    })
    .catch(() => {
      // 拉取失败时移除标记，下次打开详情可以重试
      for (const id of ids) extrasFetched.delete(id);
    });
}

function renderDetailPane(): void {
  // 详情内容每次重建：先销毁旧的元信息滚动条，重建后再挂到新的 .detail__scroll 上
  detachOverlayScrollbar(dom.detail.querySelector<HTMLElement>(".detail__scroll"));

  // 选中的恰好是一个字族行（某个分组里的子集）的全部字体时，右侧显示该字族信息
  const selectedFamily = soleSelectedFamily();
  if (selectedFamily) {
    const family = selectedFamily.family;
    const members = selectedFamily.members;
    if (members.length > 0) {
      requestExtras(members);
      renderFamilyDetail(
        dom.detail,
        family,
        members,
        {
          settings: state.settings,
          pool,
          registryKey: "—",
          detailsOpen: false,
        },
        {
          toggleDetails: () => undefined,
          toggleHidden: (targets) => {
            void toggleHidden(targets);
          },
          requestDelete: (targets) => {
            openDeleteDialog(targets);
          },
          cleanMissing: (entry) => {
            void cleanMissing(entry);
          },
          reveal: (target) => {
            void api
              .revealPath(target.path)
              .catch((err) => toast(errorText(err), true));
          },
          invertSelection: () => invertSelection(),
        },
      );
      attachOverlayScrollbar(dom.detail.querySelector<HTMLElement>(".detail__scroll"));
      return;
    }
  }

  const entries = selectedEntries();
  requestExtras(entries);
  const registryKey = state.registryKeys[entries[0]?.scope ?? ""] ?? "—";
  renderDetail(
    dom.detail,
    entries,
    {
      settings: state.settings,
      pool,
      registryKey,
      detailsOpen: state.detailsOpen,
    },
    {
      toggleDetails: () => {
        // 展开 / 收起由详情面板自己用 DOM 动画处理，这里只记状态，避免重建后滚动跳回顶部
        state.detailsOpen = !state.detailsOpen;
      },
      toggleHidden: (targets) => {
        void toggleHidden(targets);
      },
      requestDelete: (targets) => {
        openDeleteDialog(targets);
      },
      cleanMissing: (target) => {
        void cleanMissing(target);
      },
      reveal: (target) => {
        void api
          .revealPath(target.path)
          .catch((err) => toast(errorText(err), true));
      },
      invertSelection: () => invertSelection(),
    },
  );
  attachOverlayScrollbar(dom.detail.querySelector<HTMLElement>(".detail__scroll"));
}

function renderAll(): void {
  rebuild();
  renderDetailPane();
  updateSearchCount();
  syncSelectAllState();
}

/* ───────────────────────────── 数据操作 ───────────────────────────── */

async function refresh(): Promise<boolean> {
  state.scanning = true;
  if (state.fonts.length === 0) {
    updateEmptyState(true);
  }
  try {
    const payload = await api.listFonts();
    state.fonts = payload.fonts;
    // 列表接口不带附加字段，刷新后允许详情重新拉取
    extrasFetched.clear();

    for (const warning of payload.lockedFiles) {
      toast(warning, true);
    }
    applyFilter();
    const ids = new Set(state.fonts.map((f) => f.id));
    for (const id of Array.from(state.selectedIds)) {
      if (!ids.has(id)) state.selectedIds.delete(id);
    }

    if (state.anchorId && !ids.has(state.anchorId)) state.anchorId = null;
    renderAll();
    return true;
  } catch (err) {
    toast(t("toast.scanFailed", { error: errorText(err) }), true);
    return false;
  } finally {
    state.scanning = false;
    updateEmptyState(state.visible.length === 0);
  }
}

/** 手动重新扫描字体，完成后提示数量变化。 */
async function rescanWithToast(): Promise<void> {
  const before = state.fonts.length;
  if (!(await refresh())) return;
  const delta = state.fonts.length - before;
  if (delta === 0) {
    toast(t("toast.noFontChanges"));
  } else if (delta > 0) {
    toast(t("toast.fontsAdded", { count: delta }));
  } else {
    toast(t("toast.fontsRemoved", { count: -delta }));
  }
}

/** 批量切换后同步字族总控开关（行是原地更新的，不会重建）。 */
function syncFamilySwitches(): void {
  for (const head of dom.rows.querySelectorAll<HTMLElement>(".row--family-head")) {
    const family = head.dataset.family;
    if (!family) continue;
    const key = head.dataset.familyKey;
    const members = key ? familyMembersOfKey(key) : familyMembers(family);
    if (members.length === 0) continue;
    const on = members.some((entry) => !entry.hidden);
    const sw = head.querySelector<HTMLButtonElement>(".switch");
    if (!sw) continue;
    sw.setAttribute("aria-checked", String(on));
    // 与行内开关一致：标题也随状态更新
    sw.title = t(on ? "switch.on" : "switch.off");
  }
}
/** 字体的可读名称：家族 + 字重。 */
function fontLabel(entry: FontEntry): string {
  return entry.style ? `${entry.family} ${entry.style}` : entry.family;
}

/** 正在写入的开关操作数量；切换禁用方式前要等它归零。 */
let inflightToggles = 0;
let toggleSeq = 0;
const toggleVersions = new Map<string, number>();
/** 正在等待后台写入完成的字体 id：对应行的开关保持禁用，防止重复点击。 */
const pendingToggleIds = new Set<string>();

/** 行开关与字族总控开关的禁用态：有待完成写入时禁用。 */
function syncSwitchPending(): void {
  for (const node of dom.rows.querySelectorAll<HTMLElement>(".row")) {
    const switchEl = node.querySelector<HTMLButtonElement>(".switch");
    if (!switchEl) continue;
    const id = node.dataset.id;
    const pending = id
      ? pendingToggleIds.has(id)
      : (() => {
          const key = node.dataset.familyKey;
          const members = key
            ? familyMembersOfKey(key)
            : familyMembers(node.dataset.family ?? "");
          return members.some((entry) => pendingToggleIds.has(entry.id));
        })();
    switchEl.disabled = pending;
    switchEl.classList.toggle("switch--pending", pending);
  }
}

async function toggleHidden(entries: FontEntry[]): Promise<void> {
  const targets = entries.filter((e) => e.exists && !e.protected);
  if (targets.length === 0) return;
  // 只要还有显示的，就整体隐藏；全隐藏时整体显示
  const nextHidden = targets.some((e) => !e.hidden);
  const previousHidden = new Map(targets.map((entry) => [entry.id, entry.hidden]));
  // 后台写入通常只要几毫秒；保留一个最短禁用窗口，避免“看起来没禁用”而被连续点击
  const startedAt = performance.now();
  const minPendingMs = 800;
  const version = ++toggleSeq;
  for (const target of targets) {
    toggleVersions.set(target.id, version);
    pendingToggleIds.add(target.id);
  }
  const superseded = (): boolean =>
    targets.some((target) => toggleVersions.get(target.id) !== version);

  // 先本地生效：开关立即响应，不被 IPC 往返和 WM_FONTCHANGE 广播拖住
  applyHiddenState(targets, nextHidden);
  syncSwitchPending();

  inflightToggles += 1;
  let outcome: "ok" | "error" | "ignore" = "ok";
  let message = "";
  try {
    const report = await api.setFontsHidden(
      targets.map((e) => e.id),
      nextHidden,
    );
    if (superseded()) {
      outcome = "ignore";
      return;
    }
    if (report.errors.length > 0) {
      restoreHiddenStates(previousHidden);
      outcome = "error";
      message = report.errors.join("；");
    } else {
      message =
        targets.length === 1
          ? nextHidden
            ? t("hidden.oneOn", { name: fontLabel(targets[0]) })
            : t("hidden.oneOff", { name: fontLabel(targets[0]) })
          : nextHidden
            ? t("hidden.manyOn", { count: targets.length })
            : t("hidden.manyOff", { count: targets.length });
    }
  } catch (err) {
    // 写入失败时把界面回滚到原状态；已被更新的点击覆盖则交给新请求处理
    if (!superseded()) {
      restoreHiddenStates(previousHidden);
      outcome = "error";
      message = errorText(err);
    } else {
      outcome = "ignore";
    }
  } finally {
    const remaining = minPendingMs - (performance.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, remaining));
    }
    for (const target of targets) {
      if (toggleVersions.get(target.id) === version) pendingToggleIds.delete(target.id);
    }
    syncSwitchPending();
    inflightToggles -= 1;
  }
  // 等开关恢复可点、后台写入彻底结束后再弹提示，避免和禁用态重叠
  if (outcome === "ok") toast(message);
  else if (outcome === "error") toast(message, true);
}

/** 把隐藏状态落到模型并就地刷新界面（不重建整表，保留开关动画）。 */
function restoreHiddenStates(previous: Map<string, boolean>): void {
  for (const entry of state.fonts) {
    const hidden = previous.get(entry.id);
    if (hidden !== undefined) entry.hidden = hidden;
  }
  applyFilter();
  renderAll();
}

function applyHiddenState(targets: FontEntry[], hidden: boolean): void {
  for (const entry of targets) entry.hidden = hidden;

  if (
    state.sort.key === "enabled" ||
    state.view.kind === "hidden" ||
    state.groupBy === "enabled"
  ) {
    // 顺序或分组归属会变（含「已停用」视图移除已启用的行），必须整表重排
    applyFilter();
    renderAll();
    return;
  }
  for (const entry of targets) syncRowSwitch(entry);
  syncFamilySwitches();
  renderDetailPane();
  updateStats();
}

/** 原地刷新某一行的开关状态（不重建 DOM，保留过渡动画）。 */
function syncRowSwitch(entry: FontEntry): void {
  const row = dom.rows.querySelector<HTMLElement>(
    `.row[data-id="${CSS.escape(entry.id)}"]`,
  );
  if (!row) return;
  row.classList.toggle("row--hidden", entry.hidden);
  const sw = row.querySelector<HTMLButtonElement>(".switch");
  if (!sw) return;
  const on = !entry.hidden;
  sw.setAttribute("aria-checked", String(on));
  sw.title = on
    ? entry.scope === "system"
      ? t("switch.onPerUser")
      : t("switch.on")
    : t("switch.off");
}

/** 删除后仍有文件被占用：提示用户重启电脑并再次打开 FontFox 时自动清理。 */
function showFontsLockedNotice(): void {
  const shell = buildModal({ title: t("delete.lockedTitle"), closable: false });
  const { overlay, body, footer } = shell;
  body.appendChild(el("p", "modal__lead", t("delete.lockedNote")));

  const ok = el("button", "btn btn--primary", t("delete.ok")) as HTMLButtonElement;
  ok.type = "button";
  const dismiss = (): void => dismissModal(overlay, onKey);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
  };
  ok.addEventListener("click", dismiss);
  footer.appendChild(ok);

  document.addEventListener("keydown", onKey);
  presentModal(overlay);
  ok.focus();
}

function describeDelete(report: DeleteReport, count: number): void {
  if (report.cancelled) {
    toast(report.errors[report.errors.length - 1] ?? t("toast.deleteCancelled"), false);
    return;
  }
  if (report.errors.length > 0) {
    toast(report.errors.join("；") , true);
  }
  if (report.lockedCount > 0) {
    showFontsLockedNotice();
    return;
  }
  if (report.errors.length > 0) return;
  if (report.removedCount > 0) {
    toast(
      count === 1
        ? t("toast.deletedOne")
        : t("toast.deletedMany", { count: report.removedCount }),
    );
  } else {
    toast(t("toast.deleteNothing"), true);
  }
}

async function performDelete(entries: FontEntry[]): Promise<void> {
  try {
    const report = await api.deleteFonts(entries.map((e) => e.id));
    describeDelete(report, entries.length);
  } catch (err) {
    toast(errorText(err), true);
  } finally {
    clearSelection();
    await refresh();
  }
}

async function cleanMissing(entry: FontEntry): Promise<void> {
  try {
    const report = await api.cleanMissing([entry.id]);
    if (report.errors.length > 0) {
      toast(report.errors.join("；"), true);
    } else {
      toast(t("toast.cleaned", { name: entry.family }));
    }
  } catch (err) {
    toast(errorText(err), true);
  } finally {
    await refresh();
  }
}

function moveSelection(delta: number): void {
  const list_ = state.visible;
  if (list_.length === 0) return;
  const current = list_.findIndex((f) => state.selectedIds.has(f.id));
  const next = Math.min(
    list_.length - 1,
    Math.max(0, (current < 0 ? 0 : current) + delta),
  );
  const target = list_[next];
  state.selectedIds = new Set([target.id]);
  state.anchorId = target.id;
  list.scrollToKey(target.id);
  renderAll();
}

/* ───────────────────────────── 弹窗外壳 ───────────────────────────── */

interface ModalShell {
  overlay: HTMLElement;
  panel: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
  footer: HTMLElement;
  /** 不可关闭的弹窗（如删除确认）不创建关闭按钮。 */
  close: HTMLButtonElement | null;
}

function buildModal(options: {
  title: string;
  wide?: boolean;
  narrow?: boolean;
  closable?: boolean;
}): ModalShell {
  const overlay = el("div", "modal");
  const panelClass = options.wide
    ? "modal__panel modal__panel--wide"
    : options.narrow
      ? "modal__panel modal__panel--narrow"
      : "modal__panel";
  const panel = el("div", panelClass);

  const head = el("div", "modal__head");
  head.appendChild(el("span", "modal__title", options.title));
  head.appendChild(el("span", "modal__spacer"));
  let close: HTMLButtonElement | null = null;
  if (options.closable !== false) {
    close = el("button", "modal__close") as HTMLButtonElement;
    close.type = "button";
    close.setAttribute("aria-label", t("delete.close"));
    close.appendChild(icon("close"));
    head.appendChild(close);
  }
  panel.appendChild(head);

  const body = el("div", "modal__body");
  attachOverlayScrollbar(body);
  panel.appendChild(body);
  const footer = el("div", "modal__footer");
  panel.appendChild(footer);

  overlay.appendChild(panel);

  // 弹窗遮罩盖住标题栏时，顶部仍保留一条可拖动区域
  const dragRegion = el("div", "modal__drag-region");
  dragRegion.setAttribute("data-tauri-drag-region", "");
  dragRegion.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement | null)?.closest("button, input, select")) return;
    void appWindow.toggleMaximize();
  });
  overlay.appendChild(dragRegion);
  return { overlay, panel, body, head, footer, close };
}

/** 弹窗入场：先挂载再加类，让过渡真的跑起来。 */
function presentModal(overlay: HTMLElement): void {
  document.body.appendChild(overlay);
  // 先让初始状态真正参与一次布局，否则同一帧里加类不会触发过渡
  void overlay.offsetWidth;
  requestAnimationFrame(() => overlay.classList.add("modal--in"));
}

/** 关闭弹窗：面板淡出与背景压暗都是 0.1s，等动画结束再移除节点。 */
function dismissModal(overlay: HTMLElement, onKey: (event: KeyboardEvent) => void): void {
  document.removeEventListener("keydown", onKey);
  detachOverlayScrollbar(overlay.querySelector<HTMLElement>(".modal__body"));
  detachOverlayScrollbar(overlay.querySelector<HTMLElement>(".modal__list"));
  overlay.classList.remove("modal--in");
  window.setTimeout(() => overlay.remove(), 140);
}

/* ───────────────────────────── 删除确认弹窗 ───────────────────────────── */

function openDeleteDialog(entries: FontEntry[]): void {
  // 破坏性确认：不提供右上角关闭，也不允许点外部关闭
  const shell = buildModal({ title: t("delete.title"), closable: false });
  const { overlay, body, footer } = shell;

  const needsElevation = entries.some((e) => e.requiresElevation);
  const lead = el("p", "modal__lead", t("delete.confirmList", { count: entries.length }));
  if (needsElevation) lead.append(" ", t("delete.warnUacShort"));
  body.appendChild(lead);

  const list = el("div", "modal__list");
  for (const entry of entries) {
    const item = el("div", "modal__item");
    item.appendChild(el("span", "modal__item-name", entry.family || entry.displayName));
    if (entry.style) {
      item.appendChild(el("span", "modal__item-style", entry.style));
    }
    list.appendChild(item);
  }
  body.appendChild(list);
  // 名单最多 9 行，超出后内部滚动（悬浮滚动条）
  attachOverlayScrollbar(list)?.setInset(2).setPinned(true);
  window.requestAnimationFrame(() => refreshOverlayScrollbar(list));

  const cancel = el("button", "btn btn--soft", t("delete.cancel")) as HTMLButtonElement;
  cancel.type = "button";
  const confirm = el("button", "btn btn--ghost-danger", t("delete.confirm")) as HTMLButtonElement;
  confirm.type = "button";
  const permanent = el("span", "modal__footer-note modal__footer-note--danger");
  permanent.append(
    icon("about", "modal__footer-info"),
    document.createTextNode(t("delete.warnPermanent")),
  );
  footer.appendChild(permanent);
  footer.appendChild(cancel);
  footer.appendChild(confirm);

  const dismiss = (): void => dismissModal(overlay, onKey);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
    // Enter 交给当前聚焦的按钮（默认焦点在「删除」），避免 document 监听与按钮默认动作各删一次
  };

  cancel.addEventListener("click", dismiss);
  confirm.addEventListener("click", () => {
    dismiss();
    void performDelete(entries);
  });
  document.addEventListener("keydown", onKey);

  presentModal(overlay);
  confirm.focus();
}

/* ───────────────────────────── 关于面板 ───────────────────────────── */

const GITHUB_PROFILE = "https://github.com/AomiRaku";
const GITHUB_REPO = "https://github.com/AomiRaku/font-fox";
const GITHUB_CONTRIBUTORS = "https://github.com/AomiRaku/font-fox/graphs/contributors";
const GITHUB_RELEASES = "https://github.com/AomiRaku/font-fox/releases/latest";
const GITHUB_ISSUES = "https://github.com/AomiRaku/font-fox/issues";

function openExternal(url: string): void {
  void api.openUrl(url).catch((err) => toast(errorText(err), true));
}

/** 独立窗口：开源许可（声明 / 许可证 / 第三方组件）。 */
function openLicenseDialog(
  payload: { noticeText: string; licenseText: string; thirdPartyText: string },
  onClose?: () => void,
): void {
  const shell = buildModal({ title: t("about.licenseTitle"), wide: true });
  const { overlay, head, body, footer, close } = shell;
  footer.remove();
  body.classList.add("modal__body--tabs");

  const tabs = el("div", "modal__tabs");
  head.insertBefore(tabs, close);
  const pre = el("pre", "modal__pre");
  const panes = [payload.noticeText, payload.licenseText, payload.thirdPartyText];
  const labels = [
    t("about.tabNotice"),
    t("about.tabLicense"),
    t("about.tabThirdParty"),
  ];
  const tabButtons: HTMLButtonElement[] = [];

  const show = (index: number): void => {
    pre.textContent = panes[index] ?? "";
    tabButtons.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
    });
  };

  labels.forEach((label, index) => {
    const tab = el("button", "tab", label) as HTMLButtonElement;
    tab.type = "button";
    tab.addEventListener("click", () => show(index));
    tabButtons.push(tab);
    tabs.appendChild(tab);
  });

  let closed = false;
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") finish();
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    dismissModal(overlay, onKey);
    onClose?.();
  };
  close?.addEventListener("click", finish);
  document.addEventListener("keydown", onKey);

  body.appendChild(pre);
  show(0);
  presentModal(overlay);
}

function localizedUpdateNotes(raw: string): string {
  const log = raw.split(/^\s*\*\*\*\s*$/m)[0] ?? "";
  const parts = log.split(/^\s*---\s*$/m);
  const zh = (parts[0] ?? "").replace(/^\s*中文\s*[:：]\s*/, "").trim();
  const en = (parts[1] ?? "").replace(/^\s*English\s*[:：]\s*/i, "").trim();
  return languageCode().toLowerCase().startsWith("zh") ? zh || en : en || zh;
}

function updateNotesBlock(raw: string): HTMLElement {
  const wrap = el("div", "update__notes");
  wrap.textContent = localizedUpdateNotes(raw) || t("update.emptyNotes");
  return wrap;
}

function openUpdateFailure(): void {
  const shell = buildModal({ title: t("update.failedTitle"), closable: false });
  const { overlay, body, footer } = shell;
  body.appendChild(el("p", "modal__lead", t("update.failedBody")));
  const ok = el("button", "btn btn--primary", t("update.ok")) as HTMLButtonElement;
  ok.type = "button";
  footer.appendChild(ok);
  const close = (): void => dismissModal(overlay, () => undefined);
  ok.addEventListener("click", close);
  presentModal(overlay);
  ok.focus();
}

function openUpdateDialog1(update: UpdateInfo): void {
  const shell = buildModal({
    title: t("update.foundTitle", { version: update.latestVersion }),
    closable: false,
  });
  const { overlay, body, footer } = shell;
  body.appendChild(updateNotesBlock(update.notes));

  const skip = el("button", "link update__link update__skip", t("update.skip")) as HTMLButtonElement;
  skip.type = "button";
  const download = el("button", "btn btn--primary", t("update.download")) as HTMLButtonElement;
  download.type = "button";
  const close = el("button", "btn btn--soft", t("update.close")) as HTMLButtonElement;
  close.type = "button";
  footer.classList.add("update__footer");
  footer.append(skip, download, close);

  const dismiss = (): void => dismissModal(overlay, () => undefined);
  skip.addEventListener("click", () => {
    state.settings.ignoredUpdateVersion = update.latestVersion;
    scheduleSave();
    dismiss();
  });
  download.addEventListener("click", () => {
    dismiss();
    void openDownloadDialog(update);
  });
  close.addEventListener("click", dismiss);
  presentModal(overlay);
  close.focus();
}

function openUpdateDialog2(update: UpdateInfo): void {
  const shell = buildModal({
    title: t("update.newTitle", { version: update.latestVersion }),
    closable: false,
  });
  const { overlay, body, footer } = shell;
  body.appendChild(updateNotesBlock(update.notes));

  const download = el("button", "btn btn--primary", t("update.download")) as HTMLButtonElement;
  download.type = "button";
  const close = el("button", "btn btn--soft", t("update.close")) as HTMLButtonElement;
  close.type = "button";
  footer.append(download, close);

  const dismiss = (): void => dismissModal(overlay, () => undefined);
  download.addEventListener("click", () => {
    dismiss();
    void openDownloadDialog(update);
  });
  close.addEventListener("click", dismiss);
  presentModal(overlay);
  close.focus();
}

function openUpdateLatestDialog(currentVersion: string): void {
  const shell = buildModal({ title: t("update.latestTitle"), closable: false });
  const { overlay, body, footer } = shell;
  body.appendChild(el("p", "modal__lead", t("update.latestBody")));

  const changelog = el("button", "link update__link update__skip", t("update.changelog")) as HTMLButtonElement;
  changelog.type = "button";
  const ok = el("button", "btn btn--primary", t("update.ok")) as HTMLButtonElement;
  ok.type = "button";
  footer.classList.add("update__footer");
  footer.append(changelog, ok);

  const dismiss = (): void => dismissModal(overlay, () => undefined);
  changelog.addEventListener("click", () => {
    dismiss();
    void openUpdateLog(currentVersion);
  });
  ok.addEventListener("click", dismiss);
  presentModal(overlay);
  ok.focus();
}

async function openUpdateLog(version: string): Promise<void> {
  let notes = "";
  try {
    notes = await api.releaseNotes(state.settings.updateSource, version);
  } catch {
    openUpdateFailure();
    return;
  }
  const shell = buildModal({ title: t("update.logTitle", { version }), closable: false });
  const { overlay, body, footer } = shell;
  body.appendChild(updateNotesBlock(notes));
  const close = el("button", "btn btn--soft", t("update.close")) as HTMLButtonElement;
  close.type = "button";
  footer.appendChild(close);
  const dismiss = (): void => dismissModal(overlay, () => undefined);
  close.addEventListener("click", dismiss);
  presentModal(overlay);
  close.focus();
}

function askCancelDownload(): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("update.cancelTitle"), closable: false });
    const { overlay, body, footer } = shell;
    body.appendChild(el("p", "modal__lead", t("update.cancelBody")));
    const keep = el("button", "btn btn--primary", t("update.keepDownloading")) as HTMLButtonElement;
    keep.type = "button";
    const stop = el("button", "btn btn--soft", t("update.cancelDownload")) as HTMLButtonElement;
    stop.type = "button";
    footer.append(keep, stop);
    const finish = (result: boolean): void => {
      dismissModal(overlay, () => undefined);
      resolve(result);
    };
    keep.addEventListener("click", () => finish(false));
    stop.addEventListener("click", () => finish(true));
    presentModal(overlay);
    keep.focus();
  });
}

async function openDownloadDialog(update: UpdateInfo): Promise<void> {
  const shell = buildModal({ title: t("update.downloadTitle"), closable: false });
  const { overlay, body, footer } = shell;
  const progress = el("p", "modal__lead update__progress");
  body.appendChild(progress);
  const browser = el("a", "link update__link update__browser") as HTMLAnchorElement;
  browser.href = GITHUB_RELEASES;
  browser.target = "_blank";
  browser.rel = "noreferrer";
  browser.textContent = t("update.latestRelease");
  browser.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(GITHUB_RELEASES);
  });
  const cancel = el("button", "btn btn--soft", t("update.cancel")) as HTMLButtonElement;
  cancel.type = "button";
  footer.append(browser, cancel);

  let cancelled = false;
  let finished = false;
  let unlisten: (() => void) | null = null;
  const stopListening = (): void => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
  const dismiss = (): void => dismissModal(overlay, () => undefined);
  const close = (): void => {
    stopListening();
    dismiss();
  };
  const renderProgress = (payload: UpdateProgress): void => {
    const percent = payload.total > 0
      ? Math.min(100, Math.round((payload.downloaded / payload.total) * 100))
      : 0;
    progress.textContent = t("update.downloadBody", {
      version: update.latestVersion,
      percent,
      speed: Math.round(payload.speedKbps),
    });
  };
  renderProgress({ downloaded: 0, total: 0, speedKbps: 0 });

  cancel.addEventListener("click", () => {
    void (async () => {
      const confirmed = await askCancelDownload();
      if (!confirmed || finished) return;
      cancelled = true;
      await api.cancelUpdateDownload();
      close();
    })();
  });

  presentModal(overlay);
  cancel.focus();

  try {
    unlisten = await listen<UpdateProgress>("update-download", (event) => {
      renderProgress(event.payload);
    });
  } catch {
    unlisten = null;
  }

  try {
    const path = await api.downloadUpdate(state.settings.updateSource, update.latestVersion);
    finished = true;
    if (cancelled) return;
    close();
    try {
      await api.installUpdate(path);
    } catch {
      openUpdateFailure();
    }
  } catch {
    if (!cancelled) {
      finished = true;
      close();
      openUpdateFailure();
    }
  }
}

async function checkStartupUpdate(): Promise<void> {
  try {
    const update = await api.checkUpdate(state.settings.updateSource);
    if (!update) return;
    if (state.settings.ignoredUpdateVersion === update.latestVersion) return;
    if (document.querySelector(".modal")) return;
    openUpdateDialog1(update);
  } catch {
    /* 启动检查失败不提示 */
  }
}
async function openAbout(): Promise<void> {
  let payload;
  try {
    payload = await api.about();
  } catch (err) {
    toast(errorText(err), true);
    return;
  }

  const shell = buildModal({ title: t("app.name"), wide: true });
  const { overlay, panel, body, footer, head } = shell;
  panel.classList.add("modal__panel--about");
  head.remove();
  body.classList.add("about__body");

  const main = el("div", "about");
  const logo = el("img", "about__icon") as HTMLImageElement;
  logo.src = logoUrl;
  logo.alt = "";
  const wordmark = el("div", "about__wordmark");
  const wordmarkLight = el("img", "about__wordmark--light") as HTMLImageElement;
  wordmarkLight.src = wordmarkLightUrl;
  wordmarkLight.alt = "FontFox";
  const wordmarkDark = el("img", "about__wordmark--dark") as HTMLImageElement;
  wordmarkDark.src = wordmarkDarkUrl;
  wordmarkDark.alt = "FontFox";
  wordmark.append(wordmarkLight, wordmarkDark);

  const tagline = el("p", "about__tagline", t("about.tagline"));
  const version = el(
    "p",
    "about__version",
    t("about.versionLine", { version: payload.version }),
  );
  const credits = el("p", "about__credits");
  credits.appendChild(document.createTextNode(`${t("about.madeWith")} `));
  const author = el("button", "about__link link", t("about.authorName")) as HTMLButtonElement;
  author.type = "button";
  author.addEventListener("click", () => openExternal(GITHUB_PROFILE));
  credits.appendChild(author);

  const licenseLine = el(
    "p",
    "about__license-line",
    t("about.licenseLine", { license: payload.licenseName }),
  );
  const links = el("div", "about__links");
  const openSource = el("button", "about__link link", t("about.openSource")) as HTMLButtonElement;
  openSource.type = "button";
  const contributors = el(
    "button",
    "about__link link",
    t("about.contributors"),
  ) as HTMLButtonElement;
  contributors.type = "button";
  contributors.addEventListener("click", () => openExternal(GITHUB_CONTRIBUTORS));
  const feedback = el("button", "about__link link", t("about.feedback")) as HTMLButtonElement;
  feedback.type = "button";
  feedback.addEventListener("click", () => openExternal(GITHUB_ISSUES));
  links.append(openSource, contributors, feedback);

  main.append(logo, wordmark, tagline, version, credits, licenseLine, links);

  body.replaceChildren(main);

  const github = el("a", "about__github link") as HTMLAnchorElement;
  github.href = GITHUB_REPO;
  github.target = "_blank";
  github.rel = "noreferrer";
  github.append(icon("github-logo"), document.createTextNode(t("about.github")));
  github.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(GITHUB_REPO);
  });
  const updateStatus = el("span", "about__update-status");
  const check = el("button", "btn btn--soft about__check", t("about.checkUpdate")) as HTMLButtonElement;
  check.type = "button";
  const close = el("button", "btn btn--soft", t("delete.close")) as HTMLButtonElement;
  close.type = "button";

  let knownUpdate: UpdateInfo | null = null;
  let updateState: "idle" | "checking" | "available" = "checking";
  let statusTimer = 0;
  const applyUpdateState = (
    state: "idle" | "checking" | "available",
    info?: UpdateInfo,
  ): void => {
    updateState = state;
    window.clearTimeout(statusTimer);
    check.disabled = state === "checking";
    check.className =
      state === "available" ? "btn btn--primary about__check" : "btn btn--soft about__check";
    if (state === "idle") {
      updateStatus.classList.remove("is-visible");
      statusTimer = window.setTimeout(() => {
        if (updateState === "idle") updateStatus.replaceChildren();
      }, 130);
      check.textContent = t("about.checkUpdate");
      return;
    }
    updateStatus.replaceChildren();
    if (state === "checking") {
      updateStatus.appendChild(el("span", "spinner"));
      check.textContent = t("about.checking");
    } else if (state === "available" && info) {
      updateStatus.textContent = t("about.newVersion", { version: info.latestVersion });
      check.textContent = t("about.updateButton");
    }
    requestAnimationFrame(() => updateStatus.classList.add("is-visible"));
  };
  const performUpdateCheck = async (manual: boolean): Promise<void> => {
    applyUpdateState("checking");
    try {
      const info = await api.checkUpdate(state.settings.updateSource);
      if (!document.body.contains(panel)) return;
      knownUpdate = info;
      if (info) {
        applyUpdateState("available", info);
        if (manual) openUpdateDialog2(info);
      } else {
        applyUpdateState("idle");
        if (manual) openUpdateLatestDialog(payload.version);
      }
    } catch {
      if (!document.body.contains(panel)) return;
      applyUpdateState("idle");
      if (manual) openUpdateFailure();
    }
  };
  check.addEventListener("click", () => {
    if (updateState === "checking") return;
    if (updateState === "available" && knownUpdate) {
      openUpdateDialog2(knownUpdate);
      return;
    }
    void performUpdateCheck(true);
  });

  footer.classList.add("about__footer");
  footer.append(github, updateStatus, check, close);

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
  };
  const dismiss = (): void => dismissModal(overlay, onKey);
  close.addEventListener("click", dismiss);
  openSource.addEventListener("click", () => {
    dismiss();
    openLicenseDialog(payload, () => {
      void openAbout();
    });
  });
  document.addEventListener("keydown", onKey);

  if (state.settings.autoCheckUpdates) {
    applyUpdateState("checking");
  } else {
    applyUpdateState("idle");
  }
  presentModal(overlay);
  close.focus();
  if (state.settings.autoCheckUpdates) {
    void performUpdateCheck(false);
  }
}
const SYSTEM_LANGUAGE = "system";

interface LanguageChoice {
  id: string;
  name: string;
  code: string;
}

function normalizeLocale(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

async function languageChoices(): Promise<LanguageChoice[]> {
  try {
    return await api.listLanguages();
  } catch {
    return [];
  }
}

/** 把设置值解析成实际加载的语言文件 id。 */
async function resolveLanguageId(
  setting: string,
  choices?: LanguageChoice[],
): Promise<string> {
  if (setting !== SYSTEM_LANGUAGE) return setting;
  const list = choices ?? (await languageChoices());
  if (list.length === 0) return "zh-cn";

  let locale = "";
  try {
    locale = await api.systemLocale();
  } catch {
    locale = "";
  }
  if (!locale) locale = navigator.language;

  const normalized = normalizeLocale(locale);
  if (!normalized) return list[0].id;

  const exact = list.find((item) => normalizeLocale(item.code) === normalized);
  if (exact) return exact.id;

  const primary = normalized.split("-")[0];
  if (primary === "zh") {
    const simplified =
      normalized.includes("hans") ||
      normalized === "zh-sg" ||
      normalized === "zh-my" ||
      normalized === "zh-cn";
    const preferred = simplified
      ? ["zh-cn"]
      : normalized.includes("hant")
        ? ["zh-tw", "zh-hk"]
        : ["zh-hk"];
    for (const code of preferred) {
      const match = list.find((item) => normalizeLocale(item.code) === code);
      if (match) return match.id;
    }
  } else {
    const sameLanguage = list.find(
      (item) => normalizeLocale(item.code).split("-")[0] === primary,
    );
    if (sameLanguage) return sameLanguage.id;
  }

  const english = list.find((item) => normalizeLocale(item.code) === "en-us");
  return (english ?? list.find((item) => normalizeLocale(item.code) === "zh-cn") ?? list[0]).id;
}
/* ───────────────────────────── 设置 ───────────────────────────── */

/** 设置窗口：界面语言 + 折叠的高级选项。 */
function openSettings(): void {
  const shell = buildModal({ title: t("settings.title"), closable: false });
  const { overlay, body, footer, panel } = shell;
  panel.classList.add("modal__panel--settings");

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
  };
  const dismiss = (): void => dismissModal(overlay, onKey);

  const list = el("div", "settings-list");
  const row = (labelText: string, control: HTMLElement, desc?: string): HTMLElement => {
    const item = el("div", "settings-row");
    item.appendChild(el("div", "settings-row__label", labelText));
    item.appendChild(control);
    if (desc) item.appendChild(el("p", "settings-row__desc", desc));
    return item;
  };

  const switchRow = (
    label: string,
    checked: boolean,
    onChange: (value: boolean) => void,
    desc?: string,
  ): HTMLElement => {
    const control = el("button", "switch") as HTMLButtonElement;
    control.type = "button";
    control.setAttribute("role", "switch");
    control.setAttribute("aria-checked", String(checked));
    control.setAttribute("aria-label", label);
    control.title = label;
    control.appendChild(el("span", "switch__knob"));
    control.addEventListener("click", () => {
      const next = control.getAttribute("aria-checked") !== "true";
      control.setAttribute("aria-checked", String(next));
      onChange(next);
    });
    return row(label, control, desc);
  };

  const languageSelect = createDropdown(
    [{ value: SYSTEM_LANGUAGE, label: t("settings.systemLanguage") }],
    state.settings.language,
    (id) => {
      void changeLanguage(id);
    },
  );
  languageSelect.el.classList.add("settings-row__control");
  const languageRow = row(t("settings.language"), languageSelect.el);
  languageRow.querySelector(".settings-row__label")?.append(
    icon("earth-filled", "settings-row__icon"),
  );
  list.appendChild(languageRow);

  const themeSelect = createDropdown(
    THEME_ORDER.map((mode) => ({ value: mode, label: themeLabel(mode) })),
    state.settings.theme,
    (value) => {
      state.settings.theme = value as ThemeMode;
      applyTheme();
      syncThemeButton();
      scheduleSave();
    },
  );
  themeSelect.el.classList.add("settings-row__control");
  list.appendChild(row(t("settings.theme"), themeSelect.el));
  list.appendChild(
    switchRow(
      t("settings.rowHover"),
      state.settings.rowHover,
      (value) => {
        state.settings.rowHover = value;
        applyRowHover();
        scheduleSave();
      },
      t("settings.rowHoverHint"),
    ),
  );


  list.appendChild(
    switchRow(
      t("settings.autoCheckUpdates"),
      state.settings.autoCheckUpdates,
      (value) => {
        state.settings.autoCheckUpdates = value;
        scheduleSave();
      },
      t("settings.autoCheckHint"),
    ),
  );
  void api
    .listLanguages()
    .then((languages) => {
      const current = state.settings.language;
      const options = [
        { value: SYSTEM_LANGUAGE, label: t("settings.systemLanguage") },
        ...languages.map((item) => ({ value: item.id, label: item.name })),
      ];
      if (current !== SYSTEM_LANGUAGE && !languages.some((item) => item.id === current)) {
        options.push({ value: current, label: current });
      }
      languageSelect.setOptions(options);
      languageSelect.setValue(current);
    })
    .catch(() => undefined);

  async function changeLanguage(id: string): Promise<void> {
    if (id === state.settings.language) return;
    try {
      const target = await resolveLanguageId(id);
      const pack = await api.loadLanguage(target);
      setLanguagePack(pack);
      state.settings.language = id;
      scheduleSave();
      applyStaticTranslations();
      document.documentElement.lang = languageCode() || "zh-CN";
      document.title = t("app.name");
      applyDetailOpen(state.settings.detailOpen);
      void syncMaximizeLabel();
      renderSidebar();
      syncToolbar();
      renderAll();
      // 用新语言重建设置窗口本身
      dismiss();
      openSettings();
    } catch (err) {
      toast(errorText(err), true);
      languageSelect.setValue(state.settings.language);
    }
  }

  // 高级选项：字体禁用方式，重启后生效
  const advanced = el("div", "settings-advanced");
  const advancedToggle = el("button", "settings-advanced__toggle") as HTMLButtonElement;
  advancedToggle.type = "button";
  advancedToggle.setAttribute("aria-expanded", "false");
  advancedToggle.append(
    el("span", "", t("settings.advanced")),
    icon("chevron-down", "settings-advanced__chev"),
  );

  const advancedBody = el("div", "settings-advanced__body");
  const advancedInner = el("div", "settings-advanced__inner");

  const updateSourceSelect = createDropdown(
    [
      { value: "github", label: t("settings.updateSourceGithub") },
      { value: "mirror1", label: t("settings.updateSourceMirror1") },
      { value: "mirror2", label: t("settings.updateSourceMirror2") },
    ],
    state.settings.updateSource,
    (value) => {
      state.settings.updateSource = value as UpdateSource;
      scheduleSave();
    },
  );
  updateSourceSelect.el.classList.add("settings-row__control");
  advancedInner.appendChild(
    row(
      t("settings.updateSource"),
      updateSourceSelect.el,
      t("settings.updateSourceHint"),
    ),
  );

  const modes: Array<[DisableMode, string]> = [
    ["dynamic", t("settings.modeDynamic")],
    ["windows", t("settings.modeWindows")],
  ];
  const pendingMode = state.settings.disableModeNext;
  const initialMode =
    pendingMode && pendingMode !== state.settings.disableMode
      ? pendingMode
      : state.settings.disableMode;

  const hint = el("p", "settings-hint", t("settings.restartHint"));
  hint.hidden = initialMode === state.settings.disableMode;

  const select = createDropdown(
    modes.map(([value, label]) => ({ value, label })),
    initialMode,
    (value) => {
      const next = value as DisableMode;
      const pending = next !== state.settings.disableMode;
      state.settings.disableModeNext = pending ? next : "";
      hint.hidden = !pending;
      scheduleSave();
    },
  );
  select.el.classList.add("settings-row__control");

  const disableRow = row(t("settings.disableMode"), select.el, t("settings.disableHint"));
  disableRow.appendChild(hint);
  advancedInner.appendChild(disableRow);

  const devSwitch = el("button", "switch") as HTMLButtonElement;
  devSwitch.type = "button";
  devSwitch.setAttribute("role", "switch");
  devSwitch.setAttribute("aria-checked", String(devToolsEnabled));
  devSwitch.setAttribute("aria-label", t("settings.devtools"));
  devSwitch.title = t("settings.devtools");
  devSwitch.appendChild(el("span", "switch__knob"));
  devSwitch.addEventListener("click", () => {
    devToolsEnabled = !devToolsEnabled;
    devSwitch.setAttribute("aria-checked", String(devToolsEnabled));
  });
  advancedInner.appendChild(
    row(t("settings.devtools"), devSwitch, t("settings.devtoolsHint")),
  );

  const resetButton = el(
    "button",
    "btn btn--solid btn--danger",
    t("settings.reset"),
  ) as HTMLButtonElement;
  resetButton.type = "button";
  resetButton.addEventListener("click", () => openResetDialog());
  advancedInner.appendChild(row(t("settings.resetFontFox"), resetButton));

  advancedBody.appendChild(advancedInner);
  advanced.append(advancedToggle, advancedBody);
  advancedToggle.addEventListener("click", () => {
    const open = !advanced.classList.contains("is-open");
    advanced.classList.toggle("is-open", open);
    advancedToggle.setAttribute("aria-expanded", String(open));
  });
  list.appendChild(advanced);
  body.appendChild(list);

  const close = el("button", "btn btn--soft", t("settings.close")) as HTMLButtonElement;
  close.type = "button";
  close.addEventListener("click", dismiss);
  footer.appendChild(close);

  document.addEventListener("keydown", onKey);
  presentModal(overlay);
  close.focus();
}
/* ───────────────────────────── 重置 FontFox ───────────────────────────── */

function openResetDialog(): void {
  const shell = buildModal({ title: t("settings.resetFontFox"), closable: false });
  const { overlay, body, footer } = shell;
  body.appendChild(el("p", "modal__lead", t("settings.resetConfirm")));

  const hint = el("span", "modal__footer-note");
  hint.append(
    icon("about", "modal__footer-info"),
    document.createTextNode(t("settings.resetHint")),
  );
  const cancel = el("button", "btn btn--soft", t("delete.cancel")) as HTMLButtonElement;
  cancel.type = "button";
  const reset = el("button", "btn btn--ghost-danger", t("settings.reset")) as HTMLButtonElement;
  reset.type = "button";
  footer.append(hint, cancel, reset);

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
  };
  const dismiss = (): void => dismissModal(overlay, onKey);
  cancel.addEventListener("click", dismiss);
  reset.addEventListener("click", () => {
    dismiss();
    void runReset();
  });

  document.addEventListener("keydown", onKey);
  presentModal(overlay);
  cancel.focus();
}

async function runReset(): Promise<void> {
  try {
    const report = await api.reconcileDisabledForReset();
    if (report.extra.length > 0) {
      const ok = await askResetExtra(report.extra);
      if (!ok) return;
    }
    if (report.missing.length > 0) {
      const ok = await askResetMissing(report.missing);
      if (!ok) return;
    }

    await enableAllForReset();

    // 先停掉所有延迟保存，再删配置目录，避免删完又被写回
    suppressPersistence = true;
    window.clearTimeout(saveTimer);
    window.clearTimeout(libraryTimer);
    await api.resetUserData();
    await showResetDone();
  } catch (err) {
    toast(errorText(err), true);
  }
}

/** 重置对账：多出来的隔离文件。取消关闭即中止重置。 */
function askResetExtra(
  extra: Array<{ path: string; fileName: string; family: string; style: string }>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("reconcile.extraTitle") });
    const { overlay, body, footer, close } = shell;
    body.appendChild(
      el("p", "modal__lead", t("reconcile.extraLead", { count: extra.length })),
    );
    const list = el("div", "modal__list");
    for (const file of extra) {
      const row = el("div", "modal__item");
      row.appendChild(el("span", "modal__item-name", file.family || file.fileName));
      row.appendChild(el("span", "modal__item-style", file.fileName));
      list.appendChild(row);
    }
    body.appendChild(list);
    attachOverlayScrollbar(list)?.setInset(2).setPinned(true);

    const finish = (ok: boolean): void => {
      dismissModal(overlay, onKey);
      resolve(ok);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(false);
    };
    const move = el("button", "btn btn--soft", t("settings.moveToDesktop")) as HTMLButtonElement;
    move.type = "button";
    const adopt = el("button", "btn btn--primary", t("reconcile.adopt")) as HTMLButtonElement;
    adopt.type = "button";
    footer.append(move, adopt);

    const setBusy = (busy: boolean): void => {
      move.disabled = busy;
      adopt.disabled = busy;
    };
    move.addEventListener("click", () => {
      void (async () => {
        setBusy(true);
        try {
          await api.moveDisabledToDesktop(extra.map((file) => file.path));
          finish(true);
        } catch (err) {
          toast(errorText(err), true);
          setBusy(false);
        }
      })();
    });
    adopt.addEventListener("click", () => {
      void (async () => {
        setBusy(true);
        try {
          await api.adoptDisabledFiles(extra.map((file) => file.path));
          finish(true);
        } catch (err) {
          toast(errorText(err), true);
          setBusy(false);
        }
      })();
    });
    close?.addEventListener("click", () => finish(false));
    document.addEventListener("keydown", onKey);
    presentModal(overlay);
    move.focus();
  });
}

/** 重置对账：清单里丢失的文件；只有「删除记录」按钮。 */
function askResetMissing(
  missing: Array<{ id: string; family: string; style: string }>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("reconcile.missingTitle"), closable: false });
    const { overlay, body, footer } = shell;
    body.appendChild(
      el("p", "modal__lead", t("reconcile.missingLead", { count: missing.length })),
    );
    const list = el("div", "modal__list");
    for (const record of missing) {
      const row = el("div", "modal__item");
      row.appendChild(el("span", "modal__item-name", record.family || record.id));
      if (record.style) {
        row.appendChild(el("span", "modal__item-style", record.style));
      }
      list.appendChild(row);
    }
    body.appendChild(list);
    attachOverlayScrollbar(list)?.setInset(2).setPinned(true);

    const drop = el("button", "btn btn--ghost-danger", t("reconcile.drop")) as HTMLButtonElement;
    drop.type = "button";
    footer.appendChild(drop);
    drop.addEventListener("click", () => {
      void (async () => {
        drop.disabled = true;
        try {
          await api.dropMissingDisabled(missing.map((record) => record.id));
          dismissModal(overlay, () => undefined);
          resolve(true);
        } catch (err) {
          toast(errorText(err), true);
          drop.disabled = false;
        }
      })();
    });
    presentModal(overlay);
    drop.focus();
  });
}

function askEnableRetry(): Promise<void> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("settings.retryTitle"), closable: false });
    const { overlay, body, footer } = shell;
    body.appendChild(el("p", "modal__lead", t("settings.enableFailed")));
    const retry = el("button", "btn btn--primary", t("settings.retryTitle")) as HTMLButtonElement;
    retry.type = "button";
    footer.appendChild(retry);
    retry.addEventListener("click", () => {
      dismissModal(overlay, () => undefined);
      resolve();
    });
    presentModal(overlay);
    retry.focus();
  });
}

function showEnablePartial(): Promise<void> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("settings.enablePartialTitle"), closable: false });
    const { overlay, body, footer } = shell;
    body.appendChild(el("p", "modal__lead", t("settings.enablePartial")));
    const ok = el("button", "btn btn--primary", t("settings.ok")) as HTMLButtonElement;
    ok.type = "button";
    footer.appendChild(ok);
    ok.addEventListener("click", () => {
      dismissModal(overlay, () => undefined);
      resolve();
    });
    presentModal(overlay);
    ok.focus();
  });
}

async function enableAllForReset(): Promise<void> {
  let retries = 0;
  for (;;) {
    try {
      await api.restoreAllFonts();
      return;
    } catch {
      if (retries >= 3) {
        // 移动失败时不能继续删配置目录，否则失败字体文件会丢失
        await api.moveQuarantinedToDesktop();
        await showEnablePartial();
        return;
      }
      retries += 1;
      await askEnableRetry();
    }
  }
}

function showResetDone(): Promise<void> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("settings.resetDone"), closable: false });
    const { overlay, body, footer } = shell;
    body.remove();
    const restart = el("button", "btn btn--primary", t("settings.restart")) as HTMLButtonElement;
    restart.type = "button";
    footer.appendChild(restart);
    restart.addEventListener("click", () => {
      void api.restartApp().catch((err) => toast(errorText(err), true));
      resolve();
    });
    presentModal(overlay);
    restart.focus();
  });
}
/* ───────────────────────────── 禁用文件对账 ───────────────────────────── */

/** 启动时对账禁用清单与隔离目录。 */
async function checkDisabledFiles(): Promise<void> {
  let report;
  try {
    report = await api.reconcileDisabled();
  } catch {
    return;
  }
  if (report.extra.length > 0) {
    await askAdoptDisabled(report.extra);
  }
  if (report.missing.length > 0) {
    await askDropMissingDisabled(report.missing);
  }
}

function askAdoptDisabled(
  extra: Array<{ path: string; fileName: string; family: string; style: string }>,
): Promise<void> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("reconcile.extraTitle") });
    const { overlay, body, footer, close } = shell;
    body.appendChild(
      el("p", "modal__lead", t("reconcile.extraLead", { count: extra.length })),
    );
    const list = el("div", "modal__list");
    for (const file of extra) {
      const row = el("div", "modal__item");
      row.appendChild(el("span", "modal__item-name", file.family || file.fileName));
      row.appendChild(el("span", "modal__item-style", file.fileName));
      list.appendChild(row);
    }
    body.appendChild(list);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      dismissModal(overlay, onKey);
      resolve();
    };
    const later = el("button", "btn btn--soft", t("reconcile.later")) as HTMLButtonElement;
    later.type = "button";
    later.addEventListener("click", () => {
      dismissModal(overlay, onKey);
      resolve();
    });
    const adopt = el("button", "btn btn--primary", t("reconcile.adopt")) as HTMLButtonElement;
    adopt.type = "button";
    adopt.addEventListener("click", () => {
      void (async () => {
        try {
          await api.adoptDisabledFiles(extra.map((file) => file.path));
          await refresh();
        } catch (err) {
          toast(errorText(err), true);
        }
        dismissModal(overlay, onKey);
        resolve();
      })();
    });
    footer.append(later, adopt);
    close?.addEventListener("click", () => {
      dismissModal(overlay, onKey);
      resolve();
    });
    document.addEventListener("keydown", onKey);
    presentModal(overlay);
  });
}

function askDropMissingDisabled(
  missing: Array<{ id: string; family: string; style: string }>,
): Promise<void> {
  return new Promise((resolve) => {
    const shell = buildModal({ title: t("reconcile.missingTitle") });
    const { overlay, body, footer } = shell;
    body.appendChild(
      el("p", "modal__lead", t("reconcile.missingLead", { count: missing.length })),
    );
    const list = el("div", "modal__list");
    for (const record of missing) {
      const row = el("div", "modal__item");
      row.appendChild(el("span", "modal__item-name", record.family || record.id));
      if (record.style) {
        row.appendChild(el("span", "modal__item-style", record.style));
      }
      list.appendChild(row);
    }
    body.appendChild(list);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      dismissModal(overlay, onKey);
      resolve();
    };
    const later = el("button", "btn btn--soft", t("reconcile.later")) as HTMLButtonElement;
    later.type = "button";
    later.addEventListener("click", () => {
      dismissModal(overlay, onKey);
      resolve();
    });
    const drop = el("button", "btn btn--ghost-danger", t("reconcile.drop")) as HTMLButtonElement;
    drop.type = "button";
    drop.addEventListener("click", () => {
      void (async () => {
        try {
          await api.dropMissingDisabled(missing.map((record) => record.id));
          await refresh();
        } catch (err) {
          toast(errorText(err), true);
        }
        dismissModal(overlay, onKey);
        resolve();
      })();
    });
    footer.append(later, drop);
    document.addEventListener("keydown", onKey);
    presentModal(overlay);
  });
}

/* ───────────────────────────── 事件绑定 ───────────────────────────── */

/** 屏蔽 WebView 的浏览器默认行为。 */



/** 列表滚动：更新吸顶标题。 */
function onListScroll(): void {
  updateGroupPin();
}

/** 开发者工具开关：只在当前会话有效，退出应用后回到关闭。 */
let devToolsEnabled = false;

function openDevTools(): void {
  void api.openDevTools().catch((err) => toast(errorText(err), true));
}

function bindShellBehavior(): void {
  const devMode = import.meta.env.DEV;

  document.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement | null;
    // 输入框与合集条目有各自的菜单，其余一律禁掉
    if (target?.closest("input, textarea, .sidebar__item--sub")) return;
    const selectable = target?.closest<HTMLElement>(".kv__v, .modal__pre");
    if (selectable) {
      event.preventDefault();
      const selected = window.getSelection()?.toString() ?? "";
      // 没有选中文字时只屏蔽浏览器菜单，不弹自定义菜单
      if (selected.trim().length === 0) return;
      openContextMenu(
        [
          {
            label: t("ctx.copy"),
            run: async () => {
              try {
                await writeText(selected);
              } catch {
                toast(t("toast.clipboardFailed"), true);
              }
            },
          },
        ],
        event.clientX,
        event.clientY,
      );
      return;
    }
    event.preventDefault();
  });

  // 选中的文字不允许拖放（输入框内也不允许把文字拖走）
  document.addEventListener(
    "dragstart",
    (event) => {
      event.preventDefault();
    },
    true,
  );

  // Ctrl + 滚轮缩放
  document.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) event.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    // 页面缩放 / 打印 / 查找
    if (mod && ["+", "-", "=", "0", "p", "f", "u", "j", "g"].includes(key)) {
      event.preventDefault();
      return;
    }
    // 开发者工具开关：允许 F5 / Ctrl+R 重载，F12 / F15 打开 DevTools
    if (event.key === "F12" || event.key === "F15") {
      event.preventDefault();
      if (devToolsEnabled) openDevTools();
      return;
    }
    if (event.key === "F7") {
      event.preventDefault();
      return;
    }
    if (devToolsEnabled && (event.key === "F5" || (mod && key === "r"))) return;
    // 刷新：开发期保留，方便看改动
    if (!devMode && ((mod && key === "r") || event.key === "F5")) {
      event.preventDefault();
      return;
    }
  });
}
/** 输入框右键菜单：复制 / 粘贴 / 剪切。 */
function bindInputMenu(input: HTMLInputElement): void {
  const insert = (text: string): void => {
    const from = input.selectionStart ?? input.value.length;
    const to = input.selectionEnd ?? from;
    input.value = input.value.slice(0, from) + text + input.value.slice(to);
    const caret = from + text.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  input.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const from = input.selectionStart ?? 0;
    const to = input.selectionEnd ?? 0;
    const selected = input.value.slice(from, to);

    openContextMenu(
      [
        {
          label: t("ctx.copy"),
          disabled: selected.length === 0,
          run: async () => {
            try {
              await writeText(selected);
            } catch {
              toast(t("toast.clipboardFailed"), true);
            }
          },
        },
        {
          label: t("ctx.paste"),
          run: async () => {
            try {
              const text = await readText();
              if (text) insert(text);
            } catch {
              toast(t("toast.clipboardFailed"), true);
            }
          },
        },
        {
          label: t("ctx.cut"),
          disabled: selected.length === 0,
          run: async () => {
            try {
              await writeText(selected);
              insert("");
            } catch {
              toast(t("toast.clipboardFailed"), true);
            }
          },
        },
      ],
      event.clientX,
      event.clientY,
    );
  });
}

/* ───────────────────────────── 收藏与字体单 ───────────────────────────── */

let libraryTimer = 0;
function scheduleLibrarySave(): void {
  if (suppressPersistence) return;
  window.clearTimeout(libraryTimer);
  libraryTimer = window.setTimeout(() => {
    void api.saveLibrary(state.library).catch((err) => toast(errorText(err), true));
  }, 250);
}

function isFavorite(id: string): boolean {
  return state.library.favorites.includes(id);
}

function currentCollection(): Collection | null {
  const view = state.view;
  if (view.kind !== "collection") return null;
  return state.library.collections.find((c) => c.id === view.id) ?? null;
}

/** 侧栏条目与选中态。 */
/** 字体单可用的 10 种标记色。 */
const COLLECTION_COLORS = [
  "E21414", "EB6B26", "FFC300", "B4D400", "23C22D",
  "22B7AB", "0FC3E7", "0084FF", "9239FF", "FF3FC9",
];

/** 随机取一个当前没被占用的标记色；用满时退回随机色。 */
function pickCollectionColor(): string {
  const used = new Set(state.library.collections.map((item) => item.color));
  const free = COLLECTION_COLORS.filter((color) => !used.has(color));
  const pool = free.length > 0 ? free : COLLECTION_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderSidebar(): void {
  dom.navAll.classList.toggle("is-active", state.view.kind === "all");
  dom.navFavorites.classList.toggle("is-active", state.view.kind === "favorites");
  dom.navHidden.classList.toggle("is-active", state.view.kind === "hidden");
  dom.navMissing.classList.toggle("is-active", state.view.kind === "missing");

  dom.collections.replaceChildren();
  const collections = state.library.collections;
  dom.collectionsEmpty.hidden = collections.length > 0;

  collections.forEach((collection, index) => {
    const item = el("button", "sidebar__item sidebar__item--sub");
    item.type = "button";
    item.dataset.id = collection.id;
    if (state.view.kind === "collection" && state.view.id === collection.id) {
      item.classList.add("is-active");
    }

    const marker = el("span", "sidebar__marker");
    // 老数据没有颜色：按序号分配一个，避免全是同一个色
    const color = collection.color || COLLECTION_COLORS[index % COLLECTION_COLORS.length];
    marker.style.setProperty("--marker", `#${color}`);
    item.appendChild(marker);
    item.appendChild(el("span", "sidebar__name", collection.name));
    dom.collections.appendChild(item);
  });
}

/** 切换前记录「应该保持在中间」的那一行：优先选中项，否则取视口中线所在行。 */
function pickAnchorKey(): string | null {
  if (rowKeys.length === 0) return null;
  const viewport = dom.viewport;
  const viewTop = viewport.scrollTop;
  const viewBottom = viewTop + viewport.clientHeight;

  let candidate: string | null = null;
  const soleFamily = soleSelectedFamily();
  if (soleFamily) candidate = soleFamily.key;
  else if (state.selectedIds.size === 1) candidate = [...state.selectedIds][0];

  if (candidate) {
    const index = rowKeys.indexOf(candidate);
    if (index >= 0) {
      const top = rowOffsets[index] ?? 0;
      const bottom = top + (rowHeights[index] ?? 0);
      // 选中项在视口内才以它为锚点
      if (bottom > viewTop && top < viewBottom) return candidate;
    }
  }

  // 否则取视口中线所在的行
  const center = viewTop + viewport.clientHeight / 2;
  let low = 0;
  let high = rowKeys.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((rowOffsets[mid] ?? 0) <= center) low = mid;
    else high = mid - 1;
  }
  return rowKeys[low] ?? null;
}

/** 切换紧凑 / 预览：按行高换算滚动位置，保持选中项（或屏幕中间那一行）居中。 */
function switchViewMode(mode: Settings["viewMode"]): void {
  if (mode === state.settings.viewMode) return;

  const viewport = dom.viewport;
  const atTop = viewport.scrollTop <= 1;
  const atBottom =
    viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1;
  const anchor = pickAnchorKey();
  state.settings.viewMode = mode;
  syncToolbar();
  scheduleSave();
  rebuild();
  if (atTop) {
    viewport.scrollTop = 0;
  } else if (atBottom) {
    viewport.scrollTop = viewport.scrollHeight;
  } else if (anchor) {
    list.centerKey(anchor);
  }
}
/** 展开 / 收起右侧详情面板（持久化到设置）。 */
async function syncMaximizeLabel(): Promise<void> {
  try {
    const maximized = await appWindow.isMaximized();
    document.documentElement.dataset.maximized = String(maximized);
    const label = t(maximized ? "window.restore" : "window.maximize");
    dom.winMax.title = label;
    dom.winMax.setAttribute("aria-label", label);
  } catch {
    /* 查询失败时保持现状 */
  }
}

/** 手动多选字体时展开详情面板；字族选择不算多选。 */
function revealDetailForMultiSelection(): void {
  if (state.selectedIds.size > 1 && !state.settings.detailOpen) {
    applyDetailOpen(true);
    scheduleSave();
  }
}
function applyDetailOpen(open: boolean): void {
  state.settings.detailOpen = open;
  document.documentElement.dataset.detail = open ? "open" : "closed";
  dom.detailToggle.setAttribute("aria-pressed", String(open));
  const label = open ? t("toolbar.hideDetail") : t("toolbar.showDetail");
  dom.detailToggle.title = label;
  dom.detailToggle.setAttribute("aria-label", label);
  dom.detailToggle.replaceChildren(icon(open ? "navigation-right-hide" : "navigation-right"));
}

/** 切换视图并刷新列表。 */
function switchView(view: SidebarView): void {
  state.view = view;
  state.selectedIds.clear();
  state.anchorId = null;
  state.collapsed.clear();
  renderSidebar();
  applyFilter();
  rebuild();
  renderDetailPane();
}

/** 批量收藏 / 取消收藏；整族右键时一起处理。 */
function toggleFavorites(entries: FontEntry[]): void {
  const list = state.library.favorites;
  const name = entries.length > 1 ? entries[0].family : fontLabel(entries[0]);
  const allFavorite = entries.every((entry) => list.includes(entry.id));
  if (allFavorite) {
    const removing = new Set(entries.map((entry) => entry.id));
    state.library.favorites = list.filter((id) => !removing.has(id));
    toast(t("toast.unfavorited", { name }));
  } else {
    for (const entry of entries) {
      if (!list.includes(entry.id)) list.push(entry.id);
    }
    toast(t("toast.favorited", { name }));
  }
  scheduleLibrarySave();
  renderSidebar();
  applyFilter();
  rebuild();
}

function addEntriesToCollection(entries: FontEntry[], collection: Collection): void {
  const fresh = entries.filter((entry) => !collection.fonts.includes(entry.id));
  if (fresh.length === 0) return;
  for (const entry of fresh) collection.fonts.push(entry.id);
  scheduleLibrarySave();
  const name = entries.length > 1 ? entries[0].family : fontLabel(entries[0]);
  toast(t("toast.addedToCollection", { name, list: collection.name }));
  if (state.view.kind === "collection" && state.view.id === collection.id) {
    applyFilter();
    rebuild();
  }
}

/** 批量把字体从当前字体单移除；整族右键时一起处理。 */
function removeEntriesFromCollection(entries: FontEntry[]): void {
  const collection = currentCollection();
  if (!collection) return;
  const removing = new Set(entries.map((entry) => entry.id));
  collection.fonts = collection.fonts.filter((id) => !removing.has(id));
  scheduleLibrarySave();
  const name = entries.length > 1 ? entries[0].family : fontLabel(entries[0]);
  toast(t("toast.removedFromCollection", { name, list: collection.name }));
  for (const id of removing) state.selectedIds.delete(id);
  applyFilter();
  rebuild();
  renderDetailPane();
}

/** 编辑字体单：改名字 + 选标记色。 */
function openCollectionEditor(collection: Collection): void {
  const shell = buildModal({ title: t("collectionEdit.title"), narrow: true, closable: false });
  const { overlay, body, footer, close } = shell;

  const form = el("div", "collection-edit");

  const markerField = el("div", "collection-edit__field");
  markerField.appendChild(el("span", "collection-edit__label", t("collectionEdit.marker")));
  const swatches = el("div", "collection-edit__swatches");
  let picked = collection.color || COLLECTION_COLORS[0];
  const buttons: HTMLButtonElement[] = [];
  for (const color of COLLECTION_COLORS) {
    const dot = el("button", "color-dot") as HTMLButtonElement;
    dot.type = "button";
    dot.style.setProperty("--dot", `#${color}`);
    dot.setAttribute("aria-label", color);
    dot.classList.toggle("is-active", color === picked);
    dot.addEventListener("click", () => {
      picked = color;
      for (const button of buttons) button.classList.toggle("is-active", button === dot);
    });
    buttons.push(dot);
    swatches.appendChild(dot);
  }
  markerField.appendChild(swatches);
  form.appendChild(markerField);

  const nameField = el("div", "collection-edit__field");
  // 用 span 而不是 <label>：点标题文字不应聚焦/激活输入框
  const nameLabel = el("span", "collection-edit__label", t("collectionEdit.name"));
  nameLabel.id = `collection-name-label-${collection.id}`;
  const input = document.createElement("input");
  input.className = "input";
  input.value = collection.name;
  input.placeholder = t("collectionEdit.placeholder");
  input.id = `collection-name-${collection.id}`;
  input.setAttribute("aria-labelledby", nameLabel.id);
  nameField.append(nameLabel, input);
  form.appendChild(nameField);
  body.appendChild(form);

  const cancel = el("button", "btn btn--soft", t("delete.cancel")) as HTMLButtonElement;
  cancel.type = "button";
  const confirm = el("button", "btn btn--primary", t("collectionEdit.ok")) as HTMLButtonElement;
  confirm.type = "button";
  footer.append(cancel, confirm);

  const dismiss = (): void => dismissModal(overlay, onKey);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
  };
  const save = (): void => {
    const next = input.value.trim();
    collection.name = next || collection.name;
    collection.color = picked;
    scheduleLibrarySave();
    renderSidebar();
    dismiss();
  };

  cancel.addEventListener("click", dismiss);
  confirm.addEventListener("click", save);
  close?.addEventListener("click", dismiss);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
  // 弹窗不允许点击背景关闭
  document.addEventListener("keydown", onKey);

  presentModal(overlay);
  requestAnimationFrame(() => input.select());
}
function createCollection(): void {
  if (state.library.collections.length >= MAX_COLLECTIONS) {
    toast(t("sidebar.maxCollections", { max: MAX_COLLECTIONS }), true);
    return;
  }
  const index = state.library.collections.length + 1;
  const collection: Collection = {
    id: `c${Date.now().toString(36)}`,
    name: t("sidebar.defaultCollectionName", { n: index }),
    color: pickCollectionColor(),
    fonts: [],
  };
  state.library.collections.push(collection);
  scheduleLibrarySave();
  switchView({ kind: "collection", id: collection.id });
  const item = dom.collections.querySelector<HTMLElement>(`[data-id="${collection.id}"]`);
  if (item) startRename(collection, item);
}

/** 就地重命名；提交后写回 state 并持久化。 */
function startRename(collection: Collection, item: HTMLElement): void {
  const original = collection.name;
  const input = document.createElement("input");
  input.className = "sidebar__rename";
  input.value = original;
  // 只替换名称部分，标记环保持原位，字号与常态一致
  const nameEl = item.querySelector(".sidebar__name");
  if (nameEl) nameEl.replaceWith(input);
  else item.appendChild(input);
  input.focus();
  input.select();

  let settled = false;
  const commit = (save: boolean): void => {
    if (settled) return;
    settled = true;
    const next = save ? input.value.trim() : "";
    collection.name = next || original;
    if (save && next) scheduleLibrarySave();
    renderSidebar();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

/** 删除字体单的确认框。 */
function confirmDeleteCollection(collection: Collection): void {
  const shell = buildModal({ title: t("deleteCollection.title"), closable: false });
  const { overlay, body, footer } = shell;

  body.appendChild(el("p", "modal__lead", t("deleteCollection.confirm", { name: collection.name })));

  const note = el("span", "modal__footer-note");
  note.appendChild(icon("about", "modal__footer-info"));
  note.appendChild(document.createTextNode(t("deleteCollection.note")));

  const cancel = el("button", "btn btn--soft", t("delete.cancel")) as HTMLButtonElement;
  cancel.type = "button";
  const remove = el("button", "btn btn--ghost-danger", t("delete.confirm")) as HTMLButtonElement;
  remove.type = "button";
  footer.appendChild(note);
  footer.appendChild(cancel);
  footer.appendChild(remove);

  const dismiss = (): void => dismissModal(overlay, onKey);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
  };

  cancel.addEventListener("click", dismiss);
  remove.addEventListener("click", () => {
    dismiss();
    state.library.collections = state.library.collections.filter((c) => c.id !== collection.id);
    scheduleLibrarySave();
    if (state.view.kind === "collection" && state.view.id === collection.id) {
      switchView({ kind: "all" });
    } else {
      renderSidebar();
    }
    toast(t("deleteCollection.done", { name: collection.name }));
  });
  document.addEventListener("keydown", onKey);

  presentModal(overlay);
  remove.focus();
}

/** 输入框有内容时显示右侧清空按钮，点一下清空并保持聚焦。 */
function bindClearButton(input: HTMLInputElement, button: HTMLButtonElement): void {
  const sync = (): void => {
    button.hidden = input.value.length === 0;
  };
  input.addEventListener("input", sync);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    if (input.value.length === 0) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
  sync();
}

/** 列表行右键菜单：随当前视图变化。 */
function bindRowMenu(): void {

  dom.filter.addEventListener("click", () => toggleFilterMenu());

  // 双击：保持选中；详情面板收起时展开
  dom.rows.addEventListener("dblclick", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
    if (!row) return;
    // 字族标题行有自己的双击逻辑（见 activateFamily）；字体行同样带 data-family，按 id 区分
    if (!row.dataset.id) return;
    if ((event.target as HTMLElement).closest(".switch, .row__gutter")) return;
    if (!state.settings.detailOpen) {
      applyDetailOpen(true);
      scheduleSave();
    }
  });

  dom.rows.addEventListener("contextmenu", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
    if (!row) return;
    const entries = entriesOfRow(row);
    if (entries.length === 0) return;
    event.preventDefault();

    const id = row.dataset.id ?? "";
    const family = row.dataset.family ?? "";
    const unitIds = id ? [id] : entries.map((entry) => entry.id);
    const unitSelected = unitIds.length > 0 && unitIds.every((unitId) => state.selectedIds.has(unitId));

    let targets = entries;
    let note: string | undefined;
    if (unitSelected && state.selectedIds.size > unitIds.length) {
      // 多选中右键已选项：保留多选，菜单作用于全部选中项
      targets = selectedEntries();
      note = t("ctx.selectedCount", { count: targets.length });
    } else if (!unitSelected) {
      // 右键未选项：替换为这一项（字族 → 整族）
      state.selectedIds = new Set(unitIds);
      state.anchorId = id || `family:${family}`;
      renderAll();
      targets = entries;
    }

    // 字族行始终标注整族的字体数量（等价于选中了该字族的全部字体）
    if (!note && !id) note = t("ctx.selectedCount", { count: targets.length });

    openContextMenu(rowMenuItems(targets), event.clientX, event.clientY, { note });
  });}
/** 右键命中的行对应的字体：字族行 → 整族，普通行 → 单个。 */
function entriesOfRow(row: HTMLElement): FontEntry[] {
  const id = row.dataset.id;
  if (id) {
    const entry = state.fonts.find((f) => f.id === id);
    return entry ? [entry] : [];
  }
  const key = row.dataset.familyKey;
  if (key) return familyMembersOfKey(key);
  const family = row.dataset.family;
  if (!family) return [];
  return familyMembers(family);
}

/** 行右键菜单：单个字体与整个字族共用一套，动作作用于传入的全部条目。 */
function rowMenuItems(entries: FontEntry[]): MenuItem[] {
  const allHidden = entries.every((entry) => entry.hidden);
  const togglable = entries.filter((entry) => entry.exists && !entry.protected);
  const allFavorite = entries.every((entry) => isFavorite(entry.id));
  const items: MenuItem[] = [
    {
      label: t("ctx.view"),
      run: () => {
        applyDetailOpen(true);
        scheduleSave();
      },
    },
    {
      label: allHidden ? t("ctx.enable") : t("ctx.disable"),
      disabled: togglable.length === 0,
      run: () => {
        void toggleHidden(entries);
      },
    },
  ];

  if (state.view.kind === "all") {
    items.push({
      label: allFavorite ? t("ctx.unfavorite") : t("ctx.favorite"),
      run: () => toggleFavorites(entries),
    });
    items.push({
      label: t("ctx.addToCollection"),
      disabled: state.library.collections.length === 0,
      children: state.library.collections.map((collection) => ({
        label: collection.name,
        disabled: entries.every((entry) => collection.fonts.includes(entry.id)),
        run: () => addEntriesToCollection(entries, collection),
      })),
    });
  } else if (state.view.kind === "favorites") {
    items.push({
      label: t("ctx.unfavorite"),
      run: () => toggleFavorites(entries),
    });
  } else if (state.view.kind === "collection") {
    items.push({
      label: t("ctx.removeFromCollection"),
      run: () => removeEntriesFromCollection(entries),
    });
  }
  return items;
}
/** 侧栏：导航点击、字体单新建 / 切换 / 右键菜单。 */
function bindSidebar(): void {
  dom.detailToggle.addEventListener("click", () => {
    applyDetailOpen(!state.settings.detailOpen);
    scheduleSave();
  });

  dom.navAll.addEventListener("click", () => switchView({ kind: "all" }));
  dom.navFavorites.addEventListener("click", () => switchView({ kind: "favorites" }));
  dom.navHidden.addEventListener("click", () => switchView({ kind: "hidden" }));
  dom.navMissing.addEventListener("click", () => switchView({ kind: "missing" }));
  dom.collectionAdd.addEventListener("click", createCollection);

  dom.collections.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".sidebar__item--sub");
    if (!item) return;
    const id = item.dataset.id;
    if (id) switchView({ kind: "collection", id });
  });

  dom.collections.addEventListener("contextmenu", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".sidebar__item--sub");
    if (!item) return;
    event.preventDefault();
    const collection = state.library.collections.find((c) => c.id === item.dataset.id);
    if (!collection) return;
    // 右键命中时保持该项高亮，直到菜单关闭
    if (!item.classList.contains("is-active")) item.classList.add("is-ctx");
    openContextMenu(
      [
        { label: t("ctx.edit"), run: () => openCollectionEditor(collection) },
        {
          label: t("ctx.delete"),
          danger: true,
          run: () => confirmDeleteCollection(collection),
        },
      ],
      event.clientX,
      event.clientY,
      { onClose: () => item.classList.remove("is-ctx") },
    );
  });
  renderSidebar();
}

/** 点击标题栏（拖拽区）时让输入框失焦，避免输入状态跟着窗口拖拽走。 */
function bindTitlebarBlur(): void {
  document.addEventListener(
    "mousedown",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest("input, textarea, select") || !target.closest(".titlebar")) {
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.blur();
      }
    },
    true,
  );
}

/** 自绘窗口按钮：最小化 / 最大化 / 关闭，以及双击标题栏切换最大化。 */
function bindWindowControls(): void {
  dom.winMin.addEventListener("click", () => {
    void appWindow.minimize();
  });
  dom.winMax.addEventListener("click", () => {
    void appWindow.toggleMaximize();
  });
  dom.winClose.addEventListener("click", () => {
    void appWindow.close();
  });
  dom.titlebar.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement | null)?.closest("button, input, select")) return;
    void appWindow.toggleMaximize();
  });

  void syncMaximizeLabel();
  void appWindow.onResized(() => {
    void syncMaximizeLabel();
  });
}

/** 工具栏、菜单、滚动与快捷键。 */
function bindEvents(): void {
  // 桌面应用：屏蔽浏览器右键菜单
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  dom.search.addEventListener("input", () => {
    const changed = state.query !== dom.search.value;
    state.query = dom.search.value;
    // 查询变化时展开所有分组，之后的点击折叠照常生效
    if (changed) state.collapsed.clear();
    applyFilter();
    rebuild();
  });

  bindClearButton(dom.search, dom.searchClear);
  bindClearButton(dom.previewText, dom.previewClear);

  for (const button of dom.viewButtons) {
    button.addEventListener("click", () => {
      switchViewMode(button.dataset.view as Settings["viewMode"]);
    });
  }

  // 预览文字只影响本次会话，不写入配置
  dom.previewText.addEventListener("input", () => {
    state.settings.previewText = dom.previewText.value;
    renderAll();
  });

  dom.theme.addEventListener("click", () => {
    const index = THEME_ORDER.indexOf(state.settings.theme);
    state.settings.theme = THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? "system";
    applyTheme();
    syncThemeButton();
    scheduleSave();
  });

  // 系统深浅色变化时，只有「跟随系统」需要重绘
  const syncSystemTheme = (): void => {
    if (state.settings.theme === "system") {
      applyTheme();
      syncThemeButton();
    }
  };
  void api
    .systemTheme()
    .then((label) => {
      nativeTheme = label === "light" ? "light" : "dark";
      syncSystemTheme();
    })
    .catch(() => syncSystemTheme());
  void listen<string>("system-theme", (event) => {
    nativeTheme = event.payload === "light" ? "light" : "dark";
    syncSystemTheme();
  });
  systemTheme.addEventListener("change", () => {
    if (nativeTheme === null) syncSystemTheme();
  });

  for (const button of dom.sortButtons) {
    button.addEventListener("click", () => {
      applySort(button.dataset.sort as SortKey);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".list-head__select-all")) {
    button.addEventListener("click", () => toggleSelectAll());
  }

  window.addEventListener("resize", () => {
    syncSegThumb();
  });
  dom.groupButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleGroupMenu();
  });
  dom.more.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMoreMenu();
  });
  dom.viewport.addEventListener("scroll", onListScroll, { passive: true });
  window.addEventListener("resize", () => updateGroupPin());

  // 列表获得焦点后的键盘操作
  dom.viewport.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    }
  });

  // Esc：先取消选择，再清空搜索（在输入框里也生效）。
  // 用捕获阶段：菜单的 Esc 关闭监听多在捕获阶段且晚于这里注册，
  // 只有抢在它们之前才能看到仍然打开的浮层，避免同一次 Esc 顺带清空选择。
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (document.querySelector(".modal, .ctx, .more-menu, .group-menu, .fmenu")) return;
    if (state.selectedIds.size > 0) {
      event.preventDefault();
      clearSelection();
      return;
    }
    if (!state.query) return;
    state.query = "";
    dom.search.value = "";
    applyFilter();
    rebuild();
  }, true);

  // 主界面快捷键：Ctrl+A 全选列表、Delete 等同删除按钮。
  // Ctrl+A 在捕获阶段处理：除输入控件内的文字外，任何地方都不允许选中界面文字。
  // 模态弹窗打开时两个快捷键都不生效。
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const isSelectAll = mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a";
    const target = event.target instanceof Element ? event.target : null;
    const editable = target?.closest('input, textarea, select, [contenteditable="true"]');
    if (isSelectAll) {
      // 输入控件内保留原生行为：只选中输入内容
      if (editable) return;
      // 其余位置一律阻止浏览器全选界面文字
      event.preventDefault();
      if (document.querySelector(".modal")) return;
      selectAllVisible();
      return;
    }
    if (document.querySelector(".modal")) return;
    if (editable) return;
    if (!mod && !event.altKey && !event.shiftKey && event.key === "Delete") {
      const targets = selectedEntries().filter((entry) => entry.exists && !entry.protected);
      if (targets.length === 0) return;
      event.preventDefault();
      openDeleteDialog(targets);
    }
  }, true);
}


/** 界面就绪后让启动遮罩淡出并移除（200ms）。 */
function hideSplash(): void {
  const splash = document.getElementById("splash");
  if (!splash) return;
  // 等这一帧画完再淡出，避免和首屏渲染撞在一起
  requestAnimationFrame(() => {
    splash.classList.add("is-hidden");
    window.setTimeout(() => splash.remove(), 220);
  });
}

async function boot(): Promise<void> {
  try {
    state.settings = { ...DEFAULT_SETTINGS, ...(await api.getSettings()) };
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }

  // 上次在设置里改的禁用方式：重启后才真正迁移；失败则保留到下次启动
  const pendingMode = state.settings.disableModeNext;
  if (pendingMode && pendingMode !== state.settings.disableMode) {
    try {
      const report = await api.setDisableMode(pendingMode);
      state.settings.disableMode = report.mode as DisableMode;
      state.settings.disableModeNext = "";
      await api.saveSettings(state.settings);
    } catch {
      /* 迁移失败：保留 DisableModeNext，下次启动继续尝试 */
    }
  }

  try {
    const choices = await languageChoices();
    if (
      choices.length > 0 &&
      state.settings.language !== SYSTEM_LANGUAGE &&
      !choices.some((choice) => choice.id === state.settings.language)
    ) {
      state.settings.language = SYSTEM_LANGUAGE;
      void api.saveSettings(state.settings).catch(() => undefined);
    }
    const languageId = await resolveLanguageId(state.settings.language, choices);
    let pack = await api.loadLanguage(languageId);
    if (Object.keys(pack.entries).length === 0 && languageId !== "zh-cn") {
      pack = await api.loadLanguage("zh-cn");
    }
    setLanguagePack(pack);
    document.documentElement.lang = pack.code || "zh-CN";
  } catch {
    /* 语言包读取失败时保留键名，便于发现安装问题 */
  }
  applyStaticTranslations();
  mountIcons();
  document.title = t("app.name");

  applyTheme();
  syncToolbar();
  void revealWindow();

  try {
    state.library = { ...DEFAULT_LIBRARY, ...(await api.loadLibrary()) };
  } catch {
    state.library = { ...DEFAULT_LIBRARY };
  }

  // 老数据没有标记色：补一个未被占用的颜色并落盘，避免序号变化导致换色
  let colored = false;
  for (const collection of state.library.collections) {
    if (!collection.color) {
      collection.color = pickCollectionColor();
      colored = true;
    }
  }
  if (colored) scheduleLibrarySave();

  list = new VirtualList(dom.viewport, dom.spacer, dom.rows);
  applyDetailOpen(state.settings.detailOpen);
  applyRowHover();
  syncGroupButton();

  // 滚动条改为悬浮：不占轨道，滚动时浮在右侧
  attachOverlayScrollbar(dom.viewport);
  attachOverlayScrollbar(dom.collections);

  bindWindowControls();
  bindSidebar();
  bindRowMenu();
  bindShellBehavior();
  bindInputMenu(dom.search);
  bindInputMenu(dom.previewText);
  bindTitlebarBlur();
  bindEvents();



  // 窗口失去焦点时标题栏按钮变淡
  document.documentElement.dataset.focused = String(document.hasFocus());
  void appWindow.onFocusChanged(({ payload: focused }) => {
    document.documentElement.dataset.focused = String(focused);
  });


  void api
    .registryLocation("system")
    .then((key) => {
      state.registryKeys.system = key;
    })
    .catch(() => undefined);
  void api
    .registryLocation("user")
    .then((key) => {
      state.registryKeys.user = key;
    })
    .catch(() => undefined);

  try {
    await refresh();
  } finally {
    dom.viewport.focus();
    hideSplash();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.documentElement.dataset.detailReady = "true";
      });
    });
  }
  // 对账禁用清单与隔离目录（不阻塞首屏）
  void checkDisabledFiles();
  // 启动时静默检查更新；有新版本且未被忽略才弹窗
  if (state.settings.autoCheckUpdates) {
    void checkStartupUpdate();
  }
  // 兜底：万一首屏渲染出错也别一直白屏
  window.setTimeout(hideSplash, 8000);
}

window.setTimeout(() => { void appWindow.show(); }, 2500);

void boot();