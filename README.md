<div align="center">
  <a href="https://lunel.dev">
    <img src="./logo-ornate.png" alt="Lunel" width="600" />
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
