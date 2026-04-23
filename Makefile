.SUFFIXES:
.PHONY: help install dev build check lint \
    local-start local-start-fresh local-status local-stop local-restart \
    app-install app-start app-android app-ios app-web app-lint \
    cli-install cli-build cli-check cli-dev \
    manager-install manager-check manager-dev manager-start \
    proxy-install proxy-check proxy-dev proxy-start \
    sandman-build sandman-run sandman-test sandman-tidy \
    pty-build pty-dev

SANDMAN_DIR := $(wildcard sandman)
PWSH ?= pwsh
LOCAL_DEV_SCRIPT := ./scripts/local-dev.ps1

# ─── Help ──────────────────────────────────────────────────────────

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Top-level"
	@echo "  install            Install deps for app + cli + gateway components"
	@echo "  dev                Start gateway + app dev servers in parallel"
	@echo "  build              Build cli + pty"
	@echo "  check              Validate cli + manager + proxy"
	@echo "  lint               Lint app"
	@echo ""
	@echo "Local Dev  (Windows loopback manager + proxy)"
	@echo "  local-start        Start local manager + proxy"
	@echo "  local-start-fresh  Start local stack with fresh manager DB"
	@echo "  local-status       Show local stack status"
	@echo "  local-stop         Stop local manager + proxy"
	@echo "  local-restart      Restart local manager + proxy"
	@echo ""
	@echo "App        (Expo / React Native)"
	@echo "  app-install        npm install"
	@echo "  app-start          Expo dev server"
	@echo "  app-android        Run on Android"
	@echo "  app-ios            Run on iOS"
	@echo "  app-web            Expo web mode"
	@echo "  app-lint           ESLint via Expo"
	@echo ""
	@echo "CLI        (Node + TypeScript)"
	@echo "  cli-install        npm install"
	@echo "  cli-build          tsc compile"
	@echo "  cli-check          Type-check without emitting"
	@echo "  cli-dev            Build + run"
	@echo ""
	@echo "Manager    (Bun session control plane)"
	@echo "  manager-install    bun install"
	@echo "  manager-check      Type-check manager sources"
	@echo "  manager-dev        Dev server with --watch"
	@echo "  manager-start      Production start"
	@echo ""
	@echo "Proxy      (Bun WebSocket relay)"
	@echo "  proxy-install      bun install"
	@echo "  proxy-check        Type-check proxy sources"
	@echo "  proxy-dev          Dev server with --watch"
	@echo "  proxy-start        Production start"
	@echo ""
	@echo "PTY        (Rust portable PTY)"
	@echo "  pty-build          cargo build --release"
	@echo "  pty-dev            cargo build (debug)"
	@echo ""
	@echo "Sandman    (Not yet added)"
	@echo "  sandman-build      go build"
	@echo "  sandman-run        go run"
	@echo "  sandman-test       go test"
	@echo "  sandman-tidy       go mod tidy"

.DEFAULT_GOAL := help

# ─── Top-level ─────────────────────────────────────────────────────

install: app-install cli-install manager-install proxy-install $(if $(SANDMAN_DIR),sandman-tidy,)

## Runs proxy + app dev servers in parallel.
## Ctrl-C kills both.
dev:
	$(MAKE) -j2 proxy-dev app-start

build: cli-build pty-build $(if $(SANDMAN_DIR),sandman-build,)

check: cli-check manager-check proxy-check

lint: app-lint

local-start:
	$(PWSH) -NoProfile -File $(LOCAL_DEV_SCRIPT) start

local-start-fresh:
	$(PWSH) -NoProfile -File $(LOCAL_DEV_SCRIPT) start -FreshManager

local-status:
	$(PWSH) -NoProfile -File $(LOCAL_DEV_SCRIPT) status

local-stop:
	$(PWSH) -NoProfile -File $(LOCAL_DEV_SCRIPT) stop

local-restart:
	$(PWSH) -NoProfile -File $(LOCAL_DEV_SCRIPT) restart

# ─── App ───────────────────────────────────────────────────────────

app-install:
	cd app && npm install

app-start:
	cd app && npm run start

app-android:
	cd app && npm run android

app-ios:
	cd app && npm run ios

app-web:
	cd app && npm run web

app-lint:
	cd app && npm run lint

# ─── CLI ───────────────────────────────────────────────────────────

cli-install:
	cd cli && npm install

cli-build:
	cd cli && npm run build

cli-check:
	cd cli && npm run check

cli-dev:
	cd cli && npm run dev

# ─── Manager ───────────────────────────────────────────────────────

manager-install:
	cd manager && bun install

manager-check:
	cd manager && bun run check

manager-dev:
	cd manager && bun run dev

manager-start:
	cd manager && bun run start

# ─── Proxy ─────────────────────────────────────────────────────────

proxy-install:
	cd proxy && bun install

proxy-check:
	cd proxy && bun run check

proxy-dev:
	cd proxy && bun run dev

proxy-start:
	cd proxy && bun run start

# ─── PTY ──────────────────────────────────────────────────────────

pty-build:
	cd pty && cargo build --release

pty-dev:
	cd pty && cargo build

# ─── Sandman ───────────────────────────────────────────────────────

ifneq ($(strip $(SANDMAN_DIR)),)
sandman-build:
	cd sandman && go build -o sandman .

sandman-run:
	cd sandman && go run .

sandman-test:
	cd sandman && go test ./...

sandman-tidy:
	cd sandman && go mod tidy
else
sandman-build sandman-run sandman-test sandman-tidy:
	@echo "sandman/ not present; skipping $@"
endif
