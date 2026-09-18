using System.IO;
using System.Windows;

namespace NotePlanWpf;

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
        TaskScheduler.UnobservedTaskException += (_s, e) =>
        {
            Log("UnobservedTaskException: " + e.Exception);
            e.SetObserved();
        };
    }

    public static void Log(string msg)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(AppContext.BaseDirectory, "np-host.log"),
                DateTime.Now.ToString("HH:mm:ss.fff ") + msg + Environment.NewLine);
        }
        catch { }
    }
}
