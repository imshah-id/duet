use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use url::Url;
use uuid::Uuid;

pub const ROOM_LIFETIME: Duration = Duration::from_secs(6 * 60 * 60);
const IDLE_LIFETIME: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Host,
    Guest,
}

impl Role {
    pub fn index(self) -> usize {
        if self == Self::Host { 0 } else { 1 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    Youtube { url: String },
    Video { url: String },
    Screen,
}

impl Source {
    pub fn validate(&self) -> bool {
        match self {
            Self::Screen => true,
            Self::Youtube { url } => {
                url.len() == 11
                    && url
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            }
            Self::Video { url } => {
                if url.len() > 2048 {
                    return false;
                }
                let Ok(parsed) = Url::parse(url) else {
                    return false;
                };
                let host = parsed.host_str().unwrap_or("");
                // Media is fetched by the browser, never by this server.
                parsed.scheme() == "https"
                    && parsed.username().is_empty()
                    && parsed.password().is_none()
                    && host.contains('.')
                    && !host.ends_with(".local")
                    && !host.ends_with(".localhost")
                    && host.parse::<std::net::IpAddr>().is_err()
                    && !host.starts_with('[')
                    && (parsed.path().to_lowercase().ends_with(".mp4")
                        || parsed.path().to_lowercase().ends_with(".webm"))
            }
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Member {
    pub role: Role,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub source: Option<Source>,
    pub playing: bool,
    pub position: f64,
    pub revision: u64,
    pub members: Vec<Member>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    State {
        state: Snapshot,
    },
    Chat {
        role: Role,
        name: String,
        text: String,
        id: Uuid,
    },
    Signal {
        from: Role,
        signal: Signal,
    },
    Expired,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Signal {
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    Ice {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    },
}

impl Signal {
    pub fn allowed(&self, role: Role) -> bool {
        match self {
            Self::Offer { sdp } => role == Role::Host && sdp.len() <= 16_384,
            Self::Answer { sdp } => role == Role::Guest && sdp.len() <= 16_384,
            Self::Ice {
                candidate, sdp_mid, ..
            } => candidate.len() <= 4096 && sdp_mid.as_ref().is_none_or(|s| s.len() <= 64),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Auth { token: String, name: String },
    Source { source: Option<Source> },
    Playback { playing: bool, position: f64 },
    Chat { text: String },
    Signal { signal: Signal },
}

pub struct Room {
    pub host_token: String,
    pub guest_token: String,
    pub members: [Option<String>; 2],
    pub events: broadcast::Sender<Event>,
    pub created: Instant,
    pub touched: Instant,
    source: Option<Source>,
    playing: bool,
    position: f64,
    anchored: Instant,
    revision: u64,
}

impl Room {
    pub fn new() -> Self {
        let now = Instant::now();
        Self {
            host_token: Uuid::new_v4().simple().to_string(),
            guest_token: Uuid::new_v4().simple().to_string(),
            members: [None, None],
            events: broadcast::channel(32).0,
            created: now,
            touched: now,
            source: None,
            playing: false,
            position: 0.0,
            anchored: now,
            revision: 0,
        }
    }

    pub fn expired(&self) -> bool {
        self.created.elapsed() >= ROOM_LIFETIME
            || (self.members.iter().all(Option::is_none) && self.touched.elapsed() >= IDLE_LIFETIME)
    }

    pub fn join(&mut self, token: &str, name: &str) -> Result<Role, &'static str> {
        if self.expired() {
            return Err("This room has expired. Start a new one.");
        }
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 32 || name.chars().any(char::is_control) {
            return Err("Use a name between 1 and 32 characters.");
        }
        let role = if bool::from(token.as_bytes().ct_eq(self.host_token.as_bytes())) {
            Role::Host
        } else if bool::from(token.as_bytes().ct_eq(self.guest_token.as_bytes())) {
            Role::Guest
        } else {
            return Err("This invite is invalid.");
        };
        if self.members[role.index()].is_some() {
            return Err("That seat is already connected. Close the other tab first.");
        }
        self.members[role.index()] = Some(name.to_owned());
        self.touched = Instant::now();
        Ok(role)
    }

    pub fn leave(&mut self, role: Role) {
        self.members[role.index()] = None;
        self.position = self.snapshot().position;
        self.playing = false;
        self.anchored = Instant::now();
        self.touched = Instant::now();
        if role == Role::Host && self.source == Some(Source::Screen) {
            self.source = None;
        }
        self.revision += 1;
        self.publish();
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            source: self.source.clone(),
            playing: self.playing,
            position: self.position
                + if self.playing {
                    self.anchored.elapsed().as_secs_f64()
                } else {
                    0.0
                },
            revision: self.revision,
            members: [Role::Host, Role::Guest]
                .into_iter()
                .filter_map(|role| {
                    self.members[role.index()].as_ref().map(|name| Member {
                        role,
                        name: name.clone(),
                    })
                })
                .collect(),
        }
    }

    pub fn publish(&self) {
        let _ = self.events.send(Event::State {
            state: self.snapshot(),
        });
    }

    pub fn apply(&mut self, role: Role, command: Command) -> Result<(), &'static str> {
        if self.expired() {
            return Err("This room has expired.");
        }
        let Some(name) = self.members[role.index()].clone() else {
            return Err("Join the room first.");
        };
        match command {
            Command::Source { source } => {
                if role != Role::Host {
                    return Err("Only the host can change the source.");
                }
                if source.as_ref().is_some_and(|s| !s.validate()) {
                    return Err("Choose a YouTube video or a public HTTPS MP4/WebM link.");
                }
                self.source = source;
                self.playing = false;
                self.position = 0.0;
                self.anchored = Instant::now();
                self.revision += 1;
                self.publish();
            }
            Command::Playback { playing, position } => {
                if self.source.is_none() || self.source == Some(Source::Screen) {
                    return Err("Choose a video first.");
                }
                if !position.is_finite() || !(0.0..=604_800.0).contains(&position) {
                    return Err("Invalid playback position.");
                }
                self.playing = playing;
                self.position = position;
                self.anchored = Instant::now();
                self.revision += 1;
                self.publish();
            }
            Command::Chat { text } => {
                let text = text.trim();
                if text.is_empty()
                    || text.chars().count() > 500
                    || text.chars().any(|c| c.is_control() && c != '\n')
                {
                    return Err("Messages must contain 1–500 characters.");
                }
                let _ = self.events.send(Event::Chat {
                    role,
                    name,
                    text: text.to_owned(),
                    id: Uuid::new_v4(),
                });
            }
            Command::Signal { signal } => {
                if self.source != Some(Source::Screen) || !signal.allowed(role) {
                    return Err("Invalid screen-sharing signal.");
                }
                let _ = self.events.send(Event::Signal { from: role, signal });
            }
            Command::Auth { .. } => return Err("Already connected."),
        }
        self.touched = Instant::now();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seats_are_authenticated_and_limited() {
        let mut room = Room::new();
        assert!(room.join("invalid", "A").is_err());
        assert_eq!(room.join(&room.host_token.clone(), "A"), Ok(Role::Host));
        assert!(room.join(&room.host_token.clone(), "B").is_err());
        assert_eq!(room.join(&room.guest_token.clone(), "B"), Ok(Role::Guest));
        room.leave(Role::Guest);
        assert!(room.join(&room.guest_token.clone(), "B").is_ok());
    }
    #[test]
    fn guests_cannot_change_source_and_positions_are_bounded() {
        let mut room = Room::new();
        room.members = [Some("A".into()), Some("B".into())];
        let source = Some(Source::Youtube {
            url: "aqz-KE-bpKQ".into(),
        });
        assert!(
            room.apply(
                Role::Guest,
                Command::Source {
                    source: source.clone()
                }
            )
            .is_err()
        );
        room.apply(Role::Host, Command::Source { source }).unwrap();
        for position in [f64::NAN, f64::INFINITY, -1.0, 604_801.0] {
            assert!(
                room.apply(
                    Role::Guest,
                    Command::Playback {
                        playing: true,
                        position
                    }
                )
                .is_err()
            );
        }
        room.apply(
            Role::Guest,
            Command::Playback {
                playing: false,
                position: 42.0,
            },
        )
        .unwrap();
        assert_eq!(room.snapshot().position, 42.0);
    }
    #[test]
    fn source_urls_reject_unsafe_input() {
        for url in [
            "http://example.com/a.mp4",
            "https://127.0.0.1/a.mp4",
            "https://user:pass@example.com/a.mp4",
            "https://example.com/a.html",
            "https://[::1]/a.mp4",
        ] {
            assert!(!Source::Video { url: url.into() }.validate());
        }
        assert!(
            Source::Video {
                url: "https://media.example.com/movie.mp4?token=abc".into()
            }
            .validate()
        );
        assert!(
            !Source::Youtube {
                url: "../bad".into()
            }
            .validate()
        );
    }
    #[test]
    fn expiration_and_disconnect_pause_playback() {
        let mut room = Room::new();
        room.members[0] = Some("A".into());
        room.apply(
            Role::Host,
            Command::Source {
                source: Some(Source::Screen),
            },
        )
        .unwrap();
        room.leave(Role::Host);
        assert!(room.snapshot().source.is_none());
        room.created = Instant::now() - ROOM_LIFETIME;
        assert!(room.join(&room.host_token.clone(), "A").is_err());
    }
}
