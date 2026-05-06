#!/usr/bin/env python3
import json
import subprocess
import sys
from typing import Any


def send(proc: subprocess.Popen[str], message: dict[str, Any]) -> None:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(message) + "\n")
    proc.stdin.flush()


def read_response(proc: subprocess.Popen[str], response_id: int) -> dict[str, Any]:
    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        if line == "":
            raise RuntimeError("codex app-server exited before returning a response")

        message = json.loads(line)
        if message.get("id") == response_id:
            return message


def main() -> int:
    proc = subprocess.Popen(
        ["codex", "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    try:
        send(
            proc,
            {
                "method": "initialize",
                "id": 0,
                "params": {
                    "clientInfo": {
                        "name": "model_probe",
                        "title": "Model Probe",
                        "version": "0.1.0",
                    }
                },
            },
        )
        init_response = read_response(proc, 0)
        if "error" in init_response:
            print(json.dumps(init_response, indent=2), file=sys.stderr)
            return 1

        send(proc, {"method": "initialized", "params": {}})
        send(
            proc,
            {
                "method": "model/list",
                "id": 1,
                "params": {"limit": 100, "includeHidden": True},
            },
        )

        response = read_response(proc, 1)
        if "error" in response:
            print(json.dumps(response, indent=2), file=sys.stderr)
            return 1

        models = response.get("result", {}).get("data", [])
        for model in models:
            efforts = [
                effort.get("reasoningEffort")
                for effort in model.get("supportedReasoningEfforts", [])
            ]
            speed_fields = {
                key: value
                for key, value in model.items()
                if "speed" in key.lower()
            }
            print(model.get("id", "<missing-id>"))
            print(f"  displayName: {model.get('displayName')}")
            print(f"  model: {model.get('model')}")
            print(f"  hidden: {model.get('hidden')}")
            print(f"  isDefault: {model.get('isDefault')}")
            print(f"  defaultReasoningEffort: {model.get('defaultReasoningEffort')}")
            print(f"  supportedReasoningEfforts: {', '.join(efforts)}")
            print(f"  speedFields: {speed_fields or None}")

            for effort in model.get("supportedReasoningEfforts", []):
                description = effort.get("description")
                if description:
                    print(f"    - {effort.get('reasoningEffort')}: {description}")
            print()

        next_cursor = response.get("result", {}).get("nextCursor")
        if next_cursor is not None:
            print(f"nextCursor: {next_cursor}")

        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
