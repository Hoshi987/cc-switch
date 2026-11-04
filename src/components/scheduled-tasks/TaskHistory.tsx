import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RequestDetailPanel } from "@/components/usage/RequestDetailPanel";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { ScheduledTaskView } from "@/lib/api/scheduled-tasks";
import { usageApi } from "@/lib/api/usage";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";

const historyKey = ["usage", "scheduled-task-history"] as const;

export function TaskHistory({ accountId, views }: { accountId?: string; views: ScheduledTaskView[] }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const pageSize = expanded ? 20 : 5;
  const history = useQuery({
    queryKey: [...historyKey, accountId ?? null, page, pageSize],
    queryFn: () => usageApi.getRequestLogs({ appType: "codex", scheduledOnly: true, scheduledAccountId: accountId }, page, pageSize),
    refetchOnMount: "always",
    refetchInterval: views.some(({ run }) => run?.running) ? 3000 : 15000,
  });
  useTauriEvent("scheduled-tasks-changed", () => queryClient.invalidateQueries({ queryKey: historyKey }));
  const formatTime = (timestamp: number) => new Intl.DateTimeFormat(i18n.language, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(timestamp * 1000));

  return (
    <section className="space-y-3 border-t border-border pt-5" aria-labelledby="scheduled-history-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="scheduled-history-title" className="text-strong font-semibold text-fg-1">{t("scheduledTasks.recentRuns")}</h2>
        {(expanded || (history.data?.total ?? 0) > 5) && (
          <Button variant="quiet" size="compact" onClick={() => { setExpanded(!expanded); setPage(0); }}>
            {t(expanded ? "scheduledTasks.showRecent" : "scheduledTasks.viewAll")}
            <ChevronRight aria-hidden className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-panel border border-border bg-surface">
        {history.isPending ? (
          <p role="status" className="flex items-center justify-center gap-2 py-10 text-body text-fg-3"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("scheduledTasks.historyLoading")}</p>
        ) : history.isError ? (
          <div role="alert" className="space-y-2 p-4">
            <p className="text-body text-danger-text">{t("scheduledTasks.historyFailed")}</p>
            <p className="break-words text-caption text-fg-3">{extractErrorMessage(history.error)}</p>
            <Button variant="neutral" size="compact" onClick={() => void history.refetch()}>{t("scheduledTasks.retry")}</Button>
          </div>
        ) : (
          <Table className="min-w-[700px] text-body">
            <TableHeader className="bg-subtle">
              <TableRow className="[&>th]:h-9 [&>th]:text-caption">
                <TableHead>{t("scheduledTasks.executedAt")}</TableHead>
                <TableHead>{t("scheduledTasks.task")}</TableHead>
                <TableHead>{t("scheduledTasks.accountModel")}</TableHead>
                <TableHead>{t("scheduledTasks.result")}</TableHead>
                <TableHead>{t("scheduledTasks.duration")}</TableHead>
                <TableHead className="text-end"><span className="sr-only">{t("scheduledTasks.details")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data?.data.map((log) => {
                const taskId = /^scheduled:([^:]+):/.exec(log.requestId)?.[1];
                const task = views.find(({ task }) => task.id === taskId)?.task;
                const account = log.providerId.replace(/^Codex 定时任务 · /, "");
                const success = log.statusCode >= 200 && log.statusCode < 300 && !log.errorMessage;
                const StatusIcon = success ? CheckCircle2 : XCircle;
                return (
                  <TableRow key={log.requestId} className="[&>td]:py-2.5">
                    <TableCell className="whitespace-nowrap text-fg-2 tabular-nums">{formatTime(log.createdAt)}</TableCell>
                    <TableCell><span className="block max-w-40 truncate text-fg-1" title={task?.name}>{task?.name ?? t("scheduledTasks.deletedTask")}</span></TableCell>
                    <TableCell>
                      <p className="max-w-52 truncate text-fg-1" title={account}>{account}</p>
                      <p className="mt-0.5 max-w-52 truncate text-caption text-fg-3" title={log.model}>{log.model === "(unresolved)" ? t("scheduledTasks.unresolvedModel") : log.model}</p>
                    </TableCell>
                    <TableCell>
                      <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", success ? "text-success-text" : "text-danger-text")}>
                        <StatusIcon aria-hidden className="h-4 w-4" />{t(success ? "scheduledTasks.success" : "scheduledTasks.failed")}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-fg-2 tabular-nums">{(log.latencyMs / 1000).toFixed(1)} s</TableCell>
                    <TableCell className="text-end">
                      <Button variant="quiet" size="compact" className="text-action-text" onClick={() => setRequestId(log.requestId)}>
                        {t(success ? "scheduledTasks.details" : "scheduledTasks.failureReason")}<ChevronRight aria-hidden className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {history.data?.data.length === 0 && <TableRow><TableCell colSpan={6} className="py-10 text-center text-fg-3">{t("scheduledTasks.noHistory")}</TableCell></TableRow>}
            </TableBody>
          </Table>
        )}
        {expanded && (
          <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2 text-caption text-fg-3">
            <span>{t("scheduledTasks.historyTotal", { count: history.data?.total ?? 0 })}</span>
            <Button variant="quiet" size="icon-compact" disabled={page === 0 || history.isPending} aria-label={t("usage.prevPage")} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="tabular-nums">{page + 1}</span>
            <Button variant="quiet" size="icon-compact" disabled={!history.data || (page + 1) * pageSize >= history.data.total || history.isFetching} aria-label={t("usage.nextPage")} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
      <RequestDetailPanel requestId={requestId} onClose={() => setRequestId(null)} />
    </section>
  );
}
