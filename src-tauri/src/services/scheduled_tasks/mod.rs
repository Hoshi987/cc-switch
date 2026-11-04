//! App-resident scheduling. This module owns configuration, model catalogs,
//! and schedule de-duplication only; UsageLogger owns all request history.

mod request;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, FixedOffset, NaiveTime, TimeZone, Utc};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinSet;

use crate::proxy::usage::{CostCalculator, RequestLog, UsageLogger};
use crate::services::codex_oauth_models;
use crate::services::model_fetch::FetchedModel;
use crate::services::subscription::{query_codex_quota, SubscriptionQuota};
use crate::store::AppState;

const STORE_KEY: &str = "scheduled_codex_tasks_v1";
pub(crate) const CHANGE_EVENT: &str = "scheduled-tasks-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelMode {
    Random,
    Fixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountMode {
    All,
    Selected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskTimezone {
    #[serde(rename = "Asia/Shanghai")]
    Shanghai,
    #[serde(rename = "UTC")]
    Utc,
}

impl TaskTimezone {
    fn offset(self) -> FixedOffset {
        // Both supported zones have a fixed offset; do not silently substitute
        // the host timezone for the timezone saved in a task.
        FixedOffset::east_opt(if self == Self::Shanghai { 8 * 3600 } else { 0 })
            .expect("supported timezone offset")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub id: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub times: Vec<String>,
    pub timezone: TaskTimezone,
    pub account_mode: AccountMode,
    pub account_ids: Vec<String>,
    pub model_mode: ModelMode,
    pub fixed_model: String,
    pub message: String,
    pub account_interval_secs: u64,
    pub catch_up: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub times: Vec<String>,
    pub timezone: TaskTimezone,
    pub account_mode: AccountMode,
    pub account_ids: Vec<String>,
    pub model_mode: ModelMode,
    pub fixed_model: String,
    pub message: String,
    pub account_interval_secs: u64,
    pub catch_up: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub schedule_changed_at: i64,
    pub last_scheduled_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub account_id: String,
    #[serde(default)]
    pub account_name: String,
    pub chatgpt_account_id: String,
    pub models: Vec<FetchedModel>,
    pub fetched_at: i64,
    #[serde(default)]
    pub reasoning_efforts: BTreeMap<String, String>,
    pub refresh_error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    #[serde(default)]
    tasks: Vec<ScheduledTask>,
    #[serde(default)]
    catalogs: BTreeMap<String, ModelCatalog>,
}

/// Transient feedback for the current app session, never an execution-history
/// store. Historical requests are read through the existing usage APIs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountResult {
    pub account_id: String,
    pub account_name: String,
    pub model: Option<String>,
    pub used_random_fallback: bool,
    pub success: bool,
    pub stage: String,
    pub error: Option<String>,
    pub tokens_used: Option<u64>,
    pub latency_ms: u64,
    pub quota_before: Option<SubscriptionQuota>,
    pub quota_after: Option<SubscriptionQuota>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunState {
    pub running: bool,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub account_count: usize,
    pub results: Vec<AccountResult>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub task: ScheduledTask,
    pub next_run_at: Option<i64>,
    pub run: Option<TaskRunState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerSnapshot {
    pub tasks: Vec<TaskView>,
    pub catalogs: Vec<ModelCatalog>,
}

#[derive(Clone)]
struct TaskAccount {
    id: String,
    name: String,
}

pub struct ScheduledTaskService {
    state: AppState,
    storage_gate: Mutex<()>,
    refresh_gate: Mutex<()>,
    runs: Mutex<HashMap<String, TaskRunState>>,
}

impl ScheduledTaskService {
    pub fn new(state: AppState) -> Self {
        Self {
            state,
            storage_gate: Mutex::new(()),
            refresh_gate: Mutex::new(()),
            runs: Mutex::new(HashMap::new()),
        }
    }

    fn load(&self) -> Result<Store, String> {
        match self
            .state
            .db
            .get_setting(STORE_KEY)
            .map_err(|error| error.to_string())?
        {
            Some(value) => serde_json::from_str(&value)
                .map_err(|error| format!("读取定时任务配置失败: {error}")),
            None => Ok(Store::default()),
        }
    }

    fn persist(&self, store: &Store) -> Result<(), String> {
        let value = serde_json::to_string(store).map_err(|error| error.to_string())?;
        self.state
            .db
            .set_setting(STORE_KEY, &value)
            .map_err(|error| error.to_string())
    }

    pub async fn snapshot(&self) -> Result<SchedulerSnapshot, String> {
        let _gate = self.storage_gate.lock().await;
        let store = self.load()?;
        let runs = self.runs.lock().await;
        let now = Utc::now().timestamp();
        Ok(SchedulerSnapshot {
            tasks: store
                .tasks
                .into_iter()
                .map(|task| {
                    let next_run_at = task.enabled.then(|| next_slot(&task, now)).flatten();
                    let run = runs.get(&task.id).cloned();
                    TaskView {
                        task,
                        next_run_at,
                        run,
                    }
                })
                .collect(),
            catalogs: store.catalogs.into_values().collect(),
        })
    }

    pub async fn save(&self, mut draft: TaskDraft) -> Result<(), String> {
        draft.name = draft.name.trim().to_string();
        draft.fixed_model = draft.fixed_model.trim().to_string();
        if draft.name.is_empty() || draft.name.chars().count() > 100 {
            return Err("任务名称需要 1–100 个字符".to_string());
        }
        if draft.times.is_empty() || draft.times.len() > 24 {
            return Err("请设置 1–24 个每日执行时间".to_string());
        }
        for time in &draft.times {
            parse_time(time)?;
        }
        draft.times.sort();
        draft.times.dedup();
        draft.account_ids.sort();
        draft.account_ids.dedup();
        if draft.account_mode == AccountMode::Selected && draft.account_ids.is_empty() {
            return Err("请至少选择一个账号".to_string());
        }
        if draft.model_mode == ModelMode::Fixed && draft.fixed_model.is_empty() {
            return Err("请选择或填写固定模型".to_string());
        }
        if draft.fixed_model.len() > 256 {
            return Err("模型名称过长".to_string());
        }
        if draft.message.trim().is_empty() || draft.message.chars().count() > 16000 {
            return Err("消息需要 1–16000 个字符".to_string());
        }
        if !(1..=300).contains(&draft.account_interval_secs) {
            return Err("账号启动间隔需要在 1–300 秒之间".to_string());
        }

        let _gate = self.storage_gate.lock().await;
        let mut store = self.load()?;
        let previous = match draft.id.as_ref() {
            Some(id) => Some(
                store
                    .tasks
                    .iter()
                    .find(|task| &task.id == id)
                    .cloned()
                    .ok_or_else(|| "任务不存在".to_string())?,
            ),
            None => None,
        };
        if let Some(task) = previous.as_ref() {
            if self
                .runs
                .lock()
                .await
                .get(&task.id)
                .is_some_and(|run| run.running)
            {
                return Err("任务正在运行，请结束后再编辑；可以先关闭后续定时执行".to_string());
            }
        } else if store.tasks.len() >= 100 {
            return Err("最多支持 100 个定时任务".to_string());
        }
        let now = Utc::now().timestamp();
        let changed_schedule = previous.as_ref().is_none_or(|task| {
            task.times != draft.times
                || task.timezone != draft.timezone
                || (!task.enabled && draft.enabled)
        });
        let task = ScheduledTask {
            id: previous
                .as_ref()
                .map(|task| task.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: draft.name,
            enabled: draft.enabled,
            times: draft.times,
            timezone: draft.timezone,
            account_mode: draft.account_mode,
            account_ids: draft.account_ids,
            model_mode: draft.model_mode,
            fixed_model: draft.fixed_model,
            message: draft.message,
            account_interval_secs: draft.account_interval_secs,
            catch_up: draft.catch_up,
            created_at: previous.as_ref().map_or(now, |task| task.created_at),
            updated_at: now,
            schedule_changed_at: if changed_schedule {
                now
            } else {
                previous
                    .as_ref()
                    .map_or(now, |task| task.schedule_changed_at)
            },
            last_scheduled_at: if changed_schedule {
                None
            } else {
                previous.as_ref().and_then(|task| task.last_scheduled_at)
            },
        };
        if let Some(existing) = store
            .tasks
            .iter_mut()
            .find(|existing| existing.id == task.id)
        {
            *existing = task;
        } else {
            store.tasks.push(task);
        }
        self.persist(&store)
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let _gate = self.storage_gate.lock().await;
        let mut store = self.load()?;
        let task = store
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if !task.enabled && enabled {
            task.schedule_changed_at = Utc::now().timestamp();
            task.last_scheduled_at = None;
        }
        task.enabled = enabled;
        task.updated_at = Utc::now().timestamp();
        self.persist(&store)
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let _gate = self.storage_gate.lock().await;
        if self
            .runs
            .lock()
            .await
            .get(id)
            .is_some_and(|run| run.running)
        {
            return Err("任务正在运行，请结束后再删除".to_string());
        }
        let mut store = self.load()?;
        store.tasks.retain(|task| task.id != id);
        self.persist(&store)?;
        self.runs.lock().await.remove(id);
        Ok(())
    }

    /// Called only when the task page opens or the user clicks refresh.
    /// Failures preserve the last successful model list for that account.
    pub async fn refresh_catalogs(&self, account_id: Option<&str>) -> Result<(), String> {
        let _refresh = self.refresh_gate.lock().await;
        let accounts = self.state.codex_oauth_manager.list_accounts().await;
        let active_ids = accounts
            .iter()
            .map(|account| account.id.clone())
            .collect::<Vec<_>>();
        if account_id.is_some_and(|id| !active_ids.iter().any(|active| active == id)) {
            return Err("此卡片绑定的 Codex 账号已移除，请到授权中心重新绑定".to_string());
        }
        let selected = accounts
            .into_iter()
            .filter(|account| account_id.is_none_or(|id| account.id == id));
        let fetched = stream::iter(selected)
            .map(|account| async move {
                let manager = &self.state.codex_oauth_manager;
                let result = async {
                    let token = manager
                        .get_valid_token_for_account(&account.id)
                        .await
                        .map_err(|error| format!("获取账号登录状态失败: {error}"))?;
                    let workspace = manager
                        .chatgpt_account_id_for_account(&account.id)
                        .await
                        .map_err(|error| error.to_string())?;
                    let raw = codex_oauth_models::fetch_catalog_with_token(&token, &workspace)
                        .await
                        .map_err(|error| crate::redact_known_secrets_strict(&error, &[token]))?;
                    let models = codex_oauth_models::parse_models(raw.clone());
                    // A structurally invalid catalog must not erase a usable cache.
                    if !has_model_list(&raw) {
                        return Err("模型接口返回了无法识别的列表".to_string());
                    }
                    Ok(ModelCatalog {
                        account_id: account.id.clone(),
                        account_name: account.login.clone(),
                        chatgpt_account_id: workspace,
                        reasoning_efforts: model_reasoning_efforts(&raw, &models),
                        models,
                        fetched_at: Utc::now().timestamp(),
                        refresh_error: None,
                    })
                }
                .await;
                (account.id, account.login, result)
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;

        let _gate = self.storage_gate.lock().await;
        let mut store = self.load()?;
        store.catalogs.retain(|id, _| active_ids.contains(id));
        for (id, name, result) in fetched {
            match result {
                Ok(catalog) => {
                    store.catalogs.insert(id, catalog);
                }
                Err(error) => {
                    let catalog =
                        store
                            .catalogs
                            .entry(id.clone())
                            .or_insert_with(|| ModelCatalog {
                                account_id: id,
                                account_name: String::new(),
                                chatgpt_account_id: String::new(),
                                models: Vec::new(),
                                reasoning_efforts: BTreeMap::new(),
                                fetched_at: 0,
                                refresh_error: None,
                            });
                    catalog.account_name = name;
                    catalog.refresh_error = Some(error.chars().take(2048).collect());
                }
            }
        }
        self.persist(&store)
    }

    pub async fn run_now(self: &Arc<Self>, app: AppHandle, id: &str) -> Result<(), String> {
        let task = {
            let _gate = self.storage_gate.lock().await;
            let store = self.load()?;
            let task = store
                .tasks
                .into_iter()
                .find(|task| task.id == id)
                .ok_or_else(|| "任务不存在".to_string())?;
            self.claim(&task.id).await?;
            task
        };
        self.spawn_execution(app, task);
        Ok(())
    }

    async fn claim(&self, id: &str) -> Result<(), String> {
        let mut runs = self.runs.lock().await;
        if runs.get(id).is_some_and(|run| run.running) {
            return Err("任务已经在运行，不会重复启动".to_string());
        }
        runs.insert(
            id.to_string(),
            TaskRunState {
                running: true,
                started_at: Utc::now().timestamp(),
                finished_at: None,
                account_count: 0,
                results: Vec::new(),
                error: None,
            },
        );
        Ok(())
    }

    pub fn start(self: Arc<Self>, app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(15));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                match self.take_due_tasks().await {
                    Ok(tasks) => {
                        for task in tasks {
                            self.spawn_execution(app.clone(), task);
                        }
                    }
                    Err(error) => log::warn!("[ScheduledTasks] 无法读取或更新调度状态: {error}"),
                }
            }
        });
    }

    async fn take_due_tasks(&self) -> Result<Vec<ScheduledTask>, String> {
        let _gate = self.storage_gate.lock().await;
        let mut store = self.load()?;
        let now = Utc::now().timestamp();
        let runs = self.runs.lock().await;
        let mut due = Vec::new();
        let mut changed = false;
        for task in &mut store.tasks {
            if !task.enabled {
                continue;
            }
            let Some(slot) = latest_slot(task, now) else {
                continue;
            };
            if slot <= task.schedule_changed_at
                || task
                    .last_scheduled_at
                    .is_some_and(|handled| slot <= handled)
            {
                continue;
            }
            // Claim a schedule occurrence durably before any network work. A
            // crash may leave completion unknown, but must not replay a charge.
            task.last_scheduled_at = Some(slot);
            changed = true;
            if (!task.catch_up && now - slot >= 60)
                || runs.get(&task.id).is_some_and(|run| run.running)
            {
                continue;
            }
            due.push(task.clone());
        }
        drop(runs);
        if changed {
            self.persist(&store)?;
        }
        for task in &due {
            self.claim(&task.id).await?;
        }
        Ok(due)
    }

    fn spawn_execution(self: &Arc<Self>, app: AppHandle, task: ScheduledTask) {
        let _ = app.emit(CHANGE_EVENT, ());
        let service = self.clone();
        let id = task.id.clone();
        let worker_service = self.clone();
        let worker_app = app.clone();
        // Supervise the worker as well, so an unexpected task panic cannot leave
        // a permanent in-memory "running" flag.
        let worker = tokio::spawn(async move { worker_service.execute(worker_app, task).await });
        tauri::async_runtime::spawn(async move {
            let error = match worker.await {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(_) => Some("任务意外中断，部分请求完成状态未知，请查看用量记录".to_string()),
            };
            if let Some(run) = service.runs.lock().await.get_mut(&id) {
                run.running = false;
                run.finished_at = Some(Utc::now().timestamp());
                run.error = error;
            }
            let _ = app.emit(CHANGE_EVENT, ());
        });
    }

    async fn execute(self: Arc<Self>, app: AppHandle, task: ScheduledTask) -> Result<(), String> {
        let managed = self.state.codex_oauth_manager.list_accounts().await;
        let accounts = match task.account_mode {
            AccountMode::All => managed
                .into_iter()
                .map(|account| TaskAccount {
                    id: account.id,
                    name: account.login,
                })
                .collect::<Vec<_>>(),
            AccountMode::Selected => task
                .account_ids
                .iter()
                .map(|id| TaskAccount {
                    id: id.clone(),
                    name: managed
                        .iter()
                        .find(|account| &account.id == id)
                        .map(|account| account.login.clone())
                        .unwrap_or_else(|| id.clone()),
                })
                .collect(),
        };
        if accounts.is_empty() {
            return Err("没有可执行的 Codex OAuth 账号，请到授权中心添加账号".to_string());
        }
        if let Some(run) = self.runs.lock().await.get_mut(&task.id) {
            run.account_count = accounts.len();
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let mut jobs = JoinSet::new();
        for (index, account) in accounts.into_iter().enumerate() {
            if index > 0 {
                tokio::time::sleep(Duration::from_secs(task.account_interval_secs)).await;
            }
            let service = self.clone();
            let task = task.clone();
            let app = app.clone();
            let run_id = run_id.clone();
            jobs.spawn(async move {
                let result = service.execute_account(&task, &run_id, account).await;
                if let Some(run) = service.runs.lock().await.get_mut(&task.id) {
                    run.results.push(result);
                }
                let _ = app.emit(CHANGE_EVENT, ());
            });
        }
        let mut interrupted = false;
        while let Some(result) = jobs.join_next().await {
            if result.is_err() {
                interrupted = true;
            }
        }
        if interrupted {
            Err("部分账号意外中断，完成状态未知，请查看用量记录".to_string())
        } else {
            Ok(())
        }
    }

    async fn execute_account(
        &self,
        task: &ScheduledTask,
        run_id: &str,
        account: TaskAccount,
    ) -> AccountResult {
        let started = Instant::now();
        let request_id = format!("scheduled:{}:{run_id}:{}", task.id, account.id);
        let session_id = format!("scheduled:{}:{run_id}", task.id);
        // Existing usage queries display unknown provider IDs verbatim. This
        // readable identity gives each account its own group without fabricating
        // a provider or changing the user's active provider/binding.
        let provider_id = format!("Codex 定时任务 · {}", account.name);
        let mut result = AccountResult {
            account_id: account.id.clone(),
            account_name: account.name,
            model: None,
            used_random_fallback: false,
            success: false,
            stage: "auth".to_string(),
            error: None,
            tokens_used: None,
            latency_ms: 0,
            quota_before: None,
            quota_after: None,
        };
        let logger = UsageLogger::new(&self.state.db);
        let mut known_secrets = Vec::new();
        let mut observed_usage = None;
        let mut request_latency_ms = None;
        let mut quota_auth = None;
        let mut failure_status = 400;
        let work: Result<request::CompletedRequest, String> = async {
            // No credential files, standalone OAuth refresh, or token writeback.
            let token = self
                .state
                .codex_oauth_manager
                .get_valid_token_for_account(&account.id)
                .await
                .map_err(|error| error.to_string())?;
            known_secrets.push(token.clone());
            let workspace = self
                .state
                .codex_oauth_manager
                .chatgpt_account_id_for_account(&account.id)
                .await
                .map_err(|error| error.to_string())?;
            result.stage = "model_resolution".to_string();
            let catalog = {
                let _gate = self.storage_gate.lock().await;
                self.load()?
                    .catalogs
                    .remove(&account.id)
                    .ok_or_else(|| "没有持久化模型列表，请打开定时任务页面刷新".to_string())?
            };
            if catalog.chatgpt_account_id != workspace {
                return Err("账号工作区与模型缓存不一致，请打开定时任务页面刷新".to_string());
            }
            let (model, fallback) = choose_model(task, &catalog)?;
            result.model = Some(model.clone());
            result.used_random_fallback = fallback;
            result.quota_before = query_codex_quota(
                &token,
                Some(&workspace),
                "codex_oauth",
                "请到授权中心重新登录",
            )
            .await
            .ok();
            result.stage = "request".to_string();
            let message_started = Instant::now();
            quota_auth = Some((token.clone(), workspace.clone()));
            let sent = request::send(
                &token,
                &workspace,
                &model,
                &task.message,
                catalog.reasoning_efforts.get(&model).map(String::as_str),
            )
            .await;
            request_latency_ms = Some(message_started.elapsed().as_millis() as u64);
            sent.map_err(|failure| {
                failure_status = failure.status;
                observed_usage = failure.usage;
                failure.message
            })
        }
        .await;
        result.latency_ms = started.elapsed().as_millis() as u64;
        let usage_latency_ms = request_latency_ms.unwrap_or(result.latency_ms);
        let model = result
            .model
            .clone()
            .unwrap_or_else(|| "(unresolved)".to_string());
        let log_result = match work {
            Ok(completed) => {
                result.tokens_used = Some(
                    u64::from(completed.usage.input_tokens)
                        + u64::from(completed.usage.output_tokens),
                );
                let response_model = completed
                    .usage
                    .model
                    .clone()
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| model.clone());
                let pricing_source = logger.resolve_pricing_model_source("codex").await;
                let pricing_model = if pricing_source == crate::database::PRICING_SOURCE_REQUEST {
                    model.clone()
                } else {
                    response_model.clone()
                };
                result.stage = "usage".to_string();
                logger.log_with_calculation(
                    request_id,
                    provider_id,
                    "codex".to_string(),
                    response_model,
                    model,
                    pricing_model,
                    completed.usage,
                    usage_latency_ms,
                    completed.first_token_ms,
                    200,
                    Some(session_id),
                    Some("codex_oauth".to_string()),
                    true,
                )
            }
            Err(error) => {
                let error = crate::redact_known_secrets_strict(&error, &known_secrets);
                let message = format!("[{}] {error}", result.stage);
                result.error = Some(message.clone());
                if let Some(usage) = observed_usage {
                    result.tokens_used =
                        Some(u64::from(usage.input_tokens) + u64::from(usage.output_tokens));
                    let response_model = usage.model.clone().unwrap_or_else(|| model.clone());
                    let source = logger.resolve_pricing_model_source("codex").await;
                    let pricing_model = if source == crate::database::PRICING_SOURCE_REQUEST {
                        model.clone()
                    } else {
                        response_model.clone()
                    };
                    let pricing = logger.get_model_pricing(&pricing_model).ok().flatten();
                    let cost = CostCalculator::try_calculate_for_app(
                        "codex",
                        &usage,
                        pricing.as_ref(),
                        rust_decimal::Decimal::ONE,
                    );
                    logger.log_request(&RequestLog {
                        request_id,
                        provider_id,
                        app_type: "codex".to_string(),
                        model: response_model,
                        request_model: model,
                        pricing_model,
                        usage,
                        cost,
                        latency_ms: usage_latency_ms,
                        first_token_ms: None,
                        status_code: failure_status,
                        error_message: Some(message),
                        session_id: Some(session_id),
                        provider_type: Some("codex_oauth".to_string()),
                        is_streaming: true,
                        cost_multiplier: "1".to_string(),
                    })
                } else {
                    logger.log_error_with_context(
                        request_id,
                        provider_id,
                        "codex".to_string(),
                        model,
                        failure_status,
                        message,
                        usage_latency_ms,
                        true,
                        Some(session_id),
                        Some("codex_oauth".to_string()),
                    )
                }
            }
        };
        match log_result {
            Ok(()) if result.error.is_none() => {
                result.success = true;
                result.stage = "completed".to_string();
            }
            Ok(()) => {}
            Err(error) => {
                result.stage = "usage".to_string();
                result.error = Some(format!(
                    "{}用量记录写入失败: {error}",
                    result
                        .error
                        .as_ref()
                        .map(|error| format!("{error}；"))
                        .unwrap_or_default()
                ));
            }
        }
        // Request accounting must survive quitting during the optional quota
        // observation; never postpone logging until this network call finishes.
        if let Some((token, workspace)) = quota_auth {
            result.quota_after = query_codex_quota(
                &token,
                Some(&workspace),
                "codex_oauth",
                "请到授权中心重新登录",
            )
            .await
            .ok();
            if let Some(quota) = result.quota_after.as_ref() {
                self.state
                    .usage_cache
                    .put_codex_oauth(account.id, quota.clone());
            }
        }
        result.latency_ms = started.elapsed().as_millis() as u64;
        result
    }
}

fn parse_time(time: &str) -> Result<NaiveTime, String> {
    if time.len() != 5
        || time.as_bytes()[2] != b':'
        || !time
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
    {
        return Err("执行时间需要使用 HH:mm 格式".to_string());
    }
    NaiveTime::parse_from_str(time, "%H:%M").map_err(|_| "执行时间超出有效范围".to_string())
}

fn daily_slots(task: &ScheduledTask, now: i64) -> Vec<i64> {
    let Some(now) = DateTime::from_timestamp(now, 0) else {
        return Vec::new();
    };
    let zone = task.timezone.offset();
    let today = now.with_timezone(&zone).date_naive();
    [-1, 0, 1]
        .into_iter()
        .flat_map(|day| {
            let date = today + chrono::Duration::days(day);
            task.times.iter().filter_map(move |time| {
                let time = parse_time(time).ok()?;
                zone.from_local_datetime(&date.and_time(time))
                    .single()
                    .map(|date| date.timestamp())
            })
        })
        .collect()
}

fn latest_slot(task: &ScheduledTask, now: i64) -> Option<i64> {
    daily_slots(task, now)
        .into_iter()
        .filter(|slot| *slot <= now)
        .max()
}

fn next_slot(task: &ScheduledTask, now: i64) -> Option<i64> {
    daily_slots(task, now)
        .into_iter()
        .filter(|slot| *slot > now)
        .min()
}

fn choose_model(task: &ScheduledTask, catalog: &ModelCatalog) -> Result<(String, bool), String> {
    if catalog.models.is_empty() {
        return Err("持久化模型列表为空，请打开定时任务页面刷新".to_string());
    }
    if task.model_mode == ModelMode::Fixed {
        if let Some(model) = catalog
            .models
            .iter()
            .find(|model| model.id == task.fixed_model)
        {
            return Ok((model.id.clone(), false));
        }
    }
    let index = (uuid::Uuid::new_v4().as_u128() % catalog.models.len() as u128) as usize;
    Ok((
        catalog.models[index].id.clone(),
        task.model_mode == ModelMode::Fixed,
    ))
}

fn has_model_list(raw: &Value) -> bool {
    raw.is_array()
        || ["models", "data", "items"].iter().any(|key| {
            raw.get(*key)
                .is_some_and(|value| value.is_array() || (*key == "models" && value.is_object()))
        })
}

fn model_reasoning_efforts(raw: &Value, models: &[FetchedModel]) -> BTreeMap<String, String> {
    let entries = raw
        .get("models")
        .or_else(|| raw.get("data"))
        .or_else(|| raw.get("items"))
        .unwrap_or(raw);
    models
        .iter()
        .filter_map(|model| {
            let row = entries
                .as_array()
                .and_then(|rows| {
                    rows.iter().find(|row| {
                        ["slug", "id", "model", "name"].iter().any(|key| {
                            row.get(*key).and_then(Value::as_str) == Some(model.id.as_str())
                        })
                    })
                })
                .or_else(|| entries.as_object().and_then(|rows| rows.get(&model.id)));
            let supported = row
                .and_then(|row| row.get("supported_reasoning_levels"))
                .and_then(Value::as_array);
            let effort = ["none", "minimal", "low", "medium", "high", "xhigh"]
                .into_iter()
                .find(|effort| {
                    supported.is_some_and(|levels| {
                        levels.iter().any(|level| {
                            level
                                .as_str()
                                .or_else(|| level.get("effort").and_then(Value::as_str))
                                == Some(*effort)
                        })
                    })
                })
                .or_else(|| (model.id == "codex-auto-review").then_some("none"));
            effort.map(|effort| (model.id.clone(), effort.to_string()))
        })
        .collect()
}
