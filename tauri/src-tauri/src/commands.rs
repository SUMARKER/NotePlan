use crate::{abs_to_rel, clean_canonical, is_markdown, mtime_ms, now_ms, safe_resolve, start_watching, AppState};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, Months, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;

const CAL_DIR: &str = "Calendar";
const NOTE_DIR: &str = "Notes";
const TRASH_DIR_REL: &str = ".trash";
const TRASH_INDEX_REL: &str = ".trash/index.json";

static TRASH_SEQ: AtomicU64 = AtomicU64::new(0);

/* ====================================================================
 * 任务行解析（主进程侧；渲染端 editor-src 有对应正则，注意同步）
 * ==================================================================== */

static RE_TASK_LINE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\s*[-*+]\s+\[([ xX])\]\s*(.*)$").unwrap());
static RE_DONE_TAG: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\s*@done(?:\(([^)]*)\))?").unwrap());
static RE_SCHEDULE_IN: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r">\s*(\d{4}-\d{2}-\d{2})").unwrap());
/// 连续任务：`>起 ~ 止`（分隔符支持 ~ – — 至 到）
static RE_SCHEDULE_RANGE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r">\s*(\d{4}-\d{2}-\d{2})\s*(?:~|–|—|至|到)\s*(\d{4}-\d{2}-\d{2})").unwrap()
});
static RE_TIME_RANGE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d{1,2}:\d{2})\s*(?:-|–|—|~|至|到)\s*(\d{1,2}:\d{2})").unwrap());
static RE_RECURRENCE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)(\bevery\s+(?:\d+\s+)?(?:day|week|month|year)s?\b)|每(?:天|日|周|星期|月|年)|每\s*\d+\s*(?:天|周|星期|月|年)",
    )
    .unwrap()
});
static RE_LIST_START: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\s*[-*+]\s+\[").unwrap());
static RE_DATE_STR: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static RE_FILE_EXT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\.(md|markdown|txt)$").unwrap());

fn norm_hm(s: &str) -> String {
    let parts: Vec<&str> = s.split(':').collect();
    let h: u32 = parts.first().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let m: u32 = parts.get(1).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    format!("{h:02}:{m:02}")
}

fn add_hour(hm: &str) -> String {
    let parts: Vec<&str> = hm.split(':').collect();
    let h: u32 = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
    let m: &str = parts.get(1).copied().unwrap_or("00");
    format!("{:02}:{m}", h.saturating_add(1).min(23))
}

struct ParsedTask {
    done: bool,
    done_date: Option<String>,
    scheduled: Option<String>,
    /// 连续任务的结束日期（>起 ~ 止）
    end_date: Option<String>,
    start: Option<String>,
    end: Option<String>,
    recurring: bool,
}

fn parse_task_line(raw: &str) -> Option<ParsedTask> {
    let caps = RE_TASK_LINE.captures(raw)?;
    let text = &caps[2];
    let done_date_m = RE_DONE_TAG.captures(text);
    let range_m = RE_SCHEDULE_RANGE.captures(text);
    let sched_m = match range_m {
        Some(_) => None,
        None => RE_SCHEDULE_IN.captures(text),
    };
    let time_m = RE_TIME_RANGE.captures(text);
    let done = &caps[1] != " " || done_date_m.is_some();
    Some(ParsedTask {
        done,
        done_date: done_date_m.map(|m| {
            let g = m.get(1);
            g.filter(|c| !c.is_empty()).map(|c| c.as_str().to_string())
        }).flatten(),
        scheduled: match &range_m {
            Some(r) => Some(r[1].to_string()),
            None => sched_m.map(|m| m[1].to_string()),
        },
        end_date: range_m.as_ref().map(|r| r[2].to_string()),
        start: time_m.as_ref().map(|m| norm_hm(&m[1])),
        end: time_m.as_ref().map(|m| norm_hm(&m[2])),
        recurring: RE_RECURRENCE.is_match(text),
    })
}

fn parse_iso_date(s: &str) -> Option<NaiveDate> {
    let parts: Vec<i32> = s.split('-').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 {
        return None;
    }
    NaiveDate::from_ymd_opt(parts[0], parts[1] as u32, parts[2] as u32)
}

/// 文件名净化：替换非法字符、压缩空白、去掉开头点号，最长 120 字符
fn sanitize_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.trim_start_matches('.').chars().take(120).collect()
}

/// 若候选路径已存在则依次尝试 " 2"、" 3"… 后缀
fn unique_path(dir_abs: &Path, base: &str, ext: &str) -> PathBuf {
    let mut candidate = dir_abs.join(format!("{base}{ext}"));
    let mut i = 1;
    while candidate.exists() {
        i += 1;
        candidate = dir_abs.join(format!("{base} {i}{ext}"));
    }
    candidate
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/* ====================================================================
 * 笔记库扫描
 * ==================================================================== */

pub struct ScanFile {
    pub rel: String,
    pub name: String,
    pub md: bool,
    pub mtime_ms: i64,
    pub size: u64,
}

static SKIP_DIRS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        ".git",
        ".obsidian",
        ".trash",
        "node_modules",
        "$RECYCLE.BIN",
        "System Volume Information",
        ".DS_Store",
        "desktop.ini",
    ])
});

fn scan_vault(vault: &Path) -> Vec<ScanFile> {
    let mut out = Vec::new();
    for entry in WalkDir::new(vault)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && !SKIP_DIRS.contains(name.as_ref())
        })
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(ScanFile {
            rel: abs_to_rel(vault, entry.path()),
            name,
            md: is_markdown(entry.file_name().to_string_lossy().as_ref()),
            mtime_ms: mtime,
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// 遍历所有子文件夹（不含根与隐藏目录），用于把空文件夹也展示到笔记树
fn scan_dirs(vault: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in WalkDir::new(vault)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && !SKIP_DIRS.contains(name.as_ref())
        })
    {
        let Ok(entry) = entry else { continue };
        if entry.file_type().is_dir() {
            out.push(abs_to_rel(vault, entry.path()));
        }
    }
    out
}

