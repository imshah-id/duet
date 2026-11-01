use crate::room::{Command, Event, Member, Role, Snapshot, Source};
use aws_sdk_dynamodb::{
    Client,
    types::{AttributeValue, Put, TransactWriteItem},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::HashMap;
use subtle::ConstantTimeEq;
use uuid::Uuid;

const ROOM_MS: u64 = 6 * 60 * 60 * 1000;
const IDLE_MS: u64 = 30 * 60 * 1000;
const LEASE_MS: u64 = 60 * 1000;
const AUTH_MS: u64 = 15 * 1000;
const RETRIES: usize = 6;

#[derive(Debug)]
pub enum StoreError {
    Rejected(&'static str),
    Unauthenticated(&'static str),
    Expired,
    Conflict,
    Backend(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(message) | Self::Unauthenticated(message) => f.write_str(message),
            Self::Expired => f.write_str("This room has expired."),
            Self::Conflict => f.write_str("The room is busy. Please try again."),
            Self::Backend(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for StoreError {}
fn backend(error: impl std::fmt::Display) -> StoreError {
    StoreError::Backend(error.to_string())
}
type Result<T> = std::result::Result<T, StoreError>;

#[derive(Serialize)]
pub struct CreatedRoom {
    pub id: Uuid,
    pub host_token: String,
    pub guest_token: String,
}
pub struct JoinResult {
    pub role: Role,
    pub state: Snapshot,
    pub connections: Vec<String>,
}
pub struct Delivery {
    pub event: Event,
    pub connections: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Seat {
    connection: String,
    name: String,
    seen_ms: u64,
    rate_second: u64,
    rate_count: u32,
}

#[derive(Serialize, Deserialize)]
struct RoomData {
    host_token: String,
    guest_token: String,
    created_ms: u64,
    touched_ms: u64,
    source: Option<Source>,
    playing: bool,
    position: f64,
    anchored_ms: u64,
    revision: u64,
    seats: [Option<Seat>; 2],
}

impl RoomData {
    fn new(now: u64) -> Self {
        Self {
            host_token: Uuid::new_v4().simple().to_string(),
            guest_token: Uuid::new_v4().simple().to_string(),
            created_ms: now,
            touched_ms: now,
            source: None,
            playing: false,
            position: 0.0,
            anchored_ms: now,
            revision: 0,
            seats: [None, None],
        }
    }
    fn expired(&self, now: u64) -> bool {
        now.saturating_sub(self.created_ms) >= ROOM_MS
            || (self.seats.iter().all(Option::is_none)
                && now.saturating_sub(self.touched_ms) >= IDLE_MS)
    }
    fn position(&self, now: u64) -> f64 {
        self.position
            + if self.playing {
                now.saturating_sub(self.anchored_ms) as f64 / 1000.0
            } else {
                0.0
            }
    }
    fn snapshot(&self, now: u64) -> Snapshot {
        Snapshot {
            source: self.source.clone(),
            playing: self.playing,
            position: self.position(now),
            revision: self.revision,
            snapshot_at: Some(now),
            members: [Role::Host, Role::Guest]
                .into_iter()
                .filter_map(|role| {
                    self.seats[role.index()].as_ref().map(|seat| Member {
                        role,
                        name: seat.name.clone(),
                    })
                })
                .collect(),
        }
    }
    fn connections(&self) -> Vec<String> {
        self.seats
            .iter()
            .flatten()
            .map(|s| s.connection.clone())
            .collect()
    }
    fn leave(&mut self, role: Role, now: u64) {
        if self.seats[role.index()].take().is_none() {
            return;
        }
        self.position = self.position(now);
        self.playing = false;
        self.anchored_ms = now;
        self.touched_ms = now;
        if role == Role::Host && self.source == Some(Source::Screen) {
            self.source = None;
        }
        self.revision += 1;
    }
    fn reap(&mut self, now: u64) {
        let mut roles = [Role::Host, Role::Guest];
        roles.sort_by_key(|role| {
            self.seats[role.index()]
                .as_ref()
                .map_or(u64::MAX, |seat| seat.seen_ms)
        });
        for role in roles {
            if let Some(seat) = &self.seats[role.index()]
                && now.saturating_sub(seat.seen_ms) >= LEASE_MS
            {
                // Anchor at the lease deadline, not a potentially much later cleanup invocation.
                self.leave(role, seat.seen_ms.saturating_add(LEASE_MS));
            }
        }
    }
    fn join(&mut self, connection: &str, token: &str, name: &str, now: u64) -> Result<Role> {
        self.reap(now);
        if self.expired(now) {
            return Err(StoreError::Expired);
        }
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 32 || name.chars().any(char::is_control) {
            return Err(StoreError::Rejected(
                "Use a name between 1 and 32 characters.",
            ));
        }
        // Evaluate both comparisons; the token remains a bearer capability, never a URL parameter.
        let host = token.as_bytes().ct_eq(self.host_token.as_bytes());
        let guest = token.as_bytes().ct_eq(self.guest_token.as_bytes());
        let role = if bool::from(host) {
            Role::Host
        } else if bool::from(guest) {
            Role::Guest
        } else {
            return Err(StoreError::Rejected("This invite is invalid."));
        };
        if self.seats[role.index()].is_some() {
            return Err(StoreError::Rejected(
                "That seat is already connected. Close the other tab first.",
            ));
        }
        self.seats[role.index()] = Some(Seat {
            connection: connection.to_owned(),
            name: name.to_owned(),
            seen_ms: now,
            rate_second: now / 1000,
            rate_count: 0,
        });
        self.touched_ms = now;
        self.revision += 1;
        Ok(role)
    }
    fn authenticate(&mut self, connection: &str, role: Role, now: u64) -> Result<String> {
        self.reap(now);
        if self.expired(now) {
            return Err(StoreError::Expired);
        }
        let seat = self.seats[role.index()]
            .as_mut()
            .filter(|seat| seat.connection == connection)
            .ok_or(StoreError::Unauthenticated("Join the room again."))?;
        if now / 1000 > seat.rate_second {
            seat.rate_second = now / 1000;
            seat.rate_count = 0;
        }
        if seat.rate_count >= 40 {
            return Err(StoreError::Rejected(
                "Too many messages. Try again shortly.",
            ));
        }
        seat.rate_count += 1;
        seat.seen_ms = seat.seen_ms.max(now);
        self.touched_ms = self.touched_ms.max(now);
        Ok(seat.name.clone())
    }
    fn apply(
        &mut self,
        connection: &str,
        role: Role,
        command: Option<&Command>,
        now: u64,
    ) -> Result<Event> {
        let name = self.authenticate(connection, role, now)?;
        match command {
            None => {}
            Some(Command::Source { source }) => {
                if role != Role::Host {
                    return Err(StoreError::Rejected("Only the host can change the source."));
                }
                if source.as_ref().is_some_and(|source| !source.validate()) {
                    return Err(StoreError::Rejected(
                        "Choose a YouTube video or a public HTTPS MP4/WebM link.",
                    ));
                }
                self.source = source.clone();
                self.playing = false;
                self.position = 0.0;
                self.anchored_ms = now;
                self.revision += 1;
            }
            Some(Command::Playback { playing, position }) => {
                if self.source.is_none() || self.source == Some(Source::Screen) {
                    return Err(StoreError::Rejected("Choose a video first."));
                }
                if !position.is_finite() || !(0.0..=604_800.0).contains(position) {
                    return Err(StoreError::Rejected("Invalid playback position."));
                }
                self.playing = *playing;
                self.position = *position;
                self.anchored_ms = now;
                self.revision += 1;
            }
            Some(Command::Chat { text }) => {
                let text = text.trim();
                if text.is_empty()
                    || text.chars().count() > 500
                    || text.chars().any(|c| c.is_control() && c != '\n')
                {
                    return Err(StoreError::Rejected(
                        "Messages must contain 1–500 characters.",
                    ));
                }
                return Ok(Event::Chat {
                    role,
                    name,
                    text: text.to_owned(),
                    id: Uuid::new_v4(),
                });
            }
            Some(Command::Signal { signal }) => {
                if self.source != Some(Source::Screen) || !signal.allowed(role) {
                    return Err(StoreError::Rejected("Invalid screen-sharing signal."));
                }
                return Ok(Event::Signal {
                    from: role,
                    signal: signal.clone(),
                });
            }
            Some(Command::Auth { .. }) => return Err(StoreError::Rejected("Already connected.")),
        }
        Ok(Event::State {
            state: self.snapshot(now),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Connection {
    room_id: Uuid,
    role: Option<Role>,
    created_ms: u64,
}
struct Record<T> {
    version: u64,
    value: T,
}

pub struct Store {
    client: Client,
    table: String,
}
impl Store {
    pub fn new(client: Client, table: impl Into<String>) -> Self {
        Self {
            client,
            table: table.into(),
        }
    }
    async fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<Record<T>>> {
        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .key("pk", AttributeValue::S(key.into()))
            .consistent_read(true)
            .send()
            .await
            .map_err(backend)?;
        let Some(item) = output.item else {
            return Ok(None);
        };
        let version = item
            .get("version")
            .and_then(|v| v.as_n().ok())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| backend("Invalid persisted record version"))?;
        let data = item
            .get("data")
            .and_then(|v| v.as_s().ok())
            .ok_or_else(|| backend("Invalid persisted record data"))?;
        Ok(Some(Record {
            version,
            value: serde_json::from_str(data).map_err(backend)?,
        }))
    }
    fn item<T: Serialize>(
        key: &str,
        value: &T,
        version: u64,
        expires: u64,
    ) -> Result<HashMap<String, AttributeValue>> {
        Ok(HashMap::from([
            ("pk".into(), AttributeValue::S(key.into())),
            ("version".into(), AttributeValue::N(version.to_string())),
            (
                "data".into(),
                AttributeValue::S(serde_json::to_string(value).map_err(backend)?),
            ),
            ("expires_at".into(), AttributeValue::N(expires.to_string())),
        ]))
    }
    fn put<T: Serialize>(&self, key: &str, value: &T, version: u64, expires: u64) -> Result<Put> {
        Put::builder()
            .table_name(&self.table)
            .set_item(Some(Self::item(key, value, version + 1, expires)?))
            .condition_expression("#version = :version")
            .expression_attribute_names("#version", "version")
            .expression_attribute_values(":version", AttributeValue::N(version.to_string()))
            .build()
            .map_err(backend)
    }
    async fn save_room(&self, key: &str, room: &Record<RoomData>) -> Result<bool> {
        let result = self
            .client
            .put_item()
            .table_name(&self.table)
            .set_item(Some(Self::item(
                key,
                &room.value,
                room.version + 1,
                (room.value.created_ms + ROOM_MS) / 1000,
            )?))
            .condition_expression("#version = :version")
            .expression_attribute_names("#version", "version")
            .expression_attribute_values(":version", AttributeValue::N(room.version.to_string()))
            .send()
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|e| e.is_conditional_check_failed_exception()) =>
            {
                Ok(false)
            }
            Err(error) => Err(backend(error)),
        }
    }
    pub async fn admit(&self, ip: &str, kind: &str, limit: u32, now_ms: u64) -> Result<bool> {
        let minute = now_ms / 60_000;
        let result = self
            .client
            .update_item()
            .table_name(&self.table)
            .key(
                "pk",
                AttributeValue::S(format!("RATE#{kind}#{ip}#{minute}")),
            )
            .update_expression("SET expires_at = :expires ADD #count :one")
            .condition_expression("attribute_not_exists(#count) OR #count < :limit")
            .expression_attribute_names("#count", "count")
            .expression_attribute_values(
                ":expires",
                AttributeValue::N(((minute + 2) * 60).to_string()),
            )
            .expression_attribute_values(":one", AttributeValue::N("1".into()))
            .expression_attribute_values(":limit", AttributeValue::N(limit.to_string()))
            .send()
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|e| e.is_conditional_check_failed_exception()) =>
            {
                Ok(false)
            }
            Err(error) => Err(backend(error)),
        }
    }
    pub async fn create(&self, now_ms: u64) -> Result<CreatedRoom> {
        let room = RoomData::new(now_ms);
        let id = Uuid::new_v4();
        self.client
            .put_item()
            .table_name(&self.table)
            .set_item(Some(Self::item(
                &format!("ROOM#{id}"),
                &room,
                0,
                (now_ms + ROOM_MS) / 1000,
            )?))
            .condition_expression("attribute_not_exists(pk)")
            .send()
            .await
            .map_err(backend)?;
        Ok(CreatedRoom {
            id,
            host_token: room.host_token,
            guest_token: room.guest_token,
        })
    }
    pub async fn connect(&self, connection_id: &str, room_id: Uuid, now_ms: u64) -> Result<()> {
        let mut room = self
            .get::<RoomData>(&format!("ROOM#{room_id}"))
            .await?
            .ok_or(StoreError::Expired)?;
        room.value.reap(now_ms);
        if room.value.expired(now_ms) {
            return Err(StoreError::Expired);
        }
        let connection = Connection {
            room_id,
            role: None,
            created_ms: now_ms,
        };
        self.client
            .put_item()
            .table_name(&self.table)
            .set_item(Some(Self::item(
                &format!("CONN#{connection_id}"),
                &connection,
                0,
                (now_ms + AUTH_MS) / 1000,
            )?))
            .condition_expression("attribute_not_exists(pk)")
            .send()
            .await
            .map_err(backend)?;
        Ok(())
    }
    pub async fn join(
        &self,
        connection_id: &str,
        token: &str,
        name: &str,
        now_ms: u64,
    ) -> Result<JoinResult> {
        let connection_key = format!("CONN#{connection_id}");
        for _ in 0..RETRIES {
            let mut connection = self
                .get::<Connection>(&connection_key)
                .await?
                .ok_or(StoreError::Rejected("Connect again."))?;
            if connection.value.role.is_some() {
                return Err(StoreError::Rejected("Already connected."));
            }
            if now_ms.saturating_sub(connection.value.created_ms) >= AUTH_MS {
                return Err(StoreError::Rejected(
                    "Authentication timed out. Connect again.",
                ));
            }
            let key = format!("ROOM#{}", connection.value.room_id);
            let mut room = self
                .get::<RoomData>(&key)
                .await?
                .ok_or(StoreError::Expired)?;
            let role = room.value.join(connection_id, token, name, now_ms)?;
            connection.value.role = Some(role);
            let expires = (room.value.created_ms + ROOM_MS) / 1000;
            let result = self
                .client
                .transact_write_items()
                .transact_items(
                    TransactWriteItem::builder()
                        .put(self.put(&key, &room.value, room.version, expires)?)
                        .build(),
                )
                .transact_items(
                    TransactWriteItem::builder()
                        .put(self.put(
                            &connection_key,
                            &connection.value,
                            connection.version,
                            expires,
                        )?)
                        .build(),
                )
                .send()
                .await;
            match result {
                Ok(_) => {
                    return Ok(JoinResult {
                        role,
                        state: room.value.snapshot(now_ms),
                        connections: room.value.connections(),
                    });
                }
                Err(error)
                    if error
                        .as_service_error()
                        .is_some_and(|e| e.is_transaction_canceled_exception()) =>
                {
                    continue;
                }
                Err(error) => return Err(backend(error)),
            }
        }
        Err(StoreError::Conflict)
    }
    pub async fn command(
        &self,
        connection_id: &str,
        command: Command,
        now_ms: u64,
    ) -> Result<Delivery> {
        self.mutate(connection_id, Some(&command), now_ms).await
    }
    pub async fn heartbeat(&self, connection_id: &str, now_ms: u64) -> Result<Delivery> {
        self.mutate(connection_id, None, now_ms).await
    }
    async fn mutate(
        &self,
        connection_id: &str,
        command: Option<&Command>,
        now_ms: u64,
    ) -> Result<Delivery> {
        let connection = self
            .get::<Connection>(&format!("CONN#{connection_id}"))
            .await?
            .ok_or(StoreError::Unauthenticated("Connect again."))?;
        let role = connection
            .value
            .role
            .ok_or(StoreError::Unauthenticated("Authenticate first."))?;
        let key = format!("ROOM#{}", connection.value.room_id);
        for _ in 0..RETRIES {
            let mut room = self
                .get::<RoomData>(&key)
                .await?
                .ok_or(StoreError::Expired)?;
            let event = room.value.apply(connection_id, role, command, now_ms);
            let mut connections = room.value.connections();
            if matches!(&event, Ok(Event::Signal { .. })) {
                connections.retain(|id| id != connection_id);
            }
            if self.save_room(&key, &room).await? {
                return event.map(|event| Delivery { event, connections });
            }
        }
        Err(StoreError::Conflict)
    }
    pub async fn disconnect(&self, connection_id: &str, now_ms: u64) -> Result<Option<Delivery>> {
        let connection_key = format!("CONN#{connection_id}");
        let Some(connection) = self.get::<Connection>(&connection_key).await? else {
            return Ok(None);
        };
        let key = format!("ROOM#{}", connection.value.room_id);
        let mut delivery = None;
        if let Some(role) = connection.value.role {
            let mut saved = false;
            for _ in 0..RETRIES {
                let Some(mut room) = self.get::<RoomData>(&key).await? else {
                    saved = true;
                    break;
                };
                if room.value.seats[role.index()]
                    .as_ref()
                    .is_none_or(|seat| seat.connection != connection_id)
                {
                    saved = true;
                    break;
                }
                room.value.leave(role, now_ms);
                if self.save_room(&key, &room).await? {
                    delivery = Some(Delivery {
                        event: Event::State {
                            state: room.value.snapshot(now_ms),
                        },
                        connections: room.value.connections(),
                    });
                    saved = true;
                    break;
                }
            }
            if !saved {
                return Err(StoreError::Conflict);
            }
        }
        self.client
            .delete_item()
            .table_name(&self.table)
            .key("pk", AttributeValue::S(connection_key))
            .send()
            .await
            .map_err(backend)?;
        Ok(delivery)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seats_are_capability_bound_and_stale_sockets_cannot_control_replacements() {
        let mut room = RoomData::new(1000);
        let token = room.host_token.clone();
        assert!(room.join("wrong", "invalid", "A", 1000).is_err());
        assert_eq!(room.join("first", &token, "A", 1000).unwrap(), Role::Host);
        assert!(room.join("second", &token, "B", 1001).is_err());
        assert!(room.join("replacement", &token, "A", 61_000).is_ok());
        assert!(room.apply("first", Role::Host, None, 61_001).is_err());
        assert!(room.apply("replacement", Role::Host, None, 61_001).is_ok());
    }
    #[test]
    fn persisted_playback_survives_serialization_and_disconnect_pauses() {
        let mut room = RoomData::new(1000);
        let token = room.host_token.clone();
        room.join("host", &token, "A", 1000).unwrap();
        room.apply(
            "host",
            Role::Host,
            Some(&Command::Source {
                source: Some(Source::Youtube {
                    url: "aqz-KE-bpKQ".into(),
                }),
            }),
            1000,
        )
        .unwrap();
        room.apply(
            "host",
            Role::Host,
            Some(&Command::Playback {
                playing: true,
                position: 5.0,
            }),
            2000,
        )
        .unwrap();
        let mut restored: RoomData =
            serde_json::from_str(&serde_json::to_string(&room).unwrap()).unwrap();
        assert_eq!(restored.snapshot(5000).position, 8.0);
        restored.leave(Role::Host, 5000);
        assert_eq!(restored.snapshot(10_000).position, 8.0);
        assert!(!restored.snapshot(10_000).playing);
    }
    #[test]
    fn permissions_expiry_rate_and_invalid_positions_remain_enforced() {
        let mut room = RoomData::new(1000);
        let token = room.guest_token.clone();
        room.join("guest", &token, "B", 1000).unwrap();
        assert!(
            room.apply(
                "guest",
                Role::Guest,
                Some(&Command::Source {
                    source: Some(Source::Screen)
                }),
                1000
            )
            .is_err()
        );
        room.source = Some(Source::Youtube {
            url: "aqz-KE-bpKQ".into(),
        });
        for position in [-1.0, f64::NAN, f64::INFINITY, 604_801.0] {
            assert!(
                room.apply(
                    "guest",
                    Role::Guest,
                    Some(&Command::Playback {
                        playing: true,
                        position
                    }),
                    1000
                )
                .is_err()
            );
        }
        room.seats[1].as_mut().unwrap().rate_count = 40;
        assert!(room.apply("guest", Role::Guest, None, 1000).is_err());
        assert!(room.apply("guest", Role::Guest, None, 2000).is_ok());
        assert!(matches!(
            room.apply("guest", Role::Guest, None, 1000 + ROOM_MS),
            Err(StoreError::Expired)
        ));
    }
    #[test]
    fn invalid_commands_preserve_auth_but_replaced_connections_do_not() {
        let mut room = RoomData::new(1000);
        let token = room.guest_token.clone();
        room.join("guest", &token, "B", 1000).unwrap();
        assert!(matches!(
            room.apply(
                "guest",
                Role::Guest,
                Some(&Command::Playback {
                    playing: true,
                    position: 0.0,
                }),
                1000,
            ),
            Err(StoreError::Rejected(_))
        ));
        assert!(room.apply("guest", Role::Guest, None, 1001).is_ok());
        room.join("replacement", &token, "B", 1001 + LEASE_MS)
            .unwrap();
        assert!(matches!(
            room.apply("guest", Role::Guest, None, 1002 + LEASE_MS),
            Err(StoreError::Unauthenticated(_))
        ));
        assert!(
            room.apply("replacement", Role::Guest, None, 1002 + LEASE_MS)
                .is_ok()
        );
    }
    #[test]
    fn idle_expiry_checks_wall_time_even_if_dynamo_ttl_has_not_deleted_record() {
        let room = RoomData::new(1000);
        assert!(room.expired(1000 + IDLE_MS));
        let mut room = RoomData::new(1000);
        let token = room.host_token.clone();
        room.join("host", &token, "A", 1000).unwrap();
        room.reap(1000 + LEASE_MS + IDLE_MS);
        assert!(room.expired(1000 + LEASE_MS + IDLE_MS));
    }
}

#[cfg(test)]
mod dynamodb_tests {
    use super::*;
    use aws_sdk_dynamodb::types::{
        AttributeDefinition, BillingMode, KeySchemaElement, KeyType, ScalarAttributeType,
    };

    #[tokio::test]
    #[ignore = "Requires DYNAMODB_LOCAL_ENDPOINT pointing to local DynamoDB"]
    async fn atomic_seats_concurrent_commands_and_stale_disconnects() {
        let endpoint =
            std::env::var("DYNAMODB_LOCAL_ENDPOINT").expect("Set DYNAMODB_LOCAL_ENDPOINT");
        let url = url::Url::parse(&endpoint).unwrap();
        assert!(
            url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        );
        let config = aws_sdk_dynamodb::config::Builder::new()
            .behavior_version_latest()
            .region(aws_sdk_dynamodb::config::Region::new("us-east-1"))
            .credentials_provider(aws_sdk_dynamodb::config::Credentials::new(
                "local", "local", None, None, "test",
            ))
            .endpoint_url(endpoint)
            .build();
        let client = Client::from_conf(config);
        let table = format!("duet-test-{}", Uuid::new_v4().simple());
        client
            .create_table()
            .table_name(&table)
            .attribute_definitions(
                AttributeDefinition::builder()
                    .attribute_name("pk")
                    .attribute_type(ScalarAttributeType::S)
                    .build()
                    .unwrap(),
            )
            .key_schema(
                KeySchemaElement::builder()
                    .attribute_name("pk")
                    .key_type(KeyType::Hash)
                    .build()
                    .unwrap(),
            )
            .billing_mode(BillingMode::PayPerRequest)
            .send()
            .await
            .unwrap();
        let store = Store::new(client.clone(), table.clone());
        // Cleanup runs even if an assertion inside the task fails.
        let result = tokio::spawn(async move {
            let created = store.create(1_000).await.unwrap();
            for id in ["host-a", "host-b", "guest"] {
                store.connect(id, created.id, 1_000).await.unwrap();
            }
            let (a, b) = tokio::join!(
                store.join("host-a", &created.host_token, "A", 1_000),
                store.join("host-b", &created.host_token, "B", 1_000)
            );
            assert_ne!(
                a.is_ok(),
                b.is_ok(),
                "Exactly one simultaneous host admission must succeed"
            );
            let host = if a.is_ok() { "host-a" } else { "host-b" };
            store
                .join("guest", &created.guest_token, "Guest", 1_000)
                .await
                .unwrap();
            store
                .command(
                    host,
                    Command::Source {
                        source: Some(Source::Youtube {
                            url: "aqz-KE-bpKQ".into(),
                        }),
                    },
                    1_100,
                )
                .await
                .unwrap();
            let (first, second) = tokio::join!(
                store.command(
                    host,
                    Command::Playback {
                        playing: true,
                        position: 4.0
                    },
                    1_200
                ),
                store.command(
                    "guest",
                    Command::Playback {
                        playing: false,
                        position: 8.0
                    },
                    1_200
                )
            );
            assert!(
                first.is_ok() && second.is_ok(),
                "Concurrent valid commands must retry rather than lose a write"
            );
            let room = store
                .get::<RoomData>(&format!("ROOM#{}", created.id))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(room.value.revision, 5);
            assert_eq!(room.value.connections().len(), 2);
            store
                .connect("replacement", created.id, 62_000)
                .await
                .unwrap();
            store
                .join("replacement", &created.host_token, "Replacement", 62_000)
                .await
                .unwrap();
            store.disconnect(host, 62_001).await.unwrap();
            let room = store
                .get::<RoomData>(&format!("ROOM#{}", created.id))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                room.value.seats[0].as_ref().unwrap().connection,
                "replacement"
            );
            assert!(store.heartbeat(host, 62_002).await.is_err());
            assert!(store.heartbeat("replacement", 62_002).await.is_ok());
            assert!(store.admit("127.0.0.1", "test", 1, 62_000).await.unwrap());
            assert!(!store.admit("127.0.0.1", "test", 1, 62_000).await.unwrap());
            store
                .connect("late-auth", created.id, 62_003)
                .await
                .unwrap();
            assert!(
                store
                    .join("late-auth", &created.guest_token, "Late", 80_000)
                    .await
                    .is_err()
            );
        })
        .await;
        client
            .delete_table()
            .table_name(table)
            .send()
            .await
            .unwrap();
        result.unwrap();
    }
}
