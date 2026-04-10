# Lunel fix plan

## Current status
- Completed code clusters:
  - lower-layer security/bootstrap hardening
  - session lifecycle and background reconnect handling changes
  - OpenCode fetch normalization
  - mobile thinking toggle visibility
  - port-close behavior follow-up to clear proxy tracking along with process kill
- Verified so far:
  - CLI local build passes
  - manager local typecheck passes
  - proxy local typecheck passes
  - app dependency install succeeds with `NPM_CONFIG_LEGACY_PEER_DEPS=true`
  - app editor webview build passes
- Remaining execution path:
  1. uninstall old global `lunel-cli`
  2. relink and verify local `lunel-cli`
  3. generate Android native project and build release APK
  4. copy only the final `.apk` to `/home/dhruvkejri1/lucel-builds`
  5. run end-to-end validation for the requested flows
  6. run final senior-review pass and fix any findings

## Goal
Fix all user-reported issues plus GitHub issues #6, #8, #10, #11, and #13, then rebuild `lunel-cli` locally and produce the Android APK.

## Confirmed scope
1. Mobile port close currently respawns instead of staying suspended/stopped.
2. QR code / session fetch timeout must be 60 seconds where required.
3. OpenCode sessions fail with `Failed to parse URL from [object Request]`.
4. GitHub issues: #6, #8, #10, #11, #13.
5. Mobile AI panel is missing the thinking toggle for Codex and OpenCode sessions.
6. Rebuild local `lunel-cli`, uninstall the currently installed one, and build Android APK.
7. Copy only the APK into `/home/dhruvkejri1/lunel-builds`.
8. Port close still reappears after a brief disappearance and needs a real end-to-end fix.
9. OpenCode mode/reasoning UI is incomplete and should expose the supported model/backend-specific options.
10. OpenCode should use a dropdown-based selector like Codex, not a separate on/off thinking toggle.
11. The app should restore the last active OpenCode model and mode from the session.
12. QR-based CLI pairing became slower than upstream and needs investigation.
13. OpenCode build mode currently causes an APIError.

## Execution order
1. Boundary/security fixes
   - sandbox path validation (#8)
   - remove password-in-query flows
   - replay protection for encrypted transport
   - origin validation for WebSocket upgrades
   - restrict wildcard CORS
   - validate git paths and tighten HTTP request surface
2. Spawn/bootstrap fixes
   - PTY integrity verification (#10)
   - Windows DEP0190 fix (#6)
   - process/env hardening from #11
3. Session lifecycle fixes
   - manager health probe should not close active V2 transport (#13)
   - mobile port close should not respawn
   - Android app backgrounding should not immediately disconnect the session
   - coding session should survive app disconnect/backgrounding; session persistence may need tmux-backed terminal/process retention if the current implementation tears sessions down
   - OpenCode session listing/fetch fix
4. Timeout and UI contract fixes
    - 60 second QR/session fetch timeout alignment
    - thinking toggle support and visibility for mobile AI sessions
    - full OpenCode mode/reasoning chooser instead of only on/off
    - remove the redundant OpenCode on/off thinking toggle in favor of dropdown-based selection
    - restore last OpenCode model/mode from session state
    - fix OpenCode build-mode API error
    - investigate and reduce QR-based CLI connect latency relative to upstream
5. Final build + verification
    - uninstall global `lunel-cli`
    - rebuild and reinstall local `lunel-cli`
    - build Android APK
    - place APK in `/home/dhruvkejri1/lunel-builds`

## Branch plan
- `fix/security-bootstrap` for lower-layer security/bootstrap changes
- stacked follow-up branch for session/mobile/UI fixes after lower layer is stable

## Validation plan
- Run diagnostics/type checks on touched files
- Run package builds/tests that exist for CLI / app / manager / proxy / pty
- Smoke test affected flows after each cluster
- Run end-to-end validation for all user-reported fixes, including disconnect/background behavior
- Perform a senior-engineer review pass and address review findings before finishing
- Final local build verification for CLI and Android APK
