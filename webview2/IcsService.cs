using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace NotePlanWpf;

/* ==========================================================================
   ICS 日历：拉取（URL 30 分钟缓存 / 本地文件）、解析、RRULE 基本循环展开
   ========================================================================== */

public sealed record IcsEvent(DateTime Start, DateTime? End, bool AllDay, string Title, string Loc, string Rrule);

public record CalEvent(string Date, string? StartHm, string? EndHm, bool AllDay, string Title, string Loc, int Cal);

public static partial class IcsService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private static readonly Dictionary<string, (DateTime FetchedAt, string Text)> MemCache = new();
    private static readonly TimeSpan Refresh = TimeSpan.FromMinutes(30);

    [GeneratedRegex(@"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$")]
    private static partial Regex ReDateTime();

    [GeneratedRegex(@"^\s*```")]
    private static partial Regex ReFence(); // 占位（保留与 JS 对齐的命名空间习惯）

    public static async Task<string> FetchTextAsync(string src)
    {
        if (MemCache.TryGetValue(src, out var mem) && DateTime.UtcNow - mem.FetchedAt < Refresh)
            return mem.Text;

        if (src.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            src.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var text = await Http.GetStringAsync(src);
                MemCache[src] = (DateTime.UtcNow, text);
                return text;
            }
            catch
            {
                if (mem.FetchedAt != default) return mem.Text; // 断网回退旧缓存
                throw;
            }
        }

        var abs = Path.IsPathRooted(src) ? src : AppServices.SafeResolve(src);
        if (abs == null || !File.Exists(abs)) throw new FileNotFoundException("日历文件不存在", src);
        var t = await File.ReadAllTextAsync(abs);
        MemCache[src] = (DateTime.UtcNow, t);
        return t;
    }

    public static List<IcsEvent> Parse(string text)
    {
        var unfolded = text.Replace("\r\n ", "").Replace("\r\n\t", "").Replace("\n ", "").Replace("\n\t", "");
        var events = new List<IcsEvent>();
        var blocks = unfolded.Split("BEGIN:VEVENT");
        for (int bi = 1; bi < blocks.Length; bi++)
        {
            var body = blocks[bi];
            var endIdx = body.IndexOf("END:VEVENT", StringComparison.Ordinal);
            if (endIdx < 0) continue;
            body = body[..endIdx];

            var props = new Dictionary<string, (string Params, string Value)>(StringComparer.Ordinal);
            foreach (var rawLine in body.Split('\n'))
            {
                var line = rawLine.TrimEnd('\r');
                var ci = line.IndexOf(':');
                if (ci <= 0) continue;
                var head = line[..ci];
                var si = head.IndexOf(';');
                var name = si < 0 ? head : head[..si];
                var parameters = si < 0 ? "" : head[si..];
                if (!Regex.IsMatch(name, "^[A-Z\\-]+$")) continue;
                props[name] = (parameters, line[(ci + 1)..].Trim());
            }

            if (!props.TryGetValue("DTSTART", out var dtStart)) continue;
            var start = ParseIcsDate(dtStart.Value, dtStart.Params);
            if (start == null) continue;
            var allDay = dtStart.Params.Contains("VALUE=DATE", StringComparison.OrdinalIgnoreCase)
                         || Regex.IsMatch(dtStart.Value, "^\\d{8}$");
            DateTime? end = null;
            if (props.TryGetValue("DTEND", out var dtEnd))
                end = ParseIcsDate(dtEnd.Value, dtEnd.Params);

            events.Add(new IcsEvent(
                start.Value,
                end,
                allDay,
                props.TryGetValue("SUMMARY", out var s) ? s.Value.Replace("\\,", ",").Replace("\\n", " ").Replace("\\N", " ") : "(无标题)",
                props.TryGetValue("LOCATION", out var l) ? l.Value.Replace("\\,", ",") : "",
                props.TryGetValue("RRULE", out var r) ? r.Value : null));
        }
        return events;
    }

    private static DateTime? ParseIcsDate(string value, string parameters)
    {
        parameters ??= "";
        if (parameters.Contains("VALUE=DATE", StringComparison.OrdinalIgnoreCase) ||
            Regex.IsMatch(value, "^\\d{8}$"))
        {
            if (value.Length < 8) return null;
            return new DateTime(int.Parse(value[..4]), int.Parse(value.Substring(4, 2)), int.Parse(value.Substring(6, 2)), 0, 0, 0, DateTimeKind.Local);
        }
        var m = ReDateTime().Match(value);
        if (!m.Success) return null;
        var dt = new DateTime(
            int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value),
            int.Parse(m.Groups[4].Value), int.Parse(m.Groups[5].Value), int.Parse(m.Groups[6].Value),
            m.Groups[7].Value == "Z" ? DateTimeKind.Utc : DateTimeKind.Local);
        return dt.ToLocalTime();
    }

    /// <summary>RRULE 基本展开：DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL + COUNT + UNTIL</summary>
    public static List<IcsEvent> ExpandRrule(IcsEvent ev, string rrule, DateTime rangeStart, DateTime rangeEnd)
    {
        var parts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var seg in rrule.Split(';'))
        {
            var eq = seg.IndexOf('=');
            if (eq > 0) parts[seg[..eq].ToUpperInvariant()] = seg[(eq + 1)..];
        }
        var freq = parts.GetValueOrDefault("FREQ", "").ToUpperInvariant();
        if (freq is not ("DAILY" or "WEEKLY" or "MONTHLY" or "YEARLY"))
            return ev.Start >= rangeStart && ev.Start <= rangeEnd ? [ev] : [];

        var interval = Math.Max(1, int.TryParse(parts.GetValueOrDefault("INTERVAL"), out var iv) ? iv : 1);
        var count = int.TryParse(parts.GetValueOrDefault("COUNT"), out var c) ? c : 732;
        DateTime? until = parts.TryGetValue("UNTIL", out var u) ? ParseIcsDate(u, "") : null;

        var made = new List<IcsEvent>();
        var cur = ev.Start;
        for (int i = 0; i < count && made.Count < 400; i++)
        {
            if (until != null && cur > until) break;
            if (cur > rangeEnd) break;
            if (cur >= rangeStart)
            {
                made.Add(new IcsEvent(
                    cur,
                    ev.End?.Add(cur - ev.Start),
                    ev.AllDay,
                    ev.Title,
                    ev.Loc,
                    null));
            }
            cur = freq switch
            {
                "DAILY" => cur.AddDays(interval),
                "WEEKLY" => cur.AddDays(7 * interval),
                "MONTHLY" => cur.AddMonths(interval),
                _ => cur.AddYears(interval),
            };
        }
        return made;
    }
}
