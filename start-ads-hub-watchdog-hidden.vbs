' Hidden launcher for the PARTISANS Ads Hub watchdog.
' Runs start-ads-hub-watchdog.bat without showing a console window —
' used by the Windows Startup folder entry so the watchdog boots silently on
' login AND survives any crashes that happen mid-session.
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
batPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\start-ads-hub-watchdog.bat"
sh.Run Chr(34) & batPath & Chr(34), 0, False
