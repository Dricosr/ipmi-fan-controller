' Inicia o fan controller em MODO DAEMON (sem janela) — usado no logon
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Program Files\ipmicfg\app"
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Program Files\ipmicfg\app\fan_controller.js"" --daemon", 0, False
