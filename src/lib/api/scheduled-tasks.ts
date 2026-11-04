import { invoke } from "@tauri-apps/api/core";
import type { SubscriptionQuota } from "@/types/subscription";

export interface ScheduledTaskDraft {
  id: string | null;
  name: string;
  enabled: boolean;
  times: string[];
  timezone: "Asia/Shanghai" | "UTC";
  accountMode: "all" | "selected";
  accountIds: string[];
  modelMode: "random" | "fixed";
  fixedModel: string;
  message: string;
  accountIntervalSecs: number;
  catchUp: boolean;
}

export interface ScheduledTask extends ScheduledTaskDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
  scheduleChangedAt: number;
  lastScheduledAt: number | null;
}

export interface ScheduledModelCatalog {
  accountId: string;
  accountName: string;
  chatgptAccountId: string;
  models: { id: string; ownedBy?: string | null }[];
  fetchedAt: number;
  reasoningEfforts: Record<string, string>;
  refreshError: string | null;
}

export interface ScheduledAccountResult {
  accountId: string;
  accountName: string;
  model: string | null;
  usedRandomFallback: boolean;
  success: boolean;
  stage: string;
  error: string | null;
  tokensUsed: number | null;
  latencyMs: number;
  quotaBefore: SubscriptionQuota | null;
  quotaAfter: SubscriptionQuota | null;
}

export interface ScheduledTaskRun {
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  accountCount: number;
  results: ScheduledAccountResult[];
  error: string | null;
}

export interface ScheduledTaskView {
  task: ScheduledTask;
  nextRunAt: number | null;
  run: ScheduledTaskRun | null;
}

export interface ScheduledTasksSnapshot {
  tasks: ScheduledTaskView[];
  catalogs: ScheduledModelCatalog[];
}

export const scheduledTasksKey = ["scheduled-tasks"] as const;

export const scheduledTasksApi = {
  get: () => invoke<ScheduledTasksSnapshot>("get_scheduled_tasks"),
  save: (task: ScheduledTaskDraft) =>
    invoke<void>("save_scheduled_task", { task }),
  setEnabled: (taskId: string, enabled: boolean) =>
    invoke<void>("set_scheduled_task_enabled", { taskId, enabled }),
  remove: (taskId: string) => invoke<void>("delete_scheduled_task", { taskId }),
  run: (taskId: string) => invoke<void>("run_scheduled_task", { taskId }),
  refreshModels: (accountId?: string) =>
    invoke<void>("refresh_scheduled_task_models", {
      accountId: accountId ?? null,
    }),
};