/// 读取文件开头 8KB，避免为提取标题整读大文件
fn read_head(abs: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(abs)?;
    let mut buf = vec![0u8; 8192];
    let mut n = 0;
    loop {
        let read = f.read(&mut buf[n..])?;
        if read == 0 || n + read == buf.len() {
            n += read;
            break;
        }
        n += read;
    }
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

/// 提取第一个 `# 标题` 作为显示标题；首个非空行不是标题就停止
fn extract_title(head: &str) -> Option<String> {
    static RE_HEAD: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^#\s+(.+)$").unwrap());
    for line in head.split('\n') {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        return RE_HEAD.captures(t).map(|m| m[1].trim().to_string());
    }
    None
}

/// 内容是否只有开头一个 `# 标题` 行加空白（只是点开过、没写过内容的空笔记）
fn is_blank_note(head: &str) -> bool {
    static RE_HEADING: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^#\s").unwrap());
    let mut seen_heading = false;
    for line in head.split('\n') {
        let t = line.trim();
        if !seen_heading {
            if t.is_empty() {
                continue;
            }
            if RE_HEADING.is_match(t) {
                seen_heading = true;
                continue;
            }
            return false;
        }
        if !t.is_empty() {
            return false;
        }
    }
    true
}

fn strip_md_ext(name: &str) -> String {
    RE_FILE_EXT.replace(name, "").into_owned()
}

fn vault_of(state: &State<AppState>) -> Option<PathBuf> {
    state.vault.lock().unwrap().clone()
}

/* ====================================================================
 * 设置
 * ==================================================================== */

fn settings_snapshot(state: &State<AppState>) -> Value {
    let cfg = state.config.lock().unwrap().clone();
    let exists = cfg
        .vault_path
        .as_ref()
        .map(|p| Path::new(p).is_dir())
        .unwrap_or(false);
    json!({
        "vaultPath": cfg.vault_path,
        "theme": cfg.theme,
        "lastNote": cfg.last_note,
        "sidebarView": cfg.sidebar_view,
        "calendars": cfg.calendars,
        "vaultExists": exists,
    })
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Value {
    settings_snapshot(&state)
}

#[tauri::command]
pub fn set_settings(state: State<AppState>, patch: HashMap<String, Value>) -> Value {
    {
        let mut cfg = state.config.lock().unwrap();
        if let Some(v) = patch.get("theme") {
            if let Some(s) = v.as_str() {
                cfg.theme = s.into();
            }
        }
        if let Some(v) = patch.get("lastNote") {
            cfg.last_note = v.as_str().map(String::from);
        }
        if let Some(v) = patch.get("sidebarView") {
            if let Some(s) = v.as_str() {
                cfg.sidebar_view = s.into();
            }
        }
        if let Some(v) = patch.get("calendars") {
            cfg.calendars = v.clone();
        }
    }
    state.save_config();
    settings_snapshot(&state)
}

/* ====================================================================
 * 笔记库
 * ==================================================================== */

#[tauri::command(async)]
pub fn choose_vault() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择笔记库文件夹")
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn open_vault(state: State<AppState>, dir: String, create_sample: bool) -> Value {
    let p = PathBuf::from(&dir);
    // 目录不存在则创建（"创建示例笔记库"的目标路径是全新的）
    if let Err(e) = std::fs::create_dir_all(&p) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    if !p.is_dir() {
        return json!({ "ok": false, "error": "所选路径不是文件夹" });
    }
    let Some(clean) = clean_canonical(&p) else {
        return json!({ "ok": false, "error": "无法解析路径" });
    };
    if create_sample {
        create_sample_vault(&clean);
    }
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.vault_path = Some(clean.to_string_lossy().into_owned());
        cfg.last_note = None;
    }
    state.save_config();
    state.set_vault(clean);
    start_watching(&state);
    json!({ "ok": true })
}

#[tauri::command]
pub fn get_vault_path(state: State<AppState>) -> Value {
    json!(state
        .vault
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn default_vault_path() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    Path::new(&home)
        .join("Documents")
        .join("NotePlan 笔记库")
        .to_string_lossy()
        .into_owned()
}

/* ====================================================================
 * 笔记 CRUD
 * ==================================================================== */

#[tauri::command(async)]
pub fn list_notes(state: State<AppState>) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "vaultPath": null, "notes": [] });
    };
    let files = scan_vault(&vault);
    let notes: Vec<Value> = files
        .iter()
        .map(|f| {
            let (title, empty) = if f.md {
                match safe_resolve(&vault, &f.rel)
                    .and_then(|abs| read_head(&abs).ok())
                {
                    Some(head) => (extract_title(&head), is_blank_note(&head)),
                    None => (None, false),
                }
            } else {
                (None, false)
            };
            json!({
                "rel": f.rel, "name": f.name, "md": f.md,
                "mtimeMs": f.mtime_ms, "size": f.size, "title": title,
                "empty": empty,
            })
        })
        .collect();
    // 空文件夹也返回（md:false + dir:true），否则「＋文件夹」后笔记树看不到它
    for d in scan_dirs(&vault) {
        let name = d.rsplit('/').next().unwrap_or(&d).to_string();
        notes.push(json!({
            "rel": d, "name": name, "md": false, "dir": true,
            "mtimeMs": 0, "size": 0, "title": null, "empty": true,
        }));
    }
    let vp = vault.to_string_lossy().into_owned();
    json!({ "vaultPath": vp, "notes": notes })
}

