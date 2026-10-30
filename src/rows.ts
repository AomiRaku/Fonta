// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/** 列表行 / 分组头的 DOM 构造。 */

import { icon } from "./icons";
import { t } from "./i18n";
import {
  defaultPreviewText,
  PREVIEW_FONT_SIZE,
  protectionLabel,
  type FontEntry,
  type Settings,
} from "./types";
import { previewWeight, styleLabel, toHexColor, type PreviewPool } from "./preview";
import type { VirtualRow } from "./list";

export interface RowHandlers {
  /** event 携带 Ctrl / Shift，用于多选与范围选择。 */
  select(entry: FontEntry, event: MouseEvent): void;
  toggleHidden(entry: FontEntry): void;
  cleanMissing(entry: FontEntry): void;
  toggleGroup(key: string): void;
}

export interface RowContext {
  settings: Settings;
  pool: PreviewPool;
  selectedIds: ReadonlySet<string>;
  favoriteIds: ReadonlySet<string>;
  handlers: RowHandlers;
}


export const ROW_H = 38;
export const PREVIEW_ROW_H = 76;
/** 分组头：上下各留 5px 外距 + 26px 色带。 */
export const GROUP_H = 28;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatBytes(size: number): string {
  if (!size) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 受保护字体不可改动启用状态，用锁代替开关。 */
function lockIcon(title: string): SVGSVGElement {
  const svg = icon("lock", "lock");
  const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
  tip.textContent = title;
  svg.appendChild(tip);
  return svg;
}

/** 启用状态开关：开=未被列为 Inactive，关=已隐藏；受保护字体显示锁。 */
function buildSwitch(entry: FontEntry, handlers: RowHandlers): HTMLElement {
  if (!entry.exists) {
    return el("span", "cell__dash", "—");
  }
  if (entry.protected) {
    const holder = el("span", "cell__lock");
    holder.appendChild(
      lockIcon(
        t("switch.protectedTitle", { protection: protectionLabel(entry.protection) || t("detail.protected") }),
      ),
    );
    return holder;
  }
  const on = !entry.hidden;
  const button = el("button", "switch");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", String(on));
  button.appendChild(el("span", "switch__knob"));
  {
    button.title = on
      ? entry.scope === "system"
        ? t("switch.onPerUser")
        : t("switch.on")
      : t("switch.off");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.toggleHidden(entry);
    });
  }
  return button;
}

/** 已收藏字体的小方块：叠在选中标记上方的同一中心位置。 */
function favoriteMark(): HTMLElement {
  const mark = el("span", "row__favorite");
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** 行左侧的选中槽：点击按多选切换，悬停时显示 10% 透明度的标记。 */
function selectionGutter(): HTMLElement {
  const gutter = el("span", "row__gutter");
  gutter.setAttribute("aria-hidden", "true");
  return gutter;
}

function applyRowState(
  node: HTMLElement,
  entry: FontEntry,
  ctx: RowContext,
  alternate = false,
  familySpan = false,
  familyStart = false,
  familyEnd = false,
): void {
  if (alternate) node.classList.add("row--alt");
  if (familySpan) {
    node.classList.add("row--family");
    // 折叠字族里的子行：整体缩进并画左侧竖线
    node.classList.add("row--family-child");
  }
  if (familyStart) node.classList.add("row--family-start");
  if (familyEnd) node.classList.add("row--family-end");
  if (entry.hidden) node.classList.add("row--hidden");
  if (!entry.exists) node.classList.add("row--missing");
  if (ctx.selectedIds.has(entry.id)) node.classList.add("row--selected");
  node.dataset.id = entry.id;
  node.prepend(selectionGutter());
  if (ctx.favoriteIds.has(entry.id)) node.appendChild(favoriteMark());
  node.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".row__gutter")) {
      ctx.handlers.select(entry, {
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      } as MouseEvent);
      return;
    }
    ctx.handlers.select(entry, event);
  });
}

