#!/usr/bin/env python3
import json
import os
import signal
import socket
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def get_json(base_url: str, path: str) -> Any:
    request = Request(f"{base_url}{path}", headers={"Accept": "application/json"})
    with urlopen(request, timeout=5) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else None


def wait_until_ready(base_url: str) -> None:
    deadline = time.time() + 20
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            get_json(base_url, "/global/health")
            return
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(0.25)
    raise RuntimeError(f"opencode server did not become ready: {last_error}")


def model_map(provider: dict[str, Any]) -> dict[str, Any]:
    models = provider.get("models")
    if isinstance(models, dict):
        return models
    if isinstance(models, list):
        mapped: dict[str, Any] = {}
        for model in models:
            if not isinstance(model, dict):
                continue
            model_id = model.get("id") or model.get("model") or model.get("name")
            if isinstance(model_id, str):
                mapped[model_id] = model
        return mapped
    return {}


def print_provider(provider: dict[str, Any], default_model: str | None = None) -> None:
    provider_id = provider.get("id") or provider.get("providerID") or provider.get("name")
    print(provider_id or "<missing-provider-id>")
    print(f"  name: {provider.get('name')}")
    print(f"  source: {provider.get('source')}")
    print(f"  defaultModel: {default_model}")

    extra_provider_keys = sorted(
        key for key in provider.keys()
        if key not in {"id", "providerID", "name", "source", "models"}
    )
    print(f"  providerKeys: {extra_provider_keys}")

    models = model_map(provider)
    print(f"  modelCount: {len(models)}")
    for model_id, model in models.items():
        if not isinstance(model, dict):
            print(f"    - {model_id}: {model}")
            continue

        interesting = {
            key: value
            for key, value in model.items()
            if any(token in key.lower() for token in ("reason", "effort", "speed", "tier", "limit", "modal"))
        }
        model_name = model.get("name") or model.get("displayName") or model.get("model") or model_id
        print(f"    - {model_id}")
        print(f"      name: {model_name}")
        print(f"      keys: {sorted(model.keys())}")
        print(f"      limit: {model.get('limit')}")
        print(f"      capabilities: {model.get('capabilities')}")
        print(f"      options: {model.get('options')}")
        print(f"      variants: {model.get('variants')}")
        print(f"      interesting: {interesting or None}")
    print()
    sys.stdout.flush()


def main() -> int:
    port = find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        ["opencode", "serve", "--hostname", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    )

    try:
        wait_until_ready(base_url)
        health = get_json(base_url, "/global/health")
        print("health")
        print(json.dumps(health, indent=2, sort_keys=True))
        print()
        sys.stdout.flush()

        config_providers = get_json(base_url, "/config/providers")
        print("config/providers defaults")
        print(json.dumps(config_providers.get("default", {}), indent=2, sort_keys=True))
        print()
        sys.stdout.flush()

        providers = config_providers.get("providers", [])
        print("config/providers")
        for provider in providers:
            if isinstance(provider, dict):
                provider_id = provider.get("id") or provider.get("providerID") or provider.get("name")
                default_model = config_providers.get("default", {}).get(provider_id)
                print_provider(provider, default_model)

        return 0
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
