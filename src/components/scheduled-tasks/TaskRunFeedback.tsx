import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import { tierLabel } from "@/components/SubscriptionQuotaFooter";
import type {
  ScheduledAccountResult,
  ScheduledTaskRun,
} from "@/lib/api/scheduled-tasks";
import { cn } from "@/lib/utils";

export function TaskRunFeedback({ run, defaultOpen = false }: { run: ScheduledTaskRun; defaultOpen?: boolean }) {
  const { t } = useTranslation();
  return (
    <details open={defaultOpen} className="border-t border-border px-4 py-3">
      <summary className="cursor-pointer text-caption font-medium text-fg-2 focus-visible:outline-ring">
        {t("scheduledTasks.runDetails")}
      </summary>
      {run.results.length === 0 && run.running && (
        <p
          role="status"
          className="mt-3 flex items-center gap-2 text-caption text-fg-2"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          {t("scheduledTasks.waiting")}
        </p>
      )}
      <div className="mt-3 space-y-3">
        {run.results.map((result) => (
          <AccountFeedback key={result.accountId} result={result} />
        ))}
      </div>
    </details>
  );
}

function AccountFeedback({ result }: { result: ScheduledAccountResult }) {
  const { t, i18n } = useTranslation();
  const before = result.quotaBefore?.success ? result.quotaBefore.tiers : [];
  const after = result.quotaAfter?.success ? result.quotaAfter.tiers : [];
  const names = [...new Set([...before, ...after].map((tier) => tier.name))];
  const formatReset = (value: string | null | undefined) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : date.toLocaleString(i18n.language);
  };
  const Icon = result.success ? Check : X;
  return (
    <div className="rounded-control border border-border bg-surface p-3 text-caption">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 break-all font-medium text-fg-1">
          {result.accountName}
        </span>
        <span
          className={cn(
            "flex items-center gap-1",
            result.success ? "text-success-text" : "text-danger-text",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {t(
            result.success ? "scheduledTasks.success" : "scheduledTasks.failed",
          )}
        </span>
        <span className="text-fg-3">
          {result.tokensUsed == null
            ? t("scheduledTasks.unknownTokens")
            : t("scheduledTasks.tokens", { count: result.tokensUsed })}
        </span>
        <span className="tabular-nums text-fg-3">
          {(result.latencyMs / 1000).toFixed(1)} s
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-fg-2">
        {result.model || t("scheduledTasks.unresolvedModel")}
      </p>
      {result.usedRandomFallback && (
        <p className="mt-1 text-fg-3">{t("scheduledTasks.randomFallback")}</p>
      )}
      {result.error && (
        <p className="mt-2 whitespace-pre-wrap break-words text-danger-text">
          {result.error}
        </p>
      )}
      <div className="mt-3 border-t border-border pt-2">
        <p className="mb-1 font-medium text-fg-2">
          {t("scheduledTasks.quotaComparison")}
        </p>
        {names.length === 0 ? (
          <p className="text-fg-3">{t("scheduledTasks.quotaUnavailable")}</p>
        ) : (
          names.map((name) => {
            const previous = before.find((tier) => tier.name === name);
            const current = after.find((tier) => tier.name === name);
            return (
              <div key={name} className="py-1 text-fg-2">
                <p className="flex flex-wrap justify-between gap-2">
                  <span>{tierLabel(t, name)}</span>
                  <span className="tabular-nums">
                    {previous ? `${previous.utilization}%` : "—"} →{" "}
                    {current ? `${current.utilization}%` : "—"}
                  </span>
                </p>
                <p className="mt-0.5 break-words text-fg-3">
                  {t("scheduledTasks.resetAt", {
                    time: `${formatReset(previous?.resetsAt)} → ${formatReset(current?.resetsAt)}`,
                  })}
                </p>
              </div>
            );
          })
        )}
        <p className="mt-1 text-fg-3">{t("scheduledTasks.quotaHint")}</p>
      </div>
    </div>
  );
}
