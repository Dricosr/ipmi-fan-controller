' Inicia o controlador unificado (controle total + web UI) sem janela — usado no logon
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Program Files\ipmicfg\app"
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Program Files\ipmicfg\app\controller.js""", 0, False
