# Opens the Windows share sheet for one file. Run by src/gui/share.mjs with Windows PowerShell 5.1, which can load
# WinRT types (PowerShell 7 can't). The share sheet needs a window of this process, so this makes an invisible one
# centred on the given screen point (the centre of the app's window), and the sheet opens over it. Windows shows no sheet
# for a very small window, so it is 300x200.
#
# Prints "shown" once the sheet is up, then "completed" or "canceled" and exits. Exits by itself after 15 minutes.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Title = 'QA session',
  [int]$X = 0,
  [int]$Y = 0
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.ApplicationModel.DataTransfer.DataTransferManager, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class QaShare {
  [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDataTransferManagerInterop {
    [return: MarshalAs(UnmanagedType.IInspectable)] object GetForWindow(IntPtr appWindow, [In] ref Guid riid);
    void ShowShareUIForWindow(IntPtr appWindow);
  }

  [DllImport("combase.dll", PreserveSig = false)]
  static extern void WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int length, out IntPtr hstring);
  [DllImport("combase.dll", PreserveSig = false)]
  static extern void WindowsDeleteString(IntPtr hstring);
  [DllImport("combase.dll", PreserveSig = false)]
  static extern void RoGetActivationFactory(IntPtr classId, [In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

  static IDataTransferManagerInterop Interop() {
    const string name = "Windows.ApplicationModel.DataTransfer.DataTransferManager";
    IntPtr hstring;
    WindowsCreateString(name, name.Length, out hstring);
    try {
      Guid iid = typeof(IDataTransferManagerInterop).GUID;
      object factory;
      RoGetActivationFactory(hstring, ref iid, out factory);
      return (IDataTransferManagerInterop)factory;
    } finally {
      WindowsDeleteString(hstring);
    }
  }

  // IDataTransferManager
  static Guid ManagerIid = new Guid("A5CAEE9B-8708-49D1-8D36-67D25A8DA00C");

  public static object GetForWindow(IntPtr hwnd) { return Interop().GetForWindow(hwnd, ref ManagerIid); }
  public static void Show(IntPtr hwnd) { Interop().ShowShareUIForWindow(hwnd); }
}
'@

# StorageFile.GetFileFromPathAsync is async; wait for it through .NET's AsTask
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$task = $asTask.MakeGenericMethod([Windows.Storage.StorageFile]).Invoke($null, @([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)))
try {
  $null = $task.Wait(-1)
} catch {
  [Console]::Error.WriteLine("Can't read ${Path}: $($_.Exception.InnerException.InnerException.Message)")
  exit 1
}
$file = $task.Result

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Bounds = New-Object System.Drawing.Rectangle(($X - 150), ($Y - 100), 300, 200)
$form.Opacity = 0.01

$script:result = 'canceled'
$finish = { param($how) $script:result = $how; $form.Close() }
# the window is invisible, so a click on it was meant for the app underneath: get out of the way
$form.add_Click({ & $finish 'canceled' })

$onRequest = [Windows.Foundation.TypedEventHandler[Windows.ApplicationModel.DataTransfer.DataTransferManager, Windows.ApplicationModel.DataTransfer.DataRequestedEventArgs]] {
  param($manager, $e)
  try {
    $data = $e.Request.Data
    $data.Properties.Title = $Title
    $items = New-Object 'System.Collections.Generic.List[Windows.Storage.IStorageItem]'
    $items.Add($file)
    $data.SetStorageItems($items)
    $data.add_ShareCompleted({ & $finish 'completed' })
    # Windows 11 22H2 and later
    try { $data.add_ShareCanceled({ & $finish 'canceled' }) } catch { }
  } catch {
    [Console]::Error.WriteLine($_)
    $e.Request.FailWithDisplayText("Couldn't share the file.")
  }
}

$form.add_Shown({
  try {
    $manager = [QaShare]::GetForWindow($form.Handle)
    $manager.add_DataRequested($onRequest)
    [QaShare]::Show($form.Handle)
    [Console]::Out.WriteLine('shown')
  } catch {
    [Console]::Error.WriteLine($_)
    & $finish 'failed'
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15 * 60 * 1000
$timer.add_Tick({ & $finish 'canceled' })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
[Console]::Out.WriteLine($script:result)
if ($script:result -eq 'failed') { exit 1 }
