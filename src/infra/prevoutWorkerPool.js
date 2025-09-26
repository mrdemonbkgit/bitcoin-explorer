import { Worker } from 'node:worker_threads';

const workerUrl = new URL('./prevoutWorker.js', import.meta.url);

export function isWorkerThreadsAvailable() {
  return typeof Worker === 'function';
}

export class PrevoutWorkerPool {
  constructor(size, logger) {
    this.size = Math.max(1, size);
    this.logger = logger;
    this.workers = [];
    this.idleWorkers = [];
    this.queue = [];
    this.tasks = new Map();
    this.destroyed = false;
    this.nextTaskId = 0;
    this.workerState = new Map();
  }

  static isSupported() {
    return isWorkerThreadsAvailable();
  }

  async init() {
    for (let i = 0; i < this.size; i += 1) {
      await this.spawnWorker();
    }
  }

  async spawnWorker() {
    if (this.destroyed) {
      return;
    }
    const worker = new Worker(workerUrl, { argv: [] });
    this.workerState.set(worker, { currentTaskId: null });
    worker.on('message', (message) => {
      this.handleMessage(worker, message);
    });
    worker.on('error', (error) => {
      if (this.logger) {
        this.logger.error({ context: { event: 'addressIndexer.prevout.worker.error' }, err: error }, 'Prevout worker encountered an error');
      }
    });
    worker.on('exit', (code) => {
      this.handleExit(worker, code);
    });
    worker.once('online', () => {
      if (this.destroyed) {
        worker.terminate().catch(() => {});
        return;
      }
      this.idleWorkers.push(worker);
      this.dispatch();
    });
    this.workers.push(worker);
  }

  handleExit(worker, code) {
    this.removeWorker(worker);
    if (this.destroyed) {
      return;
    }
    const state = this.workerState.get(worker);
    const currentTaskId = state?.currentTaskId ?? null;
    if (currentTaskId != null) {
      const task = this.tasks.get(currentTaskId);
      if (task) {
        task.reject(new Error('Prevout worker exited before completing task'));
        this.tasks.delete(currentTaskId);
      }
    }
    if (this.logger) {
      this.logger.warn({
        context: {
          event: 'addressIndexer.prevout.worker.exit',
          code
        }
      }, 'Prevout worker exited unexpectedly; respawning');
    }
    this.spawnWorker().catch((error) => {
      if (this.logger) {
        this.logger.error({ context: { event: 'addressIndexer.prevout.worker.spawn.error' }, err: error }, 'Failed to respawn prevout worker');
      }
    });
  }

  removeWorker(worker) {
    const index = this.workers.indexOf(worker);
    if (index >= 0) {
      this.workers.splice(index, 1);
    }
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) {
      this.idleWorkers.splice(idleIndex, 1);
    }
    this.workerState.delete(worker);
  }

  handleMessage(worker, message) {
    const { id, success, prevout, error } = message;
    const task = this.tasks.get(id);
    if (!task) {
      if (this.logger) {
        this.logger.warn({ context: { event: 'addressIndexer.prevout.worker.unknownTask', id } }, 'Received response for unknown prevout worker task');
      }
      return;
    }
    this.tasks.delete(id);
    const state = this.workerState.get(worker);
    if (state) {
      state.currentTaskId = null;
    }
    if (success) {
      task.resolve(prevout ?? null);
    } else {
      const err = new Error(error?.message ?? 'Prevout worker task failed');
      err.cause = error;
      task.reject(err);
    }
    if (!this.destroyed) {
      this.idleWorkers.push(worker);
      this.dispatch();
    }
  }

  dispatch() {
    if (this.destroyed) {
      return;
    }
    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.idleWorkers.shift();
      const task = this.queue.shift();
      const state = this.workerState.get(worker);
      if (state) {
        state.currentTaskId = task.id;
      }
      worker.postMessage({ id: task.id, payload: task.payload });
    }
  }

  runTask(payload) {
    if (this.destroyed) {
      return Promise.reject(new Error('Prevout worker pool destroyed'));
    }
    const id = this.nextTaskId += 1;
    return new Promise((resolve, reject) => {
      const task = { id, payload, resolve, reject };
      this.tasks.set(id, task);
      this.queue.push(task);
      this.dispatch();
    });
  }

  async fetchMany(items) {
    const promises = items.map((payload) =>
      this.runTask(payload)
        .then((prevout) => ({ status: 'ok', prevout }))
        .catch((error) => ({ status: 'error', error: { message: error?.message ?? 'Prevout worker error', code: error?.code ?? null } }))
    );
    return Promise.all(promises);
  }

  async destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.queue.splice(0, this.queue.length);
    for (const [, task] of this.tasks) {
      task.reject(new Error('Prevout worker pool destroyed'));
    }
    this.tasks.clear();
    await Promise.allSettled(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
    this.idleWorkers = [];
    this.workerState.clear();
  }
}
