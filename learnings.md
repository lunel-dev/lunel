# Learnings

## Branch hygiene

- Do **not** continue new regression work on whatever branch happens to be checked out.
- For follow-up fixes after the earlier branch series, use this flow:
  1. inspect current branch and worktree first,
  2. base new regression work on `merged-main`,
  3. create a dedicated issue/follow-up branch from `merged-main`,
  4. commit in atomic groups,
  5. merge back into `merged-main` with preserved branch history.
- If patch application leaves `*.orig` or `*.rej`, delete them immediately and never carry them into commits.

## Android build environment

- `./gradlew assembleRelease` may fail in this environment for **two separate reasons**:
  1. Gradle wrapper SSL download failure.
  2. Wrong Java toolchain chosen for Skia / Android compilation.
- Reliable APK build command in this repo:

```bash
cd /home/dhruvkejri1/projects/lunel/app/android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
PATH="/usr/lib/jvm/java-17-openjdk-amd64/bin:$PATH" \
JAVA_TOOL_OPTIONS="-Djavax.net.ssl.trustStore=/home/dhruvkejri1/.gradle/zscaler-truststore.jks -Djavax.net.ssl.trustStorePassword=changeit" \
./gradlew -I gradle-rewrite.init.gradle assembleRelease
```

- After a successful build, refresh the delivered APK with:

```bash
cp /home/dhruvkejri1/projects/lunel/app/android/app/build/outputs/apk/release/app-release.apk \
  /home/dhruvkejri1/lunel-builds/app-release.apk
```

## Build validation

- For code changes touching CLI + mobile AI/runtime, rerun all of:
  - `cli/npm run build`
  - `app/npm run build:editor-webview`
  - Android release APK build when user expects a fresh APK.
- If a rebuild leaves one tracked file dirty after commit splitting, stop and attach it cleanly with a fixup/autosquash instead of ignoring it.

## Process / runtime validation

- `lunel-cli -n` should not eagerly spawn fresh OpenCode processes just for pairing.
- Check live processes after CLI startup when changing AI manager lifecycle behavior.
- Backgrounding the app should not tear down local session/proxy state unless the code explicitly intends to end the session.

## Global MCP setup for Android debugging

- OpenCode global MCP config lives in `~/.config/opencode/opencode.json` under the root `mcp` object.
- Added Android-debugging MCP entries globally:
  - `dta` → `dta-cli mcp`
  - `mobile-mcp` → `npx -y @mobilenext/mobile-mcp@latest`
- OpenCode expects local MCP commands in array form, for example `"command": ["npx", "-y", "..."]`.
- Use `-y` for `npx`-backed MCPs to avoid interactive install hangs.
- OpenCode should be restarted after MCP config changes so newly added MCPs are picked up.
- On this machine, `npx` is present on PATH, but `dta-cli` was not found during verification and may need installation before the `dta` MCP can actually start.

## Research workflow reminder

- For current library/tooling behavior, prefer live docs lookup instead of relying only on stale local assumptions.
- Use `websearch`/Context7 when the task depends on up-to-date package behavior, config schema, or external integration details.
