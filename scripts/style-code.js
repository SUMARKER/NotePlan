'use strict';
/* 样式优化配套代码修改（native-wpf） */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const xamlF = path.join(ROOT, 'native-wpf', 'MainWindow.xaml');
const csF = path.join(ROOT, 'native-wpf', 'MainWindow.xaml.cs');

/* ---- XAML：主按钮样式 + 空状态提示 ---- */
{
    let s = fs.readFileSync(xamlF, 'utf8');
    if (!s.includes('Style="{StaticResource PrimaryButtonStyle}"')) {
        s = s.replace(
            '<Button Grid.Row="0" x:Name="BtnNewNote" Content="＋ 新建笔记"',
            '<Button Grid.Row="0" x:Name="BtnNewNote" Content="＋ 新建笔记" Style="{StaticResource PrimaryButtonStyle}"');
    }
    if (!s.includes('TrashEmptyHint')) {
        s = s.replace(
            '                            </ListBox>\n                        </StackPanel>',
            '                            </ListBox>\n' +
            '                            <TextBlock x:Name="TrashEmptyHint" Text="回收站是空的"\n' +
            '                                       Foreground="{StaticResource TextDimBrush}" Margin="4,2,0,0" />\n' +
            '                        </StackPanel>');
    }
    fs.writeFileSync(xamlF, s);
    console.log('xaml patched:', s.includes('PrimaryButtonStyle'), s.includes('TrashEmptyHint'));
}

/* ---- code-behind ---- */
let s = fs.readFileSync(csF, 'utf8');

// 1. 渲染回收站改用 ItemsSource + 空状态切换
const oldRenderStart = '    private void RenderTrash()\n    {\n        TrashList.Items.Clear();\n        foreach (var it in trashItems)';
const newRenderStart = '    private void RenderTrash()\n    {\n        TrashEmptyHint.Visibility = trashItems.Count == 0 ? Visibility.Visible : Visibility.Collapsed;\n        TrashList.ItemsSource = null;\n        TrashList.ItemsSource = trashItems;\n        if (trashItems.Count == 0) return;\n        foreach (var it0 in trashItems)';
if (s.includes(oldRenderStart)) {
    s = s.replace(oldRenderStart, newRenderStart);
} else {
    console.error('!! RenderTrash anchor missing');
}

// 2. 选择高亮交给 ListBoxItem 样式（IsSelected 触发器）
s = s.split('        HighlightSelection();\n').join('');
s = s.replace(/    private void HighlightSelection\(\)\n    \{[\s\S]*?\n    \}\n\n/, '');

fs.writeFileSync(csF, s);
console.log('cs patched:', s.includes('TrashEmptyHint'), !s.includes('HighlightSelection'));
