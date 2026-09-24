const { Queue, Worker } = require("bullmq");
const crypto = require("crypto");

class MemoryJob {
  constructor(id, name, data, processor) {
    this.id = id;
    this.name = name;
    this.data = data;
    this._progress = 0;
    this._returnvalue = null;
    this._failedReason = null;
    this._finished = false;
    this._failed = false;
    this._processor = processor;
  }

  async updateProgress(p) {
    this._progress = p;
  }

  async start() {
    try {
      this._returnvalue = await this._processor(this);
      this._finished = true;
    } catch (e) {
      console.error(`[MemoryJob] ${this.name} failed:`, e?.message || e);
      this._failedReason = e?.message || String(e);
      this._failed = true;
    }
  }

  isCompleted() { return this._finished; }
  isFailed() { return this._failed; }
  get progress() { return this._progress; }
  get returnvalue() { return this._returnvalue; }
  get failedReason() { return this._failedReason; }
}

class TaskManager {
  constructor(redisClient) {
    this.redisClient = redisClient;
    this.processors = {};
    this.memoryJobs = new Map();
    this.activeJobsByDedupeKey = new Map();
    this.queues = {};
    this.workers = {};

    if (this.redisClient) {
      console.log("[TaskManager] Using BullMQ (Redis)");
    } else {
      console.log("[TaskManager] Redis unavailable, using in-memory queue");
    }
  }

  registerWorker(queueName, processor, options = {}) {
    this.processors[queueName] = processor;
    if (this.redisClient) {
      try {
        this.queues[queueName] = new Queue(queueName, { connection: this.redisClient });
        this.workers[queueName] = new Worker(queueName, async (job) => {
          console.log(`[Worker:${queueName}] Processing job ${job.id}`);
          try {
            const result = await processor(job);
            console.log(`[Worker:${queueName}] Job ${job.id} completed`);
            return result;
          } catch (e) {
            console.error(`[Worker:${queueName}] Job ${job.id} failed:`, e?.message || e);
            throw e;
          } finally {
            const dedupeKey = String(job?.data?.__dedupeKey || "");
            if (dedupeKey && this.activeJobsByDedupeKey.get(dedupeKey) === String(job.id)) {
              this.activeJobsByDedupeKey.delete(dedupeKey);
            }
          }
        }, {
          connection: this.redisClient,
          concurrency: options.concurrency || 2,
        });

        this.workers[queueName].on("failed", (job, err) => {
          console.error(`[Worker:${queueName}] Job ${job?.id} FAILED:`, err?.message || err);
        });
        this.workers[queueName].on("error", (err) => {
          console.error(`[Worker:${queueName}] Worker error:`, err?.message || err);
        });

        console.log(`[TaskManager] Registered Redis worker: ${queueName} (concurrency: ${options.concurrency || 2})`);
      } catch (e) {
        console.error(`[TaskManager] Failed to register Redis worker for ${queueName}:`, e?.message || e);
        console.log(`[TaskManager] Falling back to memory queue for ${queueName}`);
      }
    }
  }

  async addJob(queueName, jobName, data, options = {}) {
    const dedupeKey = String(options?.dedupeKey || "").trim();
    if (dedupeKey) {
      const activeId = this.activeJobsByDedupeKey.get(dedupeKey);
      if (activeId) {
        console.log(`[TaskManager] Reusing active job ${activeId} for ${dedupeKey}`);
        return activeId;
      }
    }

    const payload = dedupeKey ? { ...(data || {}), __dedupeKey: dedupeKey } : { ...(data || {}) };

    // Try Redis first
    if (this.redisClient && this.queues[queueName]) {
      try {
        const job = await this.queues[queueName].add(jobName, payload);
        if (dedupeKey) this.activeJobsByDedupeKey.set(dedupeKey, String(job.id));
        console.log(`[TaskManager] Job ${job.id} added to Redis queue: ${queueName}`);
        return job.id;
      } catch (e) {
        console.error(`[TaskManager] Redis enqueue failed for ${queueName}, falling back to memory:`, e?.message || e);
      }
    }

    // Memory fallback
    const p = this.processors[queueName];
    if (!p) throw new Error(`Queue "${queueName}" not registered and no processor available`);

    const id = crypto.randomUUID();
    const wrappedProcessor = async (jobLike) => {
      try {
        return await p(jobLike);
      } finally {
        if (dedupeKey && this.activeJobsByDedupeKey.get(dedupeKey) === id) {
          this.activeJobsByDedupeKey.delete(dedupeKey);
        }
      }
    };
    const job = new MemoryJob(id, jobName, payload, wrappedProcessor);
    this.memoryJobs.set(id, job);
    if (dedupeKey) this.activeJobsByDedupeKey.set(dedupeKey, id);
    console.log(`[TaskManager] Job ${id} added to memory queue: ${queueName}`);
    setTimeout(() => job.start(), 0);
    return id;
  }

  async getJobStatus(queueName, jobId) {
    // Try Redis
    if (this.redisClient && this.queues[queueName]) {
      try {
        const job = await this.queues[queueName].getJob(jobId);
        if (job) {
          const state = await job.getState();
          return {
            id: job.id,
            state,
            progress: job.progress || 0,
            returnvalue: job.returnvalue,
            failedReason: job.failedReason,
            ownerUserId: job.data?.userId || null,
            isCompleted: await job.isCompleted(),
            isFailed: await job.isFailed(),
            backend: "redis",
          };
        }
      } catch (e) {
        // fall through to memory
      }
    }

    // Memory fallback
    const job = this.memoryJobs.get(jobId);
    if (!job) return null;
    let state = "active";
    if (job.isCompleted()) state = "completed";
    if (job.isFailed()) state = "failed";
    return {
      id: job.id,
      state,
      progress: job.progress,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      ownerUserId: job.data?.userId || null,
      isCompleted: job.isCompleted(),
      isFailed: job.isFailed(),
      backend: "memory",
    };
  }
}

module.exports = { TaskManager };
