using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace NotePlanNative;

public partial class App : Application
{
    public App()
    {
        DispatcherUnhandledException += (_s, e) =>
        {
            Log("DispatcherUnhandledException: " + e.Exception);
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_s, e) =>
            Log("UnhandledException: " + e.ExceptionObject);
    }

    public static void Log(string msg)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(AppContext.BaseDirectory, "np-native.log"),
                DateTime.Now.ToString("HH:mm:ss.fff ") + msg + Environment.NewLine);
        }
        catch { }
    }
}
