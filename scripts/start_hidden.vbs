Set Shell = CreateObject("WScript.Shell")
Set Files = CreateObject("Scripting.FileSystemObject")

ScriptDir = Files.GetParentFolderName(WScript.ScriptFullName)
RootDir = Files.GetParentFolderName(ScriptDir)
Shell.CurrentDirectory = RootDir

PreferredPython = Shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python312\python.exe"

If Files.FileExists(PreferredPython) Then
  Shell.Run """" & PreferredPython & """ """ & RootDir & "\server.py""", 0, False
Else
  Shell.Run "py -3.12 """ & RootDir & "\server.py""", 0, False
End If
