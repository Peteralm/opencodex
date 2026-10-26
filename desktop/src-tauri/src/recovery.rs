//! Publish the shell's current intent independently of the supervised runtime's lifetime.
use crate::{
    exit::{ExitCoordinator, ExitPhase},
    recovery_presence::{Presence, Snapshot},
};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

struct Recovery {
    home: Arc<Mutex<Option<std::path::PathBuf>>>,
    _presence: Presence,
}

/// Register before startup can resolve or spawn. A failure grants no consumer-side authority.
pub fn register(app: &AppHandle) {
    let home = Arc::new(Mutex::new(None));
    let observed_home = Arc::clone(&home);
    let handle = app.clone();
    let snapshot = Arc::new(move || {
        let state = handle
            .try_state::<ExitCoordinator>()
            .map(|exit| exit.supervision());
        Snapshot {
            home: observed_home.lock().ok().and_then(|home| home.clone()),
            wanted: state.is_some_and(|s| {
                s.wanted
                    && !s.reason_set
                    && matches!(s.phase, ExitPhase::Idle | ExitPhase::Spawning)
            }),
        }
    });
    match Presence::start(uuid::Uuid::new_v4().simple().to_string(), snapshot) {
        Ok(presence) => {
            app.manage(Recovery {
                home,
                _presence: presence,
            });
        }
        Err(_) => crate::logging::log_once(
            "Desktop recovery evidence is unavailable",
            "the native listener could not be registered",
        ),
    }
}

/// Only the bundled CLI's resolved home selects the scope; neither request bytes nor a locator do.
pub fn bind_home(app: &AppHandle, home: &Path) {
    if let Some(recovery) = app.try_state::<Recovery>() {
        if let Ok(mut current) = recovery.home.lock() {
            *current = Some(home.to_path_buf());
        }
    }
}
