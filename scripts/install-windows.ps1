#Requires -Version 5.1
<#
.SYNOPSIS
  Idempotent Windows installer for the codex-x-opencode-mcp bridge.

.DESCRIPTION
  Copies the bridge source from this repository to a durable user-level
  directory, builds it, installs the Codex skill template, and points the
  Codex MCP configuration at the installed runtime.

  Safe to re-run: it never deletes the source repository, never touches
  unrelated MCP servers, and preserves unrelated config.toml sections.

.PARAMETER SourceBridgeDir
  Bridge source directory. Defaults to <repo>/bridge.

.PARAMETER TargetDir
  Durable runtime directory. Defaults to $env:USERPROFILE\.codex\codex-x-opencode-mcp.

.PARAMETER SkillDir
  Skill install directory. Defaults to $env:USERPROFILE\.agents\skills\codex-x-opencode-mcp.

.PARAMETER ConfigPath
  Codex config file. Defaults to $env:USERPROFILE\.codex\config.toml.

.PARAMETER OpenCodeSkillSourceDir
  OpenCode skill-discovery source directory. Defaults to <repo>/skill/opencode-skill-discovery.

.PARAMETER OpenCodeSkillsRoot
  Global OpenCode skills root. Defaults to $env:USERPROFILE\.config\opencode\skills.

.PARAMETER SkipBuild
  Copy files and update config without running npm ci / npm run build.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#>
[CmdletBinding()]
param(
  [string]$SourceBridgeDir = '',
  [string]$TargetDir = '',
  [string]$SkillDir = '',
  [string]$ConfigPath = '',
  [string]$OpenCodeSkillSourceDir = '',
  [string]$OpenCodeSkillsRoot = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$repoRoot = Split-Path -Parent $scriptDir
if (-not $SourceBridgeDir) { $SourceBridgeDir = (Join-Path $repoRoot 'bridge') }
if (-not $TargetDir) { $TargetDir = (Join-Path $env:USERPROFILE '.codex\codex-x-opencode-mcp') }
if (-not $SkillDir) { $SkillDir = (Join-Path $env:USERPROFILE '.agents\skills\codex-x-opencode-mcp') }
if (-not $ConfigPath) { $ConfigPath = (Join-Path $env:USERPROFILE '.codex\config.toml') }
if (-not $OpenCodeSkillSourceDir) { $OpenCodeSkillSourceDir = (Join-Path $repoRoot 'skill\opencode-skill-discovery') }
if (-not $OpenCodeSkillsRoot) { $OpenCodeSkillsRoot = (Join-Path $env:USERPROFILE '.config\opencode\skills') }

function Resolve-AbsolutePath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

$SourceBridgeDir = Resolve-AbsolutePath $SourceBridgeDir
if (-not (Test-Path -LiteralPath (Join-Path $SourceBridgeDir 'package.json'))) {
  throw "Bridge source not found: $SourceBridgeDir (expected package.json)"
}

$SkillTemplate = Resolve-AbsolutePath (Join-Path $repoRoot 'skill\codex-x-opencode-mcp\SKILL.md')
if (-not (Test-Path -LiteralPath $SkillTemplate)) {
  throw "Skill template not found: $SkillTemplate"
}

$OpenCodeSkillSourceDir = Resolve-AbsolutePath $OpenCodeSkillSourceDir
$OpenCodeSkillTemplate = Join-Path $OpenCodeSkillSourceDir 'SKILL.md'
$OpenCodeSkillIndexSource = Join-Path $OpenCodeSkillSourceDir 'skill-index.json'
if (-not (Test-Path -LiteralPath $OpenCodeSkillTemplate)) {
  throw "OpenCode skill template not found: $OpenCodeSkillTemplate"
}
if (-not (Test-Path -LiteralPath $OpenCodeSkillIndexSource)) {
  throw "OpenCode skill index template not found: $OpenCodeSkillIndexSource"
}
$openCodeFrontmatter = Get-Content -LiteralPath $OpenCodeSkillTemplate -Raw
if ($openCodeFrontmatter -notmatch '(?m)^name:\s*opencode-skill-discovery\s*$') {
  throw "OpenCode SKILL.md frontmatter must contain 'name: opencode-skill-discovery'."
}
if ($openCodeFrontmatter -notmatch '(?m)^description:\s*\S+') {
  throw 'OpenCode SKILL.md frontmatter must contain a non-empty description.'
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null

# Copy bridge source, excluding local build output and state.
# Build a single quoted argument string: Start-Process does not quote
# array elements, and both paths may contain spaces.
$robocopyArgString = "`"$SourceBridgeDir`" `"$TargetDir`" /E /NFL /NDL /NJH /NJS /NP /XF *.log /XD node_modules dist .codex-x-opencode-mcp"
$proc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $robocopyArgString -Wait -PassThru
$exitCode = $proc.ExitCode
if ($exitCode -ge 8) {
  throw "robocopy failed with exit code $exitCode"
}

if (-not $SkipBuild) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw 'Node.js is not on PATH. Install Node.js 22+ first: https://nodejs.org/' }
  $nodeVersion = (& node --version) -replace '^v', ''
  if ([version]$nodeVersion -lt [version]'22.0.0') {
    throw "Node.js 22+ is required (found v$nodeVersion)."
  }
  Push-Location -LiteralPath $TargetDir
  try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $TargetDir" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed in $TargetDir" }
  } finally {
    Pop-Location
  }
}

