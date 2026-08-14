import type { SessionScheduler } from '../session/types';

interface ScheduledTask {
  id: number;
  at: number;
  callback: () => void;
  active: boolean;
}

export class FakeClock implements SessionScheduler {
  private time = 1_000;
  private nextId = 1;
  private readonly tasks: ScheduledTask[] = [];

  readonly now = (): number => this.time;

  set(delayMs: number, callback: () => void): unknown {
    const task = {
      id: this.nextId++,
      at: this.time + delayMs,
      callback,
      active: true,
    };
    this.tasks.push(task);
    return task.id;
  }

  clear(handle: unknown): void {
    const task = this.tasks.find((item) => item.id === handle);
    if (task) task.active = false;
  }

  elapseWithoutRunningTasks(ms: number): void {
    this.time += ms;
  }

  async advance(ms: number): Promise<void> {
    this.elapseWithoutRunningTasks(ms);
    while (true) {
      const task = this.tasks
        .filter((item) => item.active && item.at <= this.time)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!task) break;
      task.active = false;
      task.callback();
      for (let index = 0; index < 20; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  activeCount(): number {
    return this.tasks.filter((task) => task.active).length;
  }
}
