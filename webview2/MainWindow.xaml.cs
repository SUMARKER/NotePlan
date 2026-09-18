using System.IO;
using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace NotePlanWpf;

public partial class MainWindow : Window
{
    private FileSystemWatcher _watcher;
    private DispatcherTimer _watchDebounce;
    private bool _initialized;

    public MainWindow()
    {
        App.Log("ctor begin");
        InitializeComponent();
        App.Log("ctor done");
        Loaded += async (_s, _e) => await InitAsync();
        Closing += (_s, _e) => StopWatcher();
    }

    /* ---------------- 初始化 ---------------- */

    private async Task InitAsync()
    {
        if (_initialized) return;
        _initialized = true;
        App.Log("init start");

        AppServices.LoadSettings();
        AppServices.RestoreVaultFromSettings();
        App.Log("settings loaded, vault=" + AppServices.VaultPath);

        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NotePlanWpf", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, userData);
        App.Log("env created");
        await Web.EnsureCoreWebView2Async(env);
        App.Log("webview ready");

        var core = Web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;

        // vault:// 图片改走 https://vault.local/，由这里拦截并提供笔记库内文件
        core.AddWebResourceRequestedFilter("https://vault.local/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;

        // 页面内导航与弹窗一律转系统浏览器
        core.NavigationStarting += (_s, e) =>
        {
            if (!e.Uri.StartsWith(Environment.CurrentDirectory, StringComparison.OrdinalIgnoreCase) &&
                !e.Uri.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) { /* file 由本进程提供 */ }
            if (e.Uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                e.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                if (!e.Uri.StartsWith("https://vault.local/", StringComparison.OrdinalIgnoreCase))
                {
                    e.Cancel = true;
                    OpenExternal(e.Uri);
                }
            }
        };
        core.NewWindowRequested += (_s, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };

        core.WebMessageReceived += OnWebMessageReceived;

        ApplyThemeColorScheme();

        if (AppServices.GetSettings()["vaultExists"] is true)
        {
            StartWatcher(AppServices.VaultPath);
        }

        var indexHtml = Path.Combine(AppContext.BaseDirectory, "src", "index.html");
        App.Log("navigate: " + indexHtml + " exists=" + File.Exists(indexHtml));
        Web.Source = new Uri(indexHtml);
    }

    private void ApplyThemeColorScheme()
    {
        if (Web.CoreWebView2 == null) return;
        var theme = AppServices.Settings["theme"] as string ?? "auto";
        var dark = theme switch
        {
            "dark" => true,
            "light" => false,
            _ => IsSystemDark(),
        };
        try
        {
            Web.CoreWebView2.Profile.PreferredColorScheme = dark
                ? CoreWebView2PreferredColorScheme.Dark
                : CoreWebView2PreferredColorScheme.Light;
        }
        catch { /* 旧运行时无此 API */ }
    }

    private static bool IsSystemDark()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            var v = key?.GetValue("AppsUseLightTheme");
            if (v is int i) return i == 0;
        }
        catch { }
        return false;
    }

    /* ---------------- vault:// 文件服务 ---------------- */

    private static readonly Dictionary<string, string> MimeByExt = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif", [".webp"] = "image/webp", [".svg"] = "image/svg+xml",
        [".bmp"] = "image/bmp", [".ico"] = "image/x-icon",
        [".css"] = "text/css", [".js"] = "text/javascript", [".pdf"] = "application/pdf",
        [".md"] = "text/markdown", [".txt"] = "text/plain",
    };

    private void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = new Uri(e.Request.Uri);
        var rel = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
        var abs = AppServices.SafeResolve(rel);
        if (abs == null || !File.Exists(abs)) return;

        var ext = Path.GetExtension(abs);
        var mime = MimeByExt.GetValueOrDefault(ext, "application/octet-stream");
        try
        {
            var stream = new FileStream(abs, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            e.Response = Web.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK",
                $"Content-Type: {mime}\r\nCache-Control: no-cache");
        }
        catch { /* 文件被占用时返回 404 */ }
    }

    /* ---------------- 消息分发 ---------------- */

    private async void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(e.WebMessageAsJson); }
        catch { return; }
        using (doc)
        {
            var root = doc.RootElement;
            var fireForget = root.TryGetProperty("fireForget", out var ff) && ff.ValueKind == JsonValueKind.True;
            long id = -1;
            if (!fireForget && root.TryGetProperty("id", out var idEl)) id = idEl.GetInt64();

            string method = null;
            JsonElement args = default;
            var hasArgs = false;
            try
            {
                method = root.GetProperty("method").GetString();
                if (root.TryGetProperty("args", out args) && args.ValueKind == JsonValueKind.Array) hasArgs = true;
            }
            catch { }

            if (method == null) return;

            object result = null;
            string error = null;
            try
            {
                result = method switch
                {
                    "getSettings" => AppServices.GetSettings(),
                    "setSettings" => OnSetSettings(ArgEl(hasArgs, args, 0)),
                    "chooseVault" => ChooseVaultDialog(),
                    "openVault" => await OnOpenVault(ArgStr(hasArgs, args, 0), ArgBool(hasArgs, args, 1)),
                    "getVaultPath" => AppServices.VaultPath,
                    "listNotes" => await AppServices.ListNotes(),
                    "readNote" => await AppServices.ReadNote(ArgStr(hasArgs, args, 0)),
                    "writeNote" => await AppServices.WriteNote(ArgStr(hasArgs, args, 0), ArgStr(hasArgs, args, 1)),
                    "createNote" => await AppServices.CreateNote(ArgStr(hasArgs, args, 0), ArgStr(hasArgs, args, 1),
                        hasArgs && args.GetArrayLength() > 2 && args[2].ValueKind == JsonValueKind.String ? args[2].GetString() : null),
                    "openDaily" => await AppServices.OpenDaily(ArgStr(hasArgs, args, 0)),
                    "renameNote" => await AppServices.RenameNote(ArgStr(hasArgs, args, 0), ArgStr(hasArgs, args, 1)),
                    "trashNote" => await AppServices.TrashNote(ArgStr(hasArgs, args, 0)),
                    "moveNote" => await AppServices.MoveNote(ArgStr(hasArgs, args, 0), ArgStr(hasArgs, args, 1)),
                    "createFolder" => await AppServices.CreateFolder(ArgStr(hasArgs, args, 0), ArgStr(hasArgs, args, 1)),
                    "trashFolder" => await AppServices.TrashFolder(ArgStr(hasArgs, args, 0)),
                    "search" => await AppServices.Search(ArgStr(hasArgs, args, 0)),
                    "backlinks" => await AppServices.Backlinks(ArgStr(hasArgs, args, 0)),
                    "scheduledTasks" => await AppServices.ScheduledTasks(ArgStr(hasArgs, args, 0)),
                    "tasksAll" => await AppServices.TasksAll(),
                    "rescheduleTask" => await AppServices.RescheduleTask(ArgStr(hasArgs, args, 0), ArgLong(hasArgs, args, 1),
                        ArgStr(hasArgs, args, 2), ArgElOpt(hasArgs, args, 3)),
                    "dailyAppend" => await AppServices.DailyAppend(ArgStr(hasArgs, args, 0), ArgStr(hasArgs, args, 1)),
                    "trashList" => await AppServices.TrashList(),
                    "trashRestore" => await AppServices.TrashRestore(ArgStr(hasArgs, args, 0)),
                    "trashPurge" => await AppServices.TrashPurge(ArgStr(hasArgs, args, 0)),
                    "trashEmpty" => await AppServices.TrashEmpty(),
                    "listTags" => await AppServices.ListTags(),
                    "calEvents" => await CalEventsAsync(ArgStr(hasArgs, args, 0), ArgStr(hasArgs, args, 1)),
                    "openPath" => OpenPath(ArgStr(hasArgs, args, 0)),
                    "showInFolder" => ShowVaultFolder(),
                    "openExternal" => OpenExternal(ArgStr(hasArgs, args, 0)),
                    "defaultVaultPath" => AppServices.DefaultVaultPath(),
                    "quit" => Quit(),
                    _ => throw new NotImplementedException("未知方法: " + method),
                };
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }

            if (fireForget) return;
            if (error != null)
                Post(new { id, ok = false, error });
            else
                Post(new { id, ok = true, result });
        }
    }

    private void Post(object message)
    {
        var json = JsonSerializer.Serialize(message);
        Web.CoreWebView2.PostWebMessageAsJson(json);
    }

    private void SendEvent(string name, object data = null)
    {
        Post(new { @event = name, data });
    }

    private static string ArgStr(bool hasArgs, JsonElement args, int i) =>
        hasArgs && args.GetArrayLength() > i && args[i].ValueKind == JsonValueKind.String ? args[i].GetString() : null;

    private static long ArgLong(bool hasArgs, JsonElement args, int i) =>
        hasArgs && args.GetArrayLength() > i && args[i].ValueKind == JsonValueKind.Number ? args[i].GetInt64() : 0;

    private static bool ArgBool(bool hasArgs, JsonElement args, int i) =>
        hasArgs && args.GetArrayLength() > i && args[i].ValueKind == JsonValueKind.True;

    private static JsonElement? ArgElOpt(bool hasArgs, JsonElement args, int i) =>
        hasArgs && args.GetArrayLength() > i ? args[i] : null;

    private static JsonElement ArgEl(bool hasArgs, JsonElement args, int i) =>
        hasArgs && args.GetArrayLength() > i ? args[i] : default;

    /* ---------------- 具体动作 ---------------- */

    private object OnSetSettings(JsonElement patch)
    {
        var before = AppServices.Settings["theme"];
        var result = AppServices.ApplySettingsPatch(patch);
        if (!Equals(before, AppServices.Settings["theme"])) ApplyThemeColorScheme();
        return result;
    }

    private async Task<object> OnOpenVault(string dir, bool createSample)
    {
        var r = await AppServices.OpenVault(dir, createSample);
        if ((r as dynamic).ok == true) StartWatcher(AppServices.VaultPath);
        return r;
    }

    private string ChooseVaultDialog()
    {
        var dlg = new Microsoft.Win32.OpenFolderDialog
        {
            Title = "选择笔记库文件夹",
        };
        var vault = AppServices.VaultPath;
        if (!string.IsNullOrEmpty(vault) && Directory.Exists(vault))
            dlg.InitialDirectory = vault;
        else
            dlg.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        return dlg.ShowDialog(this) == true ? dlg.FolderName : null;
    }

    private async Task<object> CalEventsAsync(string rs, string re)
    {
        var calendars = AppServices.Settings["calendars"] as List<object> ?? [];
        var rangeStart = ParseDate(rs);
        var rangeEnd = ParseDate(re);
        if (rangeStart == null || rangeEnd == null) return Array.Empty<object>();
        rangeEnd = rangeEnd.Value.AddDays(1).AddTicks(-1);

        var outList = new List<object>();
        for (var i = 0; i < calendars.Count; i++)
        {
            var src = calendars[i] is JsonElement je && je.ValueKind == JsonValueKind.Object
                ? je.TryGetProperty("src", out var s) ? s.GetString() : null
                : calendars[i] as string;
            if (string.IsNullOrEmpty(src)) continue;
            try
            {
                var text = await IcsService.FetchTextAsync(src);
                foreach (var ev in IcsService.Parse(text))
                {
                    var list = ev.Rrule != null
                        ? IcsService.ExpandRrule(ev, ev.Rrule, rangeStart.Value, rangeEnd.Value)
                        : (ev.Start >= rangeStart && ev.Start <= rangeEnd ? [ev] : []);
                    foreach (var e in list)
                    {
                        outList.Add(new
                        {
                            date = e.Start.ToString("yyyy-MM-dd"),
                            startHM = e.AllDay ? null : e.Start.ToString("HH:mm"),
                            endHM = e.End != null && !e.AllDay ? e.End.Value.ToString("HH:mm") : null,
                            allDay = e.AllDay,
                            title = e.Title,
                            loc = e.Loc,
                            cal = i,
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("日历源读取失败: " + src + " " + ex.Message);
            }
        }
        return outList;

        static DateTime? ParseDate(string s)
        {
            if (s == null || !Regex.IsMatch(s, @"^\d{4}-\d{2}-\d{2}$")) return null;
            return DateTime.ParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
    }

    private object OpenPath(string rel)
    {
        var abs = AppServices.SafeResolve(rel);
        if (abs == null || !File.Exists(abs)) return false;
        try
        {
            Process.Start(new ProcessStartInfo(abs) { UseShellExecute = true });
            return true;
        }
        catch { return false; }
    }

    private object ShowVaultFolder()
    {
        if (!string.IsNullOrEmpty(AppServices.VaultPath))
            Process.Start(new ProcessStartInfo("explorer.exe") { Arguments = $"\"{AppServices.VaultPath}\"" });
        return null;
    }

    private object OpenExternal(string url)
    {
        if (!string.IsNullOrEmpty(url) && (url.StartsWith("http://") || url.StartsWith("https://")))
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        return null;
    }

    private object Quit()
    {
        Application.Current.Shutdown();
        return null;
    }

    /* ---------------- 文件监听 ---------------- */

    private void StartWatcher(string path)
    {
        StopWatcher();
        if (string.IsNullOrEmpty(path)) return;
        try
        {
            _watcher = new FileSystemWatcher(path)
            {
                IncludeSubdirectories = true,
                EnableRaisingEvents = true,
                InternalBufferSize = 64 * 1024,
            };
            _watcher.Changed += OnFsEvent;
            _watcher.Created += OnFsEvent;
            _watcher.Deleted += OnFsEvent;
            _watcher.Renamed += OnFsEvent;

            _watchDebounce = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
            _watchDebounce.Tick += (_s, _e) =>
            {
                _watchDebounce.Stop();
                SendEvent("vault:changed");
            };
        }
        catch { }
    }

    private void StopWatcher()
    {
        if (_watcher != null)
        {
            _watcher.EnableRaisingEvents = false;
            _watcher.Dispose();
            _watcher = null;
        }
        if (_watchDebounce != null)
        {
            _watchDebounce.Stop();
            _watchDebounce = null;
        }
    }

    private void OnFsEvent(object sender, FileSystemEventArgs e)
    {
        if (e.ChangeType == WatcherChangeTypes.Changed && AppServices.IsSelfWrite(e.FullPath)) return;
        if (e.ChangeType == WatcherChangeTypes.Renamed && e is RenamedEventArgs rn)
        {
            if (AppServices.IsSelfWrite(rn.OldFullPath) || AppServices.IsSelfWrite(rn.FullPath)) return;
        }
        Dispatcher.BeginInvoke(() =>
        {
            if (_watchDebounce == null) return;
            _watchDebounce.Stop();
            _watchDebounce.Start();
        });
    }

    /* ---------------- 菜单 ---------------- */

    private void SendMenu(string name) => SendEvent("menu:" + name);

    private void Menu_NewNote(object s, System.Windows.RoutedEventArgs e) => SendMenu("new-note");
    private void Menu_OpenToday(object s, System.Windows.RoutedEventArgs e) => SendMenu("open-today");
    private void Menu_WeekPlan(object s, System.Windows.RoutedEventArgs e) => SendMenu("week-plan");
    private void Menu_Palette(object s, System.Windows.RoutedEventArgs e) => SendMenu("palette");
    private void Menu_Search(object s, System.Windows.RoutedEventArgs e) => SendMenu("search");
    private void Menu_ChooseVault(object s, System.Windows.RoutedEventArgs e) => SendMenu("choose-vault");
    private void Menu_OpenVaultFolder(object s, System.Windows.RoutedEventArgs e) =>
        Process.Start(new ProcessStartInfo("explorer.exe") { Arguments = $"\"{AppServices.VaultPath}\"" });
    private void Menu_Settings(object s, System.Windows.RoutedEventArgs e) => SendMenu("settings");
    private void Menu_Exit(object s, System.Windows.RoutedEventArgs e) => Close();
    private void Menu_CycleView(object s, System.Windows.RoutedEventArgs e) => SendMenu("cycle-view");
    private void Menu_ToggleTheme(object s, System.Windows.RoutedEventArgs e) => SendMenu("toggle-theme");
    private void Menu_Reload(object s, System.Windows.RoutedEventArgs e) => Web.Reload();
    private void Menu_Help(object s, System.Windows.RoutedEventArgs e) => SendMenu("help");
    private void Menu_About(object s, System.Windows.RoutedEventArgs e) => SendMenu("about");
}
