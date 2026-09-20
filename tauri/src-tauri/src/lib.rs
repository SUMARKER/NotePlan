pub mod commands;

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, Theme, WindowEvent};

pub use commands::*;

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub vault_path: Option<String>,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub last_note: Option<String>,
    #[serde(default = "default_sidebar")]
    pub sidebar_view: String,
    #[serde(default)]
    pub calendars: serde_json::Value,
}

fn default_theme() -> String {
    "auto".into()
}
fn default_sidebar() -> String {
    "calendar".into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            vault_path: None,
            theme: default_theme(),
            last_note: None,
            sidebar_view: default_sidebar(),
            calendars: json!([]),
        }
    }
}

pub struct AppState {
    /// 当前笔记库根目录（绝对路径，干净形式无 \\?\ 前缀）
    pub vault: Mutex<Option<PathBuf>>,
    pub config: Mutex<Config>,
    /// 本应用自己写入的文件 (absPath -> mtimeMs)，用于忽略自身触发的变更事件
    pub self_writes: Mutex<HashMap<PathBuf, u64>>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub watch_tx: Mutex<Option<Sender<Result<notify::Event, notify::Error>>>>,
    pub app: Mutex<Option<AppHandle>>,
}

impl AppState {
    pub fn new() -> Self {
        let config = load_config();
        // 启动时从设置恢复笔记库（等价 Electron 版启动时的 setVault 恢复）
        let vault = config
            .vault_path
            .as_ref()
            .filter(|p| Path::new(p).is_dir())
            .and_then(|p| clean_canonical(Path::new(p)));
        Self {
            vault: Mutex::new(vault),
            config: Mutex::new(config),
            self_writes: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            watch_tx: Mutex::new(None),
            app: Mutex::new(None),
        }
    }

    pub fn vault_path(state: &State<AppState>) -> Option<PathBuf> {
        state.vault.lock().unwrap().clone()
    }

    pub fn set_vault(&self, path: PathBuf) {
        *self.vault.lock().unwrap() = Some(path);
    }

    pub fn save_config(&self) {
        let cfg = self.config.lock().unwrap().clone();
        save_config_file(&cfg);
    }

