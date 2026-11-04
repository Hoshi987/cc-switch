import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ChevronRight,
  Clock3,
  History,
  Plus,
  RefreshCw,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { HoverTip } from "@/components/ui/hover-tip";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { authGetStatus } from "@/lib/api/auth";
import {
  scheduledTasksApi,
  scheduledTasksKey,
  type ScheduledTaskDraft,
  type ScheduledTaskView,
} from "@/lib/api/scheduled-tasks";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";
import { TaskEditor } from "./TaskEditor";
import { TaskHistory } from "./TaskHistory";
import { TaskTable } from "./TaskTable";
import { TaskRunFeedback } from "./TaskRunFeedback";

type TaskAction =
  | { type: "run"; id: string }
  | { type: "delete"; id: string }
  | { type: "enabled"; id: string; enabled: boolean };

interface ScheduledTasksPageProps {
  accountId?: string;
  onBack?: () => void;
  onOpenUsage: () => void;
  onOpenAuth: () => void;
}

export function ScheduledTasksPage({
  accountId,
  onBack,
  onOpenUsage,
  onOpenAuth,
}: ScheduledTasksPageProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<ScheduledTaskDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskView | null>(
    null,
  );
  const [catalogsOpen, setCatalogsOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const refreshedOnOpen = useRef<string | null>(null);
  const tasks = useQuery({
    queryKey: scheduledTasksKey,
    queryFn: scheduledTasksApi.get,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.tasks.some((view) => view.run?.running) ? 3000 : 15000,
  });
  const auth = useQuery({
    queryKey: ["managed-auth-status", "codex_oauth"],
    queryFn: () => authGetStatus("codex_oauth"),
    staleTime: 30000,
  });
  const accounts = auth.data?.accounts ?? [];
  const catalogs = tasks.data?.catalogs ?? [];
  const currentAccount = accounts.find((account) => account.id === accountId);
  const currentCatalog = catalogs.find(
    (catalog) => catalog.accountId === accountId,
  );
  const accountName =
    currentAccount?.login || currentCatalog?.accountName || accountId;
  const taskViews = (tasks.data?.tasks ?? []).filter(
    ({ task }) =>
      !accountId ||
      task.accountMode === "all" ||
      task.accountIds.includes(accountId),
  );
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: scheduledTasksKey });
  const refresh = useMutation({
    mutationFn: () => scheduledTasksApi.refreshModels(accountId),
    onSuccess: invalidate,
    onError: (error) =>
      toast.error(t("scheduledTasks.modelsRefreshFailed"), {
        description: extractErrorMessage(error),
      }),
  });
  const refreshModels = refresh.mutate;
  // Wait for the local snapshot to be available before starting network work.
  // This effect runs once per page mount, regardless of cache freshness.
  useEffect(() => {
    const scope = accountId ?? "all";
    if (!tasks.isSuccess || refreshedOnOpen.current === scope) return;
    refreshedOnOpen.current = scope;
    refreshModels();
  }, [tasks.isSuccess, refreshModels, accountId]);

  useTauriEvent("scheduled-tasks-changed", invalidate);

  const action = useMutation({
    mutationFn: (action: TaskAction) => {
      switch (action.type) {
        case "run":
          return scheduledTasksApi.run(action.id);
        case "delete":
          return scheduledTasksApi.remove(action.id);
        case "enabled":
          return scheduledTasksApi.setEnabled(action.id, action.enabled);
      }
    },
    onSuccess: (_result, action) => {
      if (action.type === "delete") setDeleteTarget(null);
      if (action.type === "run") toast.success(t("scheduledTasks.runStarted"));
      return invalidate();
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
  const createTask = () =>
    setEditor({
      id: null,
      name: t("scheduledTasks.defaultName"),
      enabled: false,
      times: ["05:58", "11:00", "16:02"],
      timezone: "Asia/Shanghai",
      accountMode: accountId ? "selected" : "all",
      accountIds: accountId ? [accountId] : [],
      modelMode: "fixed",
      fixedModel: "codex-auto-review",
      message: "hi",
      accountIntervalSecs: 10,
      catchUp: true,
    });
  const formatTime = (timestamp: number, timezone = "Asia/Shanghai") =>
    new Intl.DateTimeFormat(i18n.language, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(new Date(timestamp * 1000));
  const catalogAccountIds = accountId
    ? [accountId]
    : [
        ...new Set([
          ...catalogs.map((catalog) => catalog.accountId),
          ...accounts.map((account) => account.id),
        ]),
      ];
  // Preserve the explicit scope of older all-account / multi-account tasks.
  // New plans and existing single-account plans stay bound to this card.
  const editorAccountId =
    accountId &&
    editor &&
    (editor.id == null ||
      (editor.accountMode === "selected" &&
        editor.accountIds.length === 1 &&
        editor.accountIds[0] === accountId))
      ? accountId
      : undefined;

  return (
    <>
      <AppPageHeader
        leading={
          onBack ? (
            <HoverTip content={t("common.back")}>
              <Button
                variant="quiet"
                size="icon-compact"
                onClick={onBack}
                aria-label={t("common.back")}
              >
                <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </HoverTip>
          ) : undefined
        }
        icon={
          onBack ? undefined : <Clock3 className="h-5 w-5" strokeWidth={1.5} />
        }
        title="Codex"
        variant="app"
        subtitle={`/ ${t("scheduledTasks.title")}`}
        actions={
          <Button variant="quiet" size="regular" onClick={onOpenUsage}>
            <History className="h-4 w-4" />
            {t("scheduledTasks.usageRecords")}
          </Button>
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable"
      >
        <div className="mx-auto max-w-6xl space-y-5 px-6 pb-8 pt-6">
          <div className="flex flex-wrap items-center gap-3 pb-1">
            <h2 className="text-2xl font-semibold tracking-tight text-fg-1">
              {t("scheduledTasks.title")}
            </h2>
            {accountName && (
              <span className="flex max-w-full items-center gap-2 rounded-control bg-subtle px-3 py-1.5 text-body text-fg-2" title={accountName}>
                <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-selected text-caption font-medium text-fg-2">
                  {accountName.slice(0, 1).toUpperCase()}
                </span>
                <span className="max-w-64 truncate">{accountName}</span>
              </span>
            )}
          </div>
          <section className="space-y-3" aria-labelledby="scheduled-task-list">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 id="scheduled-task-list" className="text-strong font-semibold text-fg-1">{t("scheduledTasks.taskList")}</h2>
                {tasks.data && <span className="rounded-full bg-subtle px-2 py-0.5 text-caption tabular-nums text-fg-2">{taskViews.length}</span>}
              </div>
              <Button variant="solid" size="regular" onClick={createTask} disabled={!tasks.isSuccess || Boolean(accountId && auth.isSuccess && !currentAccount)}>
                <Plus className="h-4 w-4" />{t("scheduledTasks.newTask")}
              </Button>
            </div>
            {tasks.isPending && <p role="status" className="py-8 text-center text-body text-fg-3">{t("scheduledTasks.loading")}</p>}
            {tasks.isError && (
              <div role="alert" className="space-y-2 rounded-panel border border-border p-4">
                <p className="text-body text-danger-text">{t("scheduledTasks.loadFailed")}</p>
                <p className="break-words text-caption text-fg-3">{extractErrorMessage(tasks.error)}</p>
                <Button variant="neutral" size="compact" onClick={() => void tasks.refetch()}>{t("scheduledTasks.retry")}</Button>
              </div>
            )}
            {tasks.data && taskViews.length === 0 && (
              <div className="flex items-center gap-3 rounded-panel bg-subtle px-5 py-8">
                <Clock3 aria-hidden className="h-6 w-6 shrink-0 text-fg-3" strokeWidth={1.5} />
                <p className="text-body text-fg-2">{t("scheduledTasks.emptyTitle")}</p>
              </div>
            )}
            {taskViews.length > 0 && (
              <TaskTable
                views={taskViews}
                scoped={Boolean(accountId)}
                busyTaskId={action.isPending ? action.variables.id : undefined}
                formatTime={formatTime}
                onEnabled={(id, enabled) => action.mutate({ type: "enabled", id, enabled })}
                onRun={(id) => action.mutate({ type: "run", id })}
                onEdit={({ task }) => setEditor({ ...task })}
                onDelete={setDeleteTarget}
                onDetails={setSelectedRunId}
              />
            )}
          </section>
          <TaskHistory key={accountId ?? "all"} accountId={accountId} views={tasks.data?.tasks ?? []} />

          {tasks.data && (
            <section className="overflow-hidden rounded-panel border border-border" aria-labelledby="scheduled-model-catalogs">
              <div className="flex items-center gap-3 px-4 py-2.5">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-control text-start focus-visible:outline-ring"
                  aria-expanded={catalogsOpen}
                  aria-controls="scheduled-model-content"
                  onClick={() => setCatalogsOpen(!catalogsOpen)}
                >
                  <ChevronRight aria-hidden className={cn("h-4 w-4 shrink-0 text-fg-3", catalogsOpen && "rotate-90")} />
                  <h2 id="scheduled-model-catalogs" className="text-body font-medium text-fg-1">{t("scheduledTasks.modelCatalogs")}</h2>
                  <span className="text-caption text-fg-3">
                    {t("scheduledTasks.modelsCount", { count: (accountId ? catalogs.filter((catalog) => catalog.accountId === accountId) : catalogs).reduce((total, catalog) => total + catalog.models.length, 0) })}
                  </span>
                  {currentCatalog?.fetchedAt ? <span className="text-caption text-fg-3">{t("scheduledTasks.updatedAt", { time: formatTime(currentCatalog.fetchedAt) })}</span> : null}
                  {catalogs.some((catalog) => (!accountId || catalog.accountId === accountId) && catalog.refreshError) && <span className="text-caption text-danger-text">{t("scheduledTasks.modelsRefreshFailed")}</span>}
                </button>
                <Button variant="neutral" size="compact" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                  <RefreshCw className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin motion-reduce:animate-none")} />
                  {t(refresh.isPending ? "scheduledTasks.refreshingModels" : "scheduledTasks.refreshModels")}
                </Button>
              </div>
              <div id="scheduled-model-content" hidden={!catalogsOpen} className="space-y-3 border-t border-border p-4">
              {auth.isError && (
                <p role="alert" className="text-caption text-danger-text">
                  {t("scheduledTasks.accountsFailed")}
                </p>
              )}
              {catalogAccountIds.length === 0 ? (
                <div className="flex flex-wrap items-center gap-3 rounded-panel border border-border p-4">
                  <p className="text-body text-fg-2">
                    {t(
                      auth.isPending
                        ? "scheduledTasks.accountsLoading"
                        : "scheduledTasks.noAccounts",
                    )}
                  </p>
                  <Button variant="neutral" size="compact" onClick={onOpenAuth}>
                    {t("scheduledTasks.authCenter")}
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-border overflow-hidden rounded-panel border border-border bg-surface">
                  {catalogAccountIds.map((id) => {
                    const account = accounts.find(
                      (account) => account.id === id,
                    );
                    const catalog = catalogs.find(
                      (catalog) => catalog.accountId === id,
                    );
                    return (
                      <details key={id}>
                        <summary className="cursor-pointer px-4 py-3 text-body text-fg-1 focus-visible:outline-ring">
                          <span className="break-all">
                            {account?.login || catalog?.accountName || id}
                          </span>
                          <span className="ms-3 text-caption text-fg-3">
                            {catalog?.fetchedAt
                              ? t("scheduledTasks.modelsCount", {
                                  count: catalog.models.length,
                                })
                              : t("scheduledTasks.noCatalog")}
                          </span>
                          {catalog?.fetchedAt ? (
                            <span className="ms-3 text-caption text-fg-3">
                              {t("scheduledTasks.updatedAt", {
                                time: formatTime(catalog.fetchedAt),
                              })}
                            </span>
                          ) : null}
                          {catalog?.refreshError && (
                            <span className="ms-3 text-caption text-danger-text">
                              {t(
                                catalog.fetchedAt
                                  ? "scheduledTasks.refreshFailedRetained"
                                  : "scheduledTasks.modelsRefreshFailed",
                              )}
                            </span>
                          )}
                        </summary>
                        <div className="space-y-2 px-4 pb-4">
                          {catalog?.refreshError && (
                            <p className="break-words text-caption text-danger-text">
                              {catalog.refreshError}
                            </p>
                          )}
                          {catalog?.models.length ? (
                            <div className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
                              {catalog.models.map((model) => (
                                <span
                                  key={model.id}
                                  className="max-w-full break-all rounded-control border border-border bg-subtle px-2 py-1 font-mono text-caption text-fg-2"
                                >
                                  {model.id}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="text-caption text-fg-3">
                              {t("scheduledTasks.noModels")}
                            </p>
                          )}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
              </div>
            </section>
          )}
        </div>
      </div>

      <Sheet open={selectedRunId != null} onOpenChange={(open) => { if (!open) setSelectedRunId(null); }}>
        <SheetContent width={560} closeLabel={t("common.close")} dismissOnOutsideClick aria-describedby={undefined}>
          <SheetHeader><SheetTitle>{t("scheduledTasks.runDetails")}</SheetTitle></SheetHeader>
          <SheetBody>
            {taskViews.filter(({ task, run }) => task.id === selectedRunId && run).map(({ task, run }) => (
              <div key={task.id} className="space-y-3">
                <p className="font-medium text-fg-1">{task.name}</p>
                {run?.error && <p role="alert" className="break-words text-body text-danger-text">{run.error}</p>}
                {run && <TaskRunFeedback run={run} defaultOpen />}
              </div>
            ))}
          </SheetBody>
        </SheetContent>
      </Sheet>

      {editor && (
        <TaskEditor
          initial={editor}
          scopeAccountId={editorAccountId}
          accounts={accounts}
          accountsLoading={auth.isPending}
          accountsFailed={auth.isError}
          catalogs={catalogs}
          onClose={() => setEditor(null)}
          onSave={async (draft) => {
            await scheduledTasksApi.save(draft);
            await invalidate();
          }}
        />
      )}
      <ConfirmDialog
        isOpen={deleteTarget != null}
        title={t("scheduledTasks.deleteTitle")}
        message={t("scheduledTasks.deleteMessage", {
          name: deleteTarget?.task.name ?? "",
        })}
        confirmText={t("scheduledTasks.remove")}
        pending={action.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget)
            action.mutate({ type: "delete", id: deleteTarget.task.id });
        }}
      />
    </>
  );
}
