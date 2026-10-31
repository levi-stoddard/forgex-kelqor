# Saves the ForgeX Gemini API key to .env.local from a masked prompt. The key never appears on screen, in command
# history, in a log or in any other file. Run it from a terminal:
#   pwsh -NoProfile -File .\scripts\set-gemini-key.ps1            first time
#   pwsh -NoProfile -File .\scripts\set-gemini-key.ps1 -Replace   only to replace a saved key
[CmdletBinding()]
param([switch]$Replace)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $project '.env.local'
$name = 'GEMINI_API_KEY'

$package = Join-Path $project 'package.json'
if (-not (Test-Path -LiteralPath $package) -or (Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).name -ne 'forgex') {
  Write-Host "This script has to stay in the ForgeX project's scripts folder. Nothing was changed."
  exit 1
}

$lines = @()
if (Test-Path -LiteralPath $envFile) {
  $lines = @(Get-Content -LiteralPath $envFile)
  if (@($lines -match "^\s*$name\s*=\s*\S").Count -gt 0 -and -not $Replace) {
    Write-Host 'A Gemini key is already saved in .env.local. Nothing was changed.'
    exit 2
  }
}

Write-Host ''
Write-Host 'Paste your ForgeX Gemini API key at the prompt below, then press Enter.'
Write-Host 'It shows only as asterisks and is never displayed, logged or added to command history.'
$secure = Read-Host -Prompt 'ForgeX Gemini API key' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $raw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $secure.Dispose()
}

# Accept the key pasted on its own, in quotes, after "GEMINI_API_KEY=", or inside other copied text.
$key = $raw.Trim()
if ($key -match "^(?:export\s+|set\s+|\`$env:)?$name\s*=\s*(.+)$") { $key = $Matches[1].Trim() }
if ($key -match '^["''](.+)["'']$') { $key = $Matches[1].Trim() }
$looksValid = { param($k) $k.Length -ge 20 -and $k.Length -le 300 -and $k -notmatch '[\s"''#`\\]' }
if (-not (& $looksValid $key)) {
  $found = @([regex]::Matches($raw, 'AIza[0-9A-Za-z_\-]{35}') | ForEach-Object { $_.Value } | Select-Object -Unique)
  if ($found.Count -eq 1) { $key = $found[0] }
}
$length = $raw.Length
$raw = $null
if (-not (& $looksValid $key)) {
  $key = $null
  Write-Host "Nothing was saved. The prompt received $length characters, which don't form a single API key (they include spaces, quotes or other text)."
  Write-Host 'Copy only the key itself (in AI Studio, use the copy icon next to the key) and run this again.'
  exit 3
}

# UTF-8 without a byte-order mark and LF line endings, as Node's .env loader expects. Other settings are kept.
$kept = @($lines | Where-Object { $_ -notmatch "^\s*$name\s*=" })
$text = ((@($kept) + "$name=$key") -join "`n") + "`n"
$key = $null
[IO.File]::WriteAllText($envFile, $text, [Text.UTF8Encoding]::new($false))
$text = $null

# Only this Windows account and SYSTEM may read or change the file.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $envFile /inheritance:r /grant:r "${me}:(F)" '*S-1-5-18:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'The key was saved, but the file permissions could not be restricted. Tell Claude.'
  exit 4
}

try { Set-Clipboard -Value ' ' } catch { }
Write-Host ''
Write-Host "Saved. $name is in .env.local, which only $me and SYSTEM can read and Git ignores."
Write-Host 'The clipboard was cleared. If Windows clipboard history (Win+V) is on, delete the key there as well.'