$entry = Join-Path $TargetDir 'dist\index.js'
if ((-not $SkipBuild) -and (-not (Test-Path -LiteralPath $entry))) {
  throw "Build output missing: $entry"
}

Copy-Item -Force -LiteralPath $SkillTemplate -Destination (Join-Path $SkillDir 'SKILL.md')

# Install the global OpenCode skill-discovery skill (touches only its own dir).
$OpenCodeSkillTargetDir = Join-Path $OpenCodeSkillsRoot 'opencode-skill-discovery'
New-Item -ItemType Directory -Force -Path $OpenCodeSkillTargetDir | Out-Null
Copy-Item -Force -LiteralPath $OpenCodeSkillTemplate -Destination (Join-Path $OpenCodeSkillTargetDir 'SKILL.md')
# Durable index: seed only when absent; never overwrite an existing categorized index.
$OpenCodeSkillIndexTarget = Join-Path $OpenCodeSkillTargetDir 'skill-index.json'
$openCodeIndexSeeded = $false
if (-not (Test-Path -LiteralPath $OpenCodeSkillIndexTarget)) {
  Copy-Item -Force -LiteralPath $OpenCodeSkillIndexSource -Destination $OpenCodeSkillIndexTarget
  $openCodeIndexSeeded = $true
} else {
  # Validate the accumulated index still parses; entries are never overwritten here.
  $null = (Get-Content -LiteralPath $OpenCodeSkillIndexTarget -Raw | ConvertFrom-Json)
}

# Resolve node executable for config.toml.
$nodeExe = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }

# Update Codex config: only the codex_x_opencode_mcp server block.
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Codex config not found: $ConfigPath"
}
$configBackup = "$ConfigPath.bak-codex-x-opencode-mcp"
Copy-Item -Force -LiteralPath $ConfigPath -Destination $configBackup

$text = Get-Content -LiteralPath $ConfigPath -Raw
if ($text -notmatch '\[mcp_servers\.codex_x_opencode_mcp\]') {
  $addition = @"

[mcp_servers.codex_x_opencode_mcp]
command = '$nodeExe'
args = ['$entry']

[mcp_servers.codex_x_opencode_mcp.env]
OPENCODE_WORKSPACE = '$TargetDir'
OPENCODE_HUB_JEV_ESTIMATE = '1'
"@
  $text += $addition
} else {
  # Replace command/args lines inside the existing server section only.
  $lines = Get-Content -LiteralPath $ConfigPath
  $out = New-Object System.Collections.Generic.List[string]
  $inSection = $false
  $inEnv = $false
  $hasWorkspaceEnv = $false
  foreach ($line in $lines) {
    if ($line -match '^\s*\[mcp_servers\.codex_x_opencode_mcp\.env\]') {
      $inSection = $true; $inEnv = $true
      $out.Add($line)
      continue
    }
    if ($line -match '^\s*\[mcp_servers\.codex_x_opencode_mcp\]') {
      $inSection = $true; $inEnv = $false
      $out.Add($line)
      continue
    }
    if ($line -match '^\s*\[mcp_servers\.[^\]]+\]') {
      if ($inSection -and $inEnv -and -not $hasWorkspaceEnv) {
        $out.Add("OPENCODE_WORKSPACE = '$TargetDir'")
        $hasWorkspaceEnv = $true
      }
      $inSection = $false; $inEnv = $false
      $out.Add($line)
      continue
    }
    if ($line -match '^\s*\[') {
      if ($inSection -and $inEnv -and -not $hasWorkspaceEnv) {
        $out.Add("OPENCODE_WORKSPACE = '$TargetDir'")
        $hasWorkspaceEnv = $true
      }
      $inSection = $false; $inEnv = $false
      $out.Add($line)
      continue
    }
    if ($inSection -and -not $inEnv -and $line -match '^\s*command\s*=') {
      $out.Add("command = '$nodeExe'")
      continue
    }
    if ($inSection -and -not $inEnv -and $line -match '^\s*args\s*=') {
      $out.Add("args = ['$entry']")
      continue
    }
    if ($inSection -and $inEnv -and $line -match '^\s*OPENCODE_WORKSPACE\s*=') {
      $out.Add("OPENCODE_WORKSPACE = '$TargetDir'")
      $hasWorkspaceEnv = $true
      continue
    }
    $out.Add($line)
  }
  if ($inSection -and $inEnv -and -not $hasWorkspaceEnv) {
    $out.Add("OPENCODE_WORKSPACE = '$TargetDir'")
  }
  $text = ($out -join "`r`n")
}
Set-Content -LiteralPath $ConfigPath -Value $text -Encoding UTF8

Write-Output "Installed runtime : $TargetDir"
Write-Output "Installed skill   : $SkillDir\SKILL.md"
Write-Output "Installed OpenCode skill : $OpenCodeSkillTargetDir\SKILL.md"
if ($openCodeIndexSeeded) {
  Write-Output "Seeded OpenCode skill index : $OpenCodeSkillIndexTarget"
} else {
  Write-Output "Kept existing OpenCode skill index : $OpenCodeSkillIndexTarget"
}
Write-Output "Updated config    : $ConfigPath (backup: $configBackup)"
Write-Output 'Restart Codex so the renamed MCP namespace codex_x_opencode_mcp reloads.'