/** 紧凑行：名称 / 样式 / 状态 / 大小 / 操作（作用域列已移除）。 */
export function buildCompactRow(
  entry: FontEntry,
  ctx: RowContext,
  alternate = false,
  familySpan = false,
  familyStart = false,
  familyEnd = false,
): HTMLElement {
  const row = el("div", "row row--compact");
  row.dataset.id = entry.id;
  row.dataset.family = entry.family;
  applyRowState(row, entry, ctx, alternate, familySpan, familyStart, familyEnd);

  // 名称与样式同一行：样式紧跟在家族名后面，不加粗
  const nameCell = el("div", "cell cell--name");
  nameCell.appendChild(el("span", "name", entry.family));
  const style = styleLabel(entry);
  if (style) nameCell.appendChild(el("span", "name__style", style));
  row.appendChild(nameCell);

  row.appendChild(el("div", "cell cell--lang", entry.language || t("language.unknown")));

  row.appendChild(
    el("div", "cell cell--size", entry.exists ? formatBytes(entry.size) : "—"),
  );

  // 启用开关固定在最后一列
  const switchCell = el("div", "cell cell--switch");
  switchCell.appendChild(buildSwitch(entry, ctx.handlers));
  row.appendChild(switchCell);
  return row;
}

/** 预览行：左侧元信息，右侧用被预览字体自身渲染的文本（字号固定）。 */
export function buildPreviewRow(
  entry: FontEntry,
  ctx: RowContext,
  alternate = false,
  familySpan = false,
  familyStart = false,
  familyEnd = false,
): HTMLElement {
  const row = el("div", "row row--preview");
  row.dataset.id = entry.id;
  row.dataset.family = entry.family;
  applyRowState(row, entry, ctx, alternate, familySpan, familyStart, familyEnd);

  const meta = el("div", "row__meta");

  const title = el("div", "row__title");
  title.appendChild(el("span", "row__family", entry.family));
  const style = styleLabel(entry);
  if (style) title.appendChild(el("span", "row__style", style));
  meta.appendChild(title);
  row.appendChild(meta);

  row.appendChild(previewSample(entry, ctx));

  const switchCell = el("div", "cell cell--switch row__switch");
  switchCell.appendChild(buildSwitch(entry, ctx.handlers));
  row.appendChild(switchCell);
  return row;
}

export interface GroupRowOptions {
  collapsed: boolean;
  /** 是否在顶部压一条分隔线（首个分组不需要）。 */
  divided?: boolean;
  onToggle: () => void;
  /** 本次切换方向，只给被点击的那个分组加旋转动画。 */
  /** 仅在首次渲染时播放三角旋转（之后滚动重建不再重播）。 */
  spin?: "expand" | "collapse" | null;
}

/** 分组头元素：色带 + 箭头 + 标签 + 计数。吸顶时复用同一个构造函数。 */
export function buildGroupBand(
  label: string,
  count: number,
  options: GroupRowOptions,
): HTMLElement {
  const classes = ["group"];
  if (options.collapsed) classes.push("group--collapsed");
  if (options.divided) classes.push("group--divided");
  const node = el("div", classes.join(" "));
  if (options.spin === "expand") node.classList.add("group--spin-open");
  if (options.spin === "collapse") node.classList.add("group--spin-close");


  const toggle = el("button", "group__toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(!options.collapsed));
  toggle.title = options.collapsed ? t("list.expandGroup") : t("list.collapseGroup");

  // 红色加号 / 减号：展开时竖线收起成减号，切换时整体转 90°（见 style.css）
  toggle.appendChild(el("span", "group__sign"));

  toggle.appendChild(el("span", "group__label", label));
  toggle.appendChild(el("span", "group__count", String(count)));
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onToggle();
  });

  // 整行都可点击展开/收起
  node.addEventListener("click", () => options.onToggle());

  node.appendChild(toggle);
  return node;
}


/** 分组行：外层负责占位，内层色带满宽。 */
export function buildGroupRow(
  label: string,
  count: number,
  key: string,
  options: GroupRowOptions,
): VirtualRow {
  // 旋转只在第一次渲染时播放：滚动导致的重建不该再转一次
  let pendingSpin: "expand" | "collapse" | null = options.spin ?? null;
  return {
    key,
    height: GROUP_H,
    render: () => {
      const slot = el("div", "group-slot");
      slot.appendChild(
        buildGroupBand(label, count, { ...options, spin: pendingSpin }),
      );
      pendingSpin = null;
      return slot;
    },
  };
}

