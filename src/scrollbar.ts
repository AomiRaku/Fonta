/**
 * 悬浮滚动条：原生滚动条改为不占位，滚动时在内容右侧浮出一个 6px 的圆角滑块。
 *
 * - 不预留轨道，出现/消失不会改变内容宽度；
 * - 悬停容器或滚动时显示，静止 700ms 后淡出；
 * - 支持拖动滑块。
 */

const THUMB_MIN = 28;
const FADE_DELAY = 700;

const instances = new WeakMap<HTMLElement, OverlayScrollbar>();

export class OverlayScrollbar {
  private readonly el: HTMLDivElement;
  private hideTimer = 0;
  private frame = 0;
  private dragging = false;
  private dragOffset = 0;
  private pinned = false;
  /** 滑块轨道距宿主上下边缘的内缩（菜单浮层用一点留白）。 */
  private inset = 0;
  private observer: ResizeObserver | null = null;

  constructor(private readonly target: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "ovl-scroll";
    this.el.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.el);

    this.target.addEventListener("scroll", this.onScroll, { passive: true });
    this.target.addEventListener("pointerenter", this.onEnter);
    this.target.addEventListener("pointerleave", this.onLeave);
    this.el.addEventListener("pointerdown", this.onThumbDown);
    this.el.addEventListener("pointermove", this.onThumbMove);
    this.el.addEventListener("pointerup", this.onThumbUp);
    this.el.addEventListener("pointercancel", this.onThumbUp);
    this.el.addEventListener("pointerenter", this.show);

    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.schedule());
      this.observer.observe(this.target);
    }
    window.addEventListener("resize", this.schedule, { passive: true });

    this.update();
  }

  /** 内容尺寸变化后手动刷新（虚拟列表重建行时调用）。 */
  refresh(): void {
    this.update();
  }

  /** 常驻显示（弹层这类临时面板用），关闭时不自动淡出。 */
  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    if (!pinned) return;
    window.clearTimeout(this.hideTimer);
    this.update();
    // 只有真的能滚动时才常驻，否则会留下一条空滑块
    if (this.metrics()) this.el.classList.add("is-visible");
  }

  /** 目标元素被移除时销毁叠加层，避免 body 里堆积空节点。 */
  destroy(): void {
    window.clearTimeout(this.hideTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.target.removeEventListener("scroll", this.onScroll);
    this.target.removeEventListener("pointerenter", this.onEnter);
    this.target.removeEventListener("pointerleave", this.onLeave);
    this.observer?.disconnect();
    window.removeEventListener("resize", this.schedule);
    this.el.remove();
  }

  private schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  };

  private onScroll = (): void => {
    this.show();
    this.schedule();
    if (this.pinned) this.el.classList.add("is-visible");
  };

  private onEnter = (): void => this.show();

  private onLeave = (): void => {
    if (this.dragging || this.pinned) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), FADE_DELAY);
  };

  private show = (): void => {
    window.clearTimeout(this.hideTimer);
    this.el.classList.add("is-visible");
    this.schedule();
    if (!this.dragging) {
      this.hideTimer = window.setTimeout(() => this.hide(), FADE_DELAY);
    }
  };

  private hide = (): void => {
    if (this.dragging || this.pinned) return;
    this.el.classList.remove("is-visible");
  };

  private metrics(): { top: number; height: number; travel: number; maxScroll: number } | null {
    const rect = this.target.getBoundingClientRect();
    const viewH = this.target.clientHeight;
    const contentH = this.target.scrollHeight;
    if (contentH <= viewH + 1 || viewH === 0) return null;
    const trackH = Math.max(0, viewH - this.inset * 2);
    const thumbH = Math.min(trackH, Math.max(THUMB_MIN, (viewH / contentH) * trackH));
    const maxScroll = contentH - viewH;
    const travel = trackH - thumbH;
    const ratio = maxScroll > 0 ? this.target.scrollTop / maxScroll : 0;
    return {
      top: rect.top + this.inset + Math.round(travel * ratio),
      height: Math.round(thumbH),
      travel,
      maxScroll,
    };
  }

  /** 飘在 body 上，需要压过宿主所在的浮层（菜单 900、弹窗 1000 等）。 */
  private stackingZ(): number {
    let z = 0;
    for (let node: HTMLElement | null = this.target; node; node = node.parentElement) {
      const value = Number.parseInt(window.getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(value) && value > z) z = value;
    }
    return z + 1;
  }

  /** 设置滑块轨道内缩；返回自身便于链式调用。 */
  setInset(inset: number): this {
    this.inset = inset;
    this.update();
    return this;
  }

  private update(): void {
    const m = this.metrics();
    if (!m) {
      this.el.style.display = "none";
      return;
    }
    const rect = this.target.getBoundingClientRect();
    this.el.style.display = "";
    this.el.style.top = `${m.top}px`;
    this.el.style.height = `${m.height}px`;
    this.el.style.right = `${Math.max(2, Math.round(window.innerWidth - rect.right + 2))}px`;
    this.el.style.zIndex = String(this.stackingZ());
    // 内容变短后如果已经不需要滚动条，直接隐藏
    if (rect.height >= this.target.scrollHeight - 1) this.el.classList.remove("is-visible");
  }

  private onThumbDown = (event: PointerEvent): void => {
    const m = this.metrics();
    if (!m) return;
    event.preventDefault();
    this.dragging = true;
    this.el.classList.add("is-dragging");
    this.dragOffset = event.clientY - this.el.getBoundingClientRect().top;
    this.el.setPointerCapture(event.pointerId);
  };

  private onThumbMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const m = this.metrics();
    if (!m || m.travel <= 0) return;
    const rect = this.target.getBoundingClientRect();
    const y = event.clientY - this.dragOffset - rect.top;
    const ratio = Math.min(1, Math.max(0, y / m.travel));
    this.target.scrollTop = ratio * m.maxScroll;
  };

  private onThumbUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove("is-dragging");
    if (this.el.hasPointerCapture(event.pointerId)) {
      this.el.releasePointerCapture(event.pointerId);
    }
    this.onLeave();
  };
}

/** 让一个滚动容器改用悬浮滚动条（重复调用无副作用）。 */
export function attachOverlayScrollbar(target: HTMLElement | null): OverlayScrollbar | null {
  if (!target) return null;
  const existing = instances.get(target);
  if (existing) {
    existing.refresh();
    return existing;
  }
  const created = new OverlayScrollbar(target);
  instances.set(target, created);
  return created;
}

export function refreshOverlayScrollbar(target: HTMLElement | null): void {
  if (!target) return;
  instances.get(target)?.refresh();
}

/** 容器销毁前解除绑定（弹窗、筛选菜单关闭时调用）。 */
export function detachOverlayScrollbar(target: HTMLElement | null): void {
  if (!target) return;
  const instance = instances.get(target);
  if (!instance) return;
  instance.destroy();
  instances.delete(target);
}

