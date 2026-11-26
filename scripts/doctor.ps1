#requires -Version 7.0
[CmdletBinding()]
param()

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    Write-Output '[失败] Node.js · 需要 Node.js 22.13 或更高版本。'
    exit 1
}
$version = [version]((& $node.Source -p 'process.versions.node') -replace '-.*$', '')
if ($LASTEXITCODE -ne 0 -or $version -lt [version]'22.13.0') {
    Write-Output '[失败] Node.js · 需要 Node.js 22.13 或更高版本。'
    exit 1
}
$root = Split-Path -Parent $PSScriptRoot
& $node.Source (Join-Path $root 'src/sidecar/doctor.mjs')
exit $LASTEXITCODE