#[tauri::command(async)]
pub fn read_note(state: State<AppState>, rel: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let Some(abs) = safe_resolve(&vault, &rel) else {
        return json!({ "ok": false, "error": "非法路径" });
    };
    match std::fs::read(&abs) {
        Ok(bytes) => json!({
            "ok": true,
            "content": String::from_utf8_lossy(&bytes),
            "mtimeMs": mtime_ms(&abs),
        }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command(async)]
pub fn write_note(state: State<AppState>, rel: String, content: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let Some(abs) = safe_resolve(&vault, &rel) else {
        return json!({ "ok": false, "error": "非法路径" });
    };
    if let Some(parent) = abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&abs, content.as_bytes()) {
        Ok(()) => {
            state.mark_self_write(&abs);
            json!({ "ok": true, "mtimeMs": mtime_ms(&abs) })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command(async)]
pub fn create_note(state: State<AppState>, folder: String, title: String, content: Option<String>) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let mut clean = sanitize_name(&title);
    if clean.is_empty() {
        clean = "无标题笔记".into();
    }
    let folder_rel = if folder.is_empty() { NOTE_DIR } else { folder.as_str() };
    let Some(dir_abs) = safe_resolve(&vault, folder_rel) else {
        return json!({ "ok": false, "error": "非法文件夹" });
    };
    if let Err(e) = std::fs::create_dir_all(&dir_abs) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    let abs = unique_path(&dir_abs, &clean, ".md");
    let body = content.unwrap_or_else(|| format!("# {clean}\n\n"));
    match std::fs::write(&abs, body.as_bytes()) {
        Ok(()) => {
            state.mark_self_write(&abs);
            json!({ "ok": true, "rel": abs_to_rel(&vault, &abs) })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command(async)]
pub fn open_daily(state: State<AppState>, date_str: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    if !RE_DATE_STR.is_match(&date_str) {
        return json!({ "ok": false, "error": "日期格式错误" });
    }
    let rel = format!("{CAL_DIR}/{date_str}.md");
    let abs = match safe_resolve(&vault, &rel) {
        Some(a) => a,
        None => return json!({ "ok": false, "error": "非法路径" }),
    };
    if !abs.exists() {
        if let Some(parent) = abs.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // 不再写入默认的 `# 日期` 标题：日期已由界面（面包屑/周数行/右栏）展示
        if let Err(e) = std::fs::write(&abs, "") {
            return json!({ "ok": false, "error": e.to_string() });
        }
    }
    state.mark_self_write(&abs);
    json!({ "ok": true, "rel": rel })
}

#[tauri::command(async)]
pub fn rename_note(state: State<AppState>, rel: String, new_name: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let Some(abs) = safe_resolve(&vault, &rel) else {
        return json!({ "ok": false, "error": "非法路径" });
    };
    let clean = sanitize_name(&new_name);
    if clean.is_empty() {
        return json!({ "ok": false, "error": "名称不能为空" });
    }
    let ext = abs
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_else(|| ".md".into());
    let abs_new = unique_path(abs.parent().unwrap_or(&vault), &clean, &ext);
    if let Err(e) = std::fs::rename(&abs, &abs_new) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    state.mark_self_write(&abs_new);
    let new_rel = abs_to_rel(&vault, &abs_new);
    {
        let mut cfg = state.config.lock().unwrap();
        if cfg.last_note.as_deref() == Some(rel.as_str()) {
            cfg.last_note = Some(new_rel.clone());
            drop(cfg);
            state.save_config();
        }
    }
    json!({ "ok": true, "rel": new_rel })
}

#[tauri::command(async)]
pub fn move_note(state: State<AppState>, rel: String, dest_folder: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let Some(abs) = safe_resolve(&vault, &rel) else {
        return json!({ "ok": false, "error": "非法路径" });
    };
    let Some(dir_abs) = safe_resolve(&vault, &dest_folder) else {
        return json!({ "ok": false, "error": "非法路径" });
    };
    if let Err(e) = std::fs::create_dir_all(&dir_abs) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = name
        .rfind('.')
        .map(|i| name[..i].to_string())
        .unwrap_or_else(|| name.clone());
    let ext = abs
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let abs_new = unique_path(&dir_abs, &stem, &ext);
    if let Err(e) = std::fs::rename(&abs, &abs_new) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    state.mark_self_write(&abs_new);
    let new_rel = abs_to_rel(&vault, &abs_new);
    {
        let mut cfg = state.config.lock().unwrap();
        if cfg.last_note.as_deref() == Some(rel.as_str()) {
            cfg.last_note = Some(new_rel.clone());
            drop(cfg);
            state.save_config();
        }
    }
    json!({ "ok": true, "rel": new_rel })
}

#[tauri::command(async)]
pub fn create_folder(state: State<AppState>, parent: String, name: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let parent_rel = if parent.is_empty() { NOTE_DIR } else { parent.as_str() };
    let Some(parent_abs) = safe_resolve(&vault, parent_rel) else {
        return json!({ "ok": false, "error": "非法路径" });
    };
    let clean = sanitize_name(&name);
    if clean.is_empty() {
        return json!({ "ok": false, "error": "名称不能为空" });
    }
    let abs = parent_abs.join(&clean);
    if let Err(e) = std::fs::create_dir_all(&abs) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    json!({ "ok": true, "rel": abs_to_rel(&vault, &abs) })
}

/* ====================================================================
 * 应用内回收站（vault 下 .trash/items/ + .trash/index.json）
 * ==================================================================== */

fn new_trash_id() -> String {
    let seq = TRASH_SEQ.fetch_add(1, Ordering::Relaxed) & 0xffff;
    format!("{:x}{seq:04x}", now_ms())
}

fn trash_items_dir(vault: &Path) -> PathBuf {
    vault.join(TRASH_DIR_REL).join("items")
}

fn read_trash_index(vault: &Path) -> Vec<Value> {
    let p = match safe_resolve(vault, TRASH_INDEX_REL) {
        Some(p) => p,
        None => return Vec::new(),
    };
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("items").and_then(|i| i.as_array()).cloned())
        .unwrap_or_default()
}

fn write_trash_index(state: &State<AppState>, vault: &Path, items: Vec<Value>) {
    let Some(p) = safe_resolve(vault, TRASH_INDEX_REL) else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(&json!({ "items": items })) {
        if std::fs::write(&p, s).is_ok() {
            state.mark_self_write(&p);
        }
    }
}

fn move_to_trash(state: &State<AppState>, vault: &Path, rel: &str, ty: &str) -> Value {
    let Some(abs) = safe_resolve(vault, rel) else {
        return json!({ "ok": false, "error": "文件不存在" });
    };
    if !abs.exists() {
        return json!({ "ok": false, "error": "文件不存在" });
    }
    let id = new_trash_id();
    let items_dir = trash_items_dir(vault);
    if let Err(e) = std::fs::create_dir_all(&items_dir) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    let ext = abs
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let store = if ty == "dir" { id.clone() } else { format!("{id}{ext}") };
    if let Err(e) = std::fs::rename(&abs, items_dir.join(&store)) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let deleted_at = Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let mut items = read_trash_index(vault);
    items.push(json!({
        "id": id, "name": name, "origRel": rel,
        "deletedAt": deleted_at, "type": ty, "store": store,
    }));
    write_trash_index(state, vault, items);
    json!({ "ok": true, "trashId": id })
}

#[tauri::command(async)]
pub fn trash_note(state: State<AppState>, rel: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let r = move_to_trash(&state, &vault, &rel, "file");
    if r["ok"] == json!(true) {
        let mut cfg = state.config.lock().unwrap();
        if cfg.last_note.as_deref() == Some(rel.as_str()) {
            cfg.last_note = None;
            drop(cfg);
            state.save_config();
        }
    }
    r
}

#[tauri::command(async)]
pub fn trash_folder(state: State<AppState>, rel: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let Some(abs) = safe_resolve(&vault, &rel) else {
        return json!({ "ok": false, "error": "非法路径" });
    };
    if !abs.is_dir() || abs == vault {
        return json!({ "ok": false, "error": "非法路径" });
    }
    move_to_trash(&state, &vault, &rel, "dir")
}

#[tauri::command(async)]
pub fn trash_list(state: State<AppState>) -> Value {
    let Some(vault) = vault_of(&state) else { return json!([]) };
    let items_dir = trash_items_dir(&vault);
    let mut items: Vec<Value> = read_trash_index(&vault)
        .into_iter()
        .filter(|it| {
            let store = it["store"].as_str().unwrap_or("");
            items_dir.join(store).exists()
        })
        .map(|it| {
            json!({
                "id": it["id"], "name": it["name"], "origRel": it["origRel"],
                "deletedAt": it["deletedAt"], "type": it["type"],
            })
        })
        .collect();
    items.sort_by(|a, b| {
        let ka = a["deletedAt"].as_str().unwrap_or("");
        let kb = b["deletedAt"].as_str().unwrap_or("");
        kb.cmp(ka)
    });
    json!(items)
}

#[tauri::command(async)]
pub fn trash_restore(state: State<AppState>, id: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let mut items = read_trash_index(&vault);
    let pos = items.iter().position(|it| it["id"].as_str() == Some(id.as_str()));
    let Some(pos) = pos else {
        return json!({ "ok": false, "error": "记录不存在" });
    };
    let it = items[pos].clone();
    let store = it["store"].as_str().unwrap_or("");
    let store_abs = trash_items_dir(&vault).join(store);
    if !store_abs.exists() {
        return json!({ "ok": false, "error": "内容已丢失" });
    }
    let orig_rel = it["origRel"].as_str().unwrap_or("");
    let Some(target) = safe_resolve(&vault, orig_rel) else {
        return json!({ "ok": false, "error": "原始路径非法" });
    };
    let mut final_target = target.clone();
    if final_target.exists() {
        let ty = it["type"].as_str().unwrap_or("file");
        let ext = if ty == "dir" {
            String::new()
        } else {
            target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default()
        };
        let base = if ty == "dir" {
            target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            let full = target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match full.rsplit_once('.') {
                Some((stem, _)) if !stem.is_empty() => stem.to_string(),
                _ => full,
            }
        };
        let mut n = 2;
        loop {
            final_target = target.parent().unwrap_or(&vault).join(format!("{base} ({n}){ext}"));
            if !final_target.exists() {
                break;
            }
            n += 1;
        }
    }
    if let Some(parent) = final_target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::rename(&store_abs, &final_target) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    items.remove(pos);
    write_trash_index(&state, &vault, items);
    json!({ "ok": true, "rel": abs_to_rel(&vault, &final_target) })
}

#[tauri::command(async)]
pub fn trash_purge(state: State<AppState>, id: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let mut items = read_trash_index(&vault);
    let pos = items.iter().position(|it| it["id"].as_str() == Some(id.as_str()));
    let Some(pos) = pos else {
        return json!({ "ok": false, "error": "记录不存在" });
    };
    let store = items[pos]["store"].as_str().unwrap_or("");
    let store_abs = trash_items_dir(&vault).join(store);
    let _ = std::fs::remove_dir_all(&store_abs).or_else(|_| std::fs::remove_file(&store_abs));
    items.remove(pos);
    write_trash_index(&state, &vault, items);
    json!({ "ok": true })
}

#[tauri::command(async)]
pub fn trash_empty(state: State<AppState>) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let items_dir = trash_items_dir(&vault);
    for it in read_trash_index(&vault) {
        let store = it["store"].as_str().unwrap_or("");
        let store_abs = items_dir.join(store);
        let _ = std::fs::remove_dir_all(&store_abs).or_else(|_| std::fs::remove_file(&store_abs));
    }
    write_trash_index(&state, &vault, Vec::new());
    json!({ "ok": true })
}

/* ====================================================================
 * 搜索
 * ==================================================================== */

#[tauri::command(async)]
pub fn search(state: State<AppState>, q: String) -> Value {
    let Some(vault) = vault_of(&state) else { return json!([]) };
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return json!([]);
    }
    let files: Vec<ScanFile> = scan_vault(&vault).into_iter().filter(|f| f.md).collect();
    let mut results: Vec<Value> = Vec::new();
    'outer: for f in files {
        let Some(abs) = safe_resolve(&vault, &f.rel) else { continue };
        let content = match std::fs::read(&abs) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => continue,
        };
        let mut hits = 0;
        for (i, line) in content.split('\n').enumerate() {
            if !line.to_lowercase().contains(&q) {
                continue;
            }
            hits += 1;
            if results.len() < 300 && hits <= 5 {
                results.push(json!({
                    "rel": f.rel, "name": f.name,
                    "line": i + 1,
                    "text": truncate_chars(line.trim(), 200),
                }));
                if results.len() >= 300 {
                    break 'outer;
                }
            }
        }
    }
    json!(results)
}

