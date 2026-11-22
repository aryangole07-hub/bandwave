' Runs spotify-watch.ps1 with no window (one copy only: an existing watcher is left alone)
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
For Each p In wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='powershell.exe'")
  If Not IsNull(p.CommandLine) Then
    If InStr(1, p.CommandLine, "spotify-watch.ps1", 1) > 0 Then WScript.Quit
  End If
Next
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\spotify-watch.ps1""", 0, False
