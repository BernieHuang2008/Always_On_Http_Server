from __future__ import annotations

import copy
import json
import re
import time
import uuid
from queue import Empty, Queue
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from flask import Flask, Response, abort, g, jsonify, render_template, request, send_file, stream_with_context
    from werkzeug.exceptions import HTTPException
    from werkzeug.utils import secure_filename
except ModuleNotFoundError as exc:  # pragma: no cover - gives a clearer local startup message.
    raise SystemExit(
        "Flask is not installed in the host Python environment.\n"
        "Install it with: py -3.12 -m pip install Flask"
    ) from exc


BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
STATIC_ASSETS_DIR = BASE_DIR / "static_assets"
FAVICON_PATH = BASE_DIR / "favicon.svg"

HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
LOGIC_TYPES = {"static_page", "static_file", "python_script"}
ALL_FOLDER_ID = "folder-all"

app = Flask(__name__)
runtime_config: dict[str, list[dict[str, Any]]] = {"logic": [], "routes": []}
request_logs: deque[dict[str, Any]] = deque(maxlen=240)
event_listeners: list[Queue] = []
event_sequence = 0
config_revision = 0


@app.before_request
def handle_cors_preflight() -> Response | None:
    g.request_started_at = time.perf_counter()
    if request.method == "OPTIONS":
        return Response(status=204)
    return None


@app.after_request
def add_cors_headers(response: Response) -> Response:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = ", ".join(HTTP_METHODS)
    response.headers["Access-Control-Allow-Headers"] = request.headers.get(
        "Access-Control-Request-Headers",
        "Content-Type, Authorization",
    )
    response.headers["Access-Control-Max-Age"] = "86400"
    record_request_log(response)
    return response


def next_event_id() -> int:
    global event_sequence
    event_sequence += 1
    return event_sequence


def publish_event(event_type: str, payload: dict[str, Any]) -> None:
    message = {
        "id": next_event_id(),
        "type": event_type,
        "payload": payload,
    }
    for listener in event_listeners[:]:
        try:
            listener.put_nowait(message)
        except Exception:
            if listener in event_listeners:
                event_listeners.remove(listener)


def publish_config_changed() -> None:
    global config_revision
    config_revision += 1
    publish_event("config", {"revision": config_revision, "updated_at": now_iso()})


def request_body_preview() -> str:
    body = request.get_data(cache=True, as_text=True) or ""
    if len(body) > 1200:
        return body[:1200] + "...[truncated]"
    return body


def response_body_preview(response: Response) -> str:
    if response.direct_passthrough:
        return ""
    content_type = response.content_type or ""
    if not any(kind in content_type for kind in ("json", "text", "html", "xml")):
        return ""
    try:
        body = response.get_data(as_text=True) or ""
    except Exception:
        return ""
    if len(body) > 1200:
        return body[:1200] + "...[truncated]"
    return body


def should_log_request() -> bool:
    path = request.path
    return not (
        path == "/__admin__/events"
        or path.startswith("/static/")
    )


