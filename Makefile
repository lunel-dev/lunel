.SUFFIXES:
.PHONY: help install dev build lint \
    app-install app-start app-android app-ios app-web app-lint \
    cli-install cli-build cli-dev \
    manager-install manager-dev manager-start \
    proxy-install proxy-dev proxy-start \
    sandman-build sandman-run sandman-test sandman-tidy \
    pty-build pty-dev

# ─── Help ──────────────────────────────────────────────────────────

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Top-level"
	@echo "  install            Install deps for app + cli + gateway + sandman"
	@echo "  dev                Start gateway + app dev servers in parallel"
	@echo "  build              Build cli + sandman"
	@echo "  lint               Lint app"
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
	@echo "  cli-dev            Build + run"
	@echo ""
	@echo "Manager    (Bun session control plane)"
	@echo "  manager-install    bun install"
	@echo "  manager-dev        Dev server with --watch"
	@echo "  manager-start      Production start"
	@echo ""
	@echo "Proxy      (Bun WebSocket relay)"
	@echo "  proxy-install      bun install"
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

install: app-install cli-install manager-install proxy-install pty-dev

## Runs proxy + app dev servers in parallel.
## Ctrl-C kills both.
dev:
	$(MAKE) -j2 proxy-dev app-start

build: cli-build pty-build sandman-build

lint: app-lint

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

cli-dev:
	cd cli && npm run dev

# ─── Manager ───────────────────────────────────────────────────────

manager-install:
	cd manager && bun install

manager-dev:
	cd manager && bun run dev

manager-start:
	cd manager && bun run start

# ─── Proxy ─────────────────────────────────────────────────────────

proxy-install:
	cd proxy && bun install

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

sandman-build:
	cd sandman && go build -o sandman .

sandman-run:
	cd sandman && go run .

sandman-test:
	cd sandman && go test ./...

sandman-tidy:
	cd sandman && go mod tidy