    pub fn mark_self_write(&self, abs: &Path) {
        let ms = mtime_ms(abs);
        let mut map = self.self_writes.lock().unwrap();
        map.insert(abs.to_path_buf(), ms);
        if map.len() > 200 {
            let n = map.len() / 2;
            let keys: Vec<PathBuf> = map.keys().take(n).cloned().collect();
            for k in keys {
                map.remove(&k);
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* 配置持久化：%LOCALAPPDATA%\NotePlanTauri\config.json                */
/* ------------------------------------------------------------------ */

fn config_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&base).join("NotePlanTauri")
}

fn load_config() -> Config {
    std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config_file(cfg: &Config) {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(dir.join("config.json"), s);
    }
}

/* ------------------------------------------------------------------ */
/* 路径与文件工具                                                      */
/* ------------------------------------------------------------------ */

/// canonicalize 后去掉 Windows 的 \\?\ 前缀，得到干净的可显示路径
pub fn clean_canonical(p: &Path) -> Option<PathBuf> {
    let c = p.canonicalize().ok()?;
    let s = c.to_string_lossy().to_string();
    Some(PathBuf::from(
        s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s),
    ))
}

/// 把相对路径解析到笔记库内（拒绝 .. / 绝对路径 / 空路径），防止越界访问
pub fn safe_resolve(vault: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let mut out = vault.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(c) => out.push(c),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

pub fn abs_to_rel(vault: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

pub fn is_markdown(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
}

pub fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ------------------------------------------------------------------ */
/* 文件监听（notify v6 + 350ms 防抖，忽略自身写入）                     */
/* ------------------------------------------------------------------ */

pub fn start_watching(state: &State<AppState>) {
    let vault = { state.vault.lock().unwrap().clone() };
    let Some(vault) = vault else { return };

    // 首次调用时创建常驻的去抖线程；之后仅重建 watcher 本体
    let tx = {
        let mut tx_guard = state.watch_tx.lock().unwrap();
        if tx_guard.is_none() {
            let (tx, rx) = std::sync::mpsc::channel();
            let app_handle = state.app.lock().unwrap().clone();
            std::thread::spawn(move || watch_loop(rx, app_handle));
            *tx_guard = Some(tx);
        }
        tx_guard.as_ref().unwrap().clone()
    };

    let mut watcher_guard = state.watcher.lock().unwrap();
    // 先释放旧的 watcher，避免重复通知
    if let Some(old) = watcher_guard.take() {
        drop(old);
    }
    match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(mut w) => {
            if let Err(e) = w.watch(&vault, RecursiveMode::Recursive) {
                eprintln!("启动文件监听失败: {e}");
            }
            *watcher_guard = Some(w);
        }
        Err(e) => eprintln!("创建文件监听失败: {e}"),
    }
}

fn watch_loop(rx: std::sync::mpsc::Receiver<Result<notify::Event, notify::Error>>, app: Option<AppHandle>) {
    const DEBOUNCE: Duration = Duration::from_millis(350);
    let mut deadline: Option<Instant> = None;
    loop {
        let timeout = deadline
            .map(|t| t.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(3600));
        match rx.recv_timeout(timeout) {
            Ok(Ok(ev)) => {
                let external = app
                    .as_ref()
                    .map(|h| !is_self_write_event(&h.state::<AppState>(), &ev))
                    .unwrap_or(true);
                if !external {
                    continue;
                }
                deadline = Some(Instant::now() + DEBOUNCE);
            }
            Ok(Err(e)) => {
                eprintln!("[watch] error event: {e}");
                deadline = Some(Instant::now() + DEBOUNCE);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if deadline.take().is_some() {
                    if let Some(h) = &app {
                        let _ = h.emit("vault:changed", ());
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 判断整批变更路径是否都来自本应用自己的写入；是则忽略本次事件
fn is_self_write_event(state: &State<AppState>, ev: &notify::Event) -> bool {
    if ev.paths.is_empty() {
        return false;
    }
    let mut map = state.self_writes.lock().unwrap();
    let mut all_self = true;
    for p in &ev.paths {
        let recorded = map.get(p).copied();
        match recorded {
            Some(ms) => {
                map.remove(p);
                let now = mtime_ms(p);
                if now.abs_diff(ms) >= 2 {
                    all_self = false;
                }
            }
            None => all_self = false,
        }
    }
    all_self
}

/* ------------------------------------------------------------------ */
/* vault:// 自定义协议：在预览中显示笔记库内的图片等文件                */
/* ------------------------------------------------------------------ */

fn vault_protocol_handler(
    state: &State<AppState>,
    uri: &tauri::http::Uri,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    use percent_encoding::percent_decode_str;

    let not_found = |code: u16, msg: &'static str| {
        tauri::http::Response::builder()
            .status(code)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(std::borrow::Cow::Borrowed(msg.as_bytes()))
            .unwrap()
    };

    let Some(vault) = state.vault.lock().unwrap().clone() else {
        return not_found(403, "forbidden");
    };

    let host = uri.host().unwrap_or("").to_string();
    let mut rel = percent_decode_str(uri.path())
        .decode_utf8_lossy()
        .replace('\\', "/");
    while rel.starts_with('/') {
        rel.remove(0);
    }
    // Tauri/WebView2 会把自定义协议请求呈现为 vault://localhost/<路径>，
    // 这里的 host 是伪主机名而非路径首段，需要忽略；
    // 仅当 host 是真实的路径首段时（vault://Notes/img.png 形式）才拼回。
    if !host.is_empty()
        && host.to_lowercase() != "localhost"
        && !rel.to_lowercase().starts_with(&host.to_lowercase())
    {
        rel = format!("{host}/{rel}");
    }

    let Some(abs) = safe_resolve(&vault, &rel) else {
        return not_found(403, "forbidden");
    };
    match std::fs::read(&abs) {
        Ok(bytes) => {
            let mime = mime_for(&abs);
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Cache-Control", "no-cache")
                .header("Access-Control-Allow-Origin", "*")
                .body(std::borrow::Cow::Owned(bytes))
                .unwrap()
        }
        Err(_) => not_found(404, "not found"),
    }
}

fn mime_for(p: &Path) -> &'static str {
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "txt" | "md" | "markdown" | "json" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/* ------------------------------------------------------------------ */
/* 原生菜单                                                            */
/* ------------------------------------------------------------------ */

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let mk = |id: &str, label: &str| {
        MenuItemBuilder::with_id(id, label)
            .build(app)
            .expect("menu item")
    };

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&mk("new-note", "新建笔记　Ctrl+N"))
        .item(&mk("open-today", "打开今日笔记　Ctrl+J"))
        .item(&mk("week-plan", "周计划"))
        .separator()
        .item(&mk("palette", "命令面板　Ctrl+K"))
        .item(&mk("search", "全库搜索　Ctrl+Shift+F"))
        .separator()
        .item(&mk("choose-vault", "更换笔记库…"))
        .item(&mk("show-vault", "在资源管理器中打开笔记库"))
        .separator()
        .item(&mk("settings", "设置…　Ctrl+,"))
        .item(&mk("quit", "退出"))
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&mk("toggle-task", "切换当前行任务　Ctrl+L"))
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&mk("cycle-view", "编辑 / 分栏 / 预览　Ctrl+E"))
        .item(&mk("toggle-theme", "切换深色 / 浅色主题　Ctrl+Shift+L"))
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "帮助")
        .item(&mk("help", "快捷键与语法说明"))
        .item(&mk("about", "关于"))
        .build()?;

    let menu = tauri::menu::MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        // 走窗口关闭流程（触发 CloseRequested → 渲染进程确认未保存修改），不直接退出
        "quit" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.close();
            }
        }
        "show-vault" => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Some(vault) = state.vault.lock().unwrap().clone() {
                    let _ = std::process::Command::new("explorer").arg(&vault).spawn();
                }
            }
        }
        other => {
            let _ = app.emit(&format!("menu:{other}"), ());
        }
    }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