#[tauri::command(async)]
pub fn backlinks(state: State<AppState>, title: String) -> Value {
    let Some(vault) = vault_of(&state) else { return json!([]) };
    let t = title.trim().to_lowercase();
    if t.is_empty() {
        return json!([]);
    }
    let needle1 = format!("[[{t}]]");
    let needle2 = format!("[[{t}|");
    let files: Vec<ScanFile> = scan_vault(&vault).into_iter().filter(|f| f.md).collect();
    let mut results: Vec<Value> = Vec::new();
    for f in files {
        let Some(abs) = safe_resolve(&vault, &f.rel) else { continue };
        let content = match std::fs::read(&abs) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => continue,
        };
        for (i, line) in content.split('\n').enumerate() {
            let low = line.to_lowercase();
            if !low.contains(&needle1) && !low.contains(&needle2) {
                continue;
            }
            results.push(json!({
                "rel": f.rel, "name": f.name,
                "line": i + 1,
                "text": truncate_chars(line.trim(), 200),
            }));
            break; // 每个文件只列一条
        }
    }
    json!(results)
}

#[tauri::command(async)]
pub fn scheduled_tasks(state: State<AppState>, date_str: String) -> Value {
    let Some(vault) = vault_of(&state) else { return json!([]) };
    if date_str.is_empty() {
        return json!([]);
    }
    let cal_prefix = format!("{CAL_DIR}/");
    let files: Vec<ScanFile> = scan_vault(&vault)
        .into_iter()
        .filter(|f| f.md && !f.rel.starts_with(&cal_prefix)) // 每日本身不重复抓取
        .collect();
    let mut out: Vec<Value> = Vec::new();
    for f in files {
        let Some(abs) = safe_resolve(&vault, &f.rel) else { continue };
        let content = match std::fs::read(&abs) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => continue,
        };
        for (i, line) in content.split('\n').enumerate() {
            let t = line.trim();
            if !t.contains('>') {
                continue;
            }
            let Some(p) = parse_task_line(t) else { continue };
            // 连续任务：日期落在区间内即算覆盖；普通任务：排期日等于该日
            let covers = match (&p.scheduled, &p.end_date) {
                (Some(s), Some(e)) => s.as_str() <= date_str.as_str() && date_str.as_str() <= e.as_str(),
                (Some(s), None) => s.as_str() == date_str.as_str(),
                _ => false,
            };
            if !covers {
                continue;
            }
            out.push(json!({
                "rel": f.rel, "name": f.name,
                "line": i + 1,
                "text": truncate_chars(t, 240),
                "done": p.done,
                "endDate": p.end_date,
            }));
        }
    }
    json!(out)
}

