# Lunel issues checklist

## Current progress snapshot
- Implemented and verified in code:
  - [x] V2 transport connect timeout (90s) prevents stuck-at-connecting
  - [x] `buildSessionV2WsUrl` parameter order fix (root cause of connection failure)
  - [x] Port close clears `trackedProxyPorts` so ports don't respawn
  - [x] App assembleWithCode timeout (60s)
  - [x] Fetch timeouts (30s) on proxy/reattach API calls
  - [x] Nonce replay protection restored in both transports
  - [x] Android background/session lifecycle handling — app no longer disconnects on background
  - [x] Stored-session persistence via SecureStore + AsyncStorage fallback
  - [x] QR/session fetch timeout alignment to 60 seconds
  - [x] OpenCode fetch normalization for `Failed to parse URL from [object Request]`
  - [x] Visible thinking toggle in the mobile AI panel
  - [x] CLI-side agent filtering removes internal/subagent entries before sending to app
  - [x] App-side ConfigureSheet also filters agents (defense in depth)
  - [x] Selected agent validation after fetch (prevents stale selection)
  - [x] Session title detection improved — catches more generic patterns
  - [x] formatBackendSessionTitle now shows real title when available
  - [x] ConfigureSheet UI polish — handle bar, consistent card styling, better typography
  - [x] GitHub issue fixes: #6, #8, #10, #11, #13
- Build verified:
  - [x] `cli/`: `npm install` and `npm run build`
- Still pending:
  - [ ] Android prebuild + release APK build
  - [ ] End-to-end runtime verification for mobile/session/AI flows
  - [ ] Image attachment visibility in chat UI
  - [ ] Slash commands for both backends

## User-reported bug
- [x] Bug: clicking the cross on a mobile app port does not suspend/stop it; the port respawns in the UI instead.
- [x] Bug: the session disconnects as soon as the Android app goes into the background.
- [x] Requirement: the coding session should not end just because the mobile app disconnects or backgrounds.
- [x] Bug: the port close icon still only hides the port briefly and it reappears.
- [x] Bug: the OpenCode thinking/mode chooser is incomplete and only shows on/off instead of model/backend-specific options.
- [x] Requirement: OpenCode should use a dropdown-based reasoning/mode selector like Codex instead of a separate on/off toggle.
- [ ] Bug: the app does not restore the last active OpenCode model and mode from the session.
- [ ] Bug: QR-based CLI pairing is now slower than the original upstream behavior.
- [ ] Bug: using OpenCode build mode can trigger an APIError.

## User requirements for this pass
- [x] QR code / session fetch timeout is 60 seconds where required.
- [x] OpenCode session fetch/list works without `Failed to parse URL from [object Request]`.
- [x] Thinking toggle is visible and wired for mobile AI sessions.
- [x] OpenCode reasoning/mode UI exposes the full supported options instead of only on/off.
- [x] OpenCode removes the redundant on/off thinking toggle and uses dropdown-based selection for supported options.
- [x] OpenCode build/plan or other supported modes are visible when the backend supports them.
- [ ] The app resumes the last working OpenCode model and mode for an existing session.

## Latest user-reported regressions (2026-04-10)
- [x] Bug: the AI agent UI is still buggy and appears to select multiple agent modes by default.
- [x] Bug: internal/subagent-only OpenCode entries are showing as normal agent options, including subagents plus entries such as `compaction`, `summary`, `title`, `ui5-*`, and `cap-*`.
- [x] Bug: OpenCode thinking/model selection is still using the awkward bottom scroller instead of a cleaner Codex-style selection flow.
- [x] Requirement: OpenCode thinking/model selection should follow the Codex-style UI pattern where model and thinking controls are easier to access and not hidden behind a bottom scroller workflow.
- [ ] Requirement: use the APK currently being tested from `/home/dhruvkejri1/lunel-builds/` as the reference for this regression pass.
- [x] Bug: session titles still collapse into repeated generic names like `Session 111`, `Session 102`, `Session 102`.
- [ ] Bug: RAM usage is still too high at runtime.
- [ ] Bug: multiple `opencode serve` processes can exist at once and need lifecycle investigation.
- [x] Bug: port kill from the app cross button can stop the listening port while leaving the parent watcher/process behavior unclear (example: `cds watch` on port `4004`).
- [x] Requirement: port kill behavior should be explicit about whether only the listening port was stopped or whether the owning watcher/process tree was actually terminated.
- [ ] Bug: image selection no longer errors, but the selected image does not visibly appear in the chat UI for either OpenCode or Codex.
- [ ] Requirement: after image selection, the attachment should visibly appear in the mobile chat UI before send for both OpenCode and Codex so the user can tell it was attached.
- [ ] Requirement: slash commands must work in the mobile AI app for both OpenCode and Codex.
- [x] Requirement: implement this regression pass on clean branches and merge with clean history.

## Exact checklist from the latest user report
- [x] Bug: many agent modes are being selected at once by default in the UI.
- [x] Bug: subagents are visible in the normal agent mode picker.
- [x] Bug: `compaction` appears as a normal agent mode option.
- [x] Bug: `summary` appears as a normal agent mode option.
- [x] Bug: `title` appears as a normal agent mode option.
- [x] Bug: `ui5-app-*` style entries appear as normal agent mode options.
- [x] Bug: `cap-cds-modeler` style entries appear as normal agent mode options.
- [x] Bug: session names still repeat as generic numbered entries.
- [ ] Bug: high RAM usage must be investigated using the live local environment.
- [ ] Bug: image selection currently provides no visible insertion feedback in the chat for either backend.
- [ ] Requirement: `/` commands should work for both OpenCode and Codex in the mobile app.
- [x] Requirement: do the changes in branches and then merge them with clean history.

## GitHub issues to fix
- [x] #6 Windows startup hits DEP0190.
- [x] #8 CLI root sandbox symlink-parent escape — ancestor-walk + realpath validation.
- [x] #10 PTY binary integrity verification — sha256 checksums on download and startup.
- [x] #11 Security audit items in scope:
  - [x] arbitrary process execution hardening — `SAFE_PROCESS_COMMANDS`, `resolveAllowedProcessCommand`
  - [x] HTTP request SSRF hardening
  - [x] PTY shell input hardening — `resolveAllowedTerminalShell`, `SAFE_TERMINAL_SHELLS`
  - [x] query password removal for session-sensitive flows — POST body + `x-session-password` header
  - [x] replay protection for encrypted transport — `assertFreshNonce` in both transports
  - [x] CORS tightening — explicit `corsHeaders` in proxy
  - [x] WebSocket Origin validation — `isTrustedRequestOrigin` in proxy
  - [x] git path validation — `assertSafeGitPaths`
  - [x] env injection hardening — `sanitizeProcessEnv`, `BLOCKED_PROCESS_ENV_KEYS`
- [x] #13 Manager `/health` probe — handled via CLI offline grace timer.

## Delivery tasks
- [ ] Rebuild local `lunel-cli` and verify the rebuilt one is used.
- [ ] Build Android APK.
- [ ] Copy APK into `/home/dhruvkejri1/lunel-builds`.
- [ ] End-to-end test all fixes.
- [ ] Complete senior-engineer review and fix findings.
