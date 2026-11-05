#!/usr/bin/env python3
"""Build a separate SQLite database from a PostgreSQL plain INSERT export."""

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3


NAME = r"[a-zA-Z_][a-zA-Z0-9_]*"
IDENTIFIER = rf'(?:"{NAME}"|{NAME})'
TABLE = rf'"public"\."(?P<table>{NAME})"'
CREATE = re.compile(rf"CREATE TABLE {TABLE}\s*\((?P<body>.*)\);", re.S | re.I)
INSERT = re.compile(
    rf"INSERT INTO {TABLE}\s*\((?P<columns>[^)]+)\)\s+VALUES\s*",
    re.S | re.I,
)
FOREIGN_KEY = re.compile(
    rf"ALTER TABLE {TABLE}\s+ADD\s+(?:CONSTRAINT\s+\"[^\"]+\"\s+)?"
    rf"FOREIGN KEY\s*\((?P<columns>[^)]+)\)\s+REFERENCES\s+"
    rf'"public"\."(?P<parent>{NAME})"\s*\((?P<parent_columns>[^)]+)\)'
    r"(?:\s+ON (?:DELETE|UPDATE) (?:CASCADE|RESTRICT|NO ACTION|SET NULL))*;",
    re.S | re.I,
)
COLUMN = re.compile(rf'^\s*"(?P<name>{NAME})"\s+(?P<type>{NAME})\b', re.M)
LITERAL = re.compile(
    r"'(?:''|[^'])*'|[+-]?\d+|NULL\b|TRUE\b|FALSE\b",
    re.S | re.I,
)
MIGRATIONS = "__diesel_schema_migrations"


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def columns(text):
    names = re.findall(rf'"({NAME})"', text)
    if not names or re.sub(rf'"{NAME}"|\s|,', "", text):
        raise ValueError("Unsupported column list in export")
    if len(names) != len(set(names)):
        raise ValueError("Repeated column in export")
    return names


def statements(text):
    """SQLite recognizes the same standard quotes used in this export format."""
    pending = []
    for line in text.splitlines(keepends=True):
        if not pending and (not line.strip() or line.lstrip().startswith("--")):
            continue
        pending.append(line)
        if ";" in line:
            statement = "".join(pending)
            if sqlite3.complete_statement(statement):
                yield statement.strip()
                pending = []
    if pending and any(line.strip() for line in pending):
        raise ValueError("Incomplete SQL statement at end of export")


def parse_rows(text, width):
    position = 0

    def whitespace():
        nonlocal position
        while position < len(text) and text[position].isspace():
            position += 1

    def expect(character):
        nonlocal position
        whitespace()
        if position >= len(text) or text[position] != character:
            raise ValueError("Unsupported or malformed INSERT values")
        position += 1

    while True:
        expect("(")
        row = []
        for index in range(width):
            if index:
                expect(",")
            whitespace()
            match = LITERAL.match(text, position)
            if not match:
                raise ValueError("Only standard string, integer, boolean and NULL literals are supported")
            token = match.group()
            position = match.end()
            if token.startswith("'"):
                value = token[1:-1].replace("''", "'")
            elif token.upper() == "NULL":
                value = None
            elif token.upper() in ("TRUE", "FALSE"):
                value = int(token.upper() == "TRUE")
            else:
                value = int(token)
            row.append(value)
        expect(")")
        yield tuple(row)
        whitespace()
        if position < len(text) and text[position] == ",":
            position += 1
            continue
        expect(";")
        whitespace()
        if position != len(text):
            raise ValueError("Unexpected SQL after INSERT values")
        return


def convert_value(value, sql_type, location):
    if value is None:
        return None
    sql_type = sql_type.lower()
    if sql_type in ("bool", "boolean"):
        if type(value) is int and value in (0, 1):
            return value
        if isinstance(value, str) and value.lower() in ("t", "true", "1", "f", "false", "0"):
            return int(value.lower() in ("t", "true", "1"))
        raise ValueError(location + ": invalid PostgreSQL boolean")
    if sql_type == "bytea":
        if not isinstance(value, str) or not value.startswith("\\x"):
            raise ValueError(location + ": expected PostgreSQL hex bytea")
        try:
            return bytes.fromhex(value[2:])
        except ValueError:
            raise ValueError(location + ": invalid PostgreSQL hex bytea") from None
    if sql_type in ("int2", "int4", "int8", "smallint", "integer", "bigint"):
        if type(value) is not int or not -(2**63) <= value < 2**63:
            raise ValueError(location + ": expected an integer within SQLite range")
        return value
    if sql_type in ("text", "varchar", "bpchar", "char", "timestamp", "date", "timestamptz"):
        if not isinstance(value, str):
            raise ValueError(location + ": expected text")
        return value
    raise ValueError(location + ": unsupported source column type " + sql_type)


