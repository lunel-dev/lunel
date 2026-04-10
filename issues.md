# Lunel issues checklist

## Current progress snapshot
- Implemented in code, pending final runtime/e2e verification:
  - mobile port close handling now also clears proxy tracking when the same port was being forwarded
  - Android background/session lifecycle handling and stored-session persistence changes
  - QR/session fetch timeout alignment to 60 seconds
  - OpenCode fetch normalization for `Failed to parse URL from [object Request]`
  - visible thinking toggle in the mobile AI panel
  - GitHub issue fixes for #6, #8, #10, #11, #13
- Verified so far:
  - `cli/`: `npm install` and `npm run build`
  - `manager/`: `bun install` and `bunx tsc --noEmit -p tsconfig.json`
  - `proxy/`: `bun install` and `bunx tsc --noEmit -p tsconfig.json`
  - `app/`: `NPM_CONFIG_LEGACY_PEER_DEPS=true npm install` and `npm run build:editor-webview`
- Still pending:
  - uninstall old global `lunel-cli`, relink local CLI, and verify the active binary
  - Android prebuild + release APK build + copy only the APK to `/home/dhruvkejri1/lucel-builds`
  - end-to-end runtime verification for mobile/session/AI flows
  - senior-review pass and any follow-up fixes

## User-reported bug
- [ ] Bug: clicking the cross on a mobile app port does not suspend/stop it; the port respawns in the UI instead.
- [ ] Bug: the session disconnects as soon as the Android app goes into the background.
- [ ] Requirement: the coding session should not end just because the mobile app disconnects or backgrounds.
- [ ] Bug: the port close icon still only hides the port briefly and it reappears.
- [ ] Bug: the OpenCode thinking/mode chooser is incomplete and only shows on/off instead of model/backend-specific options.
- [ ] Requirement: OpenCode should use a dropdown-based reasoning/mode selector like Codex instead of a separate on/off toggle.
- [ ] Bug: the app does not restore the last active OpenCode model and mode from the session.
- [ ] Bug: QR-based CLI pairing is now slower than the original upstream behavior.
- [ ] Bug: using OpenCode build mode can trigger an APIError.

## User requirements for this pass
- [ ] QR code / session fetch timeout is 60 seconds where required.
- [ ] OpenCode session fetch/list works without `Failed to parse URL from [object Request]`.
- [ ] Thinking toggle is visible and wired for mobile AI sessions.
- [ ] OpenCode reasoning/mode UI exposes the full supported options instead of only on/off.
- [ ] OpenCode removes the redundant on/off thinking toggle and uses dropdown-based selection for supported options.
- [ ] OpenCode build/plan or other supported modes are visible when the backend supports them.
- [ ] The app resumes the last working OpenCode model and mode for an existing session.

## Latest user-reported regressions (2026-04-10)
- [ ] Bug: the AI agent UI is still buggy and appears to select multiple agent modes by default.
- [ ] Bug: internal/subagent-only OpenCode entries are showing as normal agent options, including subagents plus entries such as `compaction`, `summary`, `title`, `ui5-*`, and `cap-*`.
- [ ] Bug: OpenCode thinking/model selection is still using the awkward bottom scroller instead of a cleaner Codex-style selection flow.
- [ ] Requirement: OpenCode thinking/model selection should follow the Codex-style UI pattern where model and thinking controls are easier to access and not hidden behind a bottom scroller workflow.
- [ ] Requirement: use the APK currently being tested from `/home/dhruvkejri1/lunel-builds/` as the reference for this regression pass.
- [ ] Bug: session titles still collapse into repeated generic names like `Session 111`, `Session 102`, `Session 102`.
- [ ] Bug: RAM usage is still too high at runtime.
- [ ] Bug: multiple `opencode serve` processes can exist at once and need lifecycle investigation.
- [ ] Bug: port kill from the app cross button can stop the listening port while leaving the parent watcher/process behavior unclear (example: `cds watch` on port `4004`).
- [ ] Requirement: port kill behavior should be explicit about whether only the listening port was stopped or whether the owning watcher/process tree was actually terminated.
- [ ] Bug: image selection no longer errors, but the selected image does not visibly appear in the chat UI for either OpenCode or Codex.
- [ ] Requirement: after image selection, the attachment should visibly appear in the mobile chat UI before send for both OpenCode and Codex so the user can tell it was attached.
- [ ] Requirement: slash commands must work in the mobile AI app for both OpenCode and Codex.
- [ ] Requirement: implement this regression pass on clean branches and merge with clean history.

## Exact checklist from the latest user report
- [ ] Bug: many agent modes are being selected at once by default in the UI.
- [ ] Bug: subagents are visible in the normal agent mode picker.
- [ ] Bug: `compaction` appears as a normal agent mode option.
- [ ] Bug: `summary` appears as a normal agent mode option.
- [ ] Bug: `title` appears as a normal agent mode option.
- [ ] Bug: `ui5-app-*` style entries appear as normal agent mode options.
- [ ] Bug: `cap-cds-modeler` style entries appear as normal agent mode options.
- [ ] Bug: session names still repeat as generic numbered entries.
- [ ] Bug: high RAM usage must be investigated using the live local environment.
- [ ] Bug: image selection currently provides no visible insertion feedback in the chat for either backend.
- [ ] Requirement: `/` commands should work for both OpenCode and Codex in the mobile app.
- [ ] Requirement: do the changes in branches and then merge them with clean history.

## GitHub issues to fix
- [ ] #6 Windows startup hits DEP0190.
- [ ] #8 CLI root sandbox symlink-parent escape.
- [ ] #10 PTY binary integrity verification.
- [ ] #11 Security audit items in scope:
  - [ ] arbitrary process execution hardening
  - [ ] HTTP request SSRF hardening
  - [ ] PTY shell input hardening
  - [ ] query password removal for session-sensitive flows
  - [ ] replay protection for encrypted transport
  - [ ] CORS tightening
  - [ ] WebSocket Origin validation
  - [ ] git path validation
  - [ ] env injection hardening
- [ ] #13 Manager `/health` probe does not tear down active V2 sessions.

## Delivery tasks
- [ ] Uninstall existing global `lunel-cli`.
- [ ] Rebuild local `lunel-cli` and verify the rebuilt one is used.
- [ ] Build Android APK.
- [ ] Copy APK into `/home/dhruvkejri1/lunel-builds`.
- [ ] End-to-end test all fixes.
- [ ] Complete senior-engineer review and fix findings.
