use chrono::{Datelike, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(not(target_os = "android"))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(target_os = "android"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(not(target_os = "android"))]
use tauri::WindowEvent;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[cfg(not(target_os = "android"))]
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

// ===== Data Structures =====

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    date: String,
    successful: bool,
    idle_count: u32,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStore {
    sessions: Vec<Session>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStats {
    successful_sessions: u32,
    terminations: u32,
    idle_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActiveWindowInfo {
    app_name: String,
    window_title: String,
}

// ===== App State =====

struct AppState {
    last_activity: std::time::Instant,
    timer_running: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            last_activity: std::time::Instant::now(),
            timer_running: false,
        }
    }
}

// ===== Helpers =====

fn get_data_dir() -> PathBuf {
    let mut dir = dirs_next().unwrap_or_else(|| PathBuf::from("."));
    dir.push("eyecatcher_data");
    fs::create_dir_all(&dir).ok();
    dir
}

fn dirs_next() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::env::var("XDG_DATA_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| PathBuf::from(h).join(".local").join("share"))
            })
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA").ok().map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Some(PathBuf::from("."))
    }
}

fn get_sessions_file() -> PathBuf {
    get_data_dir().join("sessions.json")
}

fn load_sessions() -> SessionStore {
    let path = get_sessions_file();
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&data).unwrap_or(SessionStore {
            sessions: Vec::new(),
        })
    } else {
        SessionStore {
            sessions: Vec::new(),
        }
    }
}

fn save_sessions(store: &SessionStore) {
    let path = get_sessions_file();
    if let Ok(data) = serde_json::to_string_pretty(store) {
        fs::write(path, data).ok();
    }
}

#[cfg(not(target_os = "android"))]
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

// ===== Tauri Commands =====

#[tauri::command]
fn start_timer(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.timer_running = true;
        s.last_activity = std::time::Instant::now();
    }
}

#[tauri::command]
fn stop_timer(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.timer_running = false;
    }
}

#[tauri::command]
fn pause_timer(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.timer_running = false;
    }
}

#[tauri::command]
fn resume_timer(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.timer_running = true;
        s.last_activity = std::time::Instant::now();
    }
}

#[tauri::command]
fn report_activity(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.last_activity = std::time::Instant::now();
    }
}

#[tauri::command]
fn save_session(successful: bool, idle_count: u32) {
    let now = Local::now();
    let session = Session {
        date: now.format("%Y-%m-%d").to_string(),
        successful,
        idle_count,
        timestamp: now.format("%Y-%m-%dT%H:%M:%S").to_string(),
    };

    let mut store = load_sessions();
    store.sessions.push(session);
    save_sessions(&store);
}

#[tauri::command]
fn get_stats(period: String) -> SessionStats {
    let store = load_sessions();
    let today = Local::now().date_naive();

    let filtered: Vec<&Session> = store
        .sessions
        .iter()
        .filter(|s| {
            if let Ok(session_date) = NaiveDate::parse_from_str(&s.date, "%Y-%m-%d") {
                match period.as_str() {
                    "today" => session_date == today,
                    "weekly" => {
                        let days_diff = (today - session_date).num_days();
                        days_diff >= 0 && days_diff < 7
                    }
                    "monthly" => {
                        session_date.year() == today.year()
                            && session_date.month() == today.month()
                    }
                    _ => session_date == today,
                }
            } else {
                false
            }
        })
        .collect();

    let successful_sessions = filtered.iter().filter(|s| s.successful).count() as u32;
    let terminations = filtered.iter().filter(|s| !s.successful).count() as u32;
    let idle_count: u32 = filtered.iter().map(|s| s.idle_count).sum();

    SessionStats {
        successful_sessions,
        terminations,
        idle_count,
    }
}

#[tauri::command]
fn send_notification(title: String, body: String, app: AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .ok();
}

#[tauri::command]
fn get_active_window_info() -> Option<ActiveWindowInfo> {
    #[cfg(not(target_os = "android"))]
    {
        let active = active_win_pos_rs::get_active_window().ok()?;
        Some(ActiveWindowInfo {
            app_name: active.app_name,
            window_title: active.title,
        })
    }
    #[cfg(target_os = "android")]
    {
        None
    }
}