def record_request_log(response: Response) -> None:
    if not should_log_request():
        return

    started_at = getattr(g, "request_started_at", None)
    duration_ms = None
    if started_at is not None:
        duration_ms = round((time.perf_counter() - started_at) * 1000, 1)

    entry = {
        "id": next_event_id(),
        "time": now_iso(),
        "method": request.method,
        "path": request.path,
        "query": request.query_string.decode("utf-8", errors="replace"),
        "status": response.status_code,
        "remote_addr": request.headers.get("X-Forwarded-For", request.remote_addr or ""),
        "content_type": request.content_type or "",
        "response_content_type": response.content_type or "",
        "duration_ms": duration_ms,
        "body": request_body_preview(),
        "response_body": response_body_preview(response),
    }
    request_logs.appendleft(entry)
    publish_event("request", entry)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def default_config() -> dict[str, Any]:
    return {
        "version": 1,
        "updated_at": now_iso(),
        "folders": [all_folder()],
        "logic": [
            {
                "id": "logic-welcome",
                "name": "Welcome JSON",
                "type": "static_page",
                "scope": "persistent",
                "config": {
                    "status": 200,
                    "content_type": "application/json; charset=utf-8",
                    "body": json.dumps(
                        {
                            "ok": True,
                            "message": "Always On HTTP Server is running.",
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                },
            }
        ],
        "routes": [
            {
                "id": "route-health",
                "name": "Health",
                "path": "/health",
                "methods": ["GET"],
                "logic_id": "logic-welcome",
                "enabled": True,
                "scope": "persistent",
            }
        ],
    }


def read_persistent_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        cfg = default_config()
        write_persistent_config(cfg)
        return cfg

    with CONFIG_PATH.open("r", encoding="utf-8") as fh:
        cfg = json.load(fh)

    cfg.setdefault("version", 1)
    cfg["folders"] = normalize_folders(cfg.get("folders", []))
    cfg.setdefault("logic", [])
    cfg.setdefault("routes", [])
    for route in cfg["routes"]:
        route.setdefault("folder_id", ALL_FOLDER_ID)
    return cfg


def write_persistent_config(cfg: dict[str, Any]) -> None:
    cfg["updated_at"] = now_iso()
    CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def active_config() -> dict[str, Any]:
    cfg = copy.deepcopy(read_persistent_config())
    cfg["logic"].extend(copy.deepcopy(runtime_config["logic"]))
    cfg["routes"].extend(copy.deepcopy(runtime_config["routes"]))
    cfg["folders"] = normalize_folders(cfg.get("folders", []))
    cfg["logic"] = sort_items(cfg["logic"])
    cfg["routes"] = sort_items(cfg["routes"])
    folder_by_id = {folder["id"]: folder for folder in cfg["folders"]}
    for route in cfg["routes"]:
        route.setdefault("folder_id", ALL_FOLDER_ID)
        route["effective_path"] = route_effective_path(route, folder_by_id)
    return cfg


def all_folder() -> dict[str, Any]:
    return {
        "id": ALL_FOLDER_ID,
        "name": "All Endpoints",
        "icon": "🌐",
        "path_prefix": "",
        "theme_color": "#ffffff",
        "order": 0,
        "locked": True,
    }


def normalize_folders(folders: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = [folder for folder in folders if folder.get("id") != ALL_FOLDER_ID]
    normalized = [validate_folder(folder, folder.get("id")) for folder in normalized]
    normalized = sort_items(normalized)
    for index, folder in enumerate(normalized, start=1):
        folder["order"] = index * 10
    return [all_folder()] + normalized


def normalize_prefix(value: str | None) -> str:
    prefix = (value or "").strip()
    if not prefix:
        return ""
    if not prefix.startswith("/"):
        prefix = "/" + prefix
    return prefix.rstrip("/")


def join_paths(prefix: str, path: str) -> str:
    prefix = normalize_prefix(prefix)
    if not prefix:
        return path
    return prefix + path


def route_effective_path(route: dict[str, Any], folder_by_id: dict[str, dict[str, Any]]) -> str:
    folder = folder_by_id.get(route.get("folder_id"), all_folder())
    return join_paths(folder.get("path_prefix", ""), route.get("path", "/"))


def sort_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        item
        for _, item in sorted(
            enumerate(items),
            key=lambda pair: (pair[1].get("order", pair[0] * 10), pair[0]),
        )
    ]


def split_by_scope(items: list[dict[str, Any]], scope: str) -> list[dict[str, Any]]:
    return [item for item in items if item.get("scope") == scope]


def ensure_scope(value: str | None) -> str:
    return "temporary" if value == "temporary" else "persistent"


def validate_logic(payload: dict[str, Any], existing_id: str | None = None) -> dict[str, Any]:
    logic_type = payload.get("type", "static_page")
    if logic_type not in LOGIC_TYPES:
        raise ValueError(f"Unsupported logic type: {logic_type}")

    item = {
        "id": existing_id or payload.get("id") or new_id("logic"),
        "name": (payload.get("name") or "Untitled logic").strip(),
        "type": logic_type,
        "scope": ensure_scope(payload.get("scope")),
        "config": payload.get("config") or {},
    }
    if isinstance(payload.get("order"), int):
        item["order"] = payload["order"]

    if item["type"] == "static_page":
        item["config"].setdefault("status", 200)
        item["config"].setdefault("content_type", "text/html; charset=utf-8")
        item["config"].setdefault("body", "")
    elif item["type"] == "static_file":
        item["config"].setdefault("file_path", "")
    elif item["type"] == "python_script":
        item["config"].setdefault(
            "code",
            "def handle(context):\n"
            "    return {\n"
            "        'json': {'ok': True, 'path': context['path']},\n"
            "        'status': 200,\n"
            "    }\n",
        )

    return item


def validate_folder(payload: dict[str, Any], existing_id: str | None = None) -> dict[str, Any]:
    folder_id = existing_id or payload.get("id") or new_id("folder")
    if folder_id == ALL_FOLDER_ID:
        return all_folder()

    item = {
        "id": folder_id,
        "name": (payload.get("name") or "New Folder").strip(),
        "icon": (payload.get("icon") or "▣").strip()[:2],
        "path_prefix": normalize_prefix(payload.get("path_prefix")),
        "theme_color": (payload.get("theme_color") or "#ffffff").strip(),
        "locked": False,
    }
    if isinstance(payload.get("order"), int):
        item["order"] = payload["order"]
    return item


def validate_route(payload: dict[str, Any], existing_id: str | None = None) -> dict[str, Any]:
    path = (payload.get("path") or "").strip()
    if not path.startswith("/"):
        raise ValueError("Path must start with /")
    if path == "/":
        raise ValueError("The root path / is reserved for the admin UI")
    if path.startswith("/__admin__"):
        raise ValueError("Paths below /__admin__ are reserved")

    methods = payload.get("methods") or ["GET"]
    methods = [str(method).upper() for method in methods if str(method).upper() in HTTP_METHODS]
    if not methods:
        raise ValueError("At least one HTTP method is required")

    item = {
        "id": existing_id or payload.get("id") or new_id("route"),
        "name": (payload.get("name") or path).strip(),
        "path": path,
        "methods": methods,
        "logic_id": payload.get("logic_id") or "",
        "folder_id": payload.get("folder_id") or ALL_FOLDER_ID,
        "enabled": bool(payload.get("enabled", True)),
        "scope": ensure_scope(payload.get("scope")),
    }
    if isinstance(payload.get("order"), int):
        item["order"] = payload["order"]
    return item


def replace_item(collection: list[dict[str, Any]], item: dict[str, Any]) -> bool:
    for index, current in enumerate(collection):
        if current.get("id") == item.get("id"):
            collection[index] = item
            return True
    return False


def remove_item(collection: list[dict[str, Any]], item_id: str) -> bool:
    original_length = len(collection)
    collection[:] = [item for item in collection if item.get("id") != item_id]
    return len(collection) != original_length


def find_raw_item(kind: str, item_id: str) -> dict[str, Any] | None:
    for item in runtime_config[kind]:
        if item.get("id") == item_id:
            return item
    for item in read_persistent_config()[kind]:
        if item.get("id") == item_id:
            return item
    return None


def next_order(kind: str) -> int:
    orders = [
        item.get("order", index * 10)
        for index, item in enumerate(active_config()[kind])
        if isinstance(item.get("order", index * 10), int)
    ]
    return (max(orders) + 10) if orders else 0


def current_order(kind: str, item_id: str) -> int | None:
    for index, item in enumerate(active_config()[kind]):
        if item.get("id") == item_id:
            return item.get("order", index * 10)
    return None


def save_item(kind: str, item: dict[str, Any], replace: bool = False) -> dict[str, Any]:
    scope = ensure_scope(item.get("scope"))
    item["scope"] = scope

    if replace:
        existing = find_raw_item(kind, item["id"])
        existing_order = current_order(kind, item["id"])
        if existing and existing_order is not None and "order" not in item:
            item["order"] = existing_order
        remove_item(runtime_config[kind], item["id"])
        cfg = read_persistent_config()
        if remove_item(cfg[kind], item["id"]):
            write_persistent_config(cfg)

    item.setdefault("order", next_order(kind))

    if scope == "temporary":
        collection = runtime_config[kind]
        collection.append(item)
        publish_config_changed()
        return item

    cfg = read_persistent_config()
    collection = cfg[kind]
    collection.append(item)
    write_persistent_config(cfg)
    publish_config_changed()
    return item


def delete_item(kind: str, item_id: str) -> bool:
    removed = remove_item(runtime_config[kind], item_id)
    cfg = read_persistent_config()
    if remove_item(cfg[kind], item_id):
        removed = True
        write_persistent_config(cfg)
    if removed:
        publish_config_changed()
    return removed


def save_folder(item: dict[str, Any], replace: bool = False) -> dict[str, Any]:
    if item["id"] == ALL_FOLDER_ID:
        raise ValueError("All Endpoints cannot be edited")

    cfg = read_persistent_config()
    folders = [folder for folder in cfg["folders"] if folder.get("id") != item["id"]]
    existing_order = current_order("folders", item["id"])
    if replace and existing_order is not None and "order" not in item:
        item["order"] = existing_order
    item.setdefault("order", next_folder_order())
    folders.append(item)
    cfg["folders"] = normalize_folders(folders)
    write_persistent_config(cfg)
    publish_config_changed()
    return item


def delete_folder(item_id: str) -> bool:
    if item_id == ALL_FOLDER_ID:
        return False

    cfg = read_persistent_config()
    original_length = len(cfg["folders"])
    cfg["folders"] = [folder for folder in cfg["folders"] if folder.get("id") != item_id]
    removed = len(cfg["folders"]) != original_length
    if removed:
        for route in cfg["routes"]:
            if route.get("folder_id") == item_id:
                route["folder_id"] = ALL_FOLDER_ID
        cfg["folders"] = normalize_folders(cfg["folders"])
        write_persistent_config(cfg)
        publish_config_changed()
    return removed


def next_folder_order() -> int:
    orders = [
        folder.get("order", index * 10)
        for index, folder in enumerate(active_config()["folders"])
        if folder.get("id") != ALL_FOLDER_ID and isinstance(folder.get("order", index * 10), int)
    ]
    return (max(orders) + 10) if orders else 10


def apply_order(kind: str, ordered_ids: list[str]) -> None:
    if kind == "folders":
        ordered_ids = [item_id for item_id in ordered_ids if item_id != ALL_FOLDER_ID]
        ordered_ids.insert(0, ALL_FOLDER_ID)

    known_ids = set(ordered_ids)
    active_ids = [item["id"] for item in active_config()[kind]]
    final_ids = ordered_ids + [item_id for item_id in active_ids if item_id not in known_ids]
    order_by_id = {item_id: index * 10 for index, item_id in enumerate(final_ids)}

    changed = False
    for item in runtime_config.get(kind, []):
        if item.get("id") in order_by_id:
            item["order"] = order_by_id[item["id"]]

    cfg = read_persistent_config()
    for item in cfg[kind]:
        if item.get("id") in order_by_id:
            item["order"] = order_by_id[item["id"]]
            changed = True
    if changed:
        write_persistent_config(cfg)
    publish_config_changed()


def route_pattern(path_template: str) -> re.Pattern[str]:
    escaped_parts: list[str] = []
    cursor = 0
    for match in re.finditer(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", path_template):
        escaped_parts.append(re.escape(path_template[cursor : match.start()]))
        escaped_parts.append(f"(?P<{match.group(1)}>[^/]+)")
        cursor = match.end()
    escaped_parts.append(re.escape(path_template[cursor:]))
    return re.compile("^" + "".join(escaped_parts) + "$")


def find_route(path: str, method: str) -> tuple[dict[str, Any], dict[str, str]] | tuple[None, None]:
    for route in active_config()["routes"]:
        if not route.get("enabled", True) or method not in route.get("methods", []):
            continue
        match = route_pattern(route.get("effective_path", route.get("path", ""))).match(path)
        if match:
            return route, match.groupdict()
    return None, None


def find_logic(logic_id: str) -> dict[str, Any] | None:
    for logic in active_config()["logic"]:
        if logic.get("id") == logic_id:
            return logic
    return None


def request_context(path_params: dict[str, str]) -> dict[str, Any]:
    return {
        "method": request.method,
        "path": request.path,
        "query": request.args.to_dict(flat=False),
        "json": request.get_json(silent=True),
        "form": request.form.to_dict(flat=False),
        "headers": dict(request.headers),
        "body": request.get_data(as_text=True),
        "path_params": path_params,
    }


def normalize_result(result: Any) -> Response:
    if isinstance(result, Response):
        return result
    if isinstance(result, tuple):
        return Response(result[0], status=result[1] if len(result) > 1 else 200)
    if isinstance(result, dict):
        status = int(result.get("status", 200))
        headers = result.get("headers") or {}
        if "json" in result:
            body = json.dumps(result["json"], ensure_ascii=False)
            return Response(body, status=status, headers=headers, content_type="application/json; charset=utf-8")
        content_type = result.get("content_type", "text/plain; charset=utf-8")
        return Response(str(result.get("body", "")), status=status, headers=headers, content_type=content_type)
    return Response(str(result), content_type="text/plain; charset=utf-8")


def run_python_script(logic: dict[str, Any], path_params: dict[str, str]) -> Response:
    code = logic.get("config", {}).get("code", "")
    namespace: dict[str, Any] = {
        "Response": Response,
        "json": json,
        "datetime": datetime,
    }
    exec(compile(code, f"<logic:{logic.get('id')}>", "exec"), namespace, namespace)
    handler = namespace.get("handle")
    if not callable(handler):
        raise ValueError("Python script must define handle(context)")
    return normalize_result(handler(request_context(path_params)))


def execute_logic(logic: dict[str, Any], path_params: dict[str, str]) -> Response:
    logic_type = logic.get("type")
    cfg = logic.get("config", {})

    if logic_type == "static_page":
        return Response(
            cfg.get("body", ""),
            status=int(cfg.get("status", 200)),
            content_type=cfg.get("content_type", "text/html; charset=utf-8"),
        )

    if logic_type == "static_file":
        requested = resolve_static_file_path(cfg.get("file_path", ""))
        if requested is None:
            abort(404)
        return send_file(requested)

    if logic_type == "python_script":
        return run_python_script(logic, path_params)

    abort(500, f"Unknown logic type: {logic_type}")


def resolve_static_file_path(file_path: str) -> Path | None:
    raw = Path(str(file_path or "").strip().strip('"'))
    if not str(raw):
        return None

    if raw.is_absolute():
        requested = raw.expanduser().resolve()
        return requested if requested.is_file() else None

    requested = (STATIC_ASSETS_DIR / raw).resolve()
    static_root = STATIC_ASSETS_DIR.resolve()
    if static_root not in requested.parents and requested != static_root:
        return None
    return requested if requested.is_file() else None


def unique_static_asset_path(filename: str) -> Path:
    STATIC_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = secure_filename(filename) or f"asset-{uuid.uuid4().hex[:8]}"
    candidate = STATIC_ASSETS_DIR / safe_name
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    return STATIC_ASSETS_DIR / f"{stem}-{uuid.uuid4().hex[:8]}{suffix}"


@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/favicon.svg")
@app.get("/favicon.ico")
def favicon() -> Response:
    if not FAVICON_PATH.is_file():
        abort(404)
    return send_file(FAVICON_PATH, mimetype="image/svg+xml")


@app.get("/__admin__/config")
def admin_config() -> Response:
    cfg = active_config()
    cfg["summary"] = {
        "persistent_logic": len(split_by_scope(cfg["logic"], "persistent")),
        "temporary_logic": len(split_by_scope(cfg["logic"], "temporary")),
        "persistent_routes": len(split_by_scope(cfg["routes"], "persistent")),
        "temporary_routes": len(split_by_scope(cfg["routes"], "temporary")),
        "folders": len(cfg["folders"]),
    }
    return jsonify(cfg)


@app.get("/__admin__/logs")
def admin_logs() -> Response:
    return jsonify({"logs": list(request_logs)})


@app.get("/__admin__/events")
def admin_events() -> Response:
    listener: Queue = Queue(maxsize=120)
    event_listeners.append(listener)

    def format_event(message: dict[str, Any]) -> str:
        return (
            f"id: {message['id']}\n"
            f"event: {message['type']}\n"
            f"data: {json.dumps(message['payload'], ensure_ascii=False)}\n\n"
        )

    @stream_with_context
    def stream():
        try:
            yield format_event(
                {
                    "id": next_event_id(),
                    "type": "ready",
                    "payload": {
                        "revision": config_revision,
                        "time": now_iso(),
                    },
                }
            )
            while True:
                try:
                    message = listener.get(timeout=20)
                    yield format_event(message)
                except Empty:
                    yield ": heartbeat\n\n"
        finally:
            if listener in event_listeners:
                event_listeners.remove(listener)

    return Response(stream(), content_type="text/event-stream; charset=utf-8")


@app.post("/__admin__/folders")
def admin_create_folder() -> Response:
    try:
        return jsonify(save_folder(validate_folder(request.get_json(force=True))))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.put("/__admin__/folders/<item_id>")
def admin_update_folder(item_id: str) -> Response:
    try:
        return jsonify(save_folder(validate_folder(request.get_json(force=True), item_id), replace=True))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.delete("/__admin__/folders/<item_id>")
def admin_delete_folder(item_id: str) -> Response:
    return jsonify({"deleted": delete_folder(item_id)})


@app.post("/__admin__/upload-static-file")
def admin_upload_static_file() -> Response:
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "No file uploaded"}), 400

    target = unique_static_asset_path(uploaded.filename)
    uploaded.save(target)
    return jsonify({
        "file_path": target.relative_to(STATIC_ASSETS_DIR).as_posix(),
        "filename": target.name,
        "size": target.stat().st_size,
    })


@app.post("/__admin__/logic")
def admin_create_logic() -> Response:
    try:
        return jsonify(save_item("logic", validate_logic(request.get_json(force=True))))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.put("/__admin__/logic/<item_id>")
def admin_update_logic(item_id: str) -> Response:
    try:
        return jsonify(save_item("logic", validate_logic(request.get_json(force=True), item_id), replace=True))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.delete("/__admin__/logic/<item_id>")
def admin_delete_logic(item_id: str) -> Response:
    return jsonify({"deleted": delete_item("logic", item_id)})


@app.post("/__admin__/routes")
def admin_create_route() -> Response:
    try:
        return jsonify(save_item("routes", validate_route(request.get_json(force=True))))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.put("/__admin__/routes/<item_id>")
def admin_update_route(item_id: str) -> Response:
    try:
        return jsonify(save_item("routes", validate_route(request.get_json(force=True), item_id), replace=True))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.delete("/__admin__/routes/<item_id>")
def admin_delete_route(item_id: str) -> Response:
    return jsonify({"deleted": delete_item("routes", item_id)})


@app.put("/__admin__/order")
def admin_order() -> Response:
    payload = request.get_json(force=True)
    kind = payload.get("kind")
    ordered_ids = payload.get("ids")
    if kind not in {"logic", "routes", "folders"} or not isinstance(ordered_ids, list):
        return jsonify({"error": "Expected kind to be logic/routes/folders and ids to be a list"}), 400
    apply_order(kind, [str(item_id) for item_id in ordered_ids])
    return jsonify({"ok": True, kind: active_config()[kind]})


@app.route("/<path:any_path>", methods=HTTP_METHODS)
def dispatch(any_path: str) -> Response:
    path = "/" + any_path
    route, path_params = find_route(path, request.method)
    if not route:
        abort(404)

    logic = find_logic(route.get("logic_id", ""))
    if not logic:
        abort(502, f"Route target logic does not exist: {route.get('logic_id')}")

    try:
        return execute_logic(logic, path_params or {})
    except HTTPException as exc:
        return jsonify({"error": exc.description, "logic_id": logic.get("id")}), exc.code
    except Exception as exc:
        app.logger.exception("Configured logic failed")
        return jsonify({"error": str(exc), "logic_id": logic.get("id")}), 500


if __name__ == "__main__":
    host = "0.0.0.0"
    port = 8787
    app.run(host=host, port=port, debug=False)
