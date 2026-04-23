<div align="center">
  <a href="https://lunel.dev">
    <picture>
      <source srcset="https://lunel.dev/img/github/github-main-dark.png" media="(prefers-color-scheme: dark)" width="600">
      <source srcset="https://lunel.dev/img/github/github-main-light.png" media="(prefers-color-scheme: light)" width="600">
      <img src="https://lunel.dev/img/github/github-main-dark.png" alt="Lunel">
    </picture>
  </a>
</div><br />
<p align="center">AI-powered mobile IDE and cloud development platform. Code on your phone, run on your machine or in secure cloud sandboxes.</p> <br />

## Structure

| Directory | Description |
|-----------|-------------|
| `app/` | Expo/React Native mobile app |
| `cli/` | CLI tool (`lunel-cli`) |
| `manager/` | Manager server |
| `proxy/` | Proxy server |
| `pty/` | Rust PTY binary uses wezterm internal libs for rendering |

<br />

## Usage

This can be used in two ways, both are for coding:

- Lunel Connect: One is when you want to remotely use pc without dealing with ssh and shit, geared towards coding
- Lunel Cloud: Coming soon

<br /> 

## App

Mobile app for iOS/Android/Web built with Expo. App is just a dumb client with most logic on cli and app just acting as a rendering client.

- File explorer and editor
- Git integration
- Terminal emulator
- Process management

<br />

## CLI

Node.js CLI that bridges your local machine to the app via WebSocket. Can be ran using `npx lunel-cli`

- Filesystem operations (read, write, grep, etc.)
- Git commands (status, commit, push, pull, etc.)
- Terminal spawning
- Process management
- Port scanning
- System monitoring (CPU, memory, disk, battery)

```bash
npx lunel-cli
```

<br />

## Manager and Proxy

Bun-based WebSocket relay server that connects CLI and app using session codes. Public verion deployed on gateway.lunel.dev

- Session management with 10-min TTL
- Dual-channel architecture (control + data)
- QR code pairing

<br />

## Remote Server Mode

If you are already using the hosted relay at `manager.xwserver.top` + `gateway.xwserver.top`, do not use the `local:*` scripts below.
Use the remote CLI supervisor instead:

```powershell
npm run remote:start
npm run remote:status
npm run remote:ensure
```

What it does:

- keeps a single managed remote CLI for this repo root
- reuses a repo-scoped app data directory under `%ProgramData%\erkai\remote-cli\...` so saved mobile sessions survive restarts without polluting the git worktree
- kills stale orphaned `node dist/index.js` processes before relaunch
- writes runtime state and logs under `%TEMP%\erkai-remote-cli`

Useful commands:

```powershell
npm run remote:window
npm run remote:restart
npm run remote:stop
```

- `remote:start` starts the CLI in the background when a saved repo session already exists
- `remote:window` opens a visible window for QR pairing or live debugging
- `remote:ensure` is safe to run repeatedly; it only restarts when the managed CLI is unhealthy
- `remote:autostart:install` installs a current-user Scheduled Task that directly runs the long-lived `watch` supervisor at logon
- `remote:boot:install` opens a UAC prompt and installs the stronger `SYSTEM + AtStartup` task for true boot-time recovery
- `remote:autostart:status` shows the managed Scheduled Task wiring and whether the old Startup shortcut still exists

Windows Explorer launchers:

```text
scripts\start-remote-cli.cmd
scripts\open-remote-cli-window.cmd
scripts\status-remote-cli.cmd
scripts\stop-remote-cli.cmd
scripts\install-remote-cli-autostart.cmd
scripts\install-remote-cli-boot-start.cmd
scripts\status-remote-cli-autostart.cmd
```

This mode is intended for the public remote relay. The actual code still runs on your PC from the current repo root; `manager` and `proxy` are only the relay layer.
The recommended steady-state wiring is a single Scheduled Task that runs `scripts\remote-cli.ps1 watch` directly. Avoid keeping both a Startup shortcut and a Scheduled Task enabled at the same time, or you risk duplicate supervisors fighting each other.

<br />

## Local Loopback Development

Windows local self-host flow is now scripted for `manager + proxy`.

```powershell
npm run local:start:fresh
npm run local:status
npm run local:stop
```

One-click env injection and launch:

```powershell
npm run local:env
npm run local:cli:dev
npm run local:cli:window
npm run local:cli:shell
npm run local:app:start
npm run local:app:window
npm run local:app:shell
```

Phone / LAN development on the same Wi-Fi:

```powershell
npm run local:lan:start:fresh
npm run local:lan:env
npm run local:lan:app:start
npm run local:lan:firewall:install
```

`local:lan:*` auto-detects the primary LAN IPv4 address and injects that address instead of `127.0.0.1`.
Use this mode only with the repo app / Expo build. A prebuilt official app that is hard-coded to `gateway.lunel.dev` will not switch to your local machine automatically.
If `8899` or `3000` is already occupied, `local-dev.ps1` automatically walks forward to the next free port (`+1`, then `+2`, etc.), writes the resolved URLs to `%TEMP%\erkai-local-dev\stack-state.json`, and `local:status` / `local:env` will show the real ports in use.
The local launcher now binds `manager` and `proxy` to the resolved host address only, so loopback mode stays on `127.0.0.1` and LAN mode stays on the detected private IP instead of listening on every interface.
If Windows Defender blocks phone access, start the LAN stack first and then run `npm run local:lan:firewall:install` once so the firewall rules follow the resolved manager/proxy ports plus the Expo dev ports.

Windows Explorer double-click launchers:

```text
scripts\start-local-stack.cmd
scripts\open-local-cli.cmd
scripts\open-local-app.cmd
scripts\stop-local-stack.cmd
scripts\start-local-lan-stack.cmd
scripts\open-local-lan-cli.cmd
scripts\open-local-lan-app.cmd
scripts\stop-local-lan-stack.cmd
scripts\install-local-lan-firewall.cmd
scripts\install-local-shortcuts.cmd
```

These `.cmd` launchers do not require `make`. `start-local-stack.cmd` boots a fresh local manager/proxy stack, while `open-local-cli.cmd` and `open-local-app.cmd` open new PowerShell windows with the correct loopback env already injected.
The matching `*-lan-*` launchers do the same thing with the auto-detected LAN IP for phone testing. `install-local-lan-firewall.cmd` prompts for admin rights and installs the required private-network firewall rules.

Desktop shortcut installer:

```powershell
npm run local:shortcuts:install
npm run local:shortcuts:list
npm run local:shortcuts:remove
```

`local:shortcuts:install` creates eight `.lnk` files on the current user's desktop:

- `Lunel Local Start`
- `Lunel Local CLI`
- `Lunel Local App`
- `Lunel Local Stop`
- `Lunel LAN Start`
- `Lunel LAN CLI`
- `Lunel LAN App`
- `Lunel LAN Stop`
- `Lunel LAN Firewall`

Before opening CLI or App windows, the launcher now checks:

- `node` is available and version `>= 18`
- `npm` is available in `PATH`
- `cli\node_modules` and `cli\node_modules\.bin\tsc.cmd` exist
- `app\node_modules` and `app\node_modules\.bin\expo.cmd` exist

If a dependency is missing, the launcher stops immediately and prints the exact fix command to run.

Phone testing note:

- `127.0.0.1` only works on the same machine
- for a physical phone, use `local:lan:*` so the phone connects to your PC's LAN IP instead

Equivalent direct PowerShell entry:

```powershell
pwsh -File .\scripts\local-dev.ps1 start -FreshManager
pwsh -File .\scripts\local-dev.ps1 status
pwsh -File .\scripts\local-dev.ps1 stop
```

Generic env wrapper:

```powershell
pwsh -File .\scripts\local-env.ps1 show
pwsh -File .\scripts\local-env.ps1 cli-exec -CommandLine 'npm run dev'
pwsh -File .\scripts\local-env.ps1 app-exec -CommandLine 'npm run start'
```

Defaults:

- Manager: `http://127.0.0.1:8899`
- Proxy: `http://127.0.0.1:3000`
- Admin password: generated on first run and stored under `%TEMP%\erkai-local-dev\stack-secrets.json` unless you pass `-ManagerAdminPassword` or set `LUNEL_LOCAL_MANAGER_ADMIN_PASSWORD`
- Proxy password: generated on first run and stored under `%TEMP%\erkai-local-dev\stack-secrets.json` unless you pass `-ProxyPassword` or set `LUNEL_LOCAL_PROXY_PASSWORD`
- Admin JWT signing secret: generated independently by `manager` and persisted next to `MANAGER_DB_PATH` unless you set `MANAGER_ADMIN_TOKEN_SECRET` or `MANAGER_ADMIN_TOKEN_SECRET_PATH`
- Runtime logs and PID files: `%TEMP%\erkai-local-dev`

The script will:

- start `manager` and `proxy` with loopback-safe `http/ws` URLs
- bind each service only to the requested host address instead of all interfaces
- if a requested manager/proxy port is busy, shift to the next free port and persist that choice to the runtime state
- wait for `/health` on both services
- log in to the manager and register the local proxy automatically
- verify `connectedProxies >= 1` and `managerReachable = true`

Optional deployment hardening:

- `MANAGER_BIND_HOST` / `PROXY_BIND_HOST`: pin the listener to a specific interface
- `MANAGER_CORS_ALLOW_ORIGIN` / `PROXY_CORS_ALLOW_ORIGIN`: replace the default `*` CORS origin with a fixed browser origin
- `MANAGER_ADMIN_TOKEN_SECRET` or `MANAGER_ADMIN_TOKEN_SECRET_PATH`: keep admin JWT signing separate from the login password
- `npm run check:servers`: run the current `manager` + `proxy` TypeScript checks from the repo root

To point the CLI at the local stack:

```powershell
$env:LUNEL_MANAGER_URL='http://127.0.0.1:8899'
$env:LUNEL_PROXY_URL='http://127.0.0.1:3000'
cd .\cli
npm run dev
```

To point the Expo app at the local stack:

```powershell
$env:EXPO_PUBLIC_LUNEL_MANAGER_URL='http://127.0.0.1:8899'
$env:EXPO_PUBLIC_LUNEL_PROXY_URL='http://127.0.0.1:3000'
cd .\app
npm run start
```

<br />

## PTY

Rust binary for pseudo-terminal management, used by the CLI.

- Real PTY sessions via `wezterm` fork on github.com/sohzm/wezterm
- Screen buffer as cell grid (char + fg + bg per cell)
- 24fps render loop (only sends updates when content changes)
- JSON line protocol over stdin/stdout

<br />

## 📄 License

MIT: See [LICENSE](LICENSE) for details.

<br />

## Star History

<a href="https://www.star-history.com/#lunel-dev/lunel&Timeline">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=lunel-dev/lunel&type=Timeline&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=lunel-dev/lunel&type=Timeline" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=lunel-dev/lunel&type=Timeline" />
 </picture>
</a>
