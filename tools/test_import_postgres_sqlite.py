import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from import_postgres_sqlite import import_database


EXPORT = r"""
-- Synthetic PostgreSQL export, with no production data.
CREATE TABLE "public"."__diesel_schema_migrations" (
    "version" varchar(50) NOT NULL,
    "run_on" timestamp NOT NULL,
    PRIMARY KEY ("version")
);
INSERT INTO "public"."__diesel_schema_migrations" ("version", "run_on") VALUES
('postgres-version', '2025-01-01 00:00:00');
DROP TABLE IF EXISTS "public"."users";
CREATE TABLE "public"."users" (
    "uuid" text NOT NULL,
    "name" text NOT NULL,
    "password_hash" bytea NOT NULL,
    "enabled" bool NOT NULL,
    "hint" text,
    PRIMARY KEY ("uuid")
);
INSERT INTO "public"."users" ("uuid", "name", "password_hash", "enabled", "hint") VALUES
('user-1', 'Apostrophe''s ; quote, \path
second line', '\x00017fff', 't', NULL),
('user-2', 'Unicode \u4e2d\u6587', '\x', 'f', 'literal NULL');
CREATE TABLE "public"."org_policies" (
    "uuid" text NOT NULL,
    "user_uuid" text,
    PRIMARY KEY ("uuid")
);
INSERT INTO "public"."org_policies" ("uuid", "user_uuid") VALUES
('policy-1', 'user-1'), ('policy-2', NULL);
ALTER TABLE "public"."org_policies" ADD FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("uuid") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX users_name_key ON public.users USING btree (name);
CREATE UNIQUE INDEX "users_uuid_key" ON "public"."users" USING btree ("uuid");
"""


class PostgresImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "export.sql"
        self.schema = self.root / "schema.sqlite3"
        self.output = self.root / "import.sqlite3"
        self.report = self.root / "report.json"
        self.source.write_text(EXPORT.replace(r"\u4e2d\u6587", "\u4e2d\u6587"))
        with sqlite3.connect(self.schema) as db:
            db.executescript("""
                CREATE TABLE __diesel_schema_migrations (version TEXT PRIMARY KEY, run_on TEXT);
                INSERT INTO __diesel_schema_migrations VALUES ('sqlite-version', '2026-01-01');
                CREATE TABLE users (
                    uuid TEXT PRIMARY KEY, name TEXT NOT NULL, password_hash BLOB NOT NULL,
                    enabled BOOLEAN NOT NULL, hint TEXT, key_id TEXT
                );
                CREATE TABLE org_policies (
                    uuid TEXT PRIMARY KEY, user_uuid TEXT REFERENCES users(uuid),
                    revision_date DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00'
                );
                CREATE TABLE archives (uuid TEXT PRIMARY KEY);
                INSERT INTO users VALUES ('template-user', 'Do not copy', X'ff', 1, NULL, NULL);
            """)

    def run_import(self):
        return import_database(self.source, self.schema, self.output, self.report)

    def test_preserves_values_types_migrations_and_backfill(self):
        raw = self.source.read_bytes()
        report = self.run_import()
        with sqlite3.connect(self.output) as db:
            rows = db.execute(
                "SELECT uuid, name, password_hash, typeof(password_hash), enabled, typeof(enabled), hint, key_id "
                "FROM users ORDER BY uuid"
            ).fetchall()
            self.assertEqual(
                rows[0], ("user-1", "Apostrophe's ; quote, \\path\nsecond line", b"\x00\x01\x7f\xff", "blob", 1, "integer", None, None)
            )
            self.assertEqual(rows[1], ("user-2", "Unicode \u4e2d\u6587", b"", "blob", 0, "integer", "literal NULL", None))
            self.assertEqual(db.execute("SELECT version FROM __diesel_schema_migrations").fetchall(), [("sqlite-version",)])
            self.assertEqual(db.execute("SELECT count(*) FROM archives").fetchone()[0], 0)
            self.assertEqual(
                db.execute("SELECT DISTINCT revision_date FROM org_policies").fetchall(),
                [(report["imported_at_utc"],)],
            )
        with sqlite3.connect(self.schema) as db:
            self.assertEqual(db.execute("SELECT uuid FROM users").fetchall(), [("template-user",)])
        self.assertEqual(raw, self.source.read_bytes())
        self.assertEqual(report["total_imported_rows"], 4)
        self.assertEqual(report["source_foreign_keys_verified"], 1)
        self.assertEqual(json.loads(self.report.read_text()), report)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)

    def test_rejects_invalid_literals_and_relationships_without_partial_output(self):
        for original, replacement in [
            ("'t'", "'unexpected'"),
            (r"'\x00017fff'", r"'\xnothex'"),
            ("'Apostrophe''s ; quote, \\path\nsecond line'", "E'escaped'"),
            ("('policy-1', 'user-1')", "('policy-1', 'missing-user')"),
            ("('user-2',", "('user-1',"),
        ]:
            with self.subTest(replacement=replacement):
                self.source.write_text(EXPORT.replace(original, replacement))
                with self.assertRaises(ValueError):
                    self.run_import()
                self.assertFalse(self.output.exists())
                self.assertFalse(self.report.exists())

    def test_never_overwrites_existing_output(self):
        self.output.write_bytes(b"keep existing database")
        with self.assertRaises(ValueError):
            self.run_import()
        self.assertEqual(self.output.read_bytes(), b"keep existing database")

    def test_rejects_loss_of_source_columns(self):
        with sqlite3.connect(self.schema) as db:
            db.execute("ALTER TABLE users DROP COLUMN hint")
        with self.assertRaisesRegex(ValueError, "source columns would be lost"):
            self.run_import()
        self.assertFalse(self.output.exists())

    def test_rejects_missing_required_new_columns(self):
        with sqlite3.connect(self.schema) as db:
            db.execute("DELETE FROM users")
            db.execute("ALTER TABLE users ADD COLUMN required_value TEXT NOT NULL")
        with self.assertRaisesRegex(ValueError, "missing required target value"):
            self.run_import()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
