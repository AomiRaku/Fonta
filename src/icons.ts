// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

/**
 * 图标来自 Siemens iX（MIT），构建时内联，颜色跟随 currentColor。
 */

import add from "@siemens/ix-icons/svg/add.svg?raw";
import chevronDown from "@siemens/ix-icons/svg/chevron-down.svg?raw";
import dataTypeString from "@siemens/ix-icons/svg/data-type-string.svg?raw";
import filter from "@siemens/ix-icons/svg/filter.svg?raw";
import filterFilled from "@siemens/ix-icons/svg/filter-filled.svg?raw";
import check from "@siemens/ix-icons/svg/check.svg?raw";
import about from "@siemens/ix-icons/svg/about.svg?raw";
import cogwheel from "@siemens/ix-icons/svg/cogwheel.svg?raw";
import earthFilled from "@siemens/ix-icons/svg/earth-filled.svg?raw";
import appMenu from "@siemens/ix-icons/svg/app-menu.svg?raw";
import errorFilled from "@siemens/ix-icons/svg/error-filled.svg?raw";
import listGraphicsText from "@siemens/ix-icons/svg/list-graphics-text.svg?raw";
import navigationRight from "@siemens/ix-icons/svg/navigation-right.svg?raw";
import navigationRightHide from "@siemens/ix-icons/svg/navigation-right-hide.svg?raw";
import heartFilled from "@siemens/ix-icons/svg/heart-filled.svg?raw";
import close from "@siemens/ix-icons/svg/close.svg?raw";
import copy from "@siemens/ix-icons/svg/copy.svg?raw";
import eyeCancelled from "@siemens/ix-icons/svg/eye-cancelled-filled.svg?raw";
import eyeFilled from "@siemens/ix-icons/svg/eye-filled.svg?raw";
import folderOpen from "@siemens/ix-icons/svg/folder-open-filled.svg?raw";
import githubLogo from "@siemens/ix-icons/svg/github-logo.svg?raw";
import lock from "@siemens/ix-icons/svg/lock.svg?raw";
import minus from "@siemens/ix-icons/svg/minus.svg?raw";
import moon from "@siemens/ix-icons/svg/moon.svg?raw";
import refresh from "@siemens/ix-icons/svg/refresh.svg?raw";
import screen from "@siemens/ix-icons/svg/screen.svg?raw";
import search from "@siemens/ix-icons/svg/search.svg?raw";
import square from "@siemens/ix-icons/svg/square.svg?raw";
import sun from "@siemens/ix-icons/svg/sun.svg?raw";
import tableRows from "@siemens/ix-icons/svg/table-rows.svg?raw";
import justified from "@siemens/ix-icons/svg/text-alginment-justified.svg?raw";
import trashcan from "@siemens/ix-icons/svg/trashcan-filled.svg?raw";

const SOURCES = {
  add,
  "chevron-down": chevronDown,
  "data-type-string": dataTypeString,
  filter,
  "filter-filled": filterFilled,
  check,
  about,
  cogwheel,
  "earth-filled": earthFilled,
  "app-menu": appMenu,
  "error-filled": errorFilled,
  "list-graphics-text": listGraphicsText,
  "navigation-right": navigationRight,
  "navigation-right-hide": navigationRightHide,
  "heart-filled": heartFilled,
  "eye-cancelled-filled": eyeCancelled,
  "eye-filled": eyeFilled,
  "folder-open-filled": folderOpen,
  "github-logo": githubLogo,
  "table-rows": tableRows,
  "text-alignment-justified": justified,
  "trashcan-filled": trashcan,
  close,
  lock,
  minus,
  moon,
  refresh,
  screen,
  search,
  sun,
  /** 窗口最大化：空心方框 */
  maximize: square,
  /** 窗口还原：叠放的两个方框 */
  restore: copy,
} as const;

export type IconName = keyof typeof SOURCES;

