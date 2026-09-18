using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace NotePlanWpf;

/* ==========================================================================
   文件库 / 设置 / 搜索 / 任务 —— main.js（Electron 主进程）的 C# 移植。
   各方法返回的对象形状与 Electron 版逐字段对齐，渲染层无需区分。
   ========================================================================== */

public static partial class AppServices
{
    private const string CalDir = "Calendar";
    private const string NoteDir = "Notes";

    public static string VaultPath { get; private set; }

    /// <summary>启动时从设置恢复笔记库（等价 Electron 版启动时的 setVault 恢复）。</summary>
    public static void RestoreVaultFromSettings()
    {
        var vp = Settings["vaultPath"] as string;
        if (!string.IsNullOrEmpty(vp) && Directory.Exists(vp))
            VaultPath = Path.GetFullPath(vp);
    }

    private static readonly Dictionary<string, long> SelfWrites = new();
    private static readonly object SelfWriteLock = new();

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /* ---------------- 设置 ---------------- */

    public static Dictionary<string, object> Settings { get; private set; } = new()
    {
        ["vaultPath"] = null,
        ["theme"] = "auto",
        ["lastNote"] = null,
        ["sidebarView"] = "calendar",
        ["calendars"] = new List<object>(),
    };

    private static string SettingsFile =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NotePlanWpf", "config.json");

    public static void LoadSettings()
    {
        try
        {
            if (!File.Exists(SettingsFile)) return;
            var loaded = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(SettingsFile));
            foreach (var (k, v) in loaded)
            {
                if (!Settings.ContainsKey(k)) continue;
                Settings[k] = v.ValueKind switch
                {
                    JsonValueKind.String => v.GetString(),
                    JsonValueKind.Number => v.GetDouble(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Array => JsonSerializer.Deserialize<List<object>>(v.GetRawText()),
                    JsonValueKind.Null => null,
                    _ => v.GetRawText(),
                };
            }
        }
        catch { /* 首次运行没有配置文件 */ }
        if (Settings["calendars"] is not List<object>) Settings["calendars"] = new List<object>();
    }

