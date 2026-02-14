export type BroadcastJobStatus = "queued" | "running" | "completed" | "failed";

export type BroadcastJobSnapshot = {
  id: string;
  status: BroadcastJobStatus;
  mode: "broadcast";
  segment: string;
  total: number;
  sent: number;
  failed: number;
  failedUsers: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
};

type BroadcastJobWorkerResult = {
  sent: number;
  failed: number;
  failedUsers: string[];
};

type BroadcastJobWorker = () => Promise<BroadcastJobWorkerResult>;

const MAX_STORED_JOBS = 100;
const jobs = new Map<string, BroadcastJobSnapshot>();

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `br_${Date.now()}_${rand}`;
}

function pruneJobs() {
  if (jobs.size <= MAX_STORED_JOBS) return;
  const ordered = Array.from(jobs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const toDelete = ordered.slice(0, jobs.size - MAX_STORED_JOBS);
  for (const job of toDelete) {
    jobs.delete(job.id);
  }
}

function patchJob(id: string, patch: Partial<BroadcastJobSnapshot>) {
  const current = jobs.get(id);
  if (!current) return;
  jobs.set(id, {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}

export function enqueueBroadcastJob(input: {
  mode: "broadcast";
  segment: string;
  total: number;
  worker: BroadcastJobWorker;
}): BroadcastJobSnapshot {
  const createdAt = nowIso();
  const job: BroadcastJobSnapshot = {
    id: makeId(),
    status: "queued",
    mode: input.mode,
    segment: input.segment,
    total: input.total,
    sent: 0,
    failed: 0,
    failedUsers: [],
    createdAt,
    updatedAt: createdAt,
  };

  jobs.set(job.id, job);
  pruneJobs();

  queueMicrotask(async () => {
    patchJob(job.id, { status: "running", startedAt: nowIso() });
    try {
      const result = await input.worker();
      patchJob(job.id, {
        status: "completed",
        sent: result.sent,
        failed: result.failed,
        failedUsers: result.failedUsers,
        finishedAt: nowIso(),
      });
    } catch (error) {
      patchJob(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Broadcast job failed",
        finishedAt: nowIso(),
      });
    }
  });

  return job;
}

export function getBroadcastJob(jobId: string): BroadcastJobSnapshot | null {
  return jobs.get(jobId) ?? null;
}
