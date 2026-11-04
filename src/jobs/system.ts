import type { Db } from "../db";
import type { ApprovalService } from "../security/approvals";
import { pruneExecutions } from "../obs/executions";
import type { JobQueue } from "./queue";

type Verifier = Parameters<ApprovalService["reconcileUnknown"]>[0];

/**
 * Background work that used to run on a setInterval in every process. As recurring jobs, each runs on one instance at a
 * time (the dedupe key keeps a single queued or running instance), survives restarts, and is retried on failure.
 */
export function registerSystemJobs(queue: JobQueue, d: { db: Db; approvals: ApprovalService; verifier: Verifier; executionDays?: number; jobDays?: number }) {
  return queue
    .register("system.reconcile", {
      everyMs: 60_000,
      leaseMs: 10 * 60_000,
      // Stuck "executing" requests become unknown_outcome, then unknown outcomes are checked against live platform state.
      // Never re-sends a mutation (see ApprovalService.reconcileUnknown).
      run: async () => {
        await d.approvals.recoverStuck();
        await d.approvals.reconcileUnknown(d.verifier);
      },
    })
    .register("system.prune_executions", { everyMs: 24 * 3600_000, run: async () => void (await pruneExecutions(d.db, d.executionDays ?? 30)) })
    .register("system.prune_jobs", { everyMs: 24 * 3600_000, run: async () => void (await queue.prune(d.jobDays ?? 7)) });
}
