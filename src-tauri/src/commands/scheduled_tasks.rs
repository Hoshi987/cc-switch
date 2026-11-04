use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::services::scheduled_tasks::{
    ScheduledTaskService, SchedulerSnapshot, TaskDraft, CHANGE_EVENT,
};

#[tauri::command]
pub async fn get_scheduled_tasks(
    service: State<'_, Arc<ScheduledTaskService>>,
) -> Result<SchedulerSnapshot, String> {
    service.snapshot().await
}

#[tauri::command]
pub async fn save_scheduled_task(
    app: AppHandle,
    service: State<'_, Arc<ScheduledTaskService>>,
    task: TaskDraft,
) -> Result<(), String> {
    service.save(task).await?;
    let _ = app.emit(CHANGE_EVENT, ());
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_scheduled_task_enabled(
    app: AppHandle,
    service: State<'_, Arc<ScheduledTaskService>>,
    task_id: String,
    enabled: bool,
) -> Result<(), String> {
    service.set_enabled(&task_id, enabled).await?;
    let _ = app.emit(CHANGE_EVENT, ());
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_scheduled_task(
    app: AppHandle,
    service: State<'_, Arc<ScheduledTaskService>>,
    task_id: String,
) -> Result<(), String> {
    service.remove(&task_id).await?;
    let _ = app.emit(CHANGE_EVENT, ());
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn refresh_scheduled_task_models(
    app: AppHandle,
    service: State<'_, Arc<ScheduledTaskService>>,
    account_id: Option<String>,
) -> Result<(), String> {
    service.refresh_catalogs(account_id.as_deref()).await?;
    let _ = app.emit(CHANGE_EVENT, ());
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn run_scheduled_task(
    app: AppHandle,
    service: State<'_, Arc<ScheduledTaskService>>,
    task_id: String,
) -> Result<(), String> {
    service.inner().run_now(app, &task_id).await
}