export function buildFontVirtualRow(
  entry: FontEntry,
  ctx: RowContext,
  viewMode: Settings["viewMode"],
  alternate = false,
  familySpan = false,
  familyStart = false,
  familyEnd = false,
): VirtualRow {
  return {
    key: entry.id,
    height: viewMode === "preview" ? PREVIEW_ROW_H : ROW_H,
    render: () =>
      viewMode === "preview"
        ? buildPreviewRow(entry, ctx, alternate, familySpan, familyStart, familyEnd)
        : buildCompactRow(entry, ctx, alternate, familySpan, familyStart, familyEnd),
  };
}

/** 用被预览字体自身渲染一行示例文字（预览行与字族标题行共用）。 */
export function previewSample(entry: FontEntry, ctx: RowContext): HTMLElement {
  const preview = el("div", "row__preview");
  preview.style.fontSize = `${PREVIEW_FONT_SIZE}px`;
  const text = ctx.settings.previewText || defaultPreviewText();

  if (!entry.exists) {
    preview.textContent = t("detail.previewMissing");
    preview.classList.add("row__preview--fallback");
    return preview;
  }

  if (entry.format === "Raster") {
    preview.textContent = t("detail.previewRaster");
    preview.style.fontSize = "var(--fs-sm)";
    preview.style.color = "var(--muted)";
    preview.classList.add("row__preview--fallback");
    return preview;
  }

  preview.textContent = text;

  const color = toHexColor(getComputedStyle(document.body).color);
  const request = {
    entry,
    text,
    fontSize: PREVIEW_FONT_SIZE,
    color,
    weight: previewWeight(entry),
    allowFallback: !ctx.settings.previewText,
  };
  ctx.pool.request(request, (url, noGlyphs) => {
    // 命中缓存时回调发生在元素挂到 DOM 之前，这里不能要求 isConnected
    if (noGlyphs) {
      preview.textContent = t("preview.noChars");
      preview.style.fontSize = "var(--fs-sm)";
      preview.style.color = "var(--muted)";
      preview.classList.add("row__preview--fallback");
      return;
    }
    if (!url) {
      preview.classList.add("row__preview--fallback");
      preview.title = t("detail.previewFailedFallback", { error: "" });
      return;
    }
    const image = document.createElement("img");
    image.className = "row__preview-img";
    image.alt = "";
    image.src = url;
    image.style.height = `${Math.round(PREVIEW_FONT_SIZE * 1.35)}px`;
    preview.replaceChildren(image);
  });
  return preview;
}

/** 字族行：整族折叠时显示语言 / 总大小 / 总控开关，展开时只留总控开关。 */
export interface FamilyRowOptions {
  expanded: boolean;
  /** 预览模式：没有语言 / 大小列，预览区显示首个字重的示例。 */
  preview?: boolean;
  /** 预览模式下取首个字重渲染示例。 */
  sample?: () => HTMLElement | null;
  /** 折叠时展示的元信息与总大小；展开时传空。 */
  language: string;
  totalSize: string;
  /** 总控开关：全部启用为 on。 */
  enabled: boolean;
  /** 整族都不可操作时传入提示文案，显示锁而不是开关。 */
  lockedLabel?: string;
  /** 参与列表 A/B 交替底色。 */
  alternate?: boolean;
  /** 渲染时动态读取是否选中（滚动重建行后仍要保持选中）。 */
  isSelected?: () => boolean;
  /** 点中标题行：普通点击显示字族信息，Ctrl / Shift 参与多选。 */
  onSelect: (event: MouseEvent) => void;
  /** 这一次重建是否需要播放箭头旋转（仅用户点击展开 / 收起时传入）。 */
  animateChevron?: "expand" | "collapse" | null;
  /** 整族都已收藏：在选中竖块上方叠收藏方块。 */
  favorite?: boolean;
  /** 行 key：按分组拆开字族时必须是唯一的 scoped key。 */
  rowKey?: string;
  /** 本次重建要播放元信息显隐动画的方向（展开渐隐下移，收起渐显上移）。 */
  animateMeta?: "expand" | "collapse" | null;
  /** 双击标题行：展开详情或展开字族，由调用方判断。 */
  onActivate: () => void;
  onToggleExpand: () => void;
  onToggleHidden: () => void;
}