pub fn run() {
    let state = AppState::new();

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            let handle = app.handle().clone();
            {
                let state: State<AppState> = app.state();
                *state.app.lock().unwrap() = Some(handle.clone());
                build_menu(&handle).expect("构建菜单失败");
                start_watching(&state);
            }

            // 系统主题变化时通知渲染进程（用于"跟随系统"模式）
            if let Some(win) = app.get_webview_window("main") {
                let h = handle.clone();
                win.on_window_event(move |e| {
                    match e {
                        // 关窗先交给渲染进程确认未保存的修改，确认后经 close_window 放行
                        WindowEvent::CloseRequested { api, .. } => {
                            if FORCE_CLOSE.load(std::sync::atomic::Ordering::SeqCst) {
                                return;
                            }
                            api.prevent_close();
                            let _ = h.emit("app:close-request", ());
                        }
                        WindowEvent::ThemeChanged(theme) => {
                            let _ = h.emit("theme:changed", *theme == Theme::Dark);
                        }
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .register_uri_scheme_protocol("vault", |ctx, request| {
            let state = ctx.app_handle().state::<AppState>();
            vault_protocol_handler(&state, request.uri())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            choose_vault,
            open_vault,
            get_vault_path,
            default_vault_path,
            list_notes,
            read_note,
            write_note,
            create_note,
            open_daily,
            rename_note,
            move_note,
            create_folder,
            trash_note,
            trash_folder,
            trash_list,
            trash_restore,
            trash_purge,
            trash_empty,
            search,
            backlinks,
            scheduled_tasks,
            list_tags,
            tasks_all,
            reschedule_task,
            daily_append,
            cal_events,
            open_path,
            show_in_folder,
            open_external,
            quit,
            close_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
