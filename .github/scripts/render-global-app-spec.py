#!/usr/bin/env python3
"""Render the DO App Platform spec for the global backend.

Secret values arrive via environment variables inside the Actions runner and
are emitted as type SECRET envs; they never appear in workflow logs. Plain
config is inlined here so the spec is the single source of truth for the
overseas runtime environment.
"""
import os
import sys

REGISTRY = "meetpr-global"
IMAGE_REPO = "meetpr-backend"

def need(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"missing required env: {name}", file=sys.stderr)
        sys.exit(1)
    return value

image_tag = need("IMAGE_TAG")
s3_endpoint = need("S3_ENDPOINT")
s3_bucket = need("S3_BUCKET")

coach_shift = os.environ.get("COACH_PLAN_SHIFT_ENABLED", "false")
if coach_shift not in ("true", "false"):
    print("COACH_PLAN_SHIFT_ENABLED must be true or false", file=sys.stderr)
    sys.exit(1)

PLAIN = {
    "COACH_PLAN_SHIFT_ENABLED": coach_shift,
    "NODE_ENV": "production",
    "PORT": "8080",
    "LOG_LEVEL": "info",
    "JWT_ACCESS_TTL": "15m",
    "JWT_REFRESH_TTL": "30d",
    # Distinct issuer/audience keeps CN and global token domains disjoint and
    # pins today's values against future default drift in code.
    "JWT_ISSUER": "meetpr-global-api",
    "JWT_AUDIENCE": "meetpr-global-client",
    "AUTH_ALLOW_LEGACY_TOKENS": "false",
    "TRUST_PROXY": "1",
    "FORCE_HTTPS": "true",
    "PUBLIC_BASE_URL": "https://api.meetpr.app",
    "CORS_ORIGIN": "https://coach.meetpr.app",
    "RATE_LIMIT_WINDOW_MS": "60000",
    "RATE_LIMIT_MAX": "300",
    "EVENTS_RATE_LIMIT_WINDOW_MS": "60000",
    "EVENTS_RATE_LIMIT_MAX": "600",
    "ANALYTICS_ENABLED": "true",
    "ANALYTICS_SAMPLE_RATE": "1",
    "SIGNALS_CRON_ENABLED": "true",
    "PUSH_ENABLED": "true",
    "PUSH_DAILY_DIGEST_ENABLED": "true",
    # TestFlight builds talk to the production APNs environment.
    "APNS_ENV": "production",
    "APNS_KEY_ID": "6PMU9UXHAD",
    "APNS_TEAM_ID": "28JW4SA779",
    "APNS_BUNDLE_ID": "com.meetpr.global",
    "APPLE_CLIENT_ID": "com.meetpr.global",
    "GOOGLE_CLIENT_ID": "1070098660233-mntdt18uc68d9gdc3di1f07s2pbofncs.apps.googleusercontent.com",
    "SIWA_KEY_ID": "3F5VGUBA8T",
    "SIWA_TEAM_ID": "28JW4SA779",
    "SELF_SIGNUP_ROLES": "coached_student",
    # The CN phone track does not exist abroad; keep its register endpoint shut.
    "REGISTRATION_ENABLED": "false",
    "EMAIL_FROM": "MeetPR <no-reply@send.meetpr.app>",
    "STORAGE_BACKEND": "s3",
    "S3_ENDPOINT": s3_endpoint,
    "S3_REGION": "auto",
    "S3_BUCKET": s3_bucket,
}

# GH-secret env name -> runtime env name (APNS_KEY is the config key for the .p8).
SECRET = {
    "JWT_ACCESS_SECRET": "JWT_ACCESS_SECRET",
    "JWT_REFRESH_SECRET": "JWT_REFRESH_SECRET",
    "S3_ACCESS_KEY_ID": "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY": "S3_SECRET_ACCESS_KEY",
    "RESEND_API_KEY": "RESEND_API_KEY",
    "SIWA_PRIVATE_KEY": "SIWA_PRIVATE_KEY",
    "APNS_PRIVATE_KEY": "APNS_KEY",
}

def yaml_quote(value: str) -> str:
    # json.dumps produces a double-quoted string that is also valid YAML and
    # covers \r, tabs and other control characters, not just LF.
    import json

    return json.dumps(value)

lines = [
    "name: meetpr-backend-global",
    "region: nyc",
    "features: []",
    "domains:",
    "  - domain: api.meetpr.app",
    "    type: PRIMARY",
    "  - domain: coach.meetpr.app",
    "    type: ALIAS",
    "databases:",
    "  - name: globalpg",
    "    engine: PG",
    "    cluster_name: meetpr-global-pg",
    "    production: true",
    "services:",
    "  - name: api",
    "    image:",
    "      registry_type: DOCR",
    f"      repository: {IMAGE_REPO}",
    f"      tag: {image_tag}",
    "    instance_count: 1",
    "    instance_size_slug: basic-xxs",
    "    http_port: 8080",
    "    health_check:",
    "      http_path: /health",
    "      initial_delay_seconds: 10",
    "    envs:",
    "      - key: DATABASE_URL",
    "        scope: RUN_TIME",
    "        value: ${globalpg.DATABASE_URL}",
    "      - key: DATABASE_CA_CERT",
    "        scope: RUN_TIME",
    "        value: ${globalpg.CA_CERT}",
]

for key, value in PLAIN.items():
    lines += [
        f"      - key: {key}",
        "        scope: RUN_TIME",
        f"        value: {yaml_quote(value)}",
    ]

for gh_name, env_name in SECRET.items():
    value = need(gh_name)
    lines += [
        f"      - key: {env_name}",
        "        scope: RUN_TIME",
        "        type: SECRET",
        f"        value: {yaml_quote(value)}",
    ]

print("\n".join(lines))
