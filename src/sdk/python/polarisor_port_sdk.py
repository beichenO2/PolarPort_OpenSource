"""
polarisor-port-sdk — Unified port registration for Polarisor ecosystem (Python).

Hard dependency on SOTAgent: if SOTAgent is unreachable, claim_port CRASHES.
All services on the same machine — if one dies, they all die.
"""

import asyncio
import json
import os
import urllib.request
import urllib.error
from typing import Any, Optional

DEFAULT_SOTAGENT_URL = "http://127.0.0.1:4800"
HEARTBEAT_INTERVAL = 30

_base_url = os.environ.get("SOTAGENT_URL", DEFAULT_SOTAGENT_URL)
_heartbeat_tasks: dict[int, asyncio.Task] = {}
_claimed_ports: set[int] = set()


def set_base_url(url: str):
    global _base_url
    _base_url = url


class SOTAgentError(RuntimeError):
    """Raised when SOTAgent is unreachable or returns an error."""
    pass


def _sync_request(method: str, path: str, body: Optional[dict] = None) -> dict:
    url = f"{_base_url}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        raise SOTAgentError(f"SOTAgent unreachable at {url}: {e}") from e
    except json.JSONDecodeError as e:
        raise SOTAgentError(f"SOTAgent returned invalid JSON: {e}") from e


async def _heartbeat_loop(port: int):
    while True:
        await asyncio.sleep(HEARTBEAT_INTERVAL)
        try:
            _sync_request("POST", "/api/ports/heartbeat", {"port": port, "pid": os.getpid()})
        except SOTAgentError as e:
            print(f"[port-sdk] heartbeat failed for port {port}: {e}")


async def claim_port(
    *,
    service: str,
    project: str,
    preferred: Optional[int] = None,
    heartbeat: bool = True,
) -> int:
    """Claim a port from SOTAgent. Raises SOTAgentError if unreachable."""
    result = _sync_request("POST", "/api/ports/allocate", {
        "service_name": service,
        "project": project,
        "preferred_port": preferred,
    })

    if not result.get("ok") or not result.get("port"):
        raise SOTAgentError(f"SOTAgent refused allocation for '{service}': {result.get('message', result)}")

    port = int(result["port"])
    _claimed_ports.add(port)

    if heartbeat:
        task = asyncio.ensure_future(_heartbeat_loop(port))
        _heartbeat_tasks[port] = task

    return port


async def release_port(port: int):
    """Release a previously claimed port."""
    _claimed_ports.discard(port)
    task = _heartbeat_tasks.pop(port, None)
    if task:
        task.cancel()
    try:
        _sync_request("POST", "/api/ports/release", {"port": port})
    except SOTAgentError:
        pass


async def get_port(service_name: str) -> Optional[int]:
    """Get a service's port by name. Raises SOTAgentError if unreachable."""
    ports = _sync_request("GET", "/api/ports")
    if not isinstance(ports, list):
        raise SOTAgentError("SOTAgent returned non-list for ports query")
    for p in ports:
        sn = p.get("service_name", "")
        if sn == service_name or sn.lower().replace(" ", "-").replace("_", "-") == service_name.lower():
            return int(p["port"])
    return None


def claim_port_sync(*, service: str, project: str, preferred: Optional[int] = None) -> int:
    """Synchronous claim_port. Raises SOTAgentError if unreachable. No heartbeat."""
    result = _sync_request("POST", "/api/ports/allocate", {
        "service_name": service,
        "project": project,
        "preferred_port": preferred,
    })
    if not result.get("ok") or not result.get("port"):
        raise SOTAgentError(f"SOTAgent refused allocation for '{service}': {result.get('message', result)}")
    port = int(result["port"])
    _claimed_ports.add(port)
    return port


def release_port_sync(port: int):
    """Synchronous release_port."""
    _claimed_ports.discard(port)
    _heartbeat_tasks.pop(port, None)
    try:
        _sync_request("POST", "/api/ports/release", {"port": port})
    except SOTAgentError:
        pass


