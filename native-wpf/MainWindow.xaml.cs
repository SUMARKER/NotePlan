using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Text.RegularExpressions;
using System.Windows.Threading;
using ICSharpCode.AvalonEdit.Folding;
using ICSharpCode.AvalonEdit.Highlighting;
using NotePlanWpf;

namespace NotePlanNative;

public partial class MainWindow : Window
{
    private string? currentRel;
    private bool dirty;
    private bool suppressDirty;
    private string lastLoadedText = "";
    private string calMonth = "";

    private readonly MarkdownFoldingStrategy foldingStrategy = new();
    private FoldingManager? foldingManager;

    private readonly DispatcherTimer saveTimer = new() { Interval = TimeSpan.FromMilliseconds(800) };
    private readonly DispatcherTimer watchTimer = new() { Interval = TimeSpan.FromMilliseconds(450) };
    private FileSystemWatcher? watcher;

    private List<Dictionary<string, object?>> allNotes = new();
    private List<Dictionary<string, object?>> trashItems = new();

    public MainWindow()
    {
        App.Log("ctor");
        InitializeComponent();
        Loaded += async (_s, _e) => await InitAsync();
    }

    /* ---------------- 初始化 ---------------- */

    private async Task InitAsync()
    {
        AppServices.LoadSettings();
        AppServices.RestoreVaultFromSettings();
        App.Log("settings loaded, vault=" + (AppServices.VaultPath ?? "(none)"));

        saveTimer.Tick += (_s, _e) => { saveTimer.Stop(); SaveNow(); };
        watchTimer.Tick += (_s, _e) => { watchTimer.Stop(); _ = ReloadData(); };

        InitEditor();

        var snap = AppServices.GetSettings();
        if (!(snap.TryGetValue("vaultExists", out var ve) && ve is true))
        {
            var choice = MessageBox.Show(
                "尚未选择笔记库。\n\n是：创建示例笔记库（文档\\NotePlan 笔记库）\n否：选择已有文件夹\n取消：退出",
                "选择笔记库", MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
            if (choice == MessageBoxResult.Yes)
                App.Log(JsonSerializer.Serialize(AsJson(AppServices.OpenVault(AppServices.DefaultVaultPath(), true))));
            else if (choice == MessageBoxResult.No)
            {
                var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "选择笔记库文件夹" };
                dlg.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                if (dlg.ShowDialog(this) != true) { Close(); return; }
                App.Log(JsonSerializer.Serialize(AsJson(AppServices.OpenVault(dlg.FolderName, false))));
            }
            else { Close(); return; }
        }

        StartWatcher();
        calMonth = DateTime.Now.ToString("yyyy-MM");
        await ReloadData();
        BtnVaultFolder.Content = "打开笔记库：" + Path.GetFileName(AppServices.VaultPath!.TrimEnd(Path.DirectorySeparatorChar));

        var last = AppServices.Settings["lastNote"] as string;
        if (!string.IsNullOrEmpty(last) && File.Exists(AppServices.SafeResolve(last)))
            await OpenNote(last);
        else
            await OpenDaily(AppServices.TodayStr());
    }

    /* ---------------- 编辑器 ---------------- */

    private void InitEditor()
    {
        Editor.SyntaxHighlighting = HighlightingManager.Instance.GetDefinitionByExtension(".md");
        foldingManager = FoldingManager.Install(Editor.TextArea);
        Editor.TextChanged += Editor_TextChanged;
        Editor.KeyDown += Editor_KeyDown;
    }

    private void UpdateFoldings()
    {
        if (foldingManager == null) return;
        var foldings = foldingStrategy.CreateNewFoldings(Editor.Document, out _);
        foldingManager.UpdateFoldings(foldings, foldings.FirstOrDefault()?.StartOffset ?? 0);
    }

    private void Editor_TextChanged(object? sender, EventArgs e)
    {
        if (suppressDirty) return;
        dirty = true;
        SaveState.Text = "编辑中…";
        UpdateWordCount();
        UpdateFoldings();
        saveTimer.Stop();
        saveTimer.Start();
    }

