mod room;

use axum::{
    Json, Router,
    extract::{
        ConnectInfo, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use room::{Command, Event, Room};
use serde_json::json;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use tower_http::{
    cors::CorsLayer, limit::RequestBodyLimitLayer, set_header::SetResponseHeaderLayer,
};
use uuid::Uuid;

type SharedRoom = Arc<Mutex<Room>>;
type ApiError = (StatusCode, Json<serde_json::Value>);

struct Admission {
    started: Instant,
    creates: u16,
    sockets: u16,
}
struct Store {
    rooms: HashMap<Uuid, SharedRoom>,
    clients: HashMap<IpAddr, Admission>,
}
struct App {
    store: Mutex<Store>,
    origins: Vec<HeaderValue>,
    connections: Arc<Semaphore>,
    ice_servers: serde_json::Value,
}

fn error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error": message})))
}

impl App {
    fn origin_allowed(&self, headers: &HeaderMap) -> bool {
        headers
            .get(header::ORIGIN)
            .is_some_and(|origin| self.origins.contains(origin))
    }

    async fn admit(&self, ip: IpAddr, create: bool) -> bool {
        let mut store = self.store.lock().await;
        store
            .clients
            .retain(|_, entry| entry.started.elapsed() < Duration::from_secs(60));
        if store.clients.len() >= 4096 && !store.clients.contains_key(&ip) {
            return false;
        }
        let entry = store.clients.entry(ip).or_insert(Admission {
            started: Instant::now(),
            creates: 0,
            sockets: 0,
        });
        let (counter, limit) = if create {
            (&mut entry.creates, 5)
        } else {
            (&mut entry.sockets, 30)
        };
        if *counter >= limit {
            return false;
        }
        *counter += 1;
        true
    }
}

async fn create_room(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    if !app.origin_allowed(&headers) {
        return Err(error(StatusCode::FORBIDDEN, "Origin is not allowed."));
    }
    if !app.admit(peer.ip(), true).await {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many rooms. Try again in a minute.",
        ));
    }
    let mut store = app.store.lock().await;
    if store.rooms.len() >= 256 {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "All rooms are busy. Try again shortly.",
        ));
    }
    let id = Uuid::new_v4();
    let room = Room::new();
    let body = json!({"id": id, "host_token": room.host_token, "guest_token": room.guest_token});
    store.rooms.insert(id, Arc::new(Mutex::new(room)));
    Ok((StatusCode::CREATED, Json(body)))
}

async fn upgrade(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !app.origin_allowed(&headers) {
        return Err(error(StatusCode::FORBIDDEN, "Origin is not allowed."));
    }
    if !app.admit(peer.ip(), false).await {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many connections.",
        ));
    }
    let permit = app
        .connections
        .clone()
        .try_acquire_owned()
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Server is busy."))?;
    let room = app
        .store
        .lock()
        .await
        .rooms
        .get(&id)
        .cloned()
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Room not found or expired."))?;
    Ok(ws
        .read_buffer_size(4096)
        .write_buffer_size(4096)
        .max_write_buffer_size(65_536)
        .max_frame_size(24_576)
        .max_message_size(24_576)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, room, app).await;
        }))
}

async fn send(socket: &mut WebSocket, value: impl serde::Serialize) -> bool {
    let Ok(text) = serde_json::to_string(&value) else {
        return false;
    };
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(text.into()))
        )
        .await,
        Ok(Ok(()))
    )
}

