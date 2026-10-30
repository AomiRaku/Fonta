// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/** 轻量右键菜单：单实例、点击外部 / Esc / 滚动即关闭。 */

export interface MenuItem {
  label: string;
  /** 置灰不可点。 */
  disabled?: boolean;
  /** 危险项：文字转为 --danger。 */
  danger?: boolean;
  /** 二级菜单：鼠标悬停时向右展开。 */
  children?: MenuItem[];
  run?: () => void | Promise<void>;
}

let openMenu: HTMLElement | null = null;
let openSubmenuEl: HTMLElement | null = null;
let closeTimer = 0;
let cleanup: (() => void) | null = null;

function closeSubmenu(): void {
  openSubmenuEl?.remove();
  openSubmenuEl = null;
}

export function closeContextMenu(): void {
  window.clearTimeout(closeTimer);
  closeSubmenu();
  openMenu?.remove();
  openMenu = null;
  cleanup?.();
  cleanup = null;
}

/** 在触发项右侧展开二级菜单，右侧放不下就翻到左边。 */
function openSubmenu(parent: HTMLElement, items: MenuItem[]): void {
  window.clearTimeout(closeTimer);
  closeSubmenu();

  const menu = document.createElement("div");
  menu.className = "ctx ctx--submenu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctx__item";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    if (item.danger) button.classList.add("ctx__item--danger");
    if (item.disabled) {
      button.disabled = true;
    } else {
      button.addEventListener("click", () => {
        closeContextMenu();
        void item.run?.();
      });
    }
    menu.appendChild(button);
  }
  menu.addEventListener("mouseenter", () => window.clearTimeout(closeTimer));
  menu.addEventListener("mouseleave", () => {
    closeTimer = window.setTimeout(closeSubmenu, 120);
  });
  document.body.appendChild(menu);

  const rect = parent.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const gap = 2;
  let left = rect.right + gap;
  if (left + size.width > window.innerWidth - 4) {
    left = Math.max(4, rect.left - size.width - gap);
  }
  const top = Math.min(rect.top - 4, window.innerHeight - size.height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(4, top)}px`;
  openSubmenuEl = menu;
}

/** 在 (x, y) 处弹出菜单；越界时自动翻转，保证完整可见。 */
export function openContextMenu(
  items: MenuItem[],
  x: number,
  y: number,
  options: { above?: boolean; onClose?: () => void; note?: string } = {},
): void {
  closeContextMenu();
  if (items.length === 0) return;

  const menu = document.createElement("div");
  menu.className = "ctx";
  menu.setAttribute("role", "menu");

  if (options.note) {
    const note = document.createElement("div");
    note.className = "ctx__note";
    note.textContent = options.note;
    menu.appendChild(note);
  }

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctx__item";
    button.setAttribute("role", "menuitem");
    button.appendChild(document.createTextNode(item.label));
    if (item.children && item.children.length > 0) {
      button.classList.add("ctx__item--parent");
      const arrow = document.createElement("span");
      arrow.className = "ctx__arrow";
      arrow.textContent = "›";
      button.appendChild(arrow);
    }
    if (item.danger) button.classList.add("ctx__item--danger");
    if (item.disabled) {
      button.disabled = true;
    } else if (item.children && item.children.length > 0) {
      const children = item.children ?? [];
      button.addEventListener("mouseenter", () => openSubmenu(button, children));
    } else {
      button.addEventListener("mouseenter", closeSubmenu);
      button.addEventListener("click", () => {
        closeContextMenu();
        void item.run?.();
      });
    }
    menu.appendChild(button);
  }

  document.body.appendChild(menu);

  // 先量尺寸再落位，避免贴边溢出
  const rect = menu.getBoundingClientRect();
  const gap = 4;
  const left = Math.min(x, window.innerWidth - rect.width - gap);
  const top = options.above
    ? Math.max(gap, y - rect.height)
    : Math.min(y, window.innerHeight - rect.height - gap);
  menu.style.left = `${Math.max(gap, left)}px`;
  menu.style.top = `${Math.max(gap, top)}px`;

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    // 二级菜单是独立节点，命中它时不能关掉整组菜单
    if (menu.contains(target) || openSubmenuEl?.contains(target)) return;
    closeContextMenu();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeContextMenu();
    }
  };
  const onScroll = (): void => closeContextMenu();

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
  document.addEventListener("scroll", onScroll, true);

  cleanup = () => {
    options.onClose?.();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", closeContextMenu);
    window.removeEventListener("resize", closeContextMenu);
    document.removeEventListener("scroll", onScroll, true);
  };
  openMenu = menu;
}
