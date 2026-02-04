<img src="https://delhi.lunel.dev/og/og.png" alt="Lunel" style="max-width: 500px; margin-bottom: 20px;" />

AI-powered mobile IDE and cloud development platform. Code on your phone, run on your machine or in secure cloud sandboxes.

## Structure

| Directory | Description |
|-----------|-------------|
| `app/` | Expo/React Native mobile app |
| `cli/` | CLI tool (`lunel-cli`) |
| `gateway/` | WebSocket proxy server |
| `sandman/` | Firecracker VM manager daemon |

## App

Mobile app for iOS/Android/Web built with Expo.

- File explorer and editor
- Git integration
- Terminal emulator
- Process management

## CLI

Node.js CLI that bridges your local machine to the app via WebSocket.

- Filesystem operations (read, write, grep, etc.)
- Git commands (status, commit, push, pull, etc.)
- Terminal spawning
- Process management
- Port scanning
- System monitoring (CPU, memory, disk, battery)

```bash
npx lunel-cli
```

## Gateway

Bun-based WebSocket relay server that connects CLI and app using session codes.

- Session management with 10-min TTL
- Dual-channel architecture (control + data)
- QR code pairing

## Sandman

Go daemon that manages Firecracker microVMs for sandboxed workloads.

- VM lifecycle management (create, run, delete)
- Resource allocation (CPU pinning, RAM, storage)
- Network isolation (TAP devices, NAT)
- State persistence across restarts

## License

FSL-1.1-Apache-2.0
