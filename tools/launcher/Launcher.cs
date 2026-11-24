// AI 酒館的啟動程式：雙擊「AI 酒館.exe」→ 檢查 Node.js → 第一次啟動時安裝套件 → 不顯示黑色視窗執行 launch.js
// 編譯：npm run build-launcher（使用 Windows 內建的 C# 編譯器，不需要安裝其他東西）
// exe 用自己所在的資料夾找程式，所以整個 AI 酒館資料夾搬到哪裡都能用（請讓 exe 和 launch.js 放在同一層）
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// 版本資訊（exe 按右鍵 → 內容 → 詳細資料）
[assembly: AssemblyTitle("AI 酒館")]                // 檔案描述
[assembly: AssemblyProduct("AI 酒館")]              // 產品名稱
[assembly: AssemblyCompany("葛恩")]                 // 公司
[assembly: AssemblyCopyright("© 2026 葛恩")]        // 著作權
[assembly: AssemblyDescription("AI 酒館啟動程式（啟動本機伺服器並開啟應用程式視窗）Made by 葛恩 with Claude.")] // 註解
[assembly: AssemblyVersion("1.6.0.0")]
[assembly: AssemblyFileVersion("1.6.0.0")]          // 檔案版本
[assembly: AssemblyInformationalVersion("1.6.0")]   // 產品版本（和 package.json 一致）

static class Launcher
{
    const string Title = "AI 酒館";

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware(); // 螢幕有縮放時，錯誤訊息視窗不會糊掉

    [STAThread]
    static int Main()
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        if (!File.Exists(Path.Combine(dir, "launch.js")))
            return Fail("找不到 launch.js。\n\n請把「AI 酒館.exe」放在 AI 酒館的資料夾裡（和 server.js、launch.js 同一層）。");