def get_port_sync(service_name: str) -> Optional[int]:
    """Synchronous get_port. Raises SOTAgentError if unreachable."""
    ports = _sync_request("GET", "/api/ports")
    if not isinstance(ports, list):
        raise SOTAgentError("SOTAgent returned non-list for ports query")
    for p in ports:
        sn = p.get("service_name", "")
        if sn == service_name or sn.lower().replace(" ", "-").replace("_", "-") == service_name.lower():
            return int(p["port"])
    return None


def discover_service_sync(service_name: str) -> dict:
    """Discover a service: returns gateway URL (preferred) and direct URL (fallback)."""
    gateway_url = f"{_base_url}/gw/{service_name.lower()}"
    port = get_port_sync(service_name)
    return {
        "gateway_url": gateway_url,
        "direct_url": f"http://127.0.0.1:{port}" if port else None,
        "port": port,
    }


def register_capabilities_sync(source, project: Optional[str] = None, service_name: Optional[str] = None):
    """Register capabilities from a file path or dict."""
    if isinstance(source, str):
        import json as _json
        from pathlib import Path as _Path
        data = _json.loads(_Path(source).read_text())
    else:
        data = source

    caps = data.get("capabilities", data) if isinstance(data, dict) else data
    if not isinstance(caps, list):
        raise ValueError("capabilities must be a list")

    result = _sync_request("POST", "/api/capabilities/register-batch", {
        "capabilities": caps,
        "project": project or (data.get("project") if isinstance(data, dict) else None),
        "service_name": service_name,
    })
    if not result.get("ok"):
        raise SOTAgentError(f"Capability registration failed: {result}")
    return result


def search_capabilities_sync(query: str) -> list:
    """Search capabilities by query."""
    from urllib.parse import quote
    return _sync_request("GET", f"/api/capabilities/search?q={quote(query)}")


def list_capabilities_sync() -> list:
    """List all registered capabilities."""
    return _sync_request("GET", "/api/capabilities")


# ─── Process Management SDK ───────────────────────────────────


def register_and_start(
    *,
    name: str,
    command: str,
    work_dir: Optional[str] = None,
    auto_start: bool = True,
    restart_on_failure: bool = True,
    max_restarts: int = 5,
    service_id: Optional[str] = None,
    health_check_url: Optional[str] = None,
) -> dict:
    """Register a service with SOTAgent and start it immediately.

    Returns {"ok": True, "service_id": "...", "pid": N} on success.
    Raises SOTAgentError on failure.
    """
    body = {
        "name": name,
        "command": command,
        "auto_start": auto_start,
        "restart_on_failure": restart_on_failure,
        "max_restarts": max_restarts,
    }
    if service_id:
        body["id"] = service_id
    if work_dir:
        body["work_dir"] = work_dir
    if health_check_url:
        body["health_check_url"] = health_check_url

    result = _sync_request("POST", "/api/services/register-and-start", body)
    if not result.get("ok"):
        raise SOTAgentError(f"Failed to register+start '{name}': {result.get('message', result)}")
    return result


def stop_service(service_id: str) -> dict:
    """Stop a running service. Returns {"ok": True/False, "message": "..."}."""
    return _sync_request("POST", f"/api/services/{service_id}/stop")


def restart_service(service_id: str) -> dict:
    """Restart a service. Returns {"ok": True/False, "pid": N}."""
    return _sync_request("POST", f"/api/services/{service_id}/restart")


def start_service(service_id: str) -> dict:
    """Start a previously registered service. Returns {"ok": True/False, "pid": N}."""
    return _sync_request("POST", f"/api/services/{service_id}/start")


def get_service_status(service_id: str) -> Optional[dict]:
    """Get the status of a specific service. Returns None if not found."""
    try:
        services = _sync_request("GET", "/api/services")
        if not isinstance(services, list):
            return None
        for svc in services:
            if svc.get("id") == service_id:
                return svc
        return None
    except SOTAgentError:
        return None


def list_services() -> list:
    """List all registered services."""
    return _sync_request("GET", "/api/services")


# ─── Task Reporting SDK ───────────────────────────────────

