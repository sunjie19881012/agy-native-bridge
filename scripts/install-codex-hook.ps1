#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Install', 'Uninstall')]
    [string]$Action = 'Install',
    [string]$CodexHome = $env:CODEX_HOME,
    [string]$HookPath
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$profileDirectory = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
if (-not $CodexHome) { $CodexHome = Join-Path $profileDirectory '.codex' }
if (-not $HookPath) {
    $HookPath = Join-Path $profileDirectory '.gemini/config/plugins/agy-native-bridge/src/hooks/codex-pipe-hook.mjs'
}
$CodexHome = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CodexHome)
$HookPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($HookPath)
$file = Join-Path $CodexHome 'hooks.json'
if (-not $PSCmdlet.ShouldProcess($file, "$Action agy-native-bridge 管道发现 Hook")) { return }

$ownedCommand = '[/\\]codex-pipe-hook\.mjs" --agy-native-bridge-hook$'
$exists = Test-Path -LiteralPath $file -PathType Leaf
if ($exists) {
    $original = [System.IO.File]::ReadAllText($file)
    $document = ConvertFrom-Json -InputObject $original -AsHashtable -Depth 100
    if ($document -isnot [System.Collections.IDictionary]) { throw 'hooks.json 需要 JSON 对象。' }
} elseif ($Action -eq 'Uninstall') {
    return
} else {
    $document = [ordered]@{}
}
if (-not $document.Contains('hooks')) {
    if ($Action -eq 'Uninstall') { return }
    $document['hooks'] = [ordered]@{}
}
$hooks = $document['hooks']
if ($hooks -isnot [System.Collections.IDictionary]) { throw 'hooks.json 的 hooks 字段需要 JSON 对象。' }

if ($Action -eq 'Install') {
    if (-not (Test-Path -LiteralPath $HookPath -PathType Leaf)) { throw "Hook 脚本不存在，路径为 $HookPath" }
    $handler = [ordered]@{
        type = 'command'
        command = 'node "' + $HookPath + '" --agy-native-bridge-hook'
        async = $true
        timeout = 6
    }
}

$changed = $false
foreach ($eventName in @('SessionStart', 'UserPromptSubmit')) {
    if ($hooks.Contains($eventName) -and $hooks[$eventName] -isnot [array]) {
        throw "hooks.json 的 $eventName 字段需要 JSON 数组。"
    }
    $groups = $hooks[$eventName]
    $keptGroups = [System.Collections.Generic.List[object]]::new()
    $owned = @()
    $alreadyRegistered = $false
    foreach ($group in $groups) {
        if ($group -isnot [System.Collections.IDictionary] -or $group['hooks'] -isnot [array]) {
            throw "hooks.json 的 $eventName Hook 组格式有误。"
        }
        $kept = [System.Collections.Generic.List[object]]::new()
        $removed = $false
        foreach ($entry in $group['hooks']) {
            if ($entry -is [System.Collections.IDictionary] -and $entry['type'] -eq 'command' -and $entry['command'] -match $ownedCommand) {
                $owned += $entry
                $removed = $true
                if ($Action -eq 'Install' -and $group['hooks'].Count -eq 1 -and -not $group.Contains('matcher') -and
                    -not $entry.Contains('commandWindows') -and $entry['command'] -ceq $handler['command'] -and
                    $entry['async'] -eq $true -and $entry['timeout'] -eq $handler['timeout']) {
                    $alreadyRegistered = $true
                }
            } else {
                $kept.Add($entry)
            }
        }
        if ($removed -and $kept.Count -eq 0) { continue }
        if ($removed) {
            $copy = [ordered]@{}
            foreach ($key in $group.Keys) { $copy[$key] = $group[$key] }
            $copy['hooks'] = $kept.ToArray()
            $keptGroups.Add($copy)
        } else {
            $keptGroups.Add($group)
        }
    }
    if ($Action -eq 'Install') {
        if ($owned.Count -eq 1 -and $alreadyRegistered) { continue }
        $keptGroups.Add([ordered]@{ hooks = @($handler) })
    } elseif ($owned.Count -eq 0) {
        continue
    }
    $hooks[$eventName] = $keptGroups.ToArray()
    $changed = $true
}

if (-not $changed) { return }
New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
$temporary = Join-Path $CodexHome ('.agy-native-bridge.' + [guid]::NewGuid() + '.tmp')
$json = (ConvertTo-Json -InputObject $document -Depth 100) + [Environment]::NewLine
[System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
if ($exists) {
    if ([System.IO.File]::ReadAllText($file) -cne $original) { throw 'hooks.json 刚被其他程序更新，请重新执行。' }
    $backup = $file + '.agy-native-bridge.' + [guid]::NewGuid() + '.bak'
    [System.IO.File]::Replace($temporary, $file, $backup)
    Write-Output "旧版 hooks.json 备份在 $backup。"
} else {
    [System.IO.File]::Move($temporary, $file)
}
Write-Output "已更新 $file。"
