import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import type {
  ScheduledModelCatalog,
  ScheduledTaskDraft,
} from "@/lib/api/scheduled-tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { extractErrorMessage } from "@/utils/errorUtils";

interface TaskEditorProps {
  initial: ScheduledTaskDraft;
  scopeAccountId?: string;
  accounts: ManagedAuthAccount[];
  accountsLoading: boolean;
  accountsFailed: boolean;
  catalogs: ScheduledModelCatalog[];
  onSave: (draft: ScheduledTaskDraft) => Promise<void>;
  onClose: () => void;
}

export function TaskEditor({
  initial,
  scopeAccountId,
  accounts,
  accountsLoading,
  accountsFailed,
  catalogs,
  onSave,
  onClose,
}: TaskEditorProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [draft, setDraft] = useState<ScheduledTaskDraft>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof ScheduledTaskDraft>(
    key: K,
    value: ScheduledTaskDraft[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const modelIds = [
    ...new Set(
      catalogs
        .filter(
          (catalog) =>
            draft.accountMode === "all" ||
            draft.accountIds.includes(catalog.accountId),
        )
        .flatMap((catalog) => catalog.models.map((model) => model.id)),
    ),
  ].sort();
  const missingIds = draft.accountIds.filter(
    (id) => !accounts.some((account) => account.id === id),
  );
  const scopeAccountName =
    accounts.find((account) => account.id === scopeAccountId)?.login ||
    catalogs.find((catalog) => catalog.accountId === scopeAccountId)
      ?.accountName ||
    scopeAccountId;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onSave(
        scopeAccountId
          ? {
              ...draft,
              accountMode: "selected",
              accountIds: [scopeAccountId],
            }
          : draft,
      );
      onClose();
    } catch (error) {
      setError(extractErrorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t(
              initial.id ? "scheduledTasks.editTask" : "scheduledTasks.newTask",
            )}
          </DialogTitle>
          <DialogDescription>
            {t("scheduledTasks.enabledHint")}
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          onSubmit={save}
          className="min-h-0 overflow-y-auto px-6 py-1"
        >
          <fieldset disabled={pending} className="min-w-0 space-y-5 pb-2">
            <div className="space-y-2">
              <Label htmlFor={`${formId}-name`}>
                {t("scheduledTasks.name")}
              </Label>
              <Input
                id={`${formId}-name`}
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder={t("scheduledTasks.namePlaceholder")}
                maxLength={100}
                required
                autoFocus
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
              <fieldset className="min-w-0 space-y-2">
                <legend className="mb-2 text-body font-medium">
                  {t("scheduledTasks.times")}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {draft.times.map((time, index) => (
                    <div key={index} className="flex items-center gap-1">
                      <Input
                        type="time"
                        step={60}
                        aria-label={`${t("scheduledTasks.times")} ${index + 1}`}
                        className="w-[112px] tabular-nums"
                        value={time}
                        onChange={(event) =>
                          update(
                            "times",
                            draft.times.map((value, at) =>
                              at === index ? event.target.value : value,
                            ),
                          )
                        }
                        required
                      />
                      <Button
                        type="button"
                        variant="quiet"
                        size="icon-compact"
                        disabled={draft.times.length === 1}
                        aria-label={t("scheduledTasks.removeTime", {
                          index: index + 1,
                        })}
                        onClick={() =>
                          update(
                            "times",
                            draft.times.filter((_, at) => at !== index),
                          )
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="neutral"
                    size="regular"
                    disabled={draft.times.length >= 24}
                    onClick={() => update("times", [...draft.times, "12:00"])}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("scheduledTasks.addTime")}
                  </Button>
                </div>
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor={`${formId}-timezone`}>
                  {t("scheduledTasks.timezone")}
                </Label>
                <Select
                  value={draft.timezone}
                  onValueChange={(value) =>
                    update("timezone", value as ScheduledTaskDraft["timezone"])
                  }
                >
                  <SelectTrigger id={`${formId}-timezone`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Asia/Shanghai">
                      {t("scheduledTasks.shanghai")}
                    </SelectItem>
                    <SelectItem value="UTC">
                      {t("scheduledTasks.utc")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {scopeAccountId ? (
              <div className="space-y-2">
                <Label htmlFor={`${formId}-account`}>
                  {t("scheduledTasks.currentAccount")}
                </Label>
                <Input
                  id={`${formId}-account`}
                  value={scopeAccountName ?? ""}
                  readOnly
                />
                <p className="text-caption text-fg-3">
                  {t("scheduledTasks.scopedAccountHint")}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor={`${formId}-accounts`}>
                  {t("scheduledTasks.accounts")}
                </Label>
                <Select
                  value={draft.accountMode}
                  onValueChange={(value) =>
                    update(
                      "accountMode",
                      value as ScheduledTaskDraft["accountMode"],
                    )
                  }
                >
                  <SelectTrigger id={`${formId}-accounts`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t("scheduledTasks.allAccounts")}
                    </SelectItem>
                    <SelectItem value="selected">
                      {t("scheduledTasks.selectedAccounts")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {draft.accountMode === "all" ? (
                  <p className="text-caption text-fg-3">
                    {t("scheduledTasks.allAccountsHint")}
                  </p>
                ) : (
                  <div className="max-h-40 space-y-2 overflow-y-auto rounded-control border border-border p-3">
                    {accounts.map((account) => (
                      <label
                        key={account.id}
                        className="flex cursor-pointer items-center gap-2 text-body"
                      >
                        <Checkbox
                          checked={draft.accountIds.includes(account.id)}
                          onCheckedChange={(checked) =>
                            update(
                              "accountIds",
                              checked
                                ? [...draft.accountIds, account.id]
                                : draft.accountIds.filter(
                                    (id) => id !== account.id,
                                  ),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {account.login}
                        </span>
                        {account.reauth_required && (
                          <span className="text-caption text-danger-text">
                            {t("scheduledTasks.reauth")}
                          </span>
                        )}
                      </label>
                    ))}
                    {!accountsLoading &&
                      !accountsFailed &&
                      missingIds.map((id) => (
                        <label
                          key={id}
                          className="flex items-center gap-2 text-body text-danger-text"
                        >
                          <Checkbox
                            checked
                            onCheckedChange={() =>
                              update(
                                "accountIds",
                                draft.accountIds.filter(
                                  (value) => value !== id,
                                ),
                              )
                            }
                          />
                          <span className="min-w-0 break-all">
                            {t("scheduledTasks.missingAccount", { id })}
                          </span>
                        </label>
                      ))}
                    {accountsLoading && (
                      <p className="text-caption text-fg-3">
                        {t("scheduledTasks.accountsLoading")}
                      </p>
                    )}
                    {accountsFailed && (
                      <p className="text-caption text-danger-text">
                        {t("scheduledTasks.accountsFailed")}
                      </p>
                    )}
                    {!accountsLoading &&
                      !accountsFailed &&
                      accounts.length === 0 &&
                      missingIds.length === 0 && (
                        <p className="text-caption text-fg-3">
                          {t("scheduledTasks.noAccounts")}
                        </p>
                      )}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor={`${formId}-model-mode`}>
                {t("scheduledTasks.modelMode")}
              </Label>
              <Select
                value={draft.modelMode}
                onValueChange={(value) =>
                  update("modelMode", value as ScheduledTaskDraft["modelMode"])
                }
              >
                <SelectTrigger id={`${formId}-model-mode`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="random">
                    {t("scheduledTasks.random")}
                  </SelectItem>
                  <SelectItem value="fixed">
                    {t("scheduledTasks.fixed")}
                  </SelectItem>
                </SelectContent>
              </Select>
              {draft.modelMode === "fixed" && (
                <>
                  <Label htmlFor={`${formId}-model`} className="sr-only">
                    {t("scheduledTasks.fixedModel")}
                  </Label>
                  <Input
                    id={`${formId}-model`}
                    list={`${formId}-models`}
                    value={draft.fixedModel}
                    onChange={(event) =>
                      update("fixedModel", event.target.value)
                    }
                    placeholder={t("scheduledTasks.modelPlaceholder")}
                    maxLength={256}
                    required
                  />
                  <datalist id={`${formId}-models`}>
                    {modelIds.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                </>
              )}
              <p className="text-caption leading-relaxed text-fg-3">
                {t(
                  draft.modelMode === "fixed"
                    ? "scheduledTasks.fixedHint"
                    : "scheduledTasks.randomHint",
                )}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${formId}-message`}>
                {t("scheduledTasks.message")}
              </Label>
              <Textarea
                id={`${formId}-message`}
                value={draft.message}
                onChange={(event) => update("message", event.target.value)}
                maxLength={16000}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${formId}-interval`}>
                {t("scheduledTasks.interval")}
              </Label>
              <Input
                id={`${formId}-interval`}
                type="number"
                min={1}
                max={300}
                step={1}
                required
                className="w-28 tabular-nums"
                value={
                  Number.isNaN(draft.accountIntervalSecs)
                    ? ""
                    : draft.accountIntervalSecs
                }
                onChange={(event) =>
                  update("accountIntervalSecs", event.target.valueAsNumber)
                }
              />
              <p className="text-caption text-fg-3">
                {t("scheduledTasks.intervalHint")}
              </p>
            </div>
            <div className="space-y-4 border-t border-border pt-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor={`${formId}-catch-up`}>
                    {t("scheduledTasks.catchUp")}
                  </Label>
                  <p className="text-caption leading-relaxed text-fg-3">
                    {t("scheduledTasks.catchUpHint")}
                  </p>
                </div>
                <Switch
                  id={`${formId}-catch-up`}
                  checked={draft.catchUp}
                  onCheckedChange={(value) => update("catchUp", value)}
                />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor={`${formId}-enabled`}>
                    {t("scheduledTasks.enabled")}
                  </Label>
                  <p className="text-caption leading-relaxed text-fg-3">
                    {t("scheduledTasks.enabledHint")}
                  </p>
                </div>
                <Switch
                  id={`${formId}-enabled`}
                  checked={draft.enabled}
                  onCheckedChange={(value) => update("enabled", value)}
                />
              </div>
            </div>
            {error && (
              <p
                role="alert"
                className="break-words text-body text-danger-text"
              >
                {error}
              </p>
            )}
          </fieldset>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="neutral"
            onClick={onClose}
            disabled={pending}
          >
            {t("scheduledTasks.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="solid"
            disabled={pending}
          >
            {t("scheduledTasks.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
