#[path = "../lambda_store.rs"]
mod lambda_store;
#[allow(dead_code)]
#[path = "../room.rs"]
mod room;

use aws_sdk_apigatewaymanagement::{Client as Connections, primitives::Blob};
use lambda_runtime::{Error, LambdaEvent, service_fn};
use lambda_store::{Delivery, Store, StoreError};
use room::{Command, Event};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

struct App {
    store: Store,
    connections: Connections,
    origins: Vec<String>,
    ice_servers: Value,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Clock before epoch")
        .as_millis() as u64
}
fn header<'a>(event: &'a Value, name: &str) -> Option<&'a str> {
    event
        .get("headers")?
        .as_object()?
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.as_str())
}
fn response(status: u16, body: Value, origin: Option<&str>) -> Value {
    let mut headers = json!({"content-type":"application/json", "cache-control":"no-store", "x-content-type-options":"nosniff", "vary":"Origin"});
    if let Some(origin) = origin {
        headers["access-control-allow-origin"] = json!(origin);
    }
    json!({"statusCode":status,"headers":headers,"body":body.to_string(),"isBase64Encoded":false})
}
fn public_error(error: &StoreError) -> (u16, &str) {
    match error {
        StoreError::Rejected(message) => (400, message),
        StoreError::Unauthenticated(message) => (401, message),
        StoreError::Expired => (404, "Room not found or expired."),
        StoreError::Conflict => (409, "The room changed. Please try again."),
        StoreError::Backend(_) => (503, "The room service is temporarily unavailable."),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Heartbeat {
    r#type: HeartbeatType,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum HeartbeatType {
    Heartbeat,
}
fn message(event: &Value) -> Result<Option<Command>, &'static str> {
    if event["isBase64Encoded"].as_bool().unwrap_or(false) {
        return Err("Text messages only.");
    }
    let body = event["body"].as_str().ok_or("Message body required.")?;
    if body.len() > 24_576 {
        return Err("Message too large.");
    }
    if let Ok(heartbeat) = serde_json::from_str::<Heartbeat>(body) {
        let HeartbeatType::Heartbeat = heartbeat.r#type;
        return Ok(None);
    }
    serde_json::from_str(body)
        .map(Some)
        .map_err(|_| "Invalid message.")
}

impl App {
    fn origin<'a>(&self, event: &'a Value) -> Option<&'a str> {
        header(event, "origin")
            .filter(|origin| self.origins.iter().any(|allowed| allowed == origin))
    }
    async fn post(&self, connection: &str, event: &Value) -> Result<bool, Error> {
        match self
            .connections
            .post_to_connection()
            .connection_id(connection)
            .data(Blob::new(serde_json::to_vec(event)?))
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|e| e.is_gone_exception()) =>
            {
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }
    async fn deliver(&self, delivery: Delivery) -> Result<(), Error> {
        let mut pending = VecDeque::from([delivery]);
        // Each room has two seats; cleanup can generate at most two additional snapshots.
        for _ in 0..3 {
            let Some(delivery) = pending.pop_front() else {
                break;
            };
            let event = serde_json::to_value(delivery.event)?;
            for connection in delivery.connections {
                if !self.post(&connection, &event).await?
                    && let Some(cleanup) = self.store.disconnect(&connection, now_ms()).await?
                {
                    pending.push_back(cleanup);
                }
            }
        }
        Ok(())
    }
    async fn reject_socket(&self, connection: &str, error: &str) -> Result<(), Error> {
        let _ = self
            .post(connection, &json!({"type":"error","message":error}))
            .await;
        let _ = self
            .connections
            .delete_connection()
            .connection_id(connection)
            .send()
            .await;
        if let Some(delivery) = self.store.disconnect(connection, now_ms()).await? {
            self.deliver(delivery).await?;
        }
        Ok(())
    }
    async fn report_store_error(
        &self,
        connection: &str,
        error: &StoreError,
        during_auth: bool,
    ) -> Result<(), Error> {
        let (_, message) = public_error(error);
        if !during_auth
            && matches!(
                error,
                StoreError::Rejected(_) | StoreError::Conflict | StoreError::Backend(_)
            )
        {
            self.post(connection, &json!({"type":"error","message":message}))
                .await?;
            Ok(())
        } else {
            self.reject_socket(connection, message).await
        }
    }
    async fn handle(&self, event: Value) -> Result<Value, Error> {
        let context = &event["requestContext"];
        if let Some(connection) = context["connectionId"].as_str() {
            return self.websocket(&event, connection).await;
        }
        let method = context["http"]["method"].as_str().unwrap_or("");
        let path = event["rawPath"].as_str().unwrap_or("");
        if method == "GET" && path == "/health" {
            return Ok(response(200, json!({"status":"ok"}), self.origin(&event)));
        }
        let Some(origin) = self.origin(&event) else {
            return Ok(response(
                403,
                json!({"error":"Origin is not allowed."}),
                None,
            ));
        };
        if method != "POST" || path != "/rooms" {
            return Ok(response(404, json!({"error":"Not found."}), Some(origin)));
        }
        if event["body"].as_str().is_some_and(|body| body.len() > 1024) {
            return Ok(response(
                413,
                json!({"error":"Request too large."}),
                Some(origin),
            ));
        }
        let Some(ip) = context["http"]["sourceIp"].as_str() else {
            return Ok(response(
                400,
                json!({"error":"Missing client address."}),
                Some(origin),
            ));
        };
        if !self.store.admit(ip, "create", 5, now_ms()).await? {
            return Ok(response(
                429,
                json!({"error":"Too many rooms. Try again in a minute."}),
                Some(origin),
            ));
        }
        match self.store.create(now_ms()).await {
            Ok(room) => Ok(response(201, serde_json::to_value(room)?, Some(origin))),
            Err(error) => {
                let (status, message) = public_error(&error);
                Ok(response(status, json!({"error":message}), Some(origin)))
            }
        }
    }
    async fn websocket(&self, event: &Value, connection: &str) -> Result<Value, Error> {
        let route = event["requestContext"]["routeKey"].as_str().unwrap_or("");
        match route {
            "$connect" => {
                if self.origin(event).is_none() {
                    return Ok(response(
                        403,
                        json!({"error":"Origin is not allowed."}),
                        None,
                    ));
                }
                let Some(ip) = event["requestContext"]["identity"]["sourceIp"].as_str() else {
                    return Ok(response(
                        400,
                        json!({"error":"Missing client address."}),
                        None,
                    ));
                };
                let Some(room) = event["queryStringParameters"]["room"]
                    .as_str()
                    .and_then(|id| Uuid::parse_str(id).ok())
                else {
                    return Ok(response(
                        400,
                        json!({"error":"A room ID is required."}),
                        None,
                    ));
                };
                if !self.store.admit(ip, "connect", 30, now_ms()).await? {
                    return Ok(response(
                        429,
                        json!({"error":"Too many connections."}),
                        None,
                    ));
                }
                if let Err(error) = self.store.connect(connection, room, now_ms()).await {
                    let (status, message) = public_error(&error);
                    return Ok(response(status, json!({"error":message}), None));
                }
            }
            "$disconnect" => {
                if let Some(delivery) = self.store.disconnect(connection, now_ms()).await? {
                    self.deliver(delivery).await?;
                }
            }
            "$default" => {
                let command = match message(event) {
                    Ok(command) => command,
                    Err(error) => {
                        self.reject_socket(connection, error).await?;
                        return Ok(response(200, json!({}), None));
                    }
                };
                let during_auth = matches!(&command, Some(Command::Auth { .. }));
                let result = match command {
                    Some(Command::Auth { token, name }) => {
                        match self.store.join(connection, &token, &name, now_ms()).await {
                            Ok(joined) => {
                                let welcome = json!({"type":"welcome","role":joined.role,"state":joined.state,"ice_servers":self.ice_servers});
                                if !self.post(connection, &welcome).await? {
                                    if let Some(delivery) =
                                        self.store.disconnect(connection, now_ms()).await?
                                    {
                                        self.deliver(delivery).await?;
                                    }
                                    return Ok(response(200, json!({}), None));
                                }
                                Ok(Delivery {
                                    event: Event::State {
                                        state: joined.state,
                                    },
                                    connections: joined
                                        .connections
                                        .into_iter()
                                        .filter(|id| id != connection)
                                        .collect(),
                                })
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Some(command) => self.store.command(connection, command, now_ms()).await,
                    None => self.store.heartbeat(connection, now_ms()).await,
                };
                match result {
                    Ok(delivery) => self.deliver(delivery).await?,
                    Err(error) => {
                        self.report_store_error(connection, &error, during_auth)
                            .await?;
                    }
                }
            }
            _ => return Ok(response(400, json!({"error":"Unknown route."}), None)),
        }
        Ok(response(200, json!({}), None))
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let endpoint = std::env::var("WS_MANAGEMENT_ENDPOINT")?;
    let management = aws_sdk_apigatewaymanagement::config::Builder::from(&config)
        .endpoint_url(endpoint)
        .build();
    let origins: Vec<String> = std::env::var("ALLOWED_ORIGINS")?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if origins.is_empty() || origins.iter().any(|origin| origin == "*") {
        return Err("Explicit ALLOWED_ORIGINS required".into());
    }
    let ice_servers: Value = serde_json::from_str(
        &std::env::var("ICE_SERVERS_JSON")
            .unwrap_or_else(|_| "[{\"urls\":\"stun:stun.l.google.com:19302\"}]".into()),
    )?;
    let app = App {
        store: Store::new(
            aws_sdk_dynamodb::Client::new(&config),
            std::env::var("TABLE_NAME")?,
        ),
        connections: Connections::from_conf(management),
        origins,
        ice_servers,
    };
    lambda_runtime::run(service_fn(|event: LambdaEvent<Value>| {
        app.handle(event.payload)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_messages_are_bounded_typed_and_never_accept_binary() {
        assert!(matches!(
            message(&json!({"body":"{\"type\":\"heartbeat\"}"})),
            Ok(None)
        ));
        assert!(message(&json!({"body":"{\"type\":\"heartbeat\",\"token\":\"x\"}"})).is_err());
        assert!(message(&json!({"body":" ".repeat(24577)})).is_err());
        assert!(message(&json!({"body":"{}","isBase64Encoded":true})).is_err());
        assert!(matches!(
            message(&json!({"body":"{\"type\":\"auth\",\"token\":\"x\",\"name\":\"A\"}"})),
            Ok(Some(Command::Auth { .. }))
        ));
    }
    #[test]
    fn errors_and_cors_do_not_expose_backend_details() {
        assert_eq!(
            public_error(&StoreError::Backend("secret internal detail".into())).1,
            "The room service is temporarily unavailable."
        );
        let event = json!({"headers":{"Origin":"https://duet.example"}});
        assert_eq!(header(&event, "origin"), Some("https://duet.example"));
        let result = response(403, json!({"error":"denied"}), None);
        assert!(
            result["headers"]
                .get("access-control-allow-origin")
                .is_none()
        );
    }
    #[tokio::test]
    async fn recoverable_command_failures_keep_seats_but_auth_and_expiry_close_them() {
        use aws_sdk_dynamodb::config::{Credentials, Region, SharedCredentialsProvider};
        use axum::{
            Router,
            extract::{Request, State},
            routing::any,
        };
        use std::sync::Arc;
        use tokio::sync::Mutex;

        type Requests = Arc<Mutex<Vec<(String, String, Value)>>>;
        let requests: Requests = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .fallback(any(
                |State(requests): State<Requests>, request: Request| async move {
                    let method = request.method().to_string();
                    let path = request.uri().path().to_owned();
                    let bytes = axum::body::to_bytes(request.into_body(), 32768)
                        .await
                        .unwrap();
                    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    requests.lock().await.push((method, path, body));
                    axum::Json(json!({}))
                },
            ))
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let credentials = Credentials::new("test", "test", None, None, "test");
        let config = aws_config::SdkConfig::builder()
            .region(Region::new("us-east-1"))
            .credentials_provider(SharedCredentialsProvider::new(credentials))
            .behavior_version(aws_config::BehaviorVersion::latest())
            .build();
        let app = App {
            store: Store::new(
                aws_sdk_dynamodb::Client::from_conf(
                    aws_sdk_dynamodb::config::Builder::from(&config)
                        .endpoint_url(&endpoint)
                        .build(),
                ),
                "test",
            ),
            connections: Connections::from_conf(
                aws_sdk_apigatewaymanagement::config::Builder::from(&config)
                    .endpoint_url(&endpoint)
                    .build(),
            ),
            origins: vec![],
            ice_servers: json!([]),
        };
        for error in [
            StoreError::Conflict,
            StoreError::Backend("private database detail".into()),
            StoreError::Rejected("Only the host can change the source."),
            StoreError::Rejected("Invalid playback position."),
        ] {
            app.report_store_error("viewer", &error, false)
                .await
                .unwrap();
            let mut observed = requests.lock().await;
            assert_eq!(
                observed.len(),
                1,
                "Recoverable command error must not disconnect or mutate storage"
            );
            assert_eq!(observed[0].0, "POST");
            assert_eq!(observed[0].1, "/@connections/viewer");
            assert_eq!(
                observed[0].2,
                json!({"type":"error", "message":public_error(&error).1})
            );
            assert!(!observed[0].2.to_string().contains("private database"));
            observed.clear();
        }
        for (error, during_auth) in [
            (StoreError::Conflict, true),
            (StoreError::Backend("private database detail".into()), true),
            (StoreError::Expired, false),
            (StoreError::Unauthenticated("Authenticate first."), false),
            (StoreError::Rejected("Invalid invite."), true),
        ] {
            app.report_store_error("viewer", &error, during_auth)
                .await
                .unwrap();
            let mut observed = requests.lock().await;
            assert_eq!(
                observed.len(),
                3,
                "Fatal error must notify, close the gateway socket, and clean up its binding"
            );
            assert_eq!(
                (&observed[1].0[..], &observed[1].1[..]),
                ("DELETE", "/@connections/viewer")
            );
            assert_eq!(observed[2].2["Key"]["pk"]["S"], "CONN#viewer");
            observed.clear();
        }
        server.abort();
    }
}
