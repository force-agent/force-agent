# Running force agent as a background service

## What the CLI already does

`force` v2 already runs its server as a background process and already
manages it:

```sh
force service start     # start it (prints the URL); idempotent
force service status    # print the URL, or "stopped"
force service restart   # replace it, preserving persistent terminals
force service stop      # stop it
force service get|set|unset   # hostname, port, password, env
```

`service start` spawns a detached server and returns. It survives the terminal
that started it, but nothing brings it back after a reboot or a logout. That is
the only gap these files close: **start at login, restart on failure**.

## Install

```sh
# Linux (systemd user unit) and macOS (launchd LaunchAgent)
bash install.sh
bash install.sh --uninstall
```

```powershell
# Windows (per-user Scheduled Task, at logon)
.\install.ps1
.\install.ps1 -Uninstall
```

Each installer resolves `force` on `PATH`; override with
`FORCE_AGENT_BIN_PATH` (the same variable the bin shim honors — `LABFY_BIN_PATH`,
`POWER_BIN_PATH`, `OPENCODE_BIN_PATH` and the older `POWERAGENT_BIN` are still
honored, in that order)
(`-Binary` on Windows). All three install a **per-user** service on purpose: the
server publishes its URL and credential into the user's state directory, and the
`force` you type in a terminal looks for it there. A system-wide daemon
would write that registration somewhere your own commands cannot read, so the
TUI would never find the running server.

All three run `force serve --service`, which runs the server in the
foreground and registers it, so the init system supervises the real process.
Never point an init system at `service start` - that spawns a detached child and
exits, and the supervisor would restart it forever.

## What each one installs

| Platform | Unit                        | Location                                             |
| -------- | --------------------------- | ---------------------------------------------------- |
| Linux    | systemd user unit           | `~/.config/systemd/user/force-agent.service`          |
| macOS    | launchd LaunchAgent         | `~/Library/LaunchAgents/com.force-agent.agent.plist`  |
| Windows  | Scheduled Task `force-agent` | Task Scheduler, `\force-agent`                        |

### Linux

```sh
systemctl --user status force-agent
journalctl --user -u force-agent -f
sudo loginctl enable-linger "$USER"   # keep it running after you log out
```

Without lingering, systemd tears down your user manager at logout and takes the
service with it.

### macOS

```sh
launchctl print "gui/$(id -u)/com.force-agent.agent"
tail -f "${XDG_STATE_HOME:-$HOME/.local/state}/force-agent/log/force-agent.err.log"
```

### Windows

```powershell
Get-ScheduledTask -TaskName force-agent | Get-ScheduledTaskInfo
force service status
```

The task runs with an S4U principal so the console binary starts without a
window. If your account is denied the batch-logon right and registration fails,
re-register with `-LogonType Interactive` in `install.ps1`; the trade-off is a
console window at logon.

## Without an init system

A container, a minimal image, or a machine where you would rather not install
anything:

```sh
force service start        # detached, survives the shell
nohup force serve --service > /var/log/force-agent.log 2>&1 &   # foreground, your own supervision
```

In a container, `force serve --service` as PID 1 is the right shape: the
container runtime is the supervisor.

## Binding somewhere other than localhost

The server refuses a reachable interface unless a password is configured - an
ephemeral credential on a reachable port is an open server. Configure both
before changing the bind:

```sh
force service set password "$(openssl rand -base64 32)"
force service set hostname 0.0.0.0
force service restart
```

## Vindo do nome antigo

Uma instalação feita quando o produto se chamava `labharness` continua rodando:
a unidade antiga aponta para o binário por caminho e nada nela quebra com o
rename. Ela também não é substituída — os instaladores acima criam
`force-agent`, então os dois passam a existir e a disputar a mesma porta. Remova
a antiga antes de instalar a nova:

```
systemctl --user disable --now labharness            # Linux
launchctl bootout "gui/$(id -u)/com.labharness.agent" # macOS
Unregister-ScheduledTask -TaskName labharness         # Windows
```
