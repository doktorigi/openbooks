# OpenBooks installer for Windows. Run in PowerShell:
#   irm https://github.com/doktorigi/openbooks/releases/latest/download/install.ps1 | iex
# Re-run it to upgrade; your books (books.db) are kept. Set $env:OPENBOOKS_DIR to install elsewhere.
& { # script block: when piped to iex, don't leak settings into the caller's session
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar on
$dir = if ($env:OPENBOOKS_DIR) { $env:OPENBOOKS_DIR } else { Join-Path $HOME 'OpenBooks' }

function Test-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a==22&&b>=13)?0:1)"
  return $LASTEXITCODE -eq 0
}

if (-not (Test-Node)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing Node.js LTS (needed to run OpenBooks)...'
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Test-Node)) { throw 'OpenBooks needs Node.js 22.13 or newer. Install it from https://nodejs.org and run this again.' }
}

Write-Host "Downloading OpenBooks to $dir ..."
$zip = Join-Path $env:TEMP "openbooks-$(Get-Random).zip"
$tmp = Join-Path $env:TEMP "openbooks-$(Get-Random)"
Invoke-WebRequest 'https://github.com/doktorigi/openbooks/releases/latest/download/openbooks.zip' -OutFile $zip -UseBasicParsing
Expand-Archive $zip $tmp
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item (Join-Path $tmp 'openbooks\*') $dir -Recurse -Force
Remove-Item $zip, $tmp -Recurse -Force

$launcher = Join-Path $dir 'Start OpenBooks.cmd'
Set-Content -Path $launcher -Encoding ASCII -Value @'
@echo off
cd /d "%~dp0"
echo OpenBooks is running at http://localhost:3000 - close this window to stop it.
start "" http://localhost:3000
node --no-warnings server.js
pause
'@

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenBooks.lnk'))
$lnk.TargetPath = $launcher
$lnk.WorkingDirectory = $dir
$lnk.Save()

Write-Host ''
Write-Host "OpenBooks is installed in $dir"
Write-Host 'Double-click "OpenBooks" on your desktop to start it, then create your login in the browser.'
}
