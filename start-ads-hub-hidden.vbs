' Hidden launcher for the PARTISANS Ads Hub.
' Runs start-ads-hub.bat without showing a console window — used by the
' Windows Startup folder entry so the server boots silently on login.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
batPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\start-ads-hub.bat"
sh.Run Chr(34) & batPath & Chr(34), 0, False