#[tauri::command]
async fn open_blur_overlay(app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        if let Some(window) = app.get_webview_window("blur-overlay") {
            window.destroy().ok();
        }

        let _blur_window = WebviewWindowBuilder::new(
            &app,
            "blur-overlay",
            WebviewUrl::App("blur.html".into()),
        )
        .title("eyeCATCHER - Break")
        .fullscreen(true)
        .always_on_top(true)
        .decorations(false)
        .skip_taskbar(true)
        .focused(true)
        .transparent(true)
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

        #[cfg(target_os = "windows")]
        {
            use window_vibrancy::apply_blur;
            apply_blur(&_blur_window, Some((18, 18, 18, 200)))
                .map_err(|e| format!("Failed to apply blur: {:?}", e))
                .ok();
        }
    }

    #[cfg(target_os = "android")]
    {
        app.emit("show-break-overlay", ()).ok();
    }

    Ok(())
}

#[tauri::command]
async fn close_blur_overlay(app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        if let Some(window) = app.get_webview_window("blur-overlay") {
            window.destroy().map_err(|e: tauri::Error| e.to_string())?;
        }
    }

    app.emit("blur-complete", ()).ok();
    Ok(())
}

// ===== Autostart Commands =====

#[tauri::command]
fn get_autostart(#[allow(unused_variables)] app: AppHandle) -> Result<bool, String> {
    #[cfg(not(target_os = "android"))]
    {
        app.autolaunch()
            .is_enabled()
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "android")]
    {
        Ok(false)
    }
}

#[tauri::command]
fn set_autostart(
    #[allow(unused_variables)] enabled: bool,
    #[allow(unused_variables)] app: AppHandle,
) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let manager = app.autolaunch();
        if enabled {
            manager.enable().map_err(|e| e.to_string())?;
        } else {
            manager.disable().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ===== Idle Monitor Background Thread =====

#[cfg(not(target_os = "android"))]
fn start_idle_monitor(app: AppHandle, state_mutex: std::sync::Arc<Mutex<AppState>>) {
    const IDLE_THRESHOLD_SECS: u64 = 120;

    std::thread::spawn(move || {
        let mut was_idle = false;

        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));

            let system_idle_secs = match user_idle::UserIdle::get_time() {
                Ok(u) => Some(u.as_seconds()),
                Err(_) => None,
            };

            let fallback_idle_secs = {
                if let Ok(s) = state_mutex.lock() {
                    s.last_activity.elapsed().as_secs()
                } else {
                    continue;
                }
            };

            let idle_secs = system_idle_secs.unwrap_or(fallback_idle_secs);

            if idle_secs >= IDLE_THRESHOLD_SECS && !was_idle {
                was_idle = true;
                app.emit("user-idle", ()).ok();
            } else if idle_secs < IDLE_THRESHOLD_SECS && was_idle {
                was_idle = false;
                app.emit("user-active", ()).ok();
            }
        }
    });
}

// ===== System Tray =====

#[cfg(not(target_os = "android"))]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show eyeCATCHER", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "Hide to tray", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("main-tray")
        .tooltip("eyeCATCHER")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "hide" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// ===== Entry Point =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = std::sync::Arc::new(Mutex::new(AppState::default()));

    #[cfg(not(target_os = "android"))]
    let monitor_state = app_state.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        None,
    ));

    builder
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            start_timer,
            stop_timer,
            pause_timer,
            resume_timer,
            report_activity,
            save_session,
            get_stats,
            send_notification,
            get_active_window_info,
            open_blur_overlay,
            close_blur_overlay,
            get_autostart,
            set_autostart,
        ])
        .on_window_event(|_window, _event| {
            #[cfg(not(target_os = "android"))]
            if _window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = _event {
                    let _ = _window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(move |app| {
            #[cfg(not(target_os = "android"))]
            {
                let handle = app.handle().clone();
                build_tray(&handle)?;
                start_idle_monitor(handle, monitor_state);
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