def read_export(raw):
    definitions, primary_keys, records, references = {}, {}, {}, []
    data_statements = []
    for statement in statements(raw.decode("utf-8-sig")):
        match = CREATE.fullmatch(statement)
        if match:
            table = match["table"]
            if table in definitions:
                raise ValueError("Repeated table definition: " + table)
            definitions[table] = {
                column["name"]: column["type"] for column in COLUMN.finditer(match["body"])
            }
            key = re.search(r"PRIMARY KEY\s*\(([^)]+)\)", match["body"], re.I)
            primary_keys[table] = columns(key[1]) if key else []
            records[table] = []
            continue
        match = INSERT.match(statement)
        if match:
            data_statements.append((match["table"], columns(match["columns"]), statement[match.end():]))
            continue
        match = FOREIGN_KEY.fullmatch(statement)
        if match:
            references.append(
                (match["table"], columns(match["columns"]), match["parent"], columns(match["parent_columns"]))
            )
            continue
        if re.fullmatch(rf"DROP TABLE IF EXISTS {TABLE};", statement, re.I):
            continue
        if re.fullmatch(
            rf'CREATE UNIQUE INDEX {IDENTIFIER} ON (?:"public"|public)\.{IDENTIFIER} USING btree\s*\([^;]+\);',
            statement,
            re.S | re.I,
        ):
            continue
        raise ValueError("Unsupported export statement; expected plain CREATE, INSERT or foreign key metadata")
    if not definitions or not data_statements:
        raise ValueError("Export contains no table definitions or data")
    for table, names, values in data_statements:
        if table not in definitions or names != list(definitions[table]):
            raise ValueError(table + ": INSERT columns must match the exported table definition")
        for row in parse_rows(values, len(names)):
            records[table].append(
                tuple(convert_value(value, definitions[table][name], table + "." + name)
                      for name, value in zip(names, row))
            )
    for table, keys in primary_keys.items():
        positions = [list(definitions[table]).index(name) for name in keys]
        values = [tuple(row[index] for index in positions) for row in records[table]]
        if keys and (len(values) != len(set(values)) or any(None in value for value in values)):
            raise ValueError(table + ": invalid source primary keys")
    return definitions, records, references