def submit_task(
    *,
    task_type: str,
    command: str,
    requester: Optional[str] = None,
    priority: int = 0,
    estimated_duration_sec: Optional[int] = None,
    checkpoint_path: Optional[str] = None,
    callback_url: Optional[str] = None,
    source_path: Optional[str] = None,
    output_dir: Optional[str] = None,
) -> dict:
    """Submit a compute task to SOTAgent for tracking.

    Use this when running CPU/GPU-intensive work (backtest, optimization,
    data collection, ML training, etc.) so SOTAgent can track progress,
    resource usage, and display it on the Task Board.

    Returns {"ok": True, "task_id": "...", "position": N}.
    Raises SOTAgentError on failure.
    """
    body: dict = {
        "task_type": task_type,
        "command": command,
        "requester": requester or f"sdk-{os.getpid()}",
        "priority": priority,
    }
    if estimated_duration_sec is not None:
        body["estimated_duration_sec"] = estimated_duration_sec
    if checkpoint_path:
        body["checkpoint_path"] = checkpoint_path
    if callback_url:
        body["callback_url"] = callback_url
    if source_path:
        body["source_path"] = source_path
    if output_dir:
        body["output_dir"] = output_dir

    result = _sync_request("POST", "/api/tasks", body)
    if not result.get("ok"):
        raise SOTAgentError(f"Failed to submit task '{task_type}': {result.get('message', result)}")
    return result


def complete_task(task_id: str) -> dict:
    """Mark a task as done via PATCH /api/tasks/:id.

    Returns {"ok": True/False}.
    """
    try:
        return _sync_request("PATCH", f"/api/tasks/{task_id}", {"status": "done"})
    except SOTAgentError:
        return {"ok": False, "message": "SOTAgent unreachable"}


def list_tasks(status: Optional[str] = None) -> list:
    """List compute tasks, optionally filtered by status.

    Status values: queued, running, done, failed.
    """
    path = "/api/tasks"
    if status:
        path += f"?status={status}"
    return _sync_request("GET", path)


# ─── Process Adoption (Resource-Pressure-Driven) ────────────────

def adopt_process(pid: int, task_type: str, owner: str) -> dict:
    """Submit a process for SOTAgent resource management.

    SOTAgent will SIGSTOP it under pressure and SIGCONT when idle.

    Args:
        pid: Process ID to manage
        task_type: Task category (e.g. 'optimizer', 'training')
        owner: Owning project/service name

    Returns:
        {"ok": True/False, "message": "..."}
    """
    return _sync_request("POST", "/api/processes/adopt", {
        "pid": pid,
        "task_type": task_type,
        "owner": owner,
    })


def release_process(pid: int) -> dict:
    """Release a previously adopted process. Ensures SIGCONT before release."""
    return _sync_request("DELETE", f"/api/processes/{pid}")


def list_adopted_processes() -> dict:
    """List all currently adopted processes."""
    return _sync_request("GET", "/api/processes")


def get_pressure() -> dict:
    """Get current system pressure state.

    Returns:
        {
            "mem_pressure": "normal"|"warn"|"critical",
            "mem_availability": 0-100,
            "cpu_load_ratio": float,
            "under_pressure": bool,
            "idle": bool
        }
    """
    return _sync_request("GET", "/api/pressure")


# ─── call() API ───────────────────────────────────────────────


class CapabilityNotFoundError(RuntimeError):
    def __init__(self, capability_id: str):
        super().__init__(f"Capability '{capability_id}' not found in registry")
        self.capability_id = capability_id


class ServiceUnreachableError(RuntimeError):
    def __init__(self, service_name: str, capability_id: str, cause: Optional[Exception] = None):
        super().__init__(f"Service '{service_name}' unreachable for capability '{capability_id}'")
        self.service_name = service_name
        self.capability_id = capability_id
        self.__cause__ = cause


class SchemaValidationError(RuntimeError):
    def __init__(self, capability_id: str, endpoint: str, details: str):
        super().__init__(f"Input validation failed for capability '{capability_id}': {details}")
        self.capability_id = capability_id
        self.endpoint = endpoint
        self.details = details


class SchemaValidationResponseError(RuntimeError):
    def __init__(self, capability_id: str, endpoint: str, details: str):
        super().__init__(f"Response validation failed for capability '{capability_id}': {details}")
        self.capability_id = capability_id
        self.endpoint = endpoint
        self.details = details


