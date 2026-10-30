// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/**
 * 虚拟滚动列表。
 *
 * 只渲染「可视窗口 + 上下各若干行」的 DOM，撑起 500+ 字体的流畅滚动。
 * 上下都留出 overscan：滚动时新行已经提前画好，不会出现"滚到位才蹦出来"的空白带。
 */

export interface VirtualRow {
  key: string;
  height: number;
  render: () => HTMLElement;
}

export class VirtualList {
  private rows: VirtualRow[] = [];
  private offsets: number[] = [];
  private total = 0;
  private frame = 0;
  private rendered = "";
  /** 上一次渲染时每一行的位置，用于展开/收起时的位移动画。 */
  private prevTops = new Map<string, number>();
  /** 下一次渲染是否要补一段动画（只由展开/收起触发）。 */
  private animateNext = false;
  /** 本次动画的方向：展开时新行从上方轻微下移，收起时下方内容滑上来。 */
  private animateDirection: "expand" | "collapse" = "expand";

  /** 上下各多渲染的行数（紧凑 38px ≈ 228px，预览 76px ≈ 456px）。 */
  private static readonly OVERSCAN_ROWS = 2;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly spacer: HTMLElement,
    private readonly container: HTMLElement,
  ) {
    this.viewport.addEventListener("scroll", () => this.schedule(), {
      passive: true,
    });
    new ResizeObserver(() => this.schedule(true)).observe(this.viewport);
  }

  setRows(
    rows: VirtualRow[],
    animate = false,
    direction: "expand" | "collapse" = "expand",
  ): void {
    this.animateNext = animate;
    this.animateDirection = direction;
    if (animate) {
      // 记录上一份列表里每一行的位置：这样即使某行当时在可视区外，
      // 展开/收起后也能从「原来的位置」滑到新位置，而不是凭空淡入
      const prev = new Map<string, number>();
      for (let i = 0; i < this.rows.length; i += 1) {
        prev.set(this.rows[i].key, this.offsets[i] ?? 0);
      }
      this.prevTops = prev;
    }
    this.rows = rows;
    this.offsets = new Array(rows.length);
    let total = 0;
    for (let i = 0; i < rows.length; i += 1) {
      this.offsets[i] = total;
      total += rows[i].height;
    }
    this.total = total;
    this.spacer.style.height = `${total}px`;
    this.rendered = "";
    this.schedule(true);
  }

  scrollToKey(key: string): void {
    const index = this.rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    const top = this.offsets[index] ?? 0;
    this.viewport.scrollTop = Math.max(0, top - this.viewport.clientHeight / 2);
  }

  /** 把某一行滚到视口正中（切换紧凑/预览时保持阅读位置）。 */
  centerKey(key: string): void {
    const index = this.rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    const top = this.offsets[index] ?? 0;
    const height = this.rows[index].height;
    const target = top + height / 2 - this.viewport.clientHeight / 2;
    const max = Math.max(0, this.total - this.viewport.clientHeight);
    this.viewport.scrollTop = Math.max(0, Math.min(target, max));
  }

  private schedule(force = false): void {
    if (this.frame && !force) return;
    if (force && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** 返回包含 y 坐标的行下标（越界时钳制到首/末行）。 */
  private indexAt(y: number): number {
    if (this.rows.length === 0) return 0;
    let low = 0;
    let high = this.rows.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.offsets[mid] ?? 0) <= y) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }

  private render(): void {
    const { rows, offsets } = this;
    const scrollTop = this.viewport.scrollTop;
    const viewHeight = this.viewport.clientHeight;

    if (rows.length === 0) {
      this.container.textContent = "";
      this.rendered = "";
      return;
    }

    // 可视区首尾行 + 上下 overscan。end 必须从「视口底部」而不是首行开始计算，
    // 否则预算会被首行上方的那几行吃掉，视口底部会留下一条未渲染的空白带。
    const first = this.indexAt(scrollTop);
    const last = this.indexAt(scrollTop + Math.max(viewHeight - 1, 0));
    const start = Math.max(0, first - VirtualList.OVERSCAN_ROWS);
    const end = Math.min(rows.length, last + VirtualList.OVERSCAN_ROWS + 1);

    const signature = `${start}:${end}:${rows.length}:${this.total}`;
    if (signature === this.rendered && this.container.childElementCount > 0) {
      return;
    }
    this.rendered = signature;

    const animate = this.animateNext;
    this.animateNext = false;
    const prevTops = this.prevTops;
    const nextTops = new Map<string, number>();

    const fragment = document.createDocumentFragment();
    const nodes: HTMLElement[] = [];
    for (let i = start; i < end; i += 1) {
      const row = rows[i];
      const node = row.render();
      const top = offsets[i] ?? 0;
      node.dataset.key = row.key;
      node.style.top = `${top}px`;
      node.style.height = `${row.height}px`;
      nextTops.set(row.key, top);
      fragment.appendChild(node);
      nodes.push(node);
    }
    const oldNodes = Array.from(this.container.children) as HTMLElement[];
    this.container.replaceChildren(fragment);
    if (animate) {
      if (this.animateDirection === "collapse") {
        this.fadeOutRemoved(oldNodes, nextTops);
      }
      this.playTransition(nodes, prevTops, nextTops, this.animateDirection);
      this.prevTops = new Map();
    } else {
      this.prevTops = nextTops;
    }
  }

  /** 展开 / 收起：原有行滑到新位置，新出现的行淡入。 */
  private playTransition(
    nodes: HTMLElement[],
    prevTops: Map<string, number>,
    nextTops: Map<string, number>,
    direction: "expand" | "collapse",
  ): void {
    // 尊重系统的「减少动态效果」设置
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const moved: Array<{ node: HTMLElement; delta: number }> = [];
    for (const node of nodes) {
      const key = node.dataset.key ?? "";
      const before = prevTops.get(key);
      const after = nextTops.get(key) ?? 0;
      if (before === undefined) {
        // 展开时新内容从上方轻微下移到位；收起时不加位移，否则下方内容会像从上往下滑出来
        const frames =
          direction === "expand"
            ? [
                { opacity: 0, transform: "translateY(-8px)" },
                { opacity: 1, transform: "translateY(0)" },
              ]
            : [{ opacity: 0 }, { opacity: 1 }];
        node.animate(frames, { duration: 160, easing: "cubic-bezier(.2,0,0,1)" });
        continue;
      }
      const raw = before - after;
      if (raw === 0) continue;
      // 收起一大组时位移可能有上千像素，收敛到一屏以内，观感才像「从下面挪上来」
      const limit = this.viewport.clientHeight * 0.85;
      const delta = Math.max(-limit, Math.min(limit, raw));
      moved.push({ node, delta });
    }
    if (moved.length === 0) return;
    // 先摆到旧位置，再统一过渡到新位置
    for (const { node, delta } of moved) {
      node.style.transform = `translateY(${delta}px)`;
    }
    requestAnimationFrame(() => {
      for (const { node } of moved) {
        node.style.transition = "transform 200ms cubic-bezier(.2,0,0,1)";
        node.style.transform = "translateY(0)";
      }
      const longest = 220;
      window.setTimeout(() => {
        for (const { node } of moved) {
          node.style.transition = "";
          node.style.transform = "";
        }
      }, longest);
    });
  }

  /** 收起：被移除的行先留在原地淡出，避免瞬间消失。 */
  private fadeOutRemoved(
    oldNodes: HTMLElement[],
    nextTops: Map<string, number>,
  ): void {
    const gone = oldNodes.filter((node) => !nextTops.has(node.dataset.key ?? ""));
    if (gone.length === 0) return;

    const ghost = document.createElement("div");
    ghost.className = "rows__ghost";
    for (const node of gone) {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.classList.remove("row--selected");
      ghost.appendChild(copy);
    }
    this.viewport.appendChild(ghost);
    // 与展开时同样的 8px 轻微位移：收起时整体向上让开
    const anim = ghost.animate(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(-8px)" },
      ],
      {
        duration: 160,
        easing: "cubic-bezier(.2,0,0,1)",
        fill: "forwards",
      },
    );
    const drop = (): void => ghost.remove();
    anim.addEventListener("finish", drop);
    window.setTimeout(drop, 400);
  }
}