async fn session(mut socket: WebSocket, room: SharedRoom, app: Arc<App>) {
    let Ok(Some(Ok(Message::Text(first)))) =
        tokio::time::timeout(Duration::from_secs(5), socket.recv()).await
    else {
        return;
    };
    let Ok(Command::Auth { token, name }) = serde_json::from_str(&first) else {
        send(
            &mut socket,
            json!({"type": "error", "message": "Authenticate first."}),
        )
        .await;
        return;
    };
    let (role, mut events, initial) = {
        let mut room = room.lock().await;
        let role = match room.join(&token, &name) {
            Ok(role) => role,
            Err(message) => {
                drop(room);
                send(&mut socket, json!({"type": "error", "message": message})).await;
                return;
            }
        };
        let events = room.events.subscribe();
        room.publish();
        (role, events, room.snapshot())
    };
    let welcome =
        json!({"type": "welcome", "role": role, "state": initial, "ice_servers": app.ice_servers});
    if !send(&mut socket, welcome).await {
        room.lock().await.leave(role);
        return;
    }
    let mut tick = tokio::time::interval(Duration::from_secs(3));
    let mut last_seen = Instant::now();
    let mut window = Instant::now();
    let mut count = 0_u16;
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_seen = Instant::now();
                        if window.elapsed() > Duration::from_secs(1) { window = Instant::now(); count = 0; }
                        count += 1;
                        if count > 40 { send(&mut socket, json!({"type": "error", "message": "Too many messages. Reconnect in a moment."})).await; break; }
                        let result = match serde_json::from_str::<Command>(&text) {
                            Ok(command) => room.lock().await.apply(role, command),
                            Err(_) => Err("Invalid message."),
                        };
                        if let Err(message) = result
                            && !send(&mut socket, json!({"type": "error", "message": message})).await {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => last_seen = Instant::now(),
                    Some(Ok(Message::Ping(_))) => {},
                    _ => break,
                }
            }
            event = events.recv() => {
                match event {
                    Ok(Event::Signal { from, .. }) if from == role => {},
                    Ok(event) => {
                        let expired = matches!(event, Event::Expired);
                        if !send(&mut socket, event).await || expired { break; }
                    }
                    Err(_) => break, // Bounded queues disconnect slow consumers instead of retaining messages.
                }
            }
            _ = tick.tick() => {
                let (expired, state) = { let room = room.lock().await; (room.expired(), room.snapshot()) };
                if expired { send(&mut socket, Event::Expired).await; break; }
                if last_seen.elapsed() > Duration::from_secs(45) { break; }
                if !send(&mut socket, Event::State { state }).await { break; }
                if !matches!(tokio::time::timeout(Duration::from_secs(5), socket.send(Message::Ping(vec![].into()))).await, Ok(Ok(()))) { break; }
            }
        }
    }
    room.lock().await.leave(role);
}

#[tokio::main]
async fn main() {
    let origins: Vec<HeaderValue> = std::env::var("ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:3000,http://127.0.0.1:3000".into())
        .split(',')
        .map(|s| s.trim().parse().expect("Invalid allowed origin"))
        .collect();
    let ice_servers = serde_json::from_str(
        &std::env::var("ICE_SERVERS_JSON")
            .unwrap_or_else(|_| r#"[{"urls":"stun:stun.l.google.com:19302"}]"#.into()),
    )
    .expect("Invalid ICE_SERVERS_JSON");
    let app = Arc::new(App {
        store: Mutex::new(Store {
            rooms: HashMap::new(),
            clients: HashMap::new(),
        }),
        origins: origins.clone(),
        connections: Arc::new(Semaphore::new(512)),
        ice_servers,
    });
    let cleanup = app.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let mut store = cleanup.store.lock().await;
            let mut expired = Vec::new();
            for (id, room) in &store.rooms {
                let room = room.lock().await;
                if room.expired() {
                    let _ = room.events.send(Event::Expired);
                    expired.push(*id);
                }
            }
            for id in expired {
                store.rooms.remove(&id);
            }
            store
                .clients
                .retain(|_, entry| entry.started.elapsed() < Duration::from_secs(60));
        }
    });
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"status": "ok"})) }))
        .route("/rooms", post(create_room))
        .route("/rooms/{id}/ws", get(upgrade))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::CONTENT_TYPE]),
        )
        .layer(RequestBodyLimitLayer::new(1024))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .with_state(app);
    let address = std::env::var("BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:4000".into());
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .expect("Cannot bind API address");
    println!("Duet API listening at http://{address}");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .expect("API server failed");
}