    private void Editor_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.S && Keyboard.Modifiers == ModifierKeys.Control) { SaveNow(); e.Handled = true; }
    }

    private void UpdateWordCount()
    {
        var text = Editor.Text ?? "";
        var cjk = Regex.Matches(text, @"[\u3400-\u4dbf\u4e00-\u9fff]").Count;
        var words = Regex.Matches(text, "[A-Za-z0-9][A-Za-z0-9'_-]*").Count;
        WordCount.Text = $"{cjk + words} 词 · {text.Length} 字符";
    }

    private static async Task<JsonElement?> AsJson(Task<object?> task)
    {
        var obj = await task;
        if (obj == null) return null;
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(obj));
        return doc.RootElement.Clone();
    }

    private static async Task<JsonElement?> AsJson(Task<Dictionary<string, object?>> task)
    {
        var obj = await task;
        if (obj == null) return null;
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(obj));
        return doc.RootElement.Clone();
    }

    /* ---------------- 打开 / 保存 ---------------- */

    private async Task OpenNote(string rel)
    {
        if (dirty) await SaveNow();
        var res = await AsJson(AppServices.ReadNote(rel));
        if (res == null || !res.Value.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
        { MessageBox.Show("无法打开笔记"); return; }

        var content = res.Value.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
        suppressDirty = true;
        Editor.Text = content;
        lastLoadedText = content;
        suppressDirty = false;
        dirty = false;
        currentRel = rel;
        UpdateFoldings();

        var meta = allNotes.FirstOrDefault(n => n["rel"] as string == rel);
        NoteTitle.Text = meta != null && meta.TryGetValue("title", out var t) && t != null
            ? t.ToString()! : Path.GetFileNameWithoutExtension(rel);
        SaveState.Text = "就绪";
        UpdateWordCount();

        AppServices.Settings["lastNote"] = rel;
        AppServices.SaveSettings();
    }

    private async Task OpenDaily(string ds)
    {
        var res = await AsJson(AppServices.OpenDaily(ds));
        if (res != null && res.Value.TryGetProperty("rel", out var rel))
        {
            await ReloadData();
            await OpenNote(rel.GetString()!);
        }
    }

    private async Task SaveNow()
    {
        saveTimer.Stop();
        if (string.IsNullOrEmpty(currentRel) || !dirty) return;
        dirty = false;
        SaveState.Text = "保存中…";
        var res = await AsJson(AppServices.WriteNote(currentRel, Editor.Text));
        if (res != null && res.Value.TryGetProperty("ok", out var ok) && ok.GetBoolean())
            SaveState.Text = "已保存 " + DateTime.Now.ToString("HH:mm:ss");
        else
        {
            dirty = true;
            SaveState.Text = "保存失败";
        }
    }

    private async Task OpenToday()
    {
        var res = await AsJson(AppServices.OpenDaily(AppServices.TodayStr()));
        if (res != null && res.Value.TryGetProperty("rel", out var rel))
        {
            await ReloadData();
            await OpenNote(rel.GetString()!);
        }
    }

    /* ---------------- 数据加载 ---------------- */

    private async Task ReloadData()
    {
        var notesRes = await AsJson(AppServices.ListNotes());
        var notes = notesRes != null && notesRes.Value.TryGetProperty("notes", out var notesArr)
            ? notesArr : (JsonElement?)default;
        allNotes.Clear();
        if (notes != null && notes.Value.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in notes.Value.EnumerateArray())
            {
                var d = new Dictionary<string, object?>();
                foreach (var p in el.EnumerateObject())
                    d[p.Name] = p.Value.ValueKind switch
                    {
                        JsonValueKind.String => p.Value.GetString(),
                        JsonValueKind.Number => p.Value.GetDouble(),
                        JsonValueKind.True => true,
                        JsonValueKind.False => false,
                        _ => null,
                    };
                allNotes.Add(d);
            }
        }

        var trash = await AsJson(AppServices.TrashList());
        trashItems.Clear();
        if (trash != null && trash.Value.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in trash.Value.EnumerateArray())
            {
                var d = new Dictionary<string, object?>();
                foreach (var p in el.EnumerateObject())
                    d[p.Name] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null;
                trashItems.Add(d);
            }
        }

        RenderNoteList();
        BuildCalendar();
        RenderDailyList();
        RenderTrash();

        // 当前笔记被外部修改且本地无未保存修改 → 自动刷新
        if (currentRel != null && !dirty)
        {
            var res = await AsJson(AppServices.ReadNote(currentRel));
            if (res != null && res.Value.TryGetProperty("content", out var c))
            {
                var text = c.GetString() ?? "";
                if (text != Editor.Text && text != lastLoadedText)
                {
                    suppressDirty = true;
                    Editor.Text = text;
                    lastLoadedText = text;
                    suppressDirty = false;
                    UpdateFoldings();
                }
            }
        }
    }

    private string ResolveNoteTitle(Dictionary<string, object?> n)
    {
        if (n.TryGetValue("title", out var t) && t != null && t.ToString()!.Length > 0)
            return t.ToString()!;
        return Regex.Replace(n["name"] as string ?? "", @"\.(md|markdown|txt)$", "");
    }

    private void RenderNoteList()
    {
        var filter = NoteFilter.Text?.Trim() ?? "";
        var items = allNotes
            .Where(n => n.TryGetValue("md", out var md) && md is true)
            .Where(n => !((n["rel"] as string) ?? "").StartsWith("Calendar/", StringComparison.OrdinalIgnoreCase))
            .Select(n => new NoteItem(
                ResolveNoteTitle(n),
                (string)n["rel"]!,
                DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(n["mtimeMs"])).LocalDateTime.ToString("yyyy/MM/dd")))
            .Where(x => filter.Length == 0 ||
                        x.Title.Contains(filter, StringComparison.OrdinalIgnoreCase) ||
                        x.Rel.Contains(filter, StringComparison.OrdinalIgnoreCase))
            .OrderBy(x => x.Title, StringComparer.CurrentCulture)
            .ToList();
        NoteList.ItemsSource = items;
    }

    private sealed record NoteItem(string Title, string Rel, string Sub);

    private void RenderDailyList()
    {
        DailyList.Items.Clear();
        var items = allNotes
            .Where(n => ((n["rel"] as string) ?? "").StartsWith("Calendar/", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(n => n["rel"] as string)
            .ToList();
        foreach (var n in items)
        {
            var rel = n["rel"] as string ?? "";
            var ds = Path.GetFileNameWithoutExtension(rel);
            if (DateTime.TryParse(ds, out var d))
            {
                var label = $"{d.Month}月{d.Day}日 {WEEKDAYS[(int)d.DayOfWeek]}";
                var hol = CnHolidays.Get(d);
                if (hol.HasValue)
                    label += $" · {hol.Value.Name}{(hol.Value.Off ? "" : "（班）")}";
                DailyList.Items.Add(new ListBoxItem
                {
                    Content = label,
                    Tag = rel,
                });
            }
        }
        if (DailyList.Items.Count == 0)
            DailyList.Items.Add(new ListBoxItem { Content = "本月还没有每日笔记", IsEnabled = false });
    }

    private static readonly string[] WEEKDAYS = { "周日", "周一", "周二", "周三", "周四", "周五", "周六" };

    /* ---------------- 月历 ---------------- */

    private void BuildCalendar()
    {
        if (!DateTime.TryParseExact(calMonth, "yyyy-MM", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out var month))
            month = DateTime.Now;

        CalTitle.Text = month.ToString("yyyy年M月");
        CalGrid.Children.Clear();
        foreach (var w in new[] { "一", "二", "三", "四", "五", "六", "日" })
            CalGrid.Children.Add(new TextBlock
            {
                Text = w,
                TextAlignment = TextAlignment.Center,
                FontSize = 11,
                Foreground = Brushes.Gray,
            });

        var first = new DateTime(month.Year, month.Month, 1);
        var lead = ((int)first.DayOfWeek + 6) % 7;
        var days = DateTime.DaysInMonth(month.Year, month.Month);
        var today = DateTime.Now.ToString("yyyy-MM-dd");
        var sel = currentRel != null && currentRel.StartsWith("Calendar/")
            ? Path.GetFileNameWithoutExtension(currentRel) : null;

        var notesByDay = new HashSet<string>();
        foreach (var n in allNotes)
        {
            var rel = n["rel"] as string ?? "";
            if (rel.StartsWith("Calendar/") && rel.EndsWith(".md"))
                notesByDay.Add(Path.GetFileNameWithoutExtension(rel));
        }

        for (var i = 0; i < lead; i++) CalGrid.Children.Add(new TextBlock());
        for (var d = 1; d <= days; d++)
        {
            var dt = new DateTime(month.Year, month.Month, d);
            var ds = dt.ToString("yyyy-MM-dd");
            var hasNote = notesByDay.Contains(ds);
            var hol = CnHolidays.Get(dt);
            var isToday = ds == today;
            var isOff = hol.HasValue && hol.Value.Off;
            var btn = new Button
            {
                Content = d.ToString(),
                Height = 26,
                Margin = new Thickness(1),
                Tag = ds,
                Background = isToday ? Brushes.CornflowerBlue : Brushes.Transparent,
                Foreground = isToday ? Brushes.White
                    : isOff ? new SolidColorBrush(Color.FromRgb(0xdc, 0x26, 0x26))
                    : SystemColors.ControlTextBrush,
                BorderBrush = hasNote && !isToday ? new SolidColorBrush(Color.FromRgb(0x33, 0x78, 0xf6)) : SystemColors.ControlDarkBrush,
                FontWeight = hasNote ? FontWeights.Bold : FontWeights.Normal,
                ToolTip = hol.HasValue
                    ? $"{ds} · {hol.Value.Name}{(hol.Value.Off ? "" : "（调休上班）")}"
                    : ds,
            };
            btn.Click += async (_s, _e) => await OpenDaily(ds);
            CalGrid.Children.Add(btn);
        }
    }

    private async void CalPrev_Click(object s, RoutedEventArgs e)
    {
        var m = DateTime.ParseExact(calMonth, "yyyy-MM", CultureInfo.InvariantCulture).AddMonths(-1);
        calMonth = m.ToString("yyyy-MM");
        BuildCalendar();
        RenderDailyList();
    }

    private async void CalNext_Click(object s, RoutedEventArgs e)
    {
        var m = DateTime.ParseExact(calMonth, "yyyy-MM", CultureInfo.InvariantCulture).AddMonths(1);
        calMonth = m.ToString("yyyy-MM");
        BuildCalendar();
        RenderDailyList();
    }

    /* ---------------- 回收站 ---------------- */

    private async void TrashExpander_Expanded(object s, RoutedEventArgs e) => RenderTrash();

    private void RenderTrash()
    {
        TrashEmptyHint.Visibility = trashItems.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        TrashList.ItemsSource = null;
        TrashList.ItemsSource = trashItems;
        if (trashItems.Count == 0) return;

    }

    public async void TrashRestore_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is Dictionary<string, object?> d && d.TryGetValue("id", out var idObj))
        {
            var r = await AsJson(AppServices.TrashRestore(idObj?.ToString()));
            if (r != null && r.Value.TryGetProperty("ok", out var ok) && ok.GetBoolean())
            {
                await ReloadData();
                var rel = r.Value.TryGetProperty("rel", out var relEl) ? relEl.GetString() : "?";
                MessageBox.Show("已恢复到 " + rel);
            }
            else MessageBox.Show("恢复失败");
        }
    }

    public async void TrashPurge_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is Dictionary<string, object?> d && d.TryGetValue("id", out var idObj))
        {
            var name = d.TryGetValue("name", out var n) ? n?.ToString() : "";
            if (MessageBox.Show($"「{name}」将被彻底删除，不可恢复。", "永久删除",
                MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
            await AppServices.TrashPurge(idObj?.ToString());
            await ReloadData();
            RenderTrash();
        }
    }

    private async void BtnTrashEmpty_Click(object s, RoutedEventArgs e)
    {
        if (MessageBox.Show("回收站中的所有内容将被彻底删除，不可恢复。", "清空回收站",
            MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
        await AppServices.TrashEmpty();
        await ReloadData();
        RenderTrash();
    }

    /* ---------------- 操作 ---------------- */

    private async void BtnNewNote_Click(object s, RoutedEventArgs e)
    {
        var res = await AsJson(AppServices.CreateNote("Notes", "无标题笔记", null));
        if (res != null && res.Value.TryGetProperty("rel", out var rel))
        {
            await ReloadData();
            await OpenNote(rel.GetString()!);
        }
    }

    private async void BtnDeleteNote_Click(object s, RoutedEventArgs e)
    {
        if (currentRel == null) return;
        if (MessageBox.Show($"「{Path.GetFileNameWithoutExtension(currentRel)}」将被移入回收站。",
            "删除笔记", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
        var r = await AsJson(AppServices.TrashNote(currentRel));
        if (r == null || !r.Value.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
        { MessageBox.Show("删除失败"); return; }
        dirty = false;
        currentRel = null;
        await ReloadData();
        await OpenToday();
    }

    private void BtnVaultFolder_Click(object s, RoutedEventArgs e) =>
        Process.Start(new ProcessStartInfo("explorer.exe") { Arguments = $"\"{AppServices.VaultPath}\"" });

    private void NoteFilter_Changed(object s, TextChangedEventArgs e) => RenderNoteList();

    private async void NoteList_SelectionChanged(object s, SelectionChangedEventArgs e)
    {
        if (NoteList.SelectedItem is NoteItem item && !string.IsNullOrEmpty(item.Rel))
            await OpenNote(item.Rel);
    }

    private async void DailyList_SelectionChanged(object s, SelectionChangedEventArgs e)
    {
        if (DailyList.SelectedItem is ListBoxItem it && it.Tag is string rel && rel.Length > 0)
            await OpenNote(rel);
        else
            DailyList.SelectedItem = null;
    }

    private void StartWatcher()
    {
        if (string.IsNullOrEmpty(AppServices.VaultPath)) return;
        try
        {
            watcher = new FileSystemWatcher(AppServices.VaultPath)
            {
                IncludeSubdirectories = true,
                EnableRaisingEvents = true,
                InternalBufferSize = 64 * 1024,
            };
            watcher.Changed += (_s, _e) => watchTimer.Start();
            watcher.Created += (_s, _e) => watchTimer.Start();
            watcher.Deleted += (_s, _e) => watchTimer.Start();
            watcher.Renamed += (_s, _e) => watchTimer.Start();
        }
        catch { }
    }

    /* ---------------- 菜单 ---------------- */

    private void Menu_NewNote(object s, RoutedEventArgs e) => BtnNewNote_Click(s, e);
    private void Menu_OpenToday(object s, RoutedEventArgs e) => OpenToday();
    private void Menu_Save(object s, RoutedEventArgs e) => SaveNow();
    private void Menu_Exit(object s, RoutedEventArgs e) => Close();
    private void Menu_About(object s, RoutedEventArgs e) =>
        MessageBox.Show("NotePlan for Windows — 原生预览版\nWPF + AvalonEdit，复用 C# 数据层（AppServices）。\n与 Electron / WebView2 版共用同一笔记库格式，可同时打开同一笔记库。");

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (dirty) SaveNow();
        watcher?.Dispose();
        base.OnClosing(e);
    }
}
