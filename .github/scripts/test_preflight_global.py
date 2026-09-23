import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("preflight-global.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreflightTest(unittest.TestCase):
    def fake(self, args, **kwargs):
        self.commands.append((args, kwargs))
        if args[0] == "psql":
            self.assertIn("BEGIN READ ONLY", kwargs["input"])
            self.assertIn("ROLLBACK", kwargs["input"])
            self.assertEqual(kwargs["env"]["PGSSLMODE"], "verify-full")
            self.assertIn("default_transaction_read_only=on", kwargs["env"]["PGOPTIONS"])
            self.assertNotIn("secret-password", " ".join(args))
            return json.dumps({"read_only": "on", "migrations": ["0068-plan-pending-revisions.sql"]})
        command = tuple(args[1:-2])
        return json.dumps({
            ("apps", "list"): [{"id": "app-id", "spec": {"name": module.APP}}],
            ("apps", "get", "app-id"): [{"active_deployment": {"id": "active-id", "phase": "ACTIVE", "spec": {
                "name": module.APP, "databases": [{"name": "globalpg", "engine": "PG", "production": True, "cluster_name": module.DATABASE}], "services": [{"name": "api", "image": {"tag": "sha-" + "a" * 40, "repository": "meetpr-backend", "registry_type": "DOCR"},
                    "envs": [{"key": "DATABASE_URL", "value": "${globalpg.DATABASE_URL}"}, {"key": "JWT_ACCESS_SECRET", "value": "secret-jwt", "type": "SECRET"},
                             {"key": "COACH_PLAN_SHIFT_ENABLED", "value": "false", "type": "GENERAL"}]}]}}}],
            ("databases", "list"): [{"id": "db-id", "name": module.DATABASE, "engine": "pg", "status": "online"}],
            ("databases", "connection", "db-id"): [{"host": "private.test", "port": 25060, "database": "defaultdb", "user": "private-user", "password": "secret-password"}],
            ("databases", "get-ca", "db-id"): [{"certificate": "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----"}],
            ("databases", "backups", "db-id"): [{"created_at": "2026-09-23T00:00:00Z", "size_gigabytes": 0.2, "hidden": "secret-backup"}],
        }[command])

    def setUp(self):
        self.commands = []

    def test_output_is_allowlisted_and_database_query_is_read_only(self):
        result = module.collect(self.fake)
        output = json.dumps(result)
        for sensitive in ("secret-jwt", "secret-password", "private.test", "private-user", "secret-backup"):
            self.assertNotIn(sensitive, output)
        self.assertEqual(result["services"][0]["coach_plan_shift_enabled"], "false")
        self.assertFalse(result["backup_restore_verified"])
        self.assertEqual(result["active_deployment_id"], "active-id")
        self.assertEqual(len(self.commands), 7)

    def test_ambiguous_app_fails_before_any_database_access(self):
        def duplicate(args, **kwargs):
            value = json.loads(self.fake(args, **kwargs))
            return json.dumps(value * 2) if args[1:3] == ["apps", "list"] else json.dumps(value)
        with self.assertRaises(RuntimeError):
            module.collect(duplicate)
        self.assertEqual(len(self.commands), 1)

    def altered_runner(self, change):
        def altered(args, **kwargs):
            value = json.loads(self.fake(args, **kwargs))
            if args[1:3] == ["apps", "get"]:
                change(value[0]["active_deployment"]["spec"])
            return json.dumps(value)
        return altered

    def test_missing_service_or_wrong_database_binding_fails_closed(self):
        for change in [lambda s: s.update(services=[]),
                       lambda s: s["databases"][0].update(cluster_name="wrong-cluster"),
                       lambda s: s["services"][0].update(image={})]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                module.collect(self.altered_runner(change))

    def test_secret_override_does_not_reveal_or_fall_back_to_app_flag(self):
        def change(s):
            s["envs"] = [{"key": "COACH_PLAN_SHIFT_ENABLED", "value": "true"}]
            s["services"][0]["envs"][-1] = {"key": "COACH_PLAN_SHIFT_ENABLED", "type": "SECRET", "value": "secret-flag"}
        result = module.collect(self.altered_runner(change))
        self.assertEqual(result["services"][0]["coach_plan_shift_enabled"], "unknown")
        self.assertNotIn("secret-flag", json.dumps(result))

    def test_build_time_flag_does_not_override_runtime_flag(self):
        def change(s):
            s["envs"] = [{"key": "COACH_PLAN_SHIFT_ENABLED", "value": "true", "scope": "RUN_TIME"}]
            s["services"][0]["envs"][-1].update(scope="BUILD_TIME")
        result = module.collect(self.altered_runner(change))
        self.assertEqual(result["services"][0]["coach_plan_shift_enabled"], "true")

    def test_workflow_modes_are_mutually_exclusive(self):
        text = Path(__file__).parents[1].joinpath("workflows/deploy-global.yml").read_text()
        self.assertIn("preflight:\n    if: ${{ inputs.read_only_preflight == true }}", text)
        self.assertIn("deploy:\n    if: ${{ inputs.read_only_preflight != true }}", text)
        self.assertNotIn("apps create", text.split("  preflight:\n")[1].split("  deploy:\n")[0])


if __name__ == "__main__":
    unittest.main()
