#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param()

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$profileDirectory = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$destination = Join-Path $profileDirectory '.gemini/config/plugins/agy-native-bridge'

if (-not $PSCmdlet.ShouldProcess($destination, '安装 agy-native-bridge 插件及 Node 依赖')) { return }

$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$npm = Get-Command npm
$nodeVersion = [version]((& $node -p 'process.versions.node') -replace '-.*$', '')
if ($LASTEXITCODE -ne 0 -or $nodeVersion -lt [version]'22.13.0') {
    throw '需要 Node.js 22.13 或更高版本。'
}

$files = @('README.md', 'package.json', 'package-lock.json', 'plugin.json', 'mcp_config.json', 'hooks.json',
    'scripts/doctor.ps1', 'scripts/101-turn-watcher.mjs', 'scripts/101-local-relay.mjs')
foreach ($directory in @('src', 'skills', 'sidecars', 'configs', 'docs')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $source $directory) -Recurse -File |
        ForEach-Object { [System.IO.Path]::GetRelativePath($source, $_.FullName) }
}
foreach ($relative in $files) {
    $file = Join-Path $destination $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $file
}

Push-Location -LiteralPath $destination
try {
    & $npm install --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund --update-notifier=false
    if ($LASTEXITCODE -ne 0) { throw '插件依赖安装失败。' }
} finally {
    Pop-Location
}
Write-Output "插件已同步到 $destination。"
