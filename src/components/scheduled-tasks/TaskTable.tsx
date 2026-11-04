import { Clock3, Loader2, MoreHorizontal, Pencil, Play, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ScheduledTaskView } from "@/lib/api/scheduled-tasks";

interface TaskTableProps {
  views: ScheduledTaskView[];
  scoped: boolean;
  busyTaskId?: string;
  formatTime: (timestamp: number, timezone: string) => string;
  onEnabled: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  onEdit: (view: ScheduledTaskView) => void;
  onDelete: (view: ScheduledTaskView) => void;
  onDetails: (id: string) => void;
}

export function TaskTable({ views, scoped, busyTaskId, formatTime, onEnabled, onRun, onEdit, onDelete, onDetails }: TaskTableProps) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-panel border border-border bg-surface">
      <Table className="min-w-[640px] text-body">
        <TableHeader className="bg-subtle">
          <TableRow className="[&>th]:h-9 [&>th]:text-caption">
            <TableHead>{t("scheduledTasks.name")}</TableHead>
            <TableHead>{t("scheduledTasks.schedule")}</TableHead>
            <TableHead>{t("scheduledTasks.fixedModel")}</TableHead>
            <TableHead>{t("scheduledTasks.status")}</TableHead>
            <TableHead className="w-16 text-end">{t("scheduledTasks.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {views.map((view) => {
            const { task, run } = view;
            const busy = busyTaskId === task.id;
            return (
              <TableRow key={task.id} className="[&>td]:py-3">
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Clock3 aria-hidden className="h-5 w-5 shrink-0 text-fg-3" strokeWidth={1.5} />
                    <div className="min-w-0">
                      <p className="max-w-64 truncate font-medium text-fg-1" title={task.name}>{task.name}</p>
                      {(!scoped || task.accountMode === "all" || task.accountIds.length > 1) && (
                        <p className="mt-0.5 text-caption text-fg-3">
                          {task.accountMode === "all"
                            ? t("scheduledTasks.allAccounts")
                            : t("scheduledTasks.accountsCount", { count: task.accountIds.length })}
                        </p>
                      )}
                      {run?.running && (
                        <button type="button" onClick={() => onDetails(task.id)} className="mt-1 flex items-center gap-1.5 rounded-control text-caption text-action-text focus-visible:outline-ring">
                          <Loader2 aria-hidden className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                          {t("scheduledTasks.running", { done: run.results.length, total: run.accountCount })}
                        </button>
                      )}
                      {!run?.running && run?.error && (
                        <button type="button" onClick={() => onDetails(task.id)} className="mt-1 rounded-control text-caption text-danger-text focus-visible:outline-ring">
                          {t("scheduledTasks.runFailed")}
                        </button>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <p className="max-w-64 text-fg-1 tabular-nums">{t("scheduledTasks.daily", { times: task.times.join(" · ") })}</p>
                  <p className="mt-0.5 text-caption text-fg-3">
                    {task.timezone === "Asia/Shanghai" ? "UTC+8" : "UTC"}
                    {view.nextRunAt != null && ` · ${t("scheduledTasks.nextRun", { time: formatTime(view.nextRunAt, task.timezone) })}`}
                  </p>
                </TableCell>
                <TableCell className="max-w-48 break-words text-fg-2">
                  {task.modelMode === "random" ? t("scheduledTasks.random") : task.fixedModel}
                </TableCell>
                <TableCell>
                  <Switch size="sm" checked={task.enabled} disabled={busy} aria-label={t("scheduledTasks.enabledLabel", { name: task.name })} onCheckedChange={(enabled) => onEnabled(task.id, enabled)} />
                </TableCell>
                <TableCell className="text-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="quiet" size="icon-compact" disabled={busy} aria-label={t("scheduledTasks.taskActions", { name: task.name })}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={run?.running} onSelect={() => onRun(task.id)}><Play className="h-3.5 w-3.5" />{t("scheduledTasks.runNow")}</DropdownMenuItem>
                      <DropdownMenuItem disabled={run?.running} onSelect={() => onEdit(view)}><Pencil className="h-3.5 w-3.5" />{t("scheduledTasks.edit")}</DropdownMenuItem>
                      {run && <DropdownMenuItem onSelect={() => onDetails(task.id)}><Clock3 className="h-3.5 w-3.5" />{t("scheduledTasks.runDetails")}</DropdownMenuItem>}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={run?.running} className="text-danger-text focus:text-danger-text" onSelect={() => onDelete(view)}><Trash2 className="h-3.5 w-3.5" />{t("scheduledTasks.remove")}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
