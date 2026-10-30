// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/** 右侧详情面板：单选详情 / 多选摘要 / 空态。 */

import { icon } from "./icons";
import { t } from "./i18n";
import {
  defaultPreviewText,
  PREVIEW_FONT_SIZE,
  type FontEntry,
  type Settings,
} from "./types";
import type { PreviewPool } from "./preview";
import { el, formatBytes } from "./rows";
import { previewWeight, styleLabel, toHexColor } from "./preview";

/** 详情面板大样字的字号（CSS px） */
const DETAIL_SAMPLE_SIZE = 28;

export interface DetailHandlers {
  toggleDetails(): void;
  toggleHidden(entries: FontEntry[]): void;
  /** 请求删除（单选或多选），由上层弹确认框。 */
  requestDelete(entries: FontEntry[]): void;
  cleanMissing(entry: FontEntry): void;
  reveal(entry: FontEntry): void;
  clearSelection(): void;
  /** 多选视图：把当前列表里未选中的字体选上、已选中的取消。 */
  invertSelection(): void;
}

export interface DetailContext {
  settings: Settings;
  pool: PreviewPool;
  registryKey: string;
  detailsOpen: boolean;
}

/** 详情面板的操作按钮：图标 + 文案。 */
function actionButton(
  iconName: Parameters<typeof icon>[0],
  label: string,
  className = "btn btn--solid",
): HTMLButtonElement {
  const button = el("button", className) as HTMLButtonElement;
  button.type = "button";
  button.appendChild(icon(iconName, "btn__icon"));
  button.appendChild(el("span", "", label));
  return button;
}

/** 只有图标的按钮：文字放进 title / aria-label，形状保持方形。 */
function iconButton(
  iconName: Parameters<typeof icon>[0],
  label: string,
  className = "btn btn--solid btn--icon",
): HTMLButtonElement {
  const button = el("button", className) as HTMLButtonElement;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(icon(iconName, "btn__icon"));
  return button;
}

function kv(label: string, value: string, mono = false): HTMLElement {
  const row = el("div", "kv__row");
  row.appendChild(el("div", "kv__k", label));
  row.appendChild(el("div", mono ? "kv__v kv__v--mono" : "kv__v", value || "—"));
  return row;
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const box = el("div", "section");
  box.appendChild(el("div", "section__title", title));
  const list = el("div", "kv");
  for (const row of rows) list.appendChild(row);
  box.appendChild(list);
  return box;
}

function statusLine(entry: FontEntry): string {
  if (!entry.exists) return t("detail.statusMissing");
  const bits: string[] = [entry.scope === "system" ? t("detail.scopeSystem") : t("detail.scopeUser")];
  bits.push(entry.hidden ? t("detail.hidden") : t("detail.visible"));
  if (entry.protected) bits.push(t("detail.protected"));
  return bits.join(" · ");
}

/** 样字框：`apply` 用于字重滑块实时重绘。 */
interface SampleView {
  box: HTMLElement;
  apply(weight: number, live: boolean): void;
}

