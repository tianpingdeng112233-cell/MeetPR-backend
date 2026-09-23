#!/usr/bin/env python3
"""Read-only Global release facts; credentials stay in runner memory."""
import base64
import datetime
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

APP = "meetpr-backend-global"
DATABASE = "meetpr-global-pg"
SQL = """BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT json_build_object(
  'read_only', current_setting('transaction_read_only'),
  'postgres_version', current_setting('server_version'),
  'migrations', (SELECT coalesce(json_agg(name ORDER BY name), '[]'::json) FROM meetpr_migrations),
  'shift_batches_exists', to_regclass('public.plan_shift_batches') IS NOT NULL,
  'shift_seq_exists', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='plan_day_shifts' AND column_name='seq')
);
ROLLBACK;
"""


def run(args, *, env=None, input=None):
    try:
        result = subprocess.run(args, env=env, input=input, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("read-only command unavailable or timed out") from None
    if result.returncode:
        raise RuntimeError("read-only command failed; raw diagnostics withheld")
    return result.stdout


def one(value):
    if isinstance(value, list):
        if len(value) != 1:
            raise RuntimeError("expected exactly one resource")
        return value[0]
    return value


def collect(runner=run):
    def do(*args):
        return json.loads(runner(["doctl", *args, "--output", "json"]))

    apps = [app for app in do("apps", "list") if app.get("spec", {}).get("name") == APP]
    app = one(apps)
    app = one(do("apps", "get", app["id"]))
    active = app.get("active_deployment")
    if not active or active.get("phase") != "ACTIVE":
        raise RuntimeError("no active deployment")
    spec = active.get("spec") or {}
    if spec.get("name") != APP:
        raise RuntimeError("active deployment name mismatch")
    service = one([s for s in spec.get("services", []) if s.get("name") == "api"])
    image = service.get("image") or {}
    if (image.get("registry_type") != "DOCR" or image.get("repository") != "meetpr-backend"
            or not (re.fullmatch(r"sha-[0-9a-f]{40}", image.get("tag", ""))
                    or re.fullmatch(r"sha256:[0-9a-f]{64}", image.get("digest", "")))):
        raise RuntimeError("active API image is missing or unrecognized")
    config = {e["key"]: e for e in [*spec.get("envs", []), *service.get("envs", [])]
              if e.get("scope") != "BUILD_TIME"}
    binding = one([d for d in spec.get("databases", []) if d.get("name") == "globalpg"])
    if (binding.get("cluster_name") != DATABASE or binding.get("engine") != "PG"
            or binding.get("production") is not True
            or config.get("DATABASE_URL", {}).get("value") != "${globalpg.DATABASE_URL}"):
        raise RuntimeError("active API database binding mismatch")
    flag = config.get("COACH_PLAN_SHIFT_ENABLED")
    flag_value = "absent" if flag is None else (
        flag.get("value") if flag.get("type") != "SECRET" and flag.get("value") in ("true", "false") else "unknown")
    services = [{"name": "api", "image": {k: image.get(k) for k in ("registry", "repository", "tag", "digest")},
                 "coach_plan_shift_enabled": flag_value}]
    clusters = [db for db in do("databases", "list") if db.get("name") == DATABASE]
    db = one(clusters)
    if db.get("engine") != "pg":
        raise RuntimeError("database engine mismatch")
    connection = one(do("databases", "connection", db["id"]))
    if binding.get("db_name") and binding["db_name"] != connection["database"]:
        raise RuntimeError("bound database differs from default connection")
    cert = one(do("databases", "get-ca", db["id"]))["certificate"]
    pem = cert if cert.startswith("-----BEGIN CERTIFICATE-----") else base64.b64decode(cert, validate=True).decode()
    backups = do("databases", "backups", db["id"])
    with tempfile.TemporaryDirectory(prefix="meetpr-preflight-") as directory:
        ca = Path(directory) / "ca.crt"
        ca.write_text(pem)
        ca.chmod(0o600)
        env = {**os.environ, "PGHOST": connection["host"], "PGPORT": str(connection["port"]),
               "PGDATABASE": connection["database"], "PGUSER": connection["user"],
               "PGPASSWORD": connection["password"], "PGSSLMODE": "verify-full",
               "PGSSLROOTCERT": str(ca), "PGCONNECT_TIMEOUT": "10",
               "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=10000"}
        raw = runner(["psql", "-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1"], env=env, input=SQL)
        ledger = json.loads(raw)
        if ledger.get("read_only") != "on":
            raise RuntimeError("database read-only guard not active")
    return {"checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "app_name": APP, "active_deployment_id": active["id"],
            "active_deployment_created_at": active.get("created_at"), "services": services,
            "database_name": DATABASE, "database_status": db.get("status"),
            "ledger": ledger,
            "backups": [{k: b.get(k) for k in ("created_at", "size_gigabytes")} for b in backups],
            "backup_restore_verified": False}


if __name__ == "__main__":
    try:
        print(json.dumps(collect(), indent=2))
    except Exception:
        raise SystemExit("Global read-only preflight failed; no raw credentials or diagnostics emitted") from None