/* ====================================================================
 * 标签 / 提及
 * ==================================================================== */

#[tauri::command(async)]
pub fn list_tags(state: State<AppState>) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "tags": [], "mentions": [] });
    };
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut mention_counts: HashMap<String, usize> = HashMap::new();
    let not_mentions: HashSet<String> = ["done", "due", "captured", "reviewed", "start", "repeat"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let files: Vec<ScanFile> = scan_vault(&vault).into_iter().filter(|f| f.md).collect();
    for f in files {
        let Some(abs) = safe_resolve(&vault, &f.rel) else { continue };
        let content = match std::fs::read(&abs) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => continue,
        };
        for raw in content.split('\n') {
            let line = raw.trim_end_matches('\r');
            if line.trim_start().starts_with('#') {
                continue; // 跳过标题行
            }
            for token in line.split([' ', '\u{3000}']) {
                if token.contains('`') {
                    continue; // 行内代码里的 # 不算标签
                }
                if let Some(rest) = token.strip_prefix('#') {
                    let tag = rest.trim_end_matches(['.', ',', '!', '?', ';', ':', '，', '。', '！', '？', '；', '：']);
                    if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) {
                        *counts.entry(tag.to_string()).or_default() += 1;
                    }
                }
                if let Some(rest) = token.strip_prefix('@') {
                    let name = rest.trim_end_matches([
                        '.', ',', '!', '?', ';', ':', '，', '。', '！', '？', '；', '：', '（', '）', '(', ')',
                    ]);
                    if !name.is_empty()
                        && !not_mentions.contains(&name.to_lowercase())
                        && !name.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
                    {
                        *mention_counts.entry(name.to_string()).or_default() += 1;
                    }
                }
            }
        }
    }
    let mut tags: Vec<(String, usize)> = counts.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let tags: Vec<Value> = tags
        .into_iter()
        .take(60)
        .map(|(tag, count)| json!({ "tag": tag, "count": count }))
        .collect();
    let mut mentions: Vec<(String, usize)> = mention_counts.into_iter().collect();
    mentions.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mentions: Vec<Value> = mentions
        .into_iter()
        .take(40)
        .map(|(name, count)| json!({ "name": name, "count": count }))
        .collect();
    json!({ "tags": tags, "mentions": mentions })
}

/* ====================================================================
 * 任务总览 / 排期 / 循环任务
 * ==================================================================== */

#[tauri::command(async)]
pub fn tasks_all(state: State<AppState>) -> Value {
    let Some(vault) = vault_of(&state) else { return json!([]) };
    let files: Vec<ScanFile> = scan_vault(&vault).into_iter().filter(|f| f.md).collect();
    let mut out: Vec<Value> = Vec::new();
    for f in files {
        let Some(abs) = safe_resolve(&vault, &f.rel) else { continue };
        let content = match std::fs::read(&abs) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => continue,
        };
        let title = read_head(&abs)
            .ok()
            .and_then(|h| extract_title(&h))
            .unwrap_or_else(|| strip_md_ext(&f.name));
        for (i, line) in content.split('\n').enumerate() {
            if !RE_LIST_START.is_match(line) {
                continue;
            }
            let trimmed = line.trim();
            let Some(p) = parse_task_line(trimmed) else { continue };
            out.push(json!({
                "rel": f.rel, "name": f.name, "title": title,
                "line": i + 1,
                "text": truncate_chars(trimmed, 240),
                "done": p.done,
                "doneDate": p.done_date,
                "scheduled": p.scheduled,
                "endDate": p.end_date,
                "start": p.start,
                "end": p.end,
                "recurring": p.recurring,
            }));
        }
    }
    json!(out)
}

#[tauri::command(async)]
pub fn reschedule_task(state: State<AppState>, rel: String, line: i64, new_date: String, time: Option<Value>) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    let Some(abs) = safe_resolve(&vault, &rel) else {
        return json!({ "ok": false, "error": "参数错误" });
    };
    if !RE_DATE_STR.is_match(&new_date) {
        return json!({ "ok": false, "error": "参数错误" });
    }
    let content = match std::fs::read_to_string(&abs) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    let mut lines: Vec<String> = content.split('\n').map(String::from).collect();
    let idx = line - 1;
    if idx < 0 || idx as usize >= lines.len() {
        return json!({ "ok": false, "error": "行号越界" });
    }
    let idx = idx as usize;
    if parse_task_line(&lines[idx]).is_none() {
        return json!({ "ok": false, "error": "该行不是任务" });
    }
    let mut l = lines[idx].clone();
    if let Some(rc) = RE_SCHEDULE_RANGE.captures(&l) {
        // 连续任务：改期时整个区间平移
        let new_date_str = format!(">{new_date}");
        if rc[1] != new_date {
            let old_start = parse_iso_date(&rc[1]);
            let old_end = parse_iso_date(&rc[2]);
            let new_start = parse_iso_date(&new_date);
            let shifted_end = match (old_start, old_end, new_start) {
                (Some(os), Some(oe), Some(ns)) => Some(oe + (ns - os)),
                _ => None,
            };
            let replacement = match shifted_end {
                Some(e) => format!(">{new_date} ~ {e}"),
                None => new_date_str.clone(),
            };
            l = RE_SCHEDULE_RANGE.replace(&l, replacement.as_str()).into_owned();
        }
    } else if RE_SCHEDULE_IN.is_match(&l) {
        l = RE_SCHEDULE_IN.replace(&l, format!(">{new_date}").as_str()).into_owned();
    } else {
        l = format!("{} >{new_date}", l.trim_end());
    }
    if let Some(t) = &time {
        let start = t["start"].as_str().map(norm_hm);
        let end = t["end"].as_str().map(norm_hm);
        let clear = t["clear"] == json!(true);
        if let Some(s) = start {
            let e = end.unwrap_or_else(|| add_hour(&s));
            if RE_TIME_RANGE.is_match(&l) {
                l = RE_TIME_RANGE.replace(&l, format!("{s}-{e}").as_str()).into_owned();
            } else {
                l = format!("{} {s}-{e}", l.trim_end());
            }
        } else if clear {
            let re = regex::Regex::new(&format!(r"\s*{}", RE_TIME_RANGE.as_str())).unwrap();
            l = re.replace(&l, "").into_owned();
        }
    }
    lines[idx] = l;
    if let Err(e) = std::fs::write(&abs, lines.join("\n")) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    state.mark_self_write(&abs);
    json!({ "ok": true })
}