    public static void SaveSettings()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile)!);
        File.WriteAllText(SettingsFile, JsonSerializer.Serialize(Settings, JsonOpts));
    }

    public static Dictionary<string, object> GetSettings()
    {
        var vaultPath = Settings["vaultPath"] as string;
        var snapshot = new Dictionary<string, object>(Settings)
        {
            ["vaultExists"] = !string.IsNullOrEmpty(vaultPath) && Directory.Exists(vaultPath),
        };
        return snapshot;
    }

    public static Dictionary<string, object> ApplySettingsPatch(JsonElement patch)
    {
        foreach (var p in patch.EnumerateObject())
        {
            if (p.Name is "theme" or "lastNote" or "sidebarView" or "calendars")
                Settings[p.Name] = p.Value.ValueKind switch
                {
                    JsonValueKind.String => p.Value.GetString(),
                    JsonValueKind.Number => p.Value.GetDouble(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Array => JsonSerializer.Deserialize<List<object>>(p.Value.GetRawText()),
                    JsonValueKind.Null => null,
                    _ => p.Value.GetRawText(),
                };
        }
        SaveSettings();
        return GetSettings();
    }

    /* ---------------- 路径安全 ---------------- */

    public static string SafeResolve(string rel)
    {
        if (string.IsNullOrEmpty(VaultPath) || string.IsNullOrEmpty(rel)) return null;
        var root = Path.GetFullPath(VaultPath);
        var abs = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
        if (abs != root && !abs.StartsWith(root + Path.DirectorySeparatorChar)) return null;
        return abs;
    }

    private static string ToRel(string abs)
    {
        var rel = Path.GetRelativePath(VaultPath, abs);
        return rel.Replace(Path.DirectorySeparatorChar, '/');
    }

    public static bool IsMarkdown(string name) =>
        name.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ||
        name.EndsWith(".markdown", StringComparison.OrdinalIgnoreCase) ||
        name.EndsWith(".txt", StringComparison.OrdinalIgnoreCase);

    /* ---------------- 扫描 ---------------- */

    private static readonly HashSet<string> SkipNames = new(StringComparer.OrdinalIgnoreCase)
    { ".git", ".obsidian", ".trash", "node_modules", "$RECYCLE.BIN", "System Volume Information", ".DS_Store", "desktop.ini" };

    public static async Task<List<Dictionary<string, object>>> ScanVault()
    {
        var outList = new List<Dictionary<string, object>>();
        if (string.IsNullOrEmpty(VaultPath)) return outList;

        void Walk(string dir)
        {
            IEnumerable<DirectoryInfo> dirs = null;
            IEnumerable<FileInfo> files = null;
            var di = new DirectoryInfo(dir);
            try
            {
                dirs = di.EnumerateDirectories();
                files = di.EnumerateFiles();
            }
            catch { return; }

            foreach (var f in files)
            {
                if (f.Name.StartsWith('.') || SkipNames.Contains(f.Name)) continue;
                outList.Add(new Dictionary<string, object>
                {
                    ["rel"] = ToRel(f.FullName),
                    ["name"] = f.Name,
                    ["md"] = IsMarkdown(f.Name),
                    ["mtimeMs"] = ((DateTimeOffset)f.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                    ["size"] = f.Length,
                });
            }
            foreach (var d in dirs)
            {
                if (d.Name.StartsWith('.') || SkipNames.Contains(d.Name)) continue;
                Walk(d.FullName);
            }
        }

        Walk(VaultPath);
        outList.Sort((a, b) => string.Compare((string)a["rel"], (string)b["rel"], StringComparison.CurrentCulture));
        return outList;
    }

    private static async Task<string> ReadHeadAsync(string abs)
    {
        await using var fs = new FileStream(abs, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var buf = new byte[8192];
        var n = await fs.ReadAsync(buf);
        return System.Text.Encoding.UTF8.GetString(buf, 0, n);
    }

    private static string ExtractTitle(string head)
    {
        foreach (var rawLine in head.Split('\n'))
        {
            var t = rawLine.TrimEnd('\r').Trim();
            if (t.Length == 0) continue;
            var m = Regex.Match(t, @"^#\s+(.+)$");
            return m.Success ? m.Groups[1].Value.Trim() : null;
        }
        return null;
    }

    /// <summary>内容是否只有开头一个 # 标题行加空白（只是点开过、没写过内容的空笔记）。</summary>
    private static bool IsEmptyNote(string head)
    {
        var seenHeading = false;
        foreach (var rawLine in head.Split('\n'))
        {
            var t = rawLine.TrimEnd('\r').Trim();
            if (!seenHeading)
            {
                if (t.Length == 0) continue;
                if (t.StartsWith("# ") || t.StartsWith("#\t") || t == "#") { seenHeading = true; continue; }
                return false;
            }
            if (t.Length > 0) return false;
        }
        return true;
    }

    private static async Task<Dictionary<string, object>> NoteMetaAsync(ScanEntry f)
    {
        string title = null;
        var empty = false;
        if (f.Md)
        {
            try
            {
                var head = await ReadHeadAsync(SafeResolve(f.Rel));
                title = ExtractTitle(head);
                empty = IsEmptyNote(head);
            }
            catch { }
        }
        return new Dictionary<string, object>
        {
            ["rel"] = f.Rel, ["name"] = f.Name, ["md"] = f.Md,
            ["mtimeMs"] = f.MtimeMs, ["size"] = f.Size, ["title"] = title,
            ["empty"] = empty,
        };
    }

    public sealed record ScanEntry(string Rel, string Name, bool Md, long MtimeMs, long Size);

    public static async Task<List<ScanEntry>> ScanEntries()
    {
        var raw = await ScanVault();
        return raw.Select(n => new ScanEntry(
            (string)n["rel"], (string)n["name"], (bool)n["md"],
            (long)n["mtimeMs"], (long)n["size"])).ToList();
    }

    public static async Task<Dictionary<string, object>> ListNotes()
    {
        var entries = await ScanEntries();
        var notes = new List<Dictionary<string, object>>();
        foreach (var e in entries) notes.Add(await NoteMetaAsync(e));
        return new Dictionary<string, object> { ["vaultPath"] = VaultPath, ["notes"] = notes };
    }

    /* ---------------- 读 / 写 ---------------- */

    public static async Task<object> ReadNote(string rel)
    {
        var abs = SafeResolve(rel);
        if (abs == null) return new { ok = false, error = "非法路径" };
        try
        {
            var content = await File.ReadAllTextAsync(abs);
            var mtimeMs = ((DateTimeOffset)File.GetLastWriteTimeUtc(abs)).ToUnixTimeMilliseconds();
            return new { ok = true, content, mtimeMs };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    public static async Task<object> WriteNote(string rel, string content)
    {
        var abs = SafeResolve(rel);
        if (abs == null) return new { ok = false, error = "非法路径" };
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
            await File.WriteAllTextAsync(abs, content, new System.Text.UTF8Encoding(false));
            MarkSelfWrite(abs);
            var mtimeMs = ((DateTimeOffset)File.GetLastWriteTimeUtc(abs)).ToUnixTimeMilliseconds();
            return new { ok = true, mtimeMs };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private static void MarkSelfWrite(string abs)
    {
        lock (SelfWriteLock)
        {
            SelfWrites[Path.GetFullPath(abs)] = File.GetLastWriteTimeUtc(Path.GetFullPath(abs)).Ticks;
            if (SelfWrites.Count > 200)
            {
                var drop = SelfWrites.Keys.Take(SelfWrites.Count / 2).ToList();
                foreach (var k in drop) SelfWrites.Remove(k);
            }
        }
    }

    /// <summary>watcher 事件过滤：本应用自己的写入不触发变更事件。</summary>
    public static bool IsSelfWrite(string abs)
    {
        lock (SelfWriteLock)
        {
            var full = Path.GetFullPath(abs);
            if (!SelfWrites.TryGetValue(full, out var ticks)) return false;
            var now = File.GetLastWriteTimeUtc(full).Ticks;
            if (Math.Abs(now - ticks) < 200_000) // 20ms
                return true;
            SelfWrites.Remove(full);
            return false;
        }
    }

    /* ---------------- 文件名 ---------------- */

    private static string SanitizeName(string name)
    {
        var n = Regex.Replace(name ?? "", @"[\\/:*?""<>|]", " ");
        n = Regex.Replace(n, @"\s+", " ").Trim().TrimStart('.');
        return n.Length > 120 ? n[..120] : n;
    }

    private static string UniquePath(string dirAbs, string baseName, string ext)
    {
        var candidate = Path.Combine(dirAbs, baseName + ext);
        var i = 1;
        while (File.Exists(candidate))
        {
            i += 1;
            candidate = Path.Combine(dirAbs, $"{baseName} {i}{ext}");
        }
        return candidate;
    }

    /* ---------------- 笔记操作 ---------------- */

    public static async Task<object> CreateNote(string folder, string title, string content)
    {
        if (string.IsNullOrEmpty(VaultPath)) return new { ok = false, error = "未设置笔记库" };
        var clean = SanitizeName(title);
        if (clean.Length == 0) clean = "无标题笔记";
        var dirAbs = SafeResolve(string.IsNullOrEmpty(folder) ? NoteDir : folder);
        if (dirAbs == null) return new { ok = false, error = "非法文件夹" };
        try
        {
            Directory.CreateDirectory(dirAbs);
            var abs = UniquePath(dirAbs, clean, ".md");
            await File.WriteAllTextAsync(abs, content ?? $"# {clean}\n\n", new System.Text.UTF8Encoding(false));
            MarkSelfWrite(abs);
            return new { ok = true, rel = ToRel(abs) };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    public static async Task<object> OpenDaily(string dateStr)
    {
        if (string.IsNullOrEmpty(VaultPath)) return new { ok = false, error = "未设置笔记库" };
        if (!Regex.IsMatch(dateStr ?? "", @"^\d{4}-\d{2}-\d{2}$")) return new { ok = false, error = "日期格式错误" };
        var rel = $"{CalDir}/{dateStr}.md";
        var abs = SafeResolve(rel);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
            if (!File.Exists(abs))
            {
                await File.WriteAllTextAsync(abs, $"# {dateStr}\n\n", new System.Text.UTF8Encoding(false));
            }
            MarkSelfWrite(abs);
            return new { ok = true, rel };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    public static async Task<object> RenameNote(string rel, string newName)
    {
        var abs = SafeResolve(rel);
        if (abs == null) return new { ok = false, error = "非法路径" };
        var clean = SanitizeName(newName);
        if (clean.Length == 0) return new { ok = false, error = "名称不能为空" };
        var ext = Path.GetExtension(abs);
        if (ext.Length == 0) ext = ".md";
        var absNew = UniquePath(Path.GetDirectoryName(abs)!, clean, ext);
        try
        {
            File.Move(abs, absNew);
            MarkSelfWrite(absNew);
            if ((string)Settings["lastNote"] == rel)
            {
                Settings["lastNote"] = ToRel(absNew);
                SaveSettings();
            }
            return new { ok = true, rel = ToRel(absNew) };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    /* ---------------- 应用内回收站 ---------------- */

    private const string TrashIndexRel = ".trash/index.json";

    private static string? TrashIndexPath() => SafeResolve(TrashIndexRel);
    private static string TrashItemsDirAbs() => Path.Combine(VaultPath, ".trash", "items");

    private static List<Dictionary<string, object?>> ReadTrashIndex()
    {
        var p = TrashIndexPath();
        if (p == null || !File.Exists(p)) return new();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(p));
            var items = new List<Dictionary<string, object?>>();
            if (doc.RootElement.TryGetProperty("items", out var arr))
            {
                foreach (var it in arr.EnumerateArray())
                {
                    items.Add(new Dictionary<string, object?>
                    {
                        ["id"] = it.TryGetProperty("id", out var id) ? id.GetString() : null,
                        ["name"] = it.TryGetProperty("name", out var nm) ? nm.GetString() : null,
                        ["origRel"] = it.TryGetProperty("origRel", out var o) ? o.GetString() : null,
                        ["deletedAt"] = it.TryGetProperty("deletedAt", out var d) ? d.GetString() : null,
                        ["type"] = it.TryGetProperty("type", out var t) ? t.GetString() : "file",
                        ["store"] = it.TryGetProperty("store", out var st) ? st.GetString() : null,
                    });
                }
            }
            return items;
        }
        catch { return new(); }
    }

    private static async Task WriteTrashIndexAsync(List<Dictionary<string, object?>> items)
    {
        var p = TrashIndexPath();
        if (p == null) return;
        Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        await File.WriteAllTextAsync(p, JsonSerializer.Serialize(new { items }, JsonOpts));
        MarkSelfWrite(p);
    }

    private static async Task<Dictionary<string, object?>> MoveToTrash(string rel, string type)
    {
        if (string.IsNullOrEmpty(VaultPath)) return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "未设置笔记库" };
        var abs = SafeResolve(rel);
        if (abs == null || (!File.Exists(abs) && !Directory.Exists(abs)))
            return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "文件不存在" };
        var id = DateTime.UtcNow.Ticks.ToString("x") + Guid.NewGuid().ToString("N")[..4];
        var itemsDir = TrashItemsDirAbs();
        Directory.CreateDirectory(itemsDir);
        var storeName = type == "dir" ? id : id + Path.GetExtension(abs);
        var storeAbs = Path.Combine(itemsDir, storeName);
        if (type == "dir") Directory.Move(abs, storeAbs); else File.Move(abs, storeAbs);
        var items = ReadTrashIndex();
        items.Add(new Dictionary<string, object?>
        {
            ["id"] = id,
            ["name"] = Path.GetFileName(abs),
            ["origRel"] = rel,
            ["deletedAt"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss"),
            ["type"] = type,
            ["store"] = storeName,
        });
        await WriteTrashIndexAsync(items);
        return new Dictionary<string, object?> { ["ok"] = true, ["trashId"] = id };
    }

    public static async Task<object> TrashNote(string rel)
    {
        var r = await MoveToTrash(rel, "file");
        if (r.TryGetValue("ok", out var ok) && ok is true && (string)Settings["lastNote"] == rel)
        {
            Settings["lastNote"] = null;
            SaveSettings();
        }
        return r;
    }

    public static async Task<object> TrashList()
    {
        var items = ReadTrashIndex();
        var outList = new List<object>();
        var itemsDir = TrashItemsDirAbs();
        foreach (var it in items.OrderByDescending(x => x["deletedAt"] as string))
        {
            var store = it["store"] as string ?? "";
            var storeAbs = Path.Combine(itemsDir, store);
            if (!File.Exists(storeAbs) && !Directory.Exists(storeAbs)) continue;
            outList.Add(new
            {
                id = it["id"],
                name = it["name"],
                origRel = it["origRel"],
                deletedAt = it["deletedAt"],
                type = it["type"],
            });
        }
        return outList;
    }

    public static async Task<object> TrashRestore(string id)
    {
        var items = ReadTrashIndex();
        var it = items.FirstOrDefault(x => x["id"] as string == id);
        if (it == null) return new { ok = false, error = "记录不存在" };
        var storeAbs = Path.Combine(TrashItemsDirAbs(), it["store"] as string ?? "");
        if (!File.Exists(storeAbs) && !Directory.Exists(storeAbs)) return new { ok = false, error = "内容已丢失" };
        var origRel = it["origRel"] as string ?? "";
        var target = SafeResolve(origRel);
        if (target == null) return new { ok = false, error = "原始路径非法" };
        var finalTarget = target;
        if (File.Exists(finalTarget) || Directory.Exists(finalTarget))
        {
            var type = it["type"] as string ?? "file";
            var ext = type == "dir" ? "" : Path.GetExtension(finalTarget);
            var baseName = type == "dir" ? Path.GetFileName(finalTarget) : Path.GetFileNameWithoutExtension(finalTarget);
            var n = 2;
            do { finalTarget = Path.Combine(Path.GetDirectoryName(finalTarget)!, baseName + " (" + n + ")" + ext); n++; }
            while (File.Exists(finalTarget) || Directory.Exists(finalTarget));
        }
        Directory.CreateDirectory(Path.GetDirectoryName(finalTarget)!);
        if (Directory.Exists(storeAbs)) Directory.Move(storeAbs, finalTarget); else File.Move(storeAbs, finalTarget);
        items.Remove(it);
        await WriteTrashIndexAsync(items);
        return new { ok = true, rel = ToRel(finalTarget) };
    }

    public static async Task<object> TrashPurge(string id)
    {
        var items = ReadTrashIndex();
        var it = items.FirstOrDefault(x => x["id"] as string == id);
        if (it == null) return new { ok = false, error = "记录不存在" };
        var storeAbs = Path.Combine(TrashItemsDirAbs(), it["store"] as string ?? "");
        if (Directory.Exists(storeAbs)) Directory.Delete(storeAbs, true);
        else if (File.Exists(storeAbs)) File.Delete(storeAbs);
        items.Remove(it);
        await WriteTrashIndexAsync(items);
        return new { ok = true };
    }

    public static async Task<object> TrashEmpty()
    {
        var items = ReadTrashIndex();
        foreach (var it in items)
        {
            var storeAbs = Path.Combine(TrashItemsDirAbs(), it["store"] as string ?? "");
            if (Directory.Exists(storeAbs)) Directory.Delete(storeAbs, true);
            else if (File.Exists(storeAbs)) File.Delete(storeAbs);
        }
        await WriteTrashIndexAsync(new List<Dictionary<string, object?>>());
        return new { ok = true };
    }

    public static async Task<object> MoveNote(string rel, string destFolder)
    {
        var abs = SafeResolve(rel);
        var dirAbs = SafeResolve(destFolder);
        if (abs == null || dirAbs == null) return new { ok = false, error = "非法路径" };
        try
        {
            Directory.CreateDirectory(dirAbs);
            var absNew = UniquePath(dirAbs, Path.GetFileNameWithoutExtension(abs), Path.GetExtension(abs));
            File.Move(abs, absNew);
            MarkSelfWrite(absNew);
            if ((string)Settings["lastNote"] == rel)
            {
                Settings["lastNote"] = ToRel(absNew);
                SaveSettings();
            }
            return new { ok = true, rel = ToRel(absNew) };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    public static Task<object> CreateFolder(string parentRel, string name)
    {
        if (string.IsNullOrEmpty(VaultPath)) return Task.FromResult<object>(new { ok = false, error = "未设置笔记库" });
        var parent = SafeResolve(string.IsNullOrEmpty(parentRel) ? NoteDir : parentRel);
        if (parent == null) return Task.FromResult<object>(new { ok = false, error = "非法路径" });
        var clean = SanitizeName(name);
        if (clean.Length == 0) return Task.FromResult<object>(new { ok = false, error = "名称不能为空" });
        try
        {
            var abs = Path.Combine(parent, clean);
            Directory.CreateDirectory(abs);
            return Task.FromResult<object>(new { ok = true, rel = ToRel(abs) });
        }
        catch (Exception ex) { return Task.FromResult<object>(new { ok = false, error = ex.Message }); }
    }

    public static async Task<object> TrashFolder(string rel)
    {
        if (string.IsNullOrEmpty(VaultPath)) return new { ok = false, error = "未设置笔记库" };
        var abs = SafeResolve(rel);
        if (abs == null || !Directory.Exists(abs)) return new { ok = false, error = "目录不存在" };
        return await MoveToTrash(rel, "dir");
    }

    /* ---------------- 搜索 ---------------- */

    public static async Task<object> Search(string query)
    {
        var q = (query ?? "").Trim().ToLowerInvariant();
        if (q.Length == 0) return Array.Empty<object>();
        var files = (await ScanEntries()).Where(f => f.Md);
        var results = new List<object>();
        foreach (var f in files)
        {
            string content;
            try { content = await File.ReadAllTextAsync(SafeResolve(f.Rel)); } catch { continue; }
            var lines = content.Split('\n');
            int hits = 0;
            for (var i = 0; i < lines.Length; i++)
            {
                if (!lines[i].ToLowerInvariant().Contains(q)) continue;
                hits++;
                if (results.Count < 300 && hits <= 5)
                    results.Add(new { rel = f.Rel, name = f.Name, line = i + 1, text = lines[i].Trim()[..Math.Min(200, lines[i].Trim().Length)] });
            }
        }
        return results;
    }

    public static async Task<object> Backlinks(string title)
    {
        if (string.IsNullOrEmpty(VaultPath) || string.IsNullOrWhiteSpace(title)) return Array.Empty<object>();
        var t = title.Trim().ToLowerInvariant();
        var needle1 = $"[[{t}]]";
        var needle2 = $"[[{t}|";
        var files = (await ScanEntries()).Where(f => f.Md);
        var results = new List<object>();
        foreach (var f in files)
        {
            string content;
            try { content = await File.ReadAllTextAsync(SafeResolve(f.Rel)); } catch { continue; }
            var lines = content.Split('\n');
            for (var i = 0; i < lines.Length; i++)
            {
                var low = lines[i].ToLowerInvariant();
                if (!low.Contains(needle1) && !low.Contains(needle2)) continue;
                results.Add(new { rel = f.Rel, name = f.Name, line = i + 1, text = lines[i].Trim()[..Math.Min(200, lines[i].Trim().Length)] });
                break;
            }
        }
        return results;
    }

    /* ---------------- 任务解析 / 索引 ---------------- */

    [GeneratedRegex(@"^\s*[-*+]\s+\[([ xX])\]\s*(.*)$")]
    private static partial Regex ReTaskLine();

    [GeneratedRegex(@"\s*@done(?:\(([^)]*)\))?", RegexOptions.IgnoreCase)]
    private static partial Regex ReDoneTag();

    [GeneratedRegex(@">\s*(\d{4}-\d{2}-\d{2})")]
    private static partial Regex ReScheduleIn();

    // 连续任务：>起 ~ 止（分隔符支持 ~ – — 至 到）
    [GeneratedRegex(@">\s*(\d{4}-\d{2}-\d{2})\s*(?:~|–|—|至|到)\s*(\d{4}-\d{2}-\d{2})")]
    private static partial Regex ReScheduleRange();

    [GeneratedRegex(@"(\d{1,2}:\d{2})\s*(?:-|–|—|~|至|到)\s*(\d{1,2}:\d{2})")]
    private static partial Regex ReTimeRange();

    [GeneratedRegex(@"\b(?:every\s+(?:(\d+)\s+)?(day|week|month|year)s?)\b|\b每(?:天|日|周|星期|月|年)\b|\b每\s*(\d+)\s*(?:天|周|星期|月|年)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ReRecurrence();

    private static string NormHm(string s)
    {
        var parts = s.Split(':');
        return $"{int.Parse(parts[0]):00}:{int.Parse(parts[1]):00}";
    }

    private static string AddHour(string hm)
    {
        var parts = hm.Split(':').Select(int.Parse).ToArray();
        return $"{Math.Min(23, parts[0] + 1):00}:{parts[1]:00}";
    }

    private sealed record ParsedTask(bool Done, string DoneDate, string Scheduled, string EndDate, string Start, string End, bool Recurring, string Body);

    private static ParsedTask ParseTaskLine(string raw)
    {
        var m = ReTaskLine().Match(raw);
        if (!m.Success) return null;
        var text = m.Groups[2].Value;
        var doneDateM = ReDoneTag().Match(text);
        var rangeM = ReScheduleRange().Match(text);
        var schedM = rangeM.Success ? Match.Empty : ReScheduleIn().Match(text);
        var timeM = ReTimeRange().Match(text);
        var done = m.Groups[1].Value != " " || doneDateM.Success;
        return new ParsedTask(
            done,
            doneDateM.Success ? (doneDateM.Groups[1].Value.Length > 0 ? doneDateM.Groups[1].Value : null) : null,
            rangeM.Success ? rangeM.Groups[1].Value : (schedM.Success ? schedM.Groups[1].Value : null),
            rangeM.Success ? rangeM.Groups[2].Value : null,
            timeM.Success ? NormHm(timeM.Groups[1].Value) : null,
            timeM.Success ? NormHm(timeM.Groups[2].Value) : null,
            ReRecurrence().IsMatch(text),
            text);
    }

    public static async Task<object> TasksAll()
    {
        if (string.IsNullOrEmpty(VaultPath)) return Array.Empty<object>();
        var files = (await ScanEntries()).Where(f => f.Md);
        var outList = new List<object>();
        foreach (var f in files)
        {
            string content;
            try { content = await File.ReadAllTextAsync(SafeResolve(f.Rel)); } catch { continue; }
            var lines = content.Split('\n');
            string title = null;
            try { title = ExtractTitle(await ReadHeadAsync(SafeResolve(f.Rel))); } catch { }
            title ??= Regex.Replace(f.Name, @"\.(md|markdown|txt)$", "");
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i].TrimEnd('\r');
                var trimmed = line.Trim();
                if (trimmed.Length == 0 || !Regex.IsMatch(line, @"^\s*[-*+]\s+\[")) continue;
                var p = ParseTaskLine(trimmed);
                if (p == null) continue;
                outList.Add(new
                {
                    rel = f.Rel,
                    name = f.Name,
                    title,
                    line = i + 1,
                    text = trimmed.Length > 240 ? trimmed[..240] : trimmed,
                    done = p.Done,
                    doneDate = p.DoneDate,
                    scheduled = p.Scheduled,
                    endDate = p.EndDate,
                    start = p.Start,
                    end = p.End,
                    recurring = p.Recurring,
                });
            }
        }
        return outList;
    }

    public static async Task<object> ScheduledTasks(string dateStr)
    {
        if (string.IsNullOrEmpty(VaultPath) || string.IsNullOrEmpty(dateStr)) return Array.Empty<object>();
        var files = (await ScanEntries()).Where(f => f.Md && !f.Rel.StartsWith(CalDir + "/"));
        var outList = new List<object>();
        foreach (var f in files)
        {
            string content;
            try { content = await File.ReadAllTextAsync(SafeResolve(f.Rel)); } catch { continue; }
            var lines = content.Split('\n');
            for (var i = 0; i < lines.Length; i++)
            {
                var t = lines[i].Trim();
                if (!t.Contains('>')) continue;
                var p = ParseTaskLine(t);
                if (p == null) continue;
                // 连续任务：日期落在区间内即算覆盖；普通任务：排期日等于该日
                var covers = p.Scheduled != null && (p.EndDate == null
                    ? p.Scheduled == dateStr
                    : string.CompareOrdinal(p.Scheduled, dateStr) <= 0 && string.CompareOrdinal(dateStr, p.EndDate) <= 0);
                if (!covers) continue;
                outList.Add(new
                {
                    rel = f.Rel,
                    name = f.Name,
                    line = i + 1,
                    text = t.Length > 240 ? t[..240] : t,
                    done = p.Done,
                    endDate = p.EndDate,
                });
            }
        }
        return outList;
    }

    public static async Task<object> RescheduleTask(string rel, long line, string newDate, JsonElement? time)
    {
        var abs = SafeResolve(rel);
        if (abs == null || !Regex.IsMatch(newDate ?? "", @"^\d{4}-\d{2}-\d{2}$")) return new { ok = false, error = "参数错误" };
        try
        {
            var lines = (await File.ReadAllTextAsync(abs)).Split('\n');
            var idx = (int)line - 1;
            if (idx < 0 || idx >= lines.Length) return new { ok = false, error = "行号越界" };
            if (ParseTaskLine(lines[idx].Trim()) == null) return new { ok = false, error = "该行不是任务" };
            var l = lines[idx];
            var rangeM = ReScheduleRange().Match(l);
            if (rangeM.Success)
            {
                // 连续任务：改期时整个区间平移
                if (rangeM.Groups[1].Value != newDate)
                {
                    var os = DateTime.ParseExact(rangeM.Groups[1].Value, "yyyy-MM-dd", null);
                    var oe = DateTime.ParseExact(rangeM.Groups[2].Value, "yyyy-MM-dd", null);
                    var ns = DateTime.ParseExact(newDate, "yyyy-MM-dd", null);
                    var endStr = oe.AddDays((ns - os).TotalDays).ToString("yyyy-MM-dd");
                    l = ReScheduleRange().Replace(l, $">{newDate} ~ {endStr}");
                }
            }
            else if (ReScheduleIn().IsMatch(l)) l = ReScheduleIn().Replace(l, $">{newDate}");
            else l = l.TrimEnd() + $" >{newDate}";

            if (time.HasValue && time.Value.ValueKind == JsonValueKind.Object)
            {
                string start = null, end = null;
                var clear = false;
                if (time.Value.TryGetProperty("start", out var se) && se.ValueKind == JsonValueKind.String)
                {
                    start = NormHm(se.GetString());
                    if (time.Value.TryGetProperty("end", out var ee) && ee.ValueKind == JsonValueKind.String)
                        end = NormHm(ee.GetString());
                }
                if (time.Value.TryGetProperty("clear", out var ce) && ce.ValueKind == JsonValueKind.True)
                    clear = true;

                if (start != null)
                {
                    var e2 = end ?? AddHour(start);
                    if (ReTimeRange().IsMatch(l)) l = ReTimeRange().Replace(l, $"{start}-{e2}");
                    else l = l.TrimEnd() + $" {start}-{e2}";
                }
                else if (clear)
                {
                    l = Regex.Replace(l, @"\s*" + ReTimeRange().ToString(), "");
                }
            }
            lines[idx] = l;
            await File.WriteAllTextAsync(abs, string.Join('\n', lines), new System.Text.UTF8Encoding(false));
            MarkSelfWrite(abs);
            return new { ok = true };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    public static async Task<object> DailyAppend(string dateStr, string lineText)
    {
        if (string.IsNullOrEmpty(VaultPath)) return new { ok = false, error = "未设置笔记库" };
        if (!Regex.IsMatch(dateStr ?? "", @"^\d{4}-\d{2}-\d{2}$")) return new { ok = false, error = "日期格式错误" };
        var rel = $"{CalDir}/{dateStr}.md";
        var abs = SafeResolve(rel);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
            var content = File.Exists(abs) ? await File.ReadAllTextAsync(abs) : $"# {dateStr}\n\n";
            if (!content.EndsWith('\n')) content += '\n';
            var line = lineText.Replace("\r", "").Replace("\n", " ");
            content += (line.Length > 400 ? line[..400] : line) + "\n";
            await File.WriteAllTextAsync(abs, content, new System.Text.UTF8Encoding(false));
            MarkSelfWrite(abs);
            return new { ok = true, rel };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    /* ---------------- 标签 / 提及 ---------------- */

    public static async Task<object> ListTags()
    {
        if (string.IsNullOrEmpty(VaultPath)) return new { tags = Array.Empty<object>(), mentions = Array.Empty<object>() };
        var counts = new Dictionary<string, int>();
        var mentionCounts = new Dictionary<string, int>();
        var notMentions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "done", "due", "captured", "reviewed", "start", "repeat" };
        var files = (await ScanEntries()).Where(f => f.Md);
        foreach (var f in files)
        {
            string content;
            try { content = await File.ReadAllTextAsync(SafeResolve(f.Rel)); } catch { continue; }
            foreach (var raw in content.Split('\n'))
            {
                var line = raw.TrimEnd('\r');
                if (line.TrimStart().StartsWith('#')) continue;
                foreach (var token in line.Split(' ', (char)0x3000))
                {
                    if (token.Contains('`')) continue;
                    if (token.StartsWith('#'))
                    {
                        var tag = token[1..].TrimEnd('.', ',', '!', '?', ';', ':', '，', '。', '！', '？', '；', '：');
                        if (tag.Length > 0 && !Regex.IsMatch(tag, "^\\d+$"))
                            counts[tag] = counts.GetValueOrDefault(tag) + 1;
                    }
                    if (token.StartsWith('@'))
                    {
                        var name = token[1..].TrimEnd('.', ',', '!', '?', ';', ':', '，', '。', '！', '？', '；', '：', '（', '）', '(', ')');
                        if (name.Length > 0 && !notMentions.Contains(name) && !char.IsDigit(name[0]))
                            mentionCounts[name] = mentionCounts.GetValueOrDefault(name) + 1;
                    }
                }
            }
        }
        var tags = counts.OrderByDescending(kv => kv.Value).Take(60)
            .Select(kv => new { tag = kv.Key, count = kv.Value }).ToList();
        var mentions = mentionCounts.OrderByDescending(kv => kv.Value).Take(40)
            .Select(kv => new { name = kv.Key, count = kv.Value }).ToList();
        return new { tags, mentions };
    }

    /* ---------------- 示例笔记库 ---------------- */

    public static void CreateSampleVault(string root)
    {
        Directory.CreateDirectory(Path.Combine(root, NoteDir));
        Directory.CreateDirectory(Path.Combine(root, CalDir));
        File.WriteAllText(Path.Combine(root, NoteDir, "欢迎使用 NotePlan for Windows.md"), Samples.Welcome, new System.Text.UTF8Encoding(false));
        File.WriteAllText(Path.Combine(root, NoteDir, "使用技巧.md"), Samples.Tips, new System.Text.UTF8Encoding(false));
        var projDir = Path.Combine(root, NoteDir, "项目");
        Directory.CreateDirectory(projDir);
        File.WriteAllText(Path.Combine(projDir, "示例项目：整理书房.md"), Samples.Project, new System.Text.UTF8Encoding(false));
        var today = Path.Combine(root, CalDir, TodayStr() + ".md");
        if (!File.Exists(today))
            File.WriteAllText(today, $"# {TodayStr()}\n\n", new System.Text.UTF8Encoding(false));
    }

    public static string TodayStr()
    {
        var d = DateTime.Now;
        return $"{d.Year:0000}-{d.Month:00}-{d.Day:00}";
    }

    public static string DefaultVaultPath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "NotePlan 笔记库");

    public static async Task<object> OpenVault(string dirPath, bool createSampleIfEmpty)
    {
        try
        {
            Directory.CreateDirectory(dirPath);
            if (!Directory.Exists(dirPath)) return new { ok = false, error = "所选路径不是文件夹" };
            VaultPath = Path.GetFullPath(dirPath);
            Settings["vaultPath"] = VaultPath;
            Settings["lastNote"] = null;
            SaveSettings();
            if (createSampleIfEmpty) CreateSampleVault(VaultPath);
            return new { ok = true };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }
}

/* 示例内容（与 Electron 版一致） */
internal static class Samples
{
    public const string Welcome = @"# 欢迎使用 NotePlan for Windows

这是一款受 [NotePlan](https://noteplan.co) 启发的桌面笔记应用。你的所有笔记都是**磁盘上的纯 Markdown 文件**，随时可以用其它编辑器打开，也方便放入 OneDrive / Dropbox / Git 等同步盘。

## 核心概念

- **每日笔记**：侧边栏的日历里，每一天都有一篇笔记，用来记录当天的事项。
- **普通笔记**：存放在 `Notes` 文件夹（支持子文件夹）。
- **双向链接**：输入 `[[笔记标题]]` 即可链接到另一篇笔记，右侧""反向链接""面板会显示谁引用了它。
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
";

    public const string Tips = @"# 使用技巧

## 每日笔记
- 按 `Ctrl+J` 或点击侧边栏日历中的日期，即可打开/创建当天的笔记。
- 在任意笔记里写 `>2026-09-01`（日期可变），这条任务就会出现在那一天的每日笔记预览的""来自其它笔记""区域。

## 任务管理
- 任务语法：`- [ ] 买东西`，完成后在预览中点复选框，或编辑器里按 `Ctrl+L`。
- 可以给任务加日期、标签：`- [ ] 交房租 >2026-10-01 #生活`。

## 双向链接
- `[[标题]]` 创建链接；标题不存在时，点击链接会自动创建那篇笔记。
- 每篇笔记右侧的""反向链接""面板列出所有引用它的位置。

## 文件即数据
- 笔记库就是一个普通文件夹，`Calendar` 里是每日笔记，`Notes` 里是普通笔记。
- 设置里可以随时更换笔记库位置；把文件夹放进同步盘即可多设备同步。

## 小贴士
- 命令面板 `Ctrl+K` 几乎能到达任何地方：搜笔记、执行命令。
- #标签 可以点击，点击后即进入全库搜索。
";

    public const string Project = @"# 示例项目：整理书房

状态：进行中 #项目

## 待办

- [ ] 清点书架上的书 >2026-09-05
- [ ] 处理不要的书（二手出售 / 捐赠）
- [ ] 买两个收纳盒 #购物
- [x] 拍照记录整理前的样子

## 想法

- 参考 [[使用技巧]] 里的任务语法，把截止日期写在任务后面。

相关每日笔记：[[2026-09-01]]
";
}