class UnsupportedTransportError(RuntimeError):
    def __init__(self, capability_id: str, transport: str):
        super().__init__(f"Transport '{transport}' not supported for capability '{capability_id}' (v1 supports HTTP only)")
        self.capability_id = capability_id
        self.transport = transport


_capability_cache: dict[str, tuple[dict, float]] = {}
_CAPABILITY_CACHE_TTL = 60.0


def _lookup_capability(capability_id: str) -> dict:
    import time
    now = time.time()
    cached = _capability_cache.get(capability_id)
    if cached and (now - cached[1]) < _CAPABILITY_CACHE_TTL:
        return cached[0]

    try:
        from urllib.parse import quote
        caps = _sync_request("GET", f"/api/capabilities/search?q={quote(capability_id)}")
    except SOTAgentError as e:
        raise ServiceUnreachableError("SOTAgent", capability_id, e)

    cap_list = caps if isinstance(caps, list) else (caps.get("capabilities", []) if isinstance(caps, dict) else [])
    match = next((c for c in cap_list if c.get("id") == capability_id), None)
    if match is None:
        raise CapabilityNotFoundError(capability_id)

    _capability_cache[capability_id] = (match, now)
    return match


def _validate_json_schema_basic(data: Any, schema: dict, label: str) -> None:
    if not schema or not isinstance(schema, dict):
        return
    if schema.get("type") == "object" and "required" in schema:
        if not isinstance(data, dict):
            raise ValueError(f"{label}: expected dict, got {type(data).__name__}")
        for key in schema["required"]:
            if key not in data:
                raise ValueError(f"{label}: missing required field '{key}'")


def call(
    capability_id: str,
    input: Any = None,
    validate_input: bool = True,
    validate_output: bool = True,
) -> dict:
    """Call a capability by ID. Three-step: lookup -> service discovery -> HTTP request."""
    cap = _lookup_capability(capability_id)

    transport = cap.get("transport", "http")
    if transport != "http":
        raise UnsupportedTransportError(capability_id, transport)

    if validate_input and cap.get("input_schema") and input is not None:
        try:
            _validate_json_schema_basic(input, cap["input_schema"], "input")
        except ValueError as e:
            raise SchemaValidationError(capability_id, cap.get("endpoint", "/"), str(e))

    service_name = cap.get("service_name", "")
    try:
        port = get_port_sync(service_name)
    except SOTAgentError as e:
        raise ServiceUnreachableError(service_name, capability_id, e)

    if port is None:
        raise ServiceUnreachableError(service_name, capability_id, RuntimeError("get_port returned None"))

    endpoint = cap.get("endpoint", "/")
    method = (cap.get("method") or "POST").upper()
    url = f"http://127.0.0.1:{port}{endpoint}"

    body = json.dumps(input).encode() if input is not None and method not in ("GET", "HEAD") else None
    req = urllib.request.Request(
        url, data=body, method=method,
        headers={"Content-Type": "application/json"} if body else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=cap.get("timeout_ms", 30000) / 1000) as resp:
            resp_data = json.loads(resp.read())
            if validate_output and cap.get("output_schema"):
                try:
                    _validate_json_schema_basic(resp_data, cap["output_schema"], "output")
                except ValueError as e:
                    raise SchemaValidationResponseError(capability_id, endpoint, str(e))
            return {"ok": True, "data": resp_data}
    except SchemaValidationResponseError:
        raise
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
        except Exception:
            err_body = str(e)
        return {"ok": False, "data": err_body, "error": str(e)}
    except urllib.error.URLError as e:
        raise ServiceUnreachableError(service_name, capability_id, e)


class _ClientProxy:
    def __init__(self, prefix: str):
        self._prefix = prefix

    def __getattr__(self, name: str):
        cap_id = name if self._prefix is None else f"{self._prefix}.{name}"
        def _call(input=None, validate_input=True, validate_output=True):
            return call(cap_id, input, validate_input=validate_input, validate_output=validate_output)
        return _call


def generate_client(service: Optional[str] = None, project: Optional[str] = None):
    """Pre-bind capabilities for a service or project."""
    prefix = (service or project or "").lower().replace(" ", "-").replace("_", "-") or None
    return _ClientProxy(prefix)