def import_database(source, schema, output, report_path):
    source, schema, output, report_path = map(Path, (source, schema, output, report_path))
    if output.resolve() in (source.resolve(), schema.resolve()) or output.resolve() == report_path.resolve():
        raise ValueError("Output, schema, export and report must use separate paths")
    if output.exists() or report_path.exists():
        raise ValueError("Output database and report must not already exist")
    raw = source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    definitions, records, references = read_export(raw)
    if MIGRATIONS not in definitions:
        raise ValueError("Source migration metadata is missing")
    created = []
    imported_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")
    try:
        fd = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        created.append(output)
        with closing(sqlite3.connect(schema.resolve().as_uri() + "?mode=ro", uri=True)) as template:
            template.execute("BEGIN")
            ddl = template.execute(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
                "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
            ).fetchall()
            migrations = template.execute("SELECT version, run_on FROM " + quote(MIGRATIONS)).fetchall()
        if not migrations:
            raise ValueError("Schema template must be initialized by Vaultwarden first")
        with closing(sqlite3.connect(output)) as target, target:
            target.execute("PRAGMA foreign_keys=OFF")
            target.execute("BEGIN")
            for (sql,) in ddl:
                target.execute(sql)
            target.executemany("INSERT INTO " + quote(MIGRATIONS) + " VALUES (?, ?)", migrations)
            tables = {row[0] for row in target.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if set(definitions) - tables:
                raise ValueError("Source contains tables absent from the target schema")
            counts, added_columns = {}, {}
            for table, source_columns in definitions.items():
                if table == MIGRATIONS:
                    continue
                info = target.execute("PRAGMA table_info(" + quote(table) + ")").fetchall()
                target_columns = {column[1]: column for column in info}
                if set(source_columns) - set(target_columns):
                    raise ValueError(table + ": source columns would be lost")
                missing = set(target_columns) - set(source_columns)
                for name in missing:
                    column = target_columns[name]
                    if column[3] and column[4] is None:
                        raise ValueError(table + "." + name + ": missing required target value")
                if missing:
                    added_columns[table] = sorted(missing)
                names = list(source_columns)
                rows = records[table]
                insert_names, insert_rows = list(names), rows
                # This mirrors the policy revision migration's backfill on existing rows.
                if table == "org_policies" and "revision_date" in missing:
                    insert_names.append("revision_date")
                    insert_rows = [row + (imported_at,) for row in rows]
                sql = "INSERT INTO " + quote(table) + " (" + ", ".join(map(quote, insert_names))
                sql += ") VALUES (" + ", ".join("?" for _ in insert_names) + ")"
                target.executemany(sql, insert_rows)
                actual = target.execute("SELECT " + ", ".join(map(quote, names)) + " FROM " + quote(table)).fetchall()
                if Counter(actual) != Counter(rows):
                    raise ValueError(table + ": imported field values do not match the source")
                counts[table] = {"source": len(rows), "sqlite": len(actual), "all_source_fields_match": True}
            for table, names, parent, parent_names in references:
                if len(names) != len(parent_names):
                    raise ValueError("Invalid source foreign key")
                nonnull = " AND ".join("child." + quote(name) + " IS NOT NULL" for name in names)
                join = " AND ".join(
                    "child." + quote(name) + " = parent." + quote(parent_name)
                    for name, parent_name in zip(names, parent_names)
                )
                sql = "SELECT COUNT(*) FROM " + quote(table) + " child WHERE " + nonnull
                sql += " AND NOT EXISTS (SELECT 1 FROM " + quote(parent) + " parent WHERE " + join + ")"
                if target.execute(sql).fetchone()[0]:
                    raise ValueError(table + ": source foreign key has orphaned records")
            if target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("SQLite integrity check failed")
            if target.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError("SQLite foreign key check failed")
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise ValueError("Export changed during import")
        report = {
            "source": str(source.resolve()),
            "source_sha256": digest,
            "schema_template": str(schema.resolve()),
            "output": str(output.resolve()),
            "imported_at_utc": imported_at,
            "source_migration_rows": len(records[MIGRATIONS]),
            "preserved_sqlite_migration_rows": len(migrations),
            "tables": counts,
            "total_imported_rows": sum(row["source"] for row in counts.values()),
            "source_foreign_keys_verified": len(references),
            "sqlite_integrity_check": "ok",
            "sqlite_foreign_key_check": "ok",
            "new_columns_filled": added_columns,
            "org_policy_revision_backfill_utc": imported_at if "org_policies" in added_columns else None,
            "target_only_tables": sorted(tables - set(definitions)),
        }
        fd = os.open(str(report_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created.append(report_path)
        with os.fdopen(fd, "w") as handle:
            json.dump(report, handle, indent=2)
            handle.write("\n")
        return report
    except Exception:
        for path in reversed(created):
            path.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--schema", required=True, type=Path, help="Existing initialized SQLite database (read only)")
    parser.add_argument("--output", required=True, type=Path, help="New database path; never replaces the live database")
    parser.add_argument("--report", required=True, type=Path, help="New JSON verification report path")
    args = parser.parse_args()
    try:
        report = import_database(args.source, args.schema, args.output, args.report)
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.exit(1, "Import failed: " + str(error) + "\n")
    for table, counts in sorted(report["tables"].items()):
        print(table + ": " + str(counts["sqlite"]) + " rows, all source fields verified")
    print("Verified " + str(report["total_imported_rows"]) + " rows; source foreign keys: "
          + str(report["source_foreign_keys_verified"]))
    print("Database: " + report["output"])
    print("Report: " + str(args.report.resolve()))


if __name__ == "__main__":
    main()