        // 優先使用電腦上安裝的 Node.js；沒有安裝時，若資料夾裡有內附版本（runtime\node.exe）就詢問要不要用它
        // （環境變數 TAVERN_IGNORE_SYSTEM_NODE=1 會假裝沒有安裝，只用來測試詢問視窗）
        string node = Environment.GetEnvironmentVariable("TAVERN_IGNORE_SYSTEM_NODE") == "1" ? null : FindNode();
        bool bundled = false;
        if (node == null)
        {
            string inside = Path.Combine(dir, @"runtime\node.exe");
            string prefs = Path.Combine(dir, @"data\launcher.ini");
            if (!File.Exists(inside))
            {
                var r = MessageBox.Show("找不到 Node.js，AI 酒館需要它才能執行。\n\n請安裝 Node.js 18 以上的版本（LTS 版即可），裝好後再開一次。\n\n"
                    + "不想安裝的話：從當初下載的 AI 酒館壓縮檔裡，把 runtime 資料夾中的 node.exe 複製回 AI 酒館資料夾的 runtime 資料夾，再開一次即可。\n\n"
                    + "要現在開啟 Node.js 的下載頁面嗎？",
                    Title, MessageBoxButtons.YesNo, MessageBoxIcon.Error);
                if (r == DialogResult.Yes) Process.Start("https://nodejs.org/");
                return 1;
            }
            if (!RememberedBundled(prefs))
            {
                bool remember;
                var choice = NodeChoice.Ask(FileVersionInfo.GetVersionInfo(inside).ProductVersion, out remember);
                if (choice == NodeChoice.Result.Install)
                {
                    // 選擇自己安裝：開下載頁之前，順便提醒裝好以後可以刪掉內附的 Node.js
                    MessageBox.Show("接下來會開啟 Node.js 的下載頁面，請安裝 LTS 版本，裝好後再開一次 AI 酒館。\n\n"
                        + "裝好以後，AI 酒館會自動改用安裝的版本，資料夾裡內附的 Node.js（約 95 MB）就用不到了：\n"
                        + "可以到酒館的「設定 → 資料 → 內附的 Node.js」按「刪除」省下空間。",
                        Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    Process.Start("https://nodejs.org/");
                    return 1;
                }
                if (choice != NodeChoice.Result.Bundled) return 1;
                if (remember)
                {
                    try { Directory.CreateDirectory(Path.GetDirectoryName(prefs)); File.WriteAllText(prefs, "bundled_node=always\r\n"); } catch { }
                }
            }
            node = inside;
            bundled = true;
        }

        // 第一次啟動：安裝套件（顯示命令視窗，看得到進度；失敗時停在畫面上）
        if (!Directory.Exists(Path.Combine(dir, @"node_modules\@anthropic-ai\sdk")))
        {
            if (bundled)
                return Fail("找不到 AI 酒館需要的套件（node_modules 資料夾），內附的 Node.js 沒辦法自己安裝套件。\n\n"
                    + "請把完整的 AI 酒館資料夾（包含 node_modules）複製過來，或是安裝 Node.js 後再開一次。");
            string npm = Path.Combine(Path.GetDirectoryName(node), "npm.cmd");
            if (!File.Exists(npm)) npm = "npm";
            string cmd = "/s /c \"title AI 酒館：第一次啟動，安裝套件中 & \"" + npm + "\" install --no-fund --no-audit"
                + " || (echo. & echo 套件安裝失敗，請確認網路連線後再開一次 AI 酒館。 & pause & exit /b 1)\"";
            var install = Process.Start(new ProcessStartInfo("cmd.exe", cmd) { WorkingDirectory = dir, UseShellExecute = false });
            install.WaitForExit();
            if (install.ExitCode != 0) return 1;
        }

        // 啟動：不顯示視窗，輸出寫到 data\launcher.log（出問題時可以查看）
        // 已經有一個 AI 酒館在執行時，它還開著 launcher.log，這次就改寫到 launcher-2.log…，不然會啟動失敗
        Directory.CreateDirectory(Path.Combine(dir, "data"));
        string logName = PickLog(Path.Combine(dir, "data"));
        string log = Path.Combine(dir, "data", logName);
        var psi = new ProcessStartInfo("cmd.exe", "/s /c \"\"" + node + "\" launch.js > \"data\\" + logName + "\" 2>&1\"")
        {
            WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true,
        };
        var proc = Process.Start(psi);

        // 最多等 20 秒：
        // - 這段時間內就失敗結束（例如程式出錯）時顯示原因
        // - 視窗出現後替它加上「釘選到工作列」用的資訊，之後就交給 launch.js
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 20000)
        {
            if (proc.HasExited && proc.ExitCode != 0)
                return Fail("AI 酒館沒有正常啟動：\n\n" + Tail(ReadLog(log), 1200) + "\n\n完整紀錄在 data\\" + logName + "；也可以執行 start.bat 查看。");
            if (Taskbar.TagAppWindows(exe) > 0) break;
            Thread.Sleep(300);
        }
        return 0;
    }

    static string FindNode()
    {
        foreach (string p in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string f = Path.Combine(p.Trim().Trim('"'), "node.exe");
                if (p.Trim().Length > 0 && File.Exists(f)) return f;
            }
            catch { }
        }
        foreach (string baseDir in new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
                                            Environment.GetEnvironmentVariable("LOCALAPPDATA") + @"\Programs", Environment.GetEnvironmentVariable("NVM_SYMLINK") })
        {
            if (string.IsNullOrEmpty(baseDir)) continue;
            string f = baseDir.EndsWith("nodejs") || File.Exists(Path.Combine(baseDir, "node.exe")) ? Path.Combine(baseDir, "node.exe") : Path.Combine(baseDir, @"nodejs\node.exe");
            if (File.Exists(f)) return f;
        }
        return null;
    }

    /** 找一個現在沒有被其他 AI 酒館佔用的紀錄檔名稱 */
    static string PickLog(string dataDir)
    {
        for (int i = 1; i <= 5; i++)
        {
            string name = i == 1 ? "launcher.log" : "launcher-" + i + ".log";
            try
            {
                using (new FileStream(Path.Combine(dataDir, name), FileMode.OpenOrCreate, FileAccess.Write, FileShare.None)) { }
                return name;
            }
            catch (IOException) { }
        }
        return "launcher-" + Process.GetCurrentProcess().Id + ".log";
    }

    static bool RememberedBundled(string prefs)
    {
        try { return File.Exists(prefs) && File.ReadAllText(prefs).Contains("bundled_node=always"); } catch { return false; }
    }

    static string ReadLog(string file)
    {
        try
        {
            using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var sr = new StreamReader(fs, Encoding.UTF8)) return sr.ReadToEnd().Trim();
        }
        catch { return "（沒有紀錄）"; }
    }

    static string Tail(string s, int max) { return s.Length <= max ? s : "…" + s.Substring(s.Length - max); }

    static int Fail(string msg)
    {
        MessageBox.Show(msg, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}

// 電腦上沒有安裝 Node.js 時的詢問視窗：使用內附版本直接執行，或是去下載安裝
static class NodeChoice
{
    public enum Result { Bundled, Install, Cancel }

    public static Result Ask(string version, out bool remember)
    {
        var form = new Form
        {
            Text = "AI 酒館", FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            AutoScaleMode = AutoScaleMode.None, Font = SystemFonts.MessageBoxFont, ShowInTaskbar = true,
        };
        try { form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        float scale = 1f;
        using (var g = form.CreateGraphics()) scale = g.DpiX / 96f;
        Func<int, int> S = v => (int)(v * scale); // 螢幕縮放時跟著放大
        form.Padding = new Padding(S(18));

        var panel = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        var width = new Size(S(500), 0);
        panel.Controls.Add(new Label
        {
            Text = "這台電腦沒有安裝 Node.js", AutoSize = true,
            Font = new Font(form.Font.FontFamily, form.Font.Size * 1.3f, FontStyle.Bold), Margin = new Padding(0, 0, 0, S(10)),
        });
        panel.Controls.Add(new Label
        {
            AutoSize = true, MaximumSize = width, Margin = new Padding(0, 0, 0, S(10)),
            Text = "AI 酒館需要 Node.js 才能執行。你可以使用資料夾裡內附的 Node.js（v" + version + "）直接執行，"
                + "不用安裝任何東西；也可以自己安裝 Node.js（建議，會自動取得安全性更新）。",
        });
        panel.Controls.Add(new Label
        {
            AutoSize = true, MaximumSize = width, Margin = new Padding(0, 0, 0, S(6)),
            Font = new Font(form.Font, FontStyle.Bold), Text = "使用內附版本可能會遇到：",
        });
        panel.Controls.Add(new Label
        {
            AutoSize = true, MaximumSize = width, Margin = new Padding(S(8), 0, 0, S(10)),
            Text = "• 不會自動更新：Node.js 的安全性修正，要等 AI 酒館的內附檔案更新後才會有。\n"
                + "• 防毒軟體第一次執行時可能會掃描或攔截，啟動比較慢；被攔截時請把 AI 酒館資料夾加入信任清單。\n"
                + "• 沒辦法自己安裝或更新套件：node_modules 資料夾不完整時，還是得安裝 Node.js。\n"
                + "• 只能在 64 位元的 Windows 上執行。",
        });
        panel.Controls.Add(new Label
        {
            AutoSize = true, MaximumSize = width, Margin = new Padding(0, 0, 0, S(8)), ForeColor = SystemColors.GrayText,
            Text = "之後只要安裝了 Node.js，AI 酒館就會自動改用安裝的版本；那時內附的 Node.js 就用不到了，"
                + "可以到酒館的「設定 → 資料 → 內附的 Node.js」按「刪除」，省下約 95 MB。",
        });
        var check = new CheckBox { Text = "記住選擇，以後直接使用內附版本（不再詢問）", AutoSize = true, Margin = new Padding(0, 0, 0, S(14)) };
        panel.Controls.Add(check);

        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = new Padding(0) };
        Func<string, DialogResult, Button> button = (text, result) => new Button
        {
            Text = text, DialogResult = result, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(S(10), S(4), S(10), S(4)), Margin = new Padding(0, 0, S(8), 0),
        };
        var use = button("使用內附版本執行", DialogResult.Yes);
        var install = button("前往下載 Node.js", DialogResult.No);
        var cancel = button("取消", DialogResult.Cancel);
        buttons.Controls.AddRange(new Control[] { use, install, cancel });
        panel.Controls.Add(buttons);

        form.Controls.Add(panel);
        form.AcceptButton = use;
        form.CancelButton = cancel;
        var r = form.ShowDialog();
        remember = check.Checked;
        return r == DialogResult.Yes ? Result.Bundled : r == DialogResult.No ? Result.Install : Result.Cancel;
    }
}

// 讓工作列把 AI 酒館的視窗當成獨立的 App：
// Chrome 的應用程式視窗預設算是 Chrome 的視窗，釘選後只會開 Chrome。替視窗設定 AppUserModelID 與「重新啟動」資訊後，
// 工作列會把它和 Chrome 分開，釘選時記下的是 AI 酒館.exe、圖示與名稱。
static class Taskbar
{
    public const string AppId = "AITavern.App";

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey { public Guid fmtid; public uint pid; public PropertyKey(Guid g, uint p) { fmtid = g; pid = p; } }

    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(8)] public long pad; }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint i, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    static readonly Guid AppModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    static readonly PropertyKey KeyId = new PropertyKey(AppModel, 5);
    static readonly PropertyKey KeyCommand = new PropertyKey(AppModel, 2);
    static readonly PropertyKey KeyIcon = new PropertyKey(AppModel, 3);
    static readonly PropertyKey KeyName = new PropertyKey(AppModel, 4);

    /** 找出 AI 酒館的應用程式視窗（Chrome / Edge、標題剛好是「AI 酒館」），加上工作列資訊；回傳處理了幾個視窗 */
    public static int TagAppWindows(string exe)
    {
        int n = 0;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            if (sb.ToString() != "Chrome_WidgetWin_1") return true;
            sb.Clear(); GetWindowText(h, sb, 256);
            if (!IsAppTitle(sb.ToString())) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            try
            {
                string name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                if (name != "chrome" && name != "msedge") return true;
            }
            catch { return true; }
            if (Tag(h, exe)) n++;
            return true;
        }, IntPtr.Zero);
        return n;
    }

    /**
     * AI 酒館的 App 視窗標題：首頁「AI酒館－by 葛恩 with Claude」、對話中「AI酒館－角色名稱」（舊版是「AI 酒館」）。
     * 一般瀏覽器分頁打開酒館時，標題後面會多「 - Google Chrome」「 - Microsoft Edge」，不會被當成 App 視窗
     */
    static bool IsAppTitle(string t)
    {
        if (t == "AI 酒館") return true;
        if (!t.StartsWith("AI酒館－")) return false;
        return !t.EndsWith(" - Google Chrome") && !t.Contains(" - Microsoft") && !t.EndsWith(" - Chromium");
    }

    static bool Tag(IntPtr hwnd, string exe)
    {
        IPropertyStore store = null;
        try
        {
            Guid iid = typeof(IPropertyStore).GUID;
            if (SHGetPropertyStoreForWindow(hwnd, ref iid, out store) != 0 || store == null) return false;
            // 先設定重新啟動的資訊，最後才設定 ID（Windows 文件建議的順序）
            Set(store, KeyCommand, "\"" + exe + "\"");
            Set(store, KeyIcon, exe + ",0");
            Set(store, KeyName, "AI 酒館");
            Set(store, KeyId, AppId);
            store.Commit();
            return true;
        }
        catch { return false; }
        finally { if (store != null) Marshal.ReleaseComObject(store); }
    }

    static void Set(IPropertyStore store, PropertyKey key, string value)
    {
        var pv = new PropVariant { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(value) };
        try { store.SetValue(ref key, ref pv); }
        finally { Marshal.FreeCoTaskMem(pv.p); }
    }
}
