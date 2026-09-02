# force-agent overlay: install the background service on Windows as a per-user
# Scheduled Task that runs at logon.
#
#   .\install.ps1              install and start
#   .\install.ps1 -Uninstall   stop and remove
#
# A Scheduled Task, not a Windows Service. A Windows Service runs in session 0
# under a service account: it would write its registration into that account's
# state directory, where the `force` you type in your own terminal cannot
# read it, so the TUI would never find the running server. A logon task runs as
# you, in your session, with your home directory - which is what the service
# discovery protocol assumes.
#
# `serve --service` runs in the foreground and registers itself, so the task
# scheduler supervises the real process.

[CmdletBinding()]
param(
  [switch]$Uninstall,
  # Same override chain as bin/force.cjs, most specific first: the current
  # LABHARNESS_ brand, the previous LABFY_ one, then POWER_, then upstream's
  # OPENCODE_. POWERAGENT_BIN is the older alias this installer accepted and still works.
  [string]$Binary = $(
    @($env:LABHARNESS_BIN_PATH, $env:LABFY_BIN_PATH, $env:POWER_BIN_PATH, $env:OPENCODE_BIN_PATH, $env:POWERAGENT_BIN) |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Select-Object -First 1
  )
)

$ErrorActionPreference = "Stop"
$taskName = "force-agent"

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Host "No '$taskName' task registered."
    return
  }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed the '$taskName' scheduled task."
  Write-Host "The server itself is still running until you run: force service stop"
  return
}

if ([string]::IsNullOrWhiteSpace($Binary)) {
  $command = Get-Command force -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw "force is not on PATH. Install it with 'npm i -g force-agent', or pass -Binary."
  }
  $Binary = $command.Source
}

# `npm i -g` puts force.cmd / force.ps1 on PATH, not the executable.
# The task scheduler cannot run a .ps1, and pointing it at the .cmd would leave a
# cmd.exe wrapper between the scheduler and the process it is meant to supervise.
# Resolve the real .exe the same way bin/force.cjs does at runtime: ask Node
# to resolve the platform package, starting from the directory the shim lives in.
if ($Binary -match '\.(cmd|bat|ps1)$') {
  $from = Split-Path -Parent $Binary
  $resolver = "const path=require('path');" +
    "const m=require.resolve('@force-agent/cli-windows-x64/package.json',{paths:[process.argv[1]]});" +
    "console.log(path.join(path.dirname(m),'bin','force.exe'))"
  $resolved = & node -e $resolver $from 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolved)) {
    throw "Could not resolve @force-agent/cli-windows-x64 from $from. Pass -Binary with the path to force.exe."
  }
  $Binary = $resolved.Trim()
}

$Binary = (Resolve-Path $Binary).Path
Write-Host "Using $Binary"

$action = New-ScheduledTaskAction -Execute $Binary -Argument "serve --service" -WorkingDirectory $env:USERPROFILE
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Defaults that make sense for a desktop agent: never stop it for running long,
# never suspend it on battery, and retry a few times if it dies.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
# S4U, not Interactive. The compiled binary is a console application: an
# interactive logon task would pop a console window on every logon. S4U runs it
# as you, with your USERPROFILE - so the same XDG state directory, the same
# service registration file, the same 127.0.0.1 port your terminal talks to -
# but with no window and no stored password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "force agent background service" -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Registered and started the '$taskName' scheduled task."
Write-Host "Check it with: force service status"