/** 把 `fill:#000;stroke:none` 这类声明拆成键值对。 */
function parseDeclarations(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const chunk of text.split(";")) {
    const index = chunk.indexOf(":");
    if (index < 0) continue;
    const key = chunk.slice(0, index).trim().toLowerCase();
    const value = chunk.slice(index + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

const KEPT_PROPS = /^(stroke-width|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|fill-rule|fill-opacity|stroke-opacity|opacity|clip-rule)$/;

/** 将 SVG 源规整为可内联、颜色跟随 currentColor 的标记。 */
function normalize(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return "";

  // 1) 展开 <style> 里的类规则（Illustrator 的 .st0/.st1 …）
  const classRules = new Map<string, Record<string, string>>();
  for (const style of Array.from(root.querySelectorAll("style"))) {
    for (const match of (style.textContent ?? "").matchAll(/\.([\w:-]+)\s*\{([^}]*)\}/g)) {
      classRules.set(match[1], {
        ...(classRules.get(match[1]) ?? {}),
        ...parseDeclarations(match[2]),
      });
    }
    style.remove();
  }

  // 2) 去掉注释与无障碍描述（内联后 title 会变成默认 tooltip）
  for (const node of Array.from(root.querySelectorAll("desc, title"))) node.remove();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);
  for (const comment of comments) comment.remove();

  const elements = [root, ...Array.from(root.querySelectorAll("*"))];

  // 3) class / style → 属性
  for (const element of elements) {
    const declarations: Record<string, string> = {};
    const className = element.getAttribute("class");
    if (className) {
      for (const name of className.split(/\s+/)) {
        Object.assign(declarations, classRules.get(name) ?? {});
      }
    }
    Object.assign(declarations, parseDeclarations(element.getAttribute("style")));
    element.removeAttribute("class");
    element.removeAttribute("style");
    element.removeAttribute("data-name");
    element.removeAttribute("enable-background");

    for (const [prop, value] of Object.entries(declarations)) {
      if (prop === "fill" || prop === "stroke") {
        element.setAttribute(prop, value.toLowerCase() === "none" ? "none" : "currentColor");
      } else if (KEPT_PROPS.test(prop)) {
        element.setAttribute(prop, value);
      }
    }
  }

  // 4) 表现属性里写死的颜色也统一成 currentColor
  for (const element of elements) {
    for (const attr of ["fill", "stroke"] as const) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      element.setAttribute(attr, value.trim().toLowerCase() === "none" ? "none" : "currentColor");
    }
  }

  const isStroke = elements.some((element) => element.getAttribute("stroke") === "currentColor");

  // 5) 填充型：剥掉 fill="none" 的包裹层，让路径继承根节点颜色
  if (!isStroke) {
    for (const element of elements) {
      if (element !== root && element.getAttribute("fill") === "none") element.removeAttribute("fill");
    }
  }

  // 6) 去掉 id：同一图标多处内联时 id 会重复；仍被 url(#…) 引用的保留
  const referenced = new Set<string>();
  for (const match of new XMLSerializer().serializeToString(root).matchAll(/url\(#([^)]+)\)/g)) {
    referenced.add(match[1]);
  }
  for (const element of elements) {
    const id = element.getAttribute("id");
    if (id && !referenced.has(id) && element !== root) element.removeAttribute("id");
  }

  // 7) 根节点：只留 viewBox 与绘制策略
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  const viewBox =
    root.getAttribute("viewBox") ??
    (Number.isFinite(width) && Number.isFinite(height) ? `0 0 ${width} ${height}` : "0 0 24 24");

  for (const attr of ["width", "height", "x", "y", "id", "version", "style", "xml:space", "class"]) {
    root.removeAttribute(attr);
  }
  root.setAttribute("viewBox", viewBox);
  root.setAttribute("fill", isStroke ? "none" : "currentColor");
  if (isStroke) root.setAttribute("stroke", "currentColor");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");

  return new XMLSerializer().serializeToString(root).trim();
}

/** 直接拿到 SVG 标记（用于 innerHTML 场景）。 */
export function iconMarkup(name: IconName): string {
  return normalize(SOURCES[name]);
}

/** 生成一个 SVG 元素。 */
export function icon(name: IconName, className = ""): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = iconMarkup(name);
  const svg = template.content.firstElementChild as SVGSVGElement;
  if (className) svg.setAttribute("class", className);
  return svg;
}

/** 把页面里 `<span data-icon="name">` 占位替换成真实图标。 */
export function mountIcons(root: ParentNode = document): void {
  for (const slot of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = slot.dataset.icon as IconName;
    if (!(name in SOURCES)) continue;
    const className = slot.className.replace(/\s*icon-slot\s*/, "").trim();
    slot.replaceWith(icon(name, className));
  }
}