#[tauri::command(async)]
pub fn daily_append(state: State<AppState>, date_str: String, line_text: String) -> Value {
    let Some(vault) = vault_of(&state) else {
        return json!({ "ok": false, "error": "未设置笔记库" });
    };
    if !RE_DATE_STR.is_match(&date_str) {
        return json!({ "ok": false, "error": "日期格式错误" });
    }
    let rel = format!("{CAL_DIR}/{date_str}.md");
    let abs = match safe_resolve(&vault, &rel) {
        Some(a) => a,
        None => return json!({ "ok": false, "error": "非法路径" }),
    };
    if let Some(parent) = abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut content = if abs.exists() {
        match std::fs::read(&abs) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        }
    } else {
        format!("# {date_str}\n\n")
    };
    if !content.ends_with('\n') {
        content.push('\n');
    }
    let line: String = line_text
        .replace('\r', "")
        .replace('\n', " ")
        .chars()
        .take(400)
        .collect();
    content.push_str(&line);
    content.push('\n');
    if let Err(e) = std::fs::write(&abs, content.as_bytes()) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    state.mark_self_write(&abs);
    json!({ "ok": true, "rel": rel })
}

/* ====================================================================
 * 日历事件（ICS 订阅）
 * ==================================================================== */

static ICS_MEM_CACHE: LazyLock<std::sync::Mutex<HashMap<String, (Instant, String)>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn http_get_text(url: &str) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .build();
    match agent.get(url).call() {
        Ok(resp) => {
            use std::io::Read;
            let mut buf = String::new();
            resp.into_reader()
                .read_to_string(&mut buf)
                .map_err(|e| e.to_string())?;
            Ok(buf)
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

/// 支持 URL 订阅（30 分钟内存缓存）和本地 .ics 文件（绝对路径或笔记库相对路径）
fn fetch_ics_text(src: &str, vault: Option<&Path>) -> Result<String, String> {
    const REFRESH: Duration = Duration::from_secs(30 * 60);
    if src.starts_with("http://") || src.starts_with("https://") {
        {
            let cache = ICS_MEM_CACHE.lock().unwrap();
            if let Some((at, text)) = cache.get(src) {
                if at.elapsed() < REFRESH {
                    return Ok(text.clone());
                }
            }
        }
        match http_get_text(src) {
            Ok(text) => {
                ICS_MEM_CACHE
                    .lock()
                    .unwrap()
                    .insert(src.to_string(), (Instant::now(), text.clone()));
                Ok(text)
            }
            Err(e) => {
                // 网络失败时用旧缓存
                let cache = ICS_MEM_CACHE.lock().unwrap();
                if let Some((_, text)) = cache.get(src) {
                    return Ok(text.clone());
                }
                Err(e)
            }
        }
    } else {
        let abs = if Path::new(src).is_absolute() {
            PathBuf::from(src)
        } else {
            vault
                .and_then(|v| safe_resolve(v, src))
                .ok_or_else(|| "非法日历文件路径".to_string())?
        };
        let text = std::fs::read_to_string(abs).map_err(|e| e.to_string())?;
        ICS_MEM_CACHE
            .lock()
            .unwrap()
            .insert(src.to_string(), (Instant::now(), text.clone()));
        Ok(text)
    }
}

struct IcsEvent {
    start: DateTime<Local>,
    end: Option<DateTime<Local>>,
    all_day: bool,
    title: String,
    loc: String,
    rrule: Option<String>,
}

fn local_from_naive(naive: NaiveDateTime) -> Option<DateTime<Local>> {
    Local.from_local_datetime(&naive).single()
}

/// DTSTART 值 → 本地时间（VALUE=DATE 按当地零点；Z 结尾按 UTC 换算）
fn parse_ics_date(value: &str, params: &str) -> Option<DateTime<Local>> {
    let value = value.trim();
    let is_date = (params.to_uppercase().contains("VALUE=DATE") && value.len() == 8) || {
        value.len() == 8 && value.chars().all(|c| c.is_ascii_digit())
    };
    if is_date {
        let y: i32 = value[0..4].parse().ok()?;
        let mo: u32 = value[4..6].parse().ok()?;
        let d: u32 = value[6..8].parse().ok()?;
        return local_from_naive(NaiveDateTime::new(
            NaiveDate::from_ymd_opt(y, mo, d)?,
            chrono::NaiveTime::from_hms_opt(0, 0, 0)?,
        ));
    }
    static RE_DT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$").unwrap()
    });
    let m = RE_DT.captures(value)?;
    let y: i32 = m[1].parse().ok()?;
    let mo: u32 = m[2].parse().ok()?;
    let d: u32 = m[3].parse().ok()?;
    let h: u32 = m[4].parse().ok()?;
    let mi: u32 = m[5].parse().ok()?;
    let s: u32 = m[6].parse().ok()?;
    let naive = NaiveDateTime::new(
        NaiveDate::from_ymd_opt(y, mo, d)?,
        chrono::NaiveTime::from_hms_opt(h, mi, s)?,
    );
    let is_utc = m.get(7).map(|g| g.as_str()).unwrap_or("") == "Z";
    if is_utc {
        Some(Utc.from_utc_datetime(&naive).with_timezone(&Local))
    } else {
        local_from_naive(naive)
    }
}