export function buildFamilyRow(
  family: string,
  count: number,
  options: FamilyRowOptions,
): VirtualRow {
  return {
    key: options.rowKey ?? `family:${family}`,
    height: options.preview ? PREVIEW_ROW_H : ROW_H,
    render: () => {
      const classes = ["row", "row--family-head"];
      classes.push(options.preview ? "row--preview" : "row--compact");
      if (options.alternate) classes.push("row--alt");
      if (options.expanded) classes.push("row--expanded");
      if (options.animateMeta === "expand") classes.push("row--meta-out");
      if (options.animateMeta === "collapse") classes.push("row--meta-in");
      if (options.isSelected?.()) classes.push("row--selected");
      const row = el("div", classes.join(" "));
      row.dataset.family = family;
      if (options.rowKey) row.dataset.familyKey = options.rowKey;
      row.prepend(selectionGutter());
      if (options.favorite) row.appendChild(favoriteMark());

      const nameCell = el("div", "cell cell--name");
      nameCell.appendChild(el("span", "name", family));
      if (count > 1) {
        // 样式数量做成可点的标签：灰底 + 右侧箭头，点它展开 / 收起字族
        const chip = el("button", "family__expand");
        chip.type = "button";
        chip.setAttribute("aria-expanded", String(options.expanded));
        chip.title = options.expanded ? t("list.collapseGroup") : t("list.expandGroup");
        chip.appendChild(el("span", "family__expand-label", t("list.styleCount", { count })));
        const chevron = icon("chevron-down", "family__expand-chevron");
        if (options.animateChevron === "expand") chevron.classList.add("is-spin-open");
        if (options.animateChevron === "collapse") chevron.classList.add("is-spin-close");
        chip.appendChild(chevron);
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          options.onToggleExpand();
        });
        nameCell.appendChild(chip);
      }
      row.appendChild(nameCell);

      if (options.preview) {
        // 预览模式：折叠时显示首个字重的示例，展开后这一格让给族内各行；
        // 展开动画期间保留旧示例，以便渐隐下移
        const slot = el("div", "row__preview-slot");
        if (!options.expanded || options.animateMeta === "expand") {
          const sample = options.sample?.();
          if (sample) {
            slot.appendChild(sample);
            if (options.animateMeta === "expand") {
              sample.addEventListener("animationend", () => sample.remove(), { once: true });
            }
          }
        }
        row.appendChild(slot);
      } else {
        // 折叠时补充语言与总大小；展开时这两格留空，只保留总控开关。
        // 展开动画期间保留旧内容并渐隐下移，结束后再清空
        const keepMeta = !options.expanded || options.animateMeta === "expand";
        const lang = el("div", "cell cell--lang", keepMeta ? options.language : "");
        const size = el("div", "cell cell--size", keepMeta ? options.totalSize : "");
        row.appendChild(lang);
        row.appendChild(size);
        if (options.animateMeta === "expand") {
          for (const cell of [lang, size]) {
            cell.addEventListener("animationend", () => { cell.textContent = ""; }, { once: true });
          }
        }
      }

      const switchCell = el("div", options.preview ? "cell cell--switch row__switch" : "cell cell--switch");
      if (options.lockedLabel) {
        const holder = el("span", "cell__lock");
        holder.appendChild(
          lockIcon(t("switch.protectedTitle", { protection: options.lockedLabel })),
        );
        switchCell.appendChild(holder);
      } else {
        switchCell.appendChild(buildFamilySwitch(options.enabled, options.onToggleHidden));
      }
      row.appendChild(switchCell);

      // 单击只选中；双击交给调用方决定（打开详情 / 展开字族），标签点击展开
      row.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest(".family__expand, .switch")) return;
        if ((event.target as HTMLElement).closest(".row__gutter")) {
          options.onSelect({ ctrlKey: true, metaKey: false, shiftKey: false } as MouseEvent);
          return;
        }
        options.onSelect(event);
      });
      row.addEventListener("dblclick", (event) => {
        if ((event.target as HTMLElement).closest(".family__expand, .switch, .row__gutter")) return;
        options.onActivate();
      });
      return row;
    },
  };
}

/** 字族总控开关：样式与行内开关一致。 */
function buildFamilySwitch(enabled: boolean, onChange: () => void): HTMLElement {
  const button = el("button", "switch");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", String(enabled));
  button.title = t(enabled ? "switch.on" : "switch.off");
  const knob = el("span", "switch__knob");
  button.appendChild(knob);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onChange();
  });
  return button;
}