' Silent launcher for the PARTISANS Ads Hub heartbeat.
' Runs heartbeat.ps1 with no console window — bypasses Windows Terminal so
' Task Scheduler can invoke it every 5 minutes without any visible flash.
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
psPath  = fso.GetParentFolderName(WScript.ScriptFullName) & "\heartbeat.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psPath & """", 0, True
