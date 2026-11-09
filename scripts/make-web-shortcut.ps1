# Puts a "Pastel Media Pro (web)" shortcut on the Desktop that runs scripts\launch-web.cmd.
$repo = Split-Path $PSScriptRoot -Parent
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pastel Media Pro (web).lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $PSScriptRoot 'launch-web.cmd'
$s.WorkingDirectory = $repo
$s.IconLocation = (Join-Path $repo 'apps\player\src-tauri\icons\icon.ico') + ',0'
$s.Description = 'Starts the Pastel Media Pro web version and opens it in the browser'
$s.Save()
"shortcut: $lnk"