/// ICS unfold：把折行（换行 + 空格/制表符开头的续行）合并回单行
fn unfold_ics(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut first = true;
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if !first && (line.starts_with(' ') || line.starts_with('\t')) {
            out.push_str(&line[1..]);
        } else {
            if !first {
                out.push('\n');
            }
            out.push_str(line);
        }
        first = false;
    }
    out
}

/// 解析 ICS 文本 → VEVENT 数组
fn parse_ics(text: &str) -> Vec<IcsEvent> {
    let unfolded = unfold_ics(text);
    // 逐块提取 BEGIN:VEVENT / END:VEVENT
    let mut events = Vec::new();
    for b in unfolded.split("BEGIN:VEVENT").skip(1) {
        let body = match b.split("END:VEVENT").next() {
            Some(x) if !x.is_empty() => x,
            _ => continue,
        };
        let mut props: HashMap<String, (String, String)> = HashMap::new();
        for line in body.split('\n') {
            let Some(ci) = line.find(':') else { continue };
            let head = &line[..ci];
            let value = line[ci + 1..].trim().to_string();
            let (name, params) = match head.find(';') {
                Some(si) => (&head[..si], head[si..].to_string()),
                None => (head, String::new()),
            };
            if !name.chars().all(|c| c.is_ascii_uppercase() || c == '-') || name.is_empty() {
                continue;
            }
            props.insert(name.to_string(), (params, value));
        }
        let Some((dt_params, dt_value)) = props.get("DTSTART") else { continue };
        let Some(start) = parse_ics_date(dt_value, dt_params) else { continue };
        let all_day = dt_params.to_uppercase().contains("VALUE=DATE")
            || (dt_value.len() == 8 && dt_value.chars().all(|c| c.is_ascii_digit()));
        let end = props
            .get("DTEND")
            .and_then(|(p, v)| parse_ics_date(v, p));
        let title = props
            .get("SUMMARY")
            .map(|(_, v)| {
                v.replace("\\,", ",")
                    .replace("\\n", " ")
                    .replace("\\N", " ")
            })
            .unwrap_or_else(|| "(无标题)".into());
        let loc = props
            .get("LOCATION")
            .map(|(_, v)| v.replace("\\,", ","))
            .unwrap_or_default();
        events.push(IcsEvent {
            start,
            end,
            all_day,
            title,
            loc,
            rrule: props.get("RRULE").map(|(_, v)| v.clone()),
        });
    }
    events
}

/// RRULE 基本展开：FREQ=DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL + COUNT + UNTIL
fn expand_rrule(ev: &IcsEvent, rrule: &str, range_start: DateTime<Local>, range_end: DateTime<Local>) -> Vec<(DateTime<Local>, Option<DateTime<Local>>)> {
    let mut parts: HashMap<String, String> = HashMap::new();
    for seg in rrule.split(';') {
        if let Some((k, v)) = seg.split_once('=') {
            parts.insert(k.to_uppercase(), v.to_string());
        }
    }
    let freq = parts.get("FREQ").map(|s| s.to_uppercase()).unwrap_or_default();
    if !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].contains(&freq.as_str()) {
        if ev.start >= range_start && ev.start <= range_end {
            return vec![(ev.start, ev.end)];
        }
        return Vec::new();
    }
    let interval: u32 = parts.get("INTERVAL").and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
    let count: usize = parts
        .get("COUNT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(366 * 2);
    let until = parts.get("UNTIL").and_then(|v| parse_ics_date(v, ""));

    let mut cur = ev.start;
    let mut made = Vec::new();
    for _ in 0..count {
        if made.len() >= 400 {
            break;
        }
        if let Some(u) = until {
            if cur > u {
                break;
            }
        }
        if cur > range_end {
            break;
        }
        if cur >= range_start {
            let end = ev.end.map(|e| e + (cur - ev.start));
            made.push((cur, end));
        }
        cur = match freq.as_str() {
            "DAILY" => cur + ChronoDuration::days(interval as i64),
            "WEEKLY" => cur + ChronoDuration::weeks(interval as i64),
            "MONTHLY" => {
                let d = cur.date_naive().checked_add_months(Months::new(interval));
                match d.and_then(|nd| local_from_naive(NaiveDateTime::new(nd, cur.time()))) {
                    Some(t) => t,
                    None => break,
                }
            }
            _ => {
                let d = cur.date_naive().checked_add_months(Months::new(12 * interval));
                match d.and_then(|nd| local_from_naive(NaiveDateTime::new(nd, cur.time()))) {
                    Some(t) => t,
                    None => break,
                }
            }
        };
    }
    made
}

fn parse_range_date(s: &str) -> Option<DateTime<Local>> {
    if !RE_DATE_STR.is_match(s) {
        return None;
    }
    let parts: Vec<i32> = s.split('-').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 {
        return None;
    }
    local_from_naive(NaiveDateTime::new(
        NaiveDate::from_ymd_opt(parts[0], parts[1] as u32, parts[2] as u32)?,
        chrono::NaiveTime::from_hms_opt(0, 0, 0)?,
    ))
}

#[tauri::command(async)]
pub fn cal_events(state: State<AppState>, range_start: String, range_end: String) -> Value {
    let cfg = state.config.lock().unwrap().clone();
    let calendars = cfg.calendars.as_array().cloned().unwrap_or_default();
    if calendars.is_empty() {
        return json!([]);
    }
    let Some(range_start) = parse_range_date(&range_start) else { return json!([]) };
    let Some(range_end) = parse_range_date(&range_end) else { return json!([]) };
    let vault = vault_of(&state);

    let mut out: Vec<Value> = Vec::new();
    for (i, cal) in calendars.iter().enumerate() {
        let src = match cal {
            Value::String(s) => s.clone(),
            v => v["src"].as_str().unwrap_or("").to_string(),
        };
        if src.is_empty() {
            continue;
        }
        let text = match fetch_ics_text(&src, vault.as_deref()) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("日历源读取失败: {src} {e}");
                continue;
            }
        };
        for ev in parse_ics(&text) {
            let list = match &ev.rrule {
                Some(rr) => expand_rrule(&ev, rr, range_start, range_end),
                None => {
                    if ev.start >= range_start && ev.start <= range_end {
                        vec![(ev.start, ev.end)]
                    } else {
                        Vec::new()
                    }
                }
            };
            for (start, end) in list {
                out.push(json!({
                    "date": start.format("%Y-%m-%d").to_string(),
                    "startHM": if ev.all_day { None } else { Some(start.format("%H:%M").to_string()) },
                    "endHM": if end.is_some() && !ev.all_day {
                        Some(end.unwrap().format("%H:%M").to_string())
                    } else {
                        None
                    },
                    "allDay": ev.all_day,
                    "title": ev.title,
                    "loc": ev.loc,
                    "cal": i,
                }));
            }
        }
    }
    json!(out)
}

