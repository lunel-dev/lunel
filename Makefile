.SUFFIXES:
.PHONY: help install dev build lint \
    app-install app-start app-android app-ios app-web app-lint \
    cli-install cli-build cli-dev \
    gateway-install gateway-dev gateway-start \
    sandman-build sandman-run sandman-test sandman-tidy

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
	@echo "Gateway    (Bun WebSocket proxy)"
	@echo "  gateway-install    bun install"
	@echo "  gateway-dev        Dev server with --watch"
	@echo "  gateway-start      Production start"
	@echo ""
	@echo "Sandman    (Go Firecracker VM manager)"
	@echo "  sandman-build      go build"
	@echo "  sandman-run        go run"
	@echo "  sandman-test       go test"
	@echo "  sandman-tidy       go mod tidy"

.DEFAULT_GOAL := help

# ─── Top-level ─────────────────────────────────────────────────────

install: app-install cli-install gateway-install sandman-tidy

## Runs gateway + app dev servers in parallel.
## Ctrl-C kills both.
dev:
	$(MAKE) -j2 gateway-dev app-start

build: cli-build sandman-build

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

# ─── Gateway ───────────────────────────────────────────────────────

gateway-install:
	cd gateway && bun install

gateway-dev:
	cd gateway && bun run dev

gateway-start:
	cd gateway && bun run start

# ─── Sandman ───────────────────────────────────────────────────────

sandman-build:
	cd sandman && go build -o sandman .

sandman-run:
	cd sandman && go run .

sandman-test:
	cd sandman && go test ./...

sandman-tidy:
	cd sandman && go mod tidy
