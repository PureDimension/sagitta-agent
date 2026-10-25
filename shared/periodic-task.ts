import pRetry, { type Options } from 'p-retry';

// 作者注：这是一个定时器注册插件，比较难理解，当个黑盒调用并在功能不充足的时候扩展功能即可
export interface PeriodicTaskOptions<T> {
  run: () => Promise<T>;
  intervalMs: number;
  retry: Omit<Options, 'signal'>;
  signal: AbortSignal;
  // 接入层提供 DSH timeout；停止时须同时取消等待并中止 signal。
  wait: (
    delayMs: number
  ) => Promise<void>;
  onSuccess: (
    result: T
  ) => void | Promise<void>;
  onFailure: (
    error: unknown
  ) => void | Promise<void>;
}

export type PeriodicTaskRegistration<T> = Omit<PeriodicTaskOptions<T>, 'signal' | 'wait'>;

type CancelTimer = () => void;
export type UnregisterTask = () => Promise<void>;

type ScheduleTimer = (
  callback: () => void,
  delayMs: number
) => CancelTimer;

type ReportError = (
  error: unknown
) => void;

/** 管理器统一停止各实例，无需知道它们各自的业务返回类型。 */
interface RunningTask {
  stop(): Promise<void>;
}

/** 注册项独立运行；schedule 接 DSH timeout，reportError 接 DSH logger。 */
export class PeriodicTasks {
  private readonly tasks = new Set<RunningTask>();
  private closed = false;

  constructor(
    private readonly schedule: ScheduleTimer,
    private readonly reportError: ReportError,
  ) {}

  register<T>(
    options: PeriodicTaskRegistration<T>
  ): UnregisterTask {
    if (this.closed) throw new Error('周期任务管理器已关闭');

    const task = new PeriodicTaskRunner(options, this.schedule, this.reportError, () => {
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    task.start();

    return () => task.stop();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const pending: Promise<void>[] = [];

    // 先通知全部实例停止，再一起等待收尾，避免逐项阻塞。
    for (const task of this.tasks) {
      pending.push(task.stop());
    }

    await Promise.all(pending);
  }
}

/** 一个注册对应一个实例；由管理器创建并启动一次。 */
class PeriodicTaskRunner<T> implements RunningTask {
  private readonly controller = new AbortController();
  private execution: Promise<void> = Promise.resolve();
  private cancelTimer: CancelTimer | undefined;
  private finishWait: (() => void) | undefined;

  constructor(
    private readonly options: PeriodicTaskRegistration<T>,
    private readonly schedule: ScheduleTimer,
    private readonly reportError: ReportError,
    private readonly onFinished: () => void,
  ) {}

  start(): void {
    this.execution = this.execute();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.cancelWaiting();
    await this.execution;
  }

  private async execute(): Promise<void> {
    try {
      await runPeriodicTask({
        ...this.options,
        signal: this.controller.signal,
        wait: (
          delayMs
        ) => this.wait(delayMs),
      });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.onFinished();
    }
  }

  private async wait(
    delayMs: number
  ): Promise<void> {
    try {
      await new Promise<void>((
        resolve
      ) => {
        this.finishWait = resolve;
        this.cancelTimer = this.schedule(resolve, delayMs);
      });
    } finally {
      this.cancelTimer = undefined;
      this.finishWait = undefined;
    }
  }

  private cancelWaiting(): void {
    if (this.cancelTimer) this.cancelTimer();

    // 取消定时器后，完成等待中的 Promise，让循环检查停止信号并退出。
    if (this.finishWait) this.finishWait();
  }
}

/** 立即执行首轮，整轮结束后再等待；返回的 Promise 由接入层观察和收尾。 */
export async function runPeriodicTask<T>(
  options: PeriodicTaskOptions<T>
): Promise<void> {
  while (!options.signal.aborted) {
    await runRound(options);
    if (options.signal.aborted) return;

    try {
      await options.wait(options.intervalMs);
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}

/** 只重试业务调用；结果回调失败直接向上传播，避免重复执行业务。 */
async function runRound<T>(
  options: PeriodicTaskOptions<T>
): Promise<void> {
  let result: T;

  try {
    result = await pRetry(options.run, { ...options.retry, signal: options.signal });
  } catch (error) {
    if (!options.signal.aborted) await options.onFailure(error);
    return;
  }

  if (!options.signal.aborted) await options.onSuccess(result);
}
