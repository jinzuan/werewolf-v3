/**
 * ringBuffer.ts — 环形缓冲（纯工具，無 UI/无副作用，雲鵺 A2.3）。
 * useLogStore / LogPanel / GodOverlay 只消费本模块；容量即缓冲区（非限流许可）。
 */

export class RingBuffer<T> {
  private buf: T[] = [];
  private head = 0; // 下一写入位置
  private size = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) capacity = 200;
    this.capacity = Math.floor(capacity);
  }

  /** 写一条；满则覆盖最旧 */
  push(item: T): T {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    return item;
  }

  /** 当前条数（≤ capacity） */
  get length(): number {
    return this.size;
  }

  /** 是否已满 */
  get full(): boolean {
    return this.size === this.capacity;
  }

  /** 读最近 N 条（不足则全部），顺序为写入顺序（旧→新） */
  slice(count: number): T[] {
    const n = Math.max(0, Math.min(count, this.size));
    const out: T[] = [];
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < n; i++) {
      out.push(this.buf[(start + this.size - n + i) % this.capacity]);
    }
    return out;
  }

  /** 全部（旧→新） */
  toArray(): T[] {
    return this.slice(this.size);
  }

  /** 快照（toArray 的别名，供日志面板导出用） */
  snapshot(): T[] {
    return this.toArray();
  }

  /** 清空 */
  clear(): void {
    this.buf = [];
    this.head = 0;
    this.size = 0;
  }
}