/* ====================================================================
 * 系统
 * ==================================================================== */

#[tauri::command(async)]
pub fn open_path(state: State<AppState>, rel: String) -> Value {
    let Some(vault) = vault_of(&state) else { return json!(false) };
    let Some(abs) = safe_resolve(&vault, &rel) else { return json!(false) };
    match std::process::Command::new("explorer").arg(&abs).spawn() {
        Ok(_) => json!(true),
        Err(_) => json!(false),
    }
}

#[tauri::command(async)]
pub fn show_in_folder(state: State<AppState>) -> Value {
    if let Some(vault) = vault_of(&state) {
        let _ = std::process::Command::new("explorer").arg(&vault).spawn();
    }
    json!(null)
}

#[tauri::command(async)]
pub fn open_external(url: String) -> Value {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = std::process::Command::new("explorer").arg(&url).spawn();
    }
    json!(null)
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// 关窗放行标记：渲染进程确认「保存/放弃」后置位，CloseRequested 直接放行
pub static FORCE_CLOSE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn close_window(app: AppHandle) {
    FORCE_CLOSE.store(true, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }
}

/* ====================================================================
 * 示例笔记库（与 Electron 版一致）
 * ==================================================================== */

pub fn today_str() -> String {
    let now = Local::now();
    format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day())
}

fn create_sample_vault(root: &Path) {
    let _ = std::fs::create_dir_all(root.join(NOTE_DIR));
    let _ = std::fs::create_dir_all(root.join(CAL_DIR));
    let _ = std::fs::write(root.join(NOTE_DIR).join("欢迎使用 NotePlan for Windows.md"), SAMPLE_WELCOME);
    let _ = std::fs::write(root.join(NOTE_DIR).join("使用技巧.md"), SAMPLE_TIPS);
    let proj_dir = root.join(NOTE_DIR).join("项目");
    let _ = std::fs::create_dir_all(&proj_dir);
    let _ = std::fs::write(proj_dir.join("示例项目：整理书房.md"), SAMPLE_PROJECT);
    let today = root.join(CAL_DIR).join(format!("{}.md", today_str()));
    if !today.exists() {
        let _ = std::fs::write(&today, format!("# {}\n\n", today_str()));
    }
}

const SAMPLE_WELCOME: &str = r#"# 欢迎使用 NotePlan for Windows

这是一款受 [NotePlan](https://noteplan.co) 启发的桌面笔记应用。你的所有笔记都是**磁盘上的纯 Markdown 文件**，随时可以用其它编辑器打开，也方便放入 OneDrive / Dropbox / Git 等同步盘。

## 核心概念

- **每日笔记**：侧边栏的日历里，每一天都有一篇笔记，用来记录当天的事项。
- **普通笔记**：存放在 `Notes` 文件夹（支持子文件夹）。
- **双向链接**：输入 `[[笔记标题]]` 即可链接到另一篇笔记，右侧"反向链接"面板会显示谁引用了它。
- **任务**：用 `- [ ] 待办事项` 创建任务，点击预览中的复选框即可打钩。

## 试试这些语法（在预览中查看效果）

- [ ] 这是一个未完成任务，可以安排到某天：>2026-09-01
- [x] 这是一个已完成任务
- 这是一个普通列表项，包含一个标签 #示例 和一次提及 @我自己
- 用 `[[欢迎使用 NotePlan for Windows]]` 链接回本篇
- ==高亮文本==、**加粗**、*斜体*、`行内代码`、~~删除线~~

> 引用块：笔记的最终目的是行动。

```js
// 代码块
console.log('Hello, NotePlan for Windows!');
```

## 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl+K | 命令面板 / 快速打开 |
| Ctrl+N | 新建笔记 |
| Ctrl+J | 打开今日笔记 |
| Ctrl+E | 切换 编辑 / 预览 / 分栏 |
| Ctrl+L | 勾选 / 取消当前行任务 |
| Ctrl+S | 立即保存（平时会自动保存） |
| Ctrl+Shift+F | 全库搜索 |

打开左侧 [[使用技巧]] 了解更多。
"#;

const SAMPLE_TIPS: &str = r#"# 使用技巧

## 每日笔记
- 按 `Ctrl+J` 或点击侧边栏日历中的日期，即可打开/创建当天的笔记。
- 在任意笔记里写 `>2026-09-01`（日期可变），这条任务就会出现在那一天的每日笔记预览的"来自其它笔记"区域。

## 任务管理
- 任务语法：`- [ ] 买东西`，完成后在预览中点复选框，或编辑器里按 `Ctrl+L`。
- 可以给任务加日期、标签：`- [ ] 交房租 >2026-10-01 #生活`。

## 双向链接
- `[[标题]]` 创建链接；标题不存在时，点击链接会自动创建那篇笔记。
- 每篇笔记右侧的"反向链接"面板列出所有引用它的位置。

## 文件即数据
- 笔记库就是一个普通文件夹，`Calendar` 里是每日笔记，`Notes` 里是普通笔记。
- 设置里可以随时更换笔记库位置；把文件夹放进同步盘即可多设备同步。

## 小贴士
- 命令面板 `Ctrl+K` 几乎能到达任何地方：搜笔记、执行命令。
- #标签 可以点击，点击后即进入全库搜索。
"#;

const SAMPLE_PROJECT: &str = r#"# 示例项目：整理书房

状态：进行中 #项目

## 待办

- [ ] 清点书架上的书 >2026-09-05
- [ ] 处理不要的书（二手出售 / 捐赠）
- [ ] 买两个收纳盒 #购物
- [x] 拍照记录整理前的样子

## 想法

- 参考 [[使用技巧]] 里的任务语法，把截止日期写在任务后面。

相关每日笔记：[[2026-09-01]]
"#;