function sample(entry: FontEntry, ctx: DetailContext, stacked = false): SampleView {
  // 切换字体时先释放上一张实时预览图
  ctx.pool.clearLive();

  const box = stacked
    ? el("div", "detail__sample detail__sample--stack")
    : el("div", "detail__sample");
  const text = el("div", "detail__sample-text");
  text.style.fontSize = `${PREVIEW_FONT_SIZE}px`;
  const content = ctx.settings.previewText || defaultPreviewText();
  const allowFallback = !ctx.settings.previewText;
  const noop = { box, apply: () => undefined };

  if (!entry.exists) {
    text.textContent = t("detail.previewMissing");
    text.style.color = "var(--muted)";
    box.appendChild(text);
    return noop;
  }

  if (entry.format === "Raster") {
    text.textContent = t("detail.previewRaster");
    text.style.fontSize = "var(--fs-sm)";
    text.style.color = "var(--muted)";
    box.appendChild(text);
    return noop;
  }

  text.textContent = content;
  box.appendChild(text);
  const color = toHexColor(getComputedStyle(document.body).color);
  let current: HTMLElement = text;
  let available = 0;

  const paint = (weight: number, live: boolean): void => {
    if (available <= 0) return;
    ctx.pool.request(
      {
        entry,
        text: content,
        fontSize: DETAIL_SAMPLE_SIZE,
        color,
        maxWidth: available,
        weight,
        allowFallback,
      },
      (url, noGlyphs) => {
        if (noGlyphs) {
          current.textContent = t("preview.noChars");
          current.style.fontSize = "var(--fs-sm)";
          current.style.color = "var(--muted)";
          return;
        }
        if (!url) {
          current.style.color = "var(--muted)";
          return;
        }
        const image = document.createElement("img");
        image.className = "detail__preview-img";
        image.alt = "";
        image.src = url;
        current.replaceWith(image);
        current = image;
      },
      { live },
    );
  };

  // 等面板挂进 DOM 拿到可用宽度，再按该宽度折行渲染
  requestAnimationFrame(() => {
    const style = getComputedStyle(box);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    available = Math.max(120, box.clientWidth - (Number.isFinite(padding) ? padding : 0));
    paint(previewWeight(entry), false);
  });

  return { box, apply: paint };
}

/** 可变字体的字重滑块：拖动实时预览，松手后把最终字重写入缓存。 */
function weightControl(entry: FontEntry, apply: (weight: number, live: boolean) => void): HTMLElement {
  const row = el("div", "detail__weight");
  row.appendChild(el("span", "detail__weight-label", t("detail.weight")));

  const input = document.createElement("input");
  input.type = "range";
  input.className = "detail__weight-input";
  input.min = String(entry.weightMin);
  input.max = String(entry.weightMax);
  input.step = "1";
  const start = previewWeight(entry);
  input.value = String(start);
  input.setAttribute("aria-label", t("detail.weight"));

  const value = el("span", "detail__weight-value", String(start));
  let frame = 0;
  input.addEventListener("input", () => {
    const weight = Number(input.value);
    value.textContent = String(weight);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      apply(Number(input.value), true);
    });
  });
  input.addEventListener("change", () => {
    apply(Number(input.value), false);
  });

  row.append(input, value);
  return row;
}

function emptyState(): HTMLElement {
  const empty = el("div", "detail__empty");
  empty.appendChild(el("div", "detail__empty-title", t("list.detailEmpty")));
  empty.appendChild(
    el("div", "detail__empty-hint", t("list.detailEmptyHint")),
  );
  return empty;
}

function multiPane(
  entries: FontEntry[],
  handlers: DetailHandlers,
): DocumentFragment {
  const fragment = document.createDocumentFragment();

  const head = el("div", "detail__head");
  head.appendChild(el("h2", "detail__title", t("detail.multiTitle", { count: entries.length })));
  const sub = el("div", "detail__sub");
  sub.appendChild(el("span", "", t("detail.multiSub")));
  head.appendChild(sub);
  fragment.appendChild(head);


  const actions = el("div", "detail__actions detail__actions--primary");
  const trailing = el("div", "detail__actions-end");

  const userEntries = entries.filter((e) => e.exists && !e.protected);
  if (userEntries.length > 0) {
    const allHidden = userEntries.every((e) => e.hidden);
    const toggle = actionButton(
      allHidden ? "eye-filled" : "eye-cancelled-filled",
      allHidden
        ? t("detail.toggleShow", { count: userEntries.length })
        : t("detail.toggleHide", { count: userEntries.length }),
      "btn btn--solid detail__actions-grow",
    );
    toggle.addEventListener("click", () => handlers.toggleHidden(userEntries));
    actions.appendChild(toggle);
  }

  const deletable = entries.filter((e) => e.exists && !e.protected);
  if (deletable.length > 0) {
    const remove = iconButton(
      "trashcan-filled",
      deletable.length === 1
        ? t("detail.delete")
        : t("detail.deleteMany", { count: deletable.length }),
      "btn btn--solid btn--danger btn--icon",
    );
    if (deletable.some((e) => e.requiresElevation)) {
      remove.title = t("detail.uacTitle");
    }
    remove.addEventListener("click", () => handlers.requestDelete(deletable));
    trailing.appendChild(remove);
  }

  const secondary = el("div", "detail__actions detail__actions--secondary");
  const invert = el("button", "btn btn--solid", t("detail.invertSelection"));
  invert.type = "button";
  invert.addEventListener("click", () => handlers.invertSelection());
  secondary.appendChild(invert);
  fragment.appendChild(secondary);

  actions.appendChild(trailing);
  fragment.appendChild(actions);
  return fragment;
}

