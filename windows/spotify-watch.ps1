# Opens Bandwave whenever Spotify starts (owner 2026-11-22: "launch on default with spotify").
# Started hidden at logon by spotify-watch.vbs (HKCU Run "Bandwave with Spotify", kept in sync by the app's
# "Open with Spotify" switch). Polls every 3 s, acts only on the Spotify not-running -> running edge;
# Bandwave's single-instance lock makes a second launch harmless.
# installed: this file is in <install>\resources, the app is <install>\Bandwave.exe; from source: start.vbs beside it
$exe = Join-Path $PSScriptRoot "..\Bandwave.exe"
$start = if (Test-Path $exe) { $exe } else { Join-Path $PSScriptRoot "start.vbs" }
$was = $false
while ($true) {
    $now = [bool](Get-Process -Name Spotify -ErrorAction SilentlyContinue)
    if ($now -and -not $was) { if ($start -like "*.exe") { Start-Process $start } else { Start-Process wscript.exe -ArgumentList "`"$start`"" } }
    $was = $now
    Start-Sleep -Seconds 3
}
