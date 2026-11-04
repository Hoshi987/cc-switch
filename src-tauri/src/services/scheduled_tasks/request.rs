//! A minimal Codex request. Authentication and accounting belong to CC Switch.

use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{json, Value};

use crate::proxy::providers::codex_oauth_auth::{
    CODEX_OAUTH_CLIENT_VERSION, CODEX_OAUTH_ORIGINATOR,
};
use crate::proxy::usage::TokenUsage;

const RESPONSE_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const MAX_EVENT_BYTES: usize = 1024 * 1024;

pub(super) struct CompletedRequest {
    pub usage: TokenUsage,
    pub first_token_ms: Option<u64>,
}

pub(super) struct RequestFailure {
    pub status: u16,
    pub message: String,
    pub usage: Option<TokenUsage>,
}

impl RequestFailure {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            usage: None,
        }
    }
}

pub(super) async fn send(
    token: &str,
    account_id: &str,
    model: &str,
    message: &str,
    reasoning_effort: Option<&str>,
) -> Result<CompletedRequest, RequestFailure> {
    let started = Instant::now();
    // Includes connection, headers, and the entire stream; never retry a message
    // whose completion is unknown, since that could charge twice.
    tokio::time::timeout(
        Duration::from_secs(60),
        send_inner(token, account_id, model, message, reasoning_effort, started),
    )
    .await
    .map_err(|_| RequestFailure::new(504, "消息请求超过 60 秒，完成状态未知"))?
}

async fn send_inner(
    token: &str,
    account_id: &str,
    model: &str,
    message: &str,
    reasoning_effort: Option<&str>,
    started: Instant,
) -> Result<CompletedRequest, RequestFailure> {
    let mut body = json!({
        "model": model,
        "instructions": "",
        "input": [{"role": "user", "content": [{"type": "input_text", "text": message}]}],
        "tools": [],
        "store": false,
        "stream": true
    });
    if let Some(effort) = reasoning_effort {
        body["reasoning"] = json!({"effort": effort});
    }
    let response = crate::proxy::http_client::get()
        .post(RESPONSE_URL)
        .bearer_auth(token)
        .header("chatgpt-account-id", account_id)
        .header("originator", CODEX_OAUTH_ORIGINATOR)
        .header("version", CODEX_OAUTH_CLIENT_VERSION)
        .header("User-Agent", "cc-switch-scheduled-task")
        .header("Accept", "text/event-stream")
        .timeout(Duration::from_secs(60))
        .json(&body)
        .send()
        .await
        .map_err(|error| RequestFailure::new(502, format!("消息连接失败: {error}")))?;

    let status = response.status();
    if !status.is_success() {
        // Bound the response before decoding, and never retain the bearer token.
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            let remaining = 4096usize.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if bytes.len() >= 4096 {
                break;
            }
        }
        let detail = crate::redact_known_secrets_strict(
            &String::from_utf8_lossy(&bytes),
            &[token.to_string()],
        );
        return Err(RequestFailure::new(
            status.as_u16(),
            format!("HTTP {status}: {detail}"),
        ));
    }

    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut data_lines = Vec::<String>::new();
    let mut event_bytes = 0usize;
    let mut first_token_ms = None;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            RequestFailure::new(502, format!("消息流读取失败，完成状态未知: {error}"))
        })?;
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let mut line = pending.drain(..=end).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                if !data_lines.is_empty() {
                    let data = data_lines.join("\n");
                    data_lines.clear();
                    event_bytes = 0;
                    if let Some(completed) = parse_event(&data, &mut first_token_ms, started)? {
                        return Ok(completed);
                    }
                }
            } else if let Some(data) = line.strip_prefix(b"data:") {
                event_bytes += data.len();
                if event_bytes > MAX_EVENT_BYTES {
                    return Err(RequestFailure::new(502, "消息事件超过大小限制"));
                }
                let data = data.strip_prefix(b" ").unwrap_or(data);
                data_lines.push(
                    String::from_utf8(data.to_vec())
                        .map_err(|_| RequestFailure::new(502, "消息事件不是有效 UTF-8"))?,
                );
            }
        }
        if pending.len() > MAX_EVENT_BYTES {
            return Err(RequestFailure::new(502, "消息流超过大小限制"));
        }
    }
    // Some upstreams omit the final empty line. Accept a complete final event,
    // but never interpret [DONE] or EOF itself as successful completion.
    if !pending.is_empty() {
        if let Some(data) = pending.strip_prefix(b"data:") {
            event_bytes += data.len();
            if event_bytes > MAX_EVENT_BYTES {
                return Err(RequestFailure::new(502, "消息事件超过大小限制"));
            }
            data_lines.push(String::from_utf8_lossy(data).trim_start().to_string());
        }
    }
    if !data_lines.is_empty() {
        if let Some(completed) = parse_event(&data_lines.join("\n"), &mut first_token_ms, started)?
        {
            return Ok(completed);
        }
    }
    Err(RequestFailure::new(
        502,
        "消息流已结束，但未收到 response.completed，完成状态未知",
    ))
}

fn parse_event(
    data: &str,
    first_token_ms: &mut Option<u64>,
    started: Instant,
) -> Result<Option<CompletedRequest>, RequestFailure> {
    if data.trim() == "[DONE]" {
        return Ok(None);
    }
    let event: Value = serde_json::from_str(data)
        .map_err(|_| RequestFailure::new(502, "消息事件不是有效 JSON"))?;
    match event.get("type").and_then(Value::as_str).unwrap_or("") {
        "response.output_text.delta" => {
            if first_token_ms.is_none()
                && event
                    .get("delta")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty())
            {
                *first_token_ms = Some(started.elapsed().as_millis() as u64);
            }
        }
        "response.completed" => {
            let response = event
                .get("response")
                .ok_or_else(|| RequestFailure::new(502, "完成事件缺少 response"))?;
            if response.get("status").and_then(Value::as_str) != Some("completed") {
                return Err(RequestFailure::new(502, "消息响应未完成"));
            }
            // Use the same token parser as the rest of CC Switch; missing usage
            // is an explicit error, rather than a fabricated zero-token success.
            let usage = TokenUsage::from_codex_response_auto(response).ok_or_else(|| {
                RequestFailure::new(502, "请求已完成，但未返回可解析的 token 用量")
            })?;
            return Ok(Some(CompletedRequest {
                usage,
                first_token_ms: *first_token_ms,
            }));
        }
        "response.failed" | "response.incomplete" | "error" => {
            let message = event
                .pointer("/response/error/message")
                .or_else(|| event.pointer("/error/message"))
                .or_else(|| event.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("消息请求失败或未完成");
            return Err(RequestFailure {
                status: 502,
                message: message.chars().take(2048).collect(),
                usage: event
                    .get("response")
                    .and_then(TokenUsage::from_codex_response_auto),
            });
        }
        _ => {}
    }
    Ok(None)
}