export function renderDetail(
  container: HTMLElement,
  entries: FontEntry[],
  ctx: DetailContext,
  handlers: DetailHandlers,
): void {
  container.replaceChildren();

  if (entries.length === 0) {
    container.appendChild(emptyState());
    return;
  }

  if (entries.length > 1) {
    container.appendChild(multiPane(entries, handlers));
    return;
  }

  const entry = entries[0];
  const head = el("div", "detail__head");
  head.appendChild(el("h2", "detail__title", entry.family || entry.displayName));
  const sub = el("div", "detail__sub");
  const style = styleLabel(entry);
  if (style) sub.appendChild(el("span", "", style));
  head.appendChild(sub);
  container.appendChild(head);

  const sampleView = sample(entry, ctx);
  container.appendChild(sampleView.box);

  const actions = el("div", "detail__actions");
  const trailing = el("div", "detail__actions-end");
  if (entry.exists) {
    const reveal = actionButton(
      "folder-open-filled",
      t("detail.reveal"),
      "btn btn--solid",
    );
    reveal.addEventListener("click", () => handlers.reveal(entry));
    trailing.appendChild(reveal);
  }

  if (!entry.exists) {
    const clean = el("button", "btn btn--solid btn--danger", t("detail.cleanMissing"));
    clean.type = "button";
    clean.addEventListener("click", () => handlers.cleanMissing(entry));
    actions.appendChild(clean);
  } else if (!entry.protected) {
    const toggle = actionButton(
      entry.hidden ? "eye-filled" : "eye-cancelled-filled",
      entry.hidden ? t("detail.showFont") : t("detail.hideFont"),
      "btn btn--solid",
    );
    toggle.title = entry.hidden
      ? t("detail.hideHintRevert")
      : entry.scope === "system"
    ? t("detail.hideHintUser")
    : t("detail.hideHintSystem");
    toggle.addEventListener("click", () => handlers.toggleHidden([entry]));
    actions.appendChild(toggle);
    const remove = iconButton("trashcan-filled", t("detail.delete"), "btn btn--solid btn--danger btn--icon");
    if (entry.requiresElevation) {
      remove.title = t("detail.uacTitle");
    }
    remove.addEventListener("click", () => handlers.requestDelete([entry]));
    trailing.appendChild(remove);
  } else {
    // 受保护字体：原「停用」按钮的位置改成一句说明
    actions.appendChild(el("span", "detail__note", t("detail.protectedNote")));
  }
  actions.appendChild(trailing);
  container.appendChild(actions);
  if (entry.variable && entry.weightMax > entry.weightMin) {
    container.appendChild(weightControl(entry, sampleView.apply));
  }
  // 字体信息在前，文件信息在后
  const fontRows: HTMLElement[] = [];
  if (entry.families.length > 1) {
    fontRows.push(kv(t("detail.family"), entry.families.join(" / ")));
  }
  fontRows.push(kv(t("detail.fullName"), entry.fullName || entry.displayName));
  // 语言按字形覆盖判定，可能有很多种，全部列出
  // 符号 / 图标字体通常判不出语言，与列表一致显示「未知」
  fontRows.push(
    kv(
      t("detail.language"),
      entry.languages?.length ? entry.languages.join("、") : t("language.unknown"),
    ),
  );
  if (entry.version) fontRows.push(kv(t("detail.version"), entry.version));
  if (entry.copyright) fontRows.push(kv(t("detail.copyright"), entry.copyright));
  container.appendChild(section(t("detail.sectionFont"), fontRows));

  // 文件与注册表等技术细节默认收起，避免详情面板过于“工程化”。
  const moreToggle = el("button", "detail__toggle");
  moreToggle.type = "button";
  moreToggle.setAttribute("aria-expanded", String(ctx.detailsOpen));
  moreToggle.appendChild(
      el("span", "", ctx.detailsOpen ? t("detail.technicalLess") : t("detail.technicalMore")),
  );
  moreToggle.appendChild(icon("chevron-down", "detail__chev"));
  moreToggle.addEventListener("click", () => handlers.toggleDetails());
  container.appendChild(moreToggle);

  if (ctx.detailsOpen) {
    container.appendChild(
      section(t("detail.sectionFile"), [
        kv(t("detail.fileName"), entry.fileName, true),
        kv(t("detail.path"), entry.path, true),
        kv(t("detail.size"), formatBytes(entry.size)),
        kv(t("detail.format"), entry.format),
      ]),
    );
    container.appendChild(
      section(t("detail.sectionRegistry"), [
        kv(t("detail.valueName"), entry.valueName, true),
        kv(t("detail.location"), ctx.registryKey, true),
        kv(t("detail.state"), statusLine(entry)),
      ]),
    );
  }
}
/** 字族详情：以一个「整体」呈现，没有具体文件信息。 */
export function renderFamilyDetail(
  container: HTMLElement,
  family: string,
  entries: FontEntry[],
  ctx: DetailContext,
  handlers: DetailHandlers,
): void {
  container.replaceChildren();
  if (entries.length === 0) {
    container.appendChild(emptyState());
    return;
  }

  const head = el("div", "detail__head");
  head.appendChild(el("h2", "detail__title", family));
  const sub = el("div", "detail__sub");
  sub.appendChild(el("span", "", t("detail.styleCount", { count: entries.length })));
  head.appendChild(sub);
  container.appendChild(head);

  // 预览用首个字重，背景加「堆叠」示意——表示这是一个字族而不是单个文件
  const sampleView = sample(entries[0], ctx, true);
  container.appendChild(sampleView.box);

  const actions = el("div", "detail__actions");
  const trailing = el("div", "detail__actions-end");
  const userEntries = entries.filter((entry) => entry.exists && !entry.protected);
  if (userEntries.length > 0) {
    const allHidden = userEntries.every((entry) => entry.hidden);
    const toggle = actionButton(
      allHidden ? "eye-filled" : "eye-cancelled-filled",
      allHidden ? t("detail.showFont") : t("detail.hideFont"),
      "btn btn--solid",
    );
    toggle.addEventListener("click", () => handlers.toggleHidden(userEntries));
    actions.appendChild(toggle);
  } else if (entries.some((entry) => entry.protected)) {
    // 整族都受保护：和单个受保护字体一样，只给一句说明
    actions.appendChild(el("span", "detail__note", t("detail.protectedNote")));
  }

  const removable = entries.filter((entry) => entry.exists && !entry.protected);
  if (removable.length > 0) {
    const remove = iconButton(
      "trashcan-filled",
      t("detail.deleteMany", { count: removable.length }),
      "btn btn--solid btn--danger btn--icon",
    );
    remove.addEventListener("click", () => handlers.requestDelete(removable));
    trailing.appendChild(remove);
  }
  actions.appendChild(trailing);
  container.appendChild(actions);
  if (entries[0].variable && entries[0].weightMax > entries[0].weightMin) {
    container.appendChild(weightControl(entries[0], sampleView.apply));
  }

  const info: HTMLElement[] = [kv(t("detail.family"), family)];
  const version = entries.find((entry) => entry.version)?.version;
  if (version) info.push(kv(t("detail.version"), version));
  const copyright = entries.find((entry) => entry.copyright)?.copyright;
  if (copyright) info.push(kv(t("detail.copyright"), copyright));
  container.appendChild(section(t("detail.sectionFont"), info));
}