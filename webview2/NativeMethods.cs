using System.Runtime.InteropServices;

namespace NotePlanWpf;

/* 删除到系统回收站（SHFileOperation，带 FOF_ALLOWUNDO） */
internal static class NativeMethods
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCTW
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string pTo;
        public ushort fFlags;
        public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperationW(ref SHFILEOPSTRUCTW lpFileOp);

    private const uint FO_DELETE = 3;
    private const ushort FOF_ALLOWUNDO = 0x40;
    private const ushort FOF_NOCONFIRMATION = 0x10;
    private const ushort FOF_SILENT = 0x4;

    /// <summary>把文件或目录移入回收站。返回是否成功。</summary>
    public static bool Trash(string path)
    {
        var op = new SHFILEOPSTRUCTW
        {
            hwnd = IntPtr.Zero,
            wFunc = FO_DELETE,
            pFrom = path + "\0\0", // 双 null 结尾（支持多路径）
            pTo = "\0\0",
            fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT),
        };
        return SHFileOperationW(ref op) == 0 && !op.fAnyOperationsAborted;
    }
}
