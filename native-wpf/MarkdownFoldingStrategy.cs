using System.Text.RegularExpressions;
using ICSharpCode.AvalonEdit.Document;
using ICSharpCode.AvalonEdit.Folding;

namespace NotePlanNative;

/// <summary>按 Markdown 标题生成折叠区间（折叠到下一个同级或更高级标题）。</summary>
public sealed partial class MarkdownFoldingStrategy
{
    [GeneratedRegex(@"^(#{1,6})\s+\S")]
    private static partial Regex ReHeading();

    public IEnumerable<NewFolding> CreateNewFoldings(TextDocument document, out int firstErrorOffset)
    {
        firstErrorOffset = -1;
        return CreateNewFoldings(document);
    }

    private static IEnumerable<NewFolding> CreateNewFoldings(TextDocument doc)
    {
        var result = new List<NewFolding>();
        var headings = new List<(int Level, int LineNo, int EndOffset)>();

        for (var i = 1; i <= doc.LineCount; i++)
        {
            var line = doc.GetLineByNumber(i);
            var text = doc.GetText(line.Offset, line.Length);
            var m = ReHeading().Match(text);
            if (m.Success) headings.Add((m.Groups[1].Length, i, line.EndOffset));
        }

        for (var idx = 0; idx < headings.Count; idx++)
        {
            var (level, lineNo, endOffset) = headings[idx];
            var foldEnd = endOffset;
            for (var j = idx + 1; j < headings.Count; j++)
            {
                if (headings[j].Level <= level) break;
                foldEnd = doc.GetLineByNumber(headings[j].LineNo).EndOffset;
            }
            if (foldEnd > endOffset)
                result.Add(new NewFolding(endOffset, foldEnd));
        }

        result.Sort((a, b) => a.StartOffset.CompareTo(b.StartOffset));
        return result;
    }
}
