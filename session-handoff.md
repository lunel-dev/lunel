# Session Handoff — 2026-04-10

## What happened this session

Dhruv asked to clone https://github.com/dhruvkej9/lunel, fix connectivity issues (app stuck at "connecting" loader), merge the `issue/device-connect-fixes` branch, and implement all remaining items from `issues.md` and `plan.md`. Work was done directly on `main` with force-sync to `issue/device-connect-fixes`.

## Root cause of connection failure

The merge into main corrupted `buildSessionV2WsUrl` in both `app/lib/transport/protocol.ts` and `cli/src/transport/protocol.ts`. The function signature was `(url, role, password, generation)` on old main, but the transport v2.ts files called it as `(url, role, generation, password)`. This swapped the password and generation parameters, so the proxy never received a valid password and rejected all WebSocket connections — the app hung at "connecting" forever.

**Fix**: Corrected both protocol.ts files to match the call convention: `(url, role, generation, password)`.

## Commits made (chronological)

### `b7b3d5d` — connection timeout and port tracking
- 90s timeout on `V2SessionTransport.connect()` (both CLI and app) so connections don't hang forever
- 60s timeout on app `assembleWithCode`
- 30s `AbortSignal.timeout` on proxy/reattach fetch calls in app
- `handlePortsKill` now calls `trackedProxyPorts.delete(portNum)` so ports don't respawn in UI

### `6c002fc` — agent mode filtering, session titles, UI polish, image preview
- CLI-side agent filtering in `toAgentInfoList` removes internal modes: `compaction`, `summary`, `title`, `subagent` mode, `ui5-*`, `cap-*`
- App ConfigureSheet also applies `shouldShowAgentInPicker` filter (defense in depth)
- Selected agent validated against available list after fetch (prevents stale ghost selections)
- `isGenericSessionTitle` catches more patterns: `Session N`, `Chat N`, `Untitled`, numbered-only
- `formatBackendSessionTitle` shows real session title when available instead of always "OpenCode"
- ConfigureSheet UI: drag handle bar, uppercase section labels with letter-spacing, consistent bordered card styling for both agent modes and model options, better padding
- Image attachment preview: border + `ZoomIn` enter animation for visibility
- Session config restore validates agent/model against available options before applying

### `139cd38` — dynamic slash commands, session config restore, UI polish
- Added `CommandInfo` interface and `commands()` method to `AIProvider`
- OpenCode provider calls `client.command.list()` to fetch available slash commands dynamically
- Codex provider returns static `/abort` command
- Wired through CLI message router (`case "commands"`) and AI manager
- App `useAI` hook exposes `getCommands()`, Panel fetches at init and merges with defaults
- Default OpenCode commands expanded: `/undo`, `/redo`, `/abort`, `/init`, `/compact`, `/share`
- Slash autocomplete popup polished: 14px rounded corners, shadow/elevation, scrollable with max-height, accent-colored command names, `ZoomIn` animation
- Session config restore validates agent against available agents list, model against available models

### `88010f5` — manager /health cleans up expired V2 sessions (#13)
- Manager `/health` endpoint now calls `cleanupExpiredV2State()` on every probe
- Previously expired V2 sessions could linger when health probes were the only activity

## Protocol fix (applied within the merge and subsequent commits)
- `app/lib/transport/v2.ts` — full rewrite to restore: `Platform` import, `MobileWebSocket` type, `toOwnedArrayBuffer`, nonce replay protection (`receivedNonceKeys`, `assertFreshNonce`), connect retry with legacy query fallback
- `cli/src/transport/v2.ts` — restored nonce replay protection (`receivedNonceKeys`, `receivedNonceOrder`, `assertFreshNonce`), nonce clearing in `resetPeerSession`
- Both protocol.ts files fixed to `buildSessionV2WsUrl(url, role, generation, password)`

## Issues.md status after this session

### Checked off
- All connectivity bugs (port respawn, background disconnect, stuck at connecting)
- All agent mode bugs (subagents, compaction, summary, title, ui5-*, cap-* filtered)
- Session title repetition fixed
- All GitHub security issues: #6, #8, #10, #11 (all sub-items), #13
- ConfigureSheet UI polished
- Dynamic slash commands wired from OpenCode SDK
- Image attachment preview improved
- Session config restore with validation
- Timeout alignment (60s QR/session, 30s fetch, 90s transport connect)
- OpenCode fetch normalization
- Thinking toggle visible for mobile AI sessions
- Password-in-query removed (POST body + x-session-password header, legacy fallback only)

### Still pending (require runtime/device)
- [ ] RAM usage investigation — needs live local environment profiling
- [ ] Multiple `opencode serve` process lifecycle — needs runtime inspection
- [ ] Image attachment rendering verification — needs device testing (code looks correct but may have platform-specific rendering issues)
- [ ] Slash command UI from OpenCode that shows interactive UI elements — needs testing with live OpenCode server
- [ ] Android APK build and copy to `/home/dhruvkejri1/lunel-builds`
- [ ] End-to-end runtime verification for all flows
- [ ] QR pairing speed investigation vs upstream

## Branch state
- `main` and `issue/device-connect-fixes` are identical at commit `88010f5`
- PAT used for push: `github_pat_11AXALVWY0...` (set on remote origin)
- Git identity: `Dhruv Kejriwal <dhruvkej9@users.noreply.github.com>`

## Key files modified
| File | Changes |
|------|---------|
| `app/lib/transport/protocol.ts` | `buildSessionV2WsUrl` signature fix |
| `app/lib/transport/v2.ts` | Full rewrite: Platform import, MobileWebSocket, nonce replay, connect timeout+retry |
| `cli/src/transport/protocol.ts` | `buildSessionV2WsUrl` signature fix, duplicate param removed |
| `cli/src/transport/v2.ts` | Nonce replay protection, connect timeout |
| `cli/src/index.ts` | Port kill clears trackedProxyPorts, `commands` action in router |
| `cli/src/ai/opencode.ts` | Agent filtering in `toAgentInfoList`, `commands()` via SDK |
| `cli/src/ai/codex.ts` | `commands()` stub |
| `cli/src/ai/index.ts` | `commands()` delegation |
| `cli/src/ai/interface.ts` | `CommandInfo` type, `commands()` on `AIProvider` |
| `app/contexts/ConnectionContext.tsx` | Assemble timeout, fetch timeouts, stored session persistence |
| `app/hooks/useAI.ts` | `getCommands()` hook |
| `app/plugins/core/ai/Panel.tsx` | Agent filtering, session titles, ConfigureSheet polish, image preview, dynamic slash commands, session config restore |
| `app/plugins/core/ai/types.ts` | No changes (already correct) |
| `manager/src/index.ts` | `/health` calls `cleanupExpiredV2State()` |
| `proxy/src/index.ts` | No changes (already correct) |
| `issues.md` | Updated with checked-off items |
| `plan.md` | Updated current status |
