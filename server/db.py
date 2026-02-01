import json
import sqlite3
from typing import Iterable

from .config import DB_PATH


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = connect()
    cur = conn.cursor()
    cur.executescript(
        """
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,
            path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            preview_name TEXT,
            media_type TEXT NOT NULL,
            mime TEXT,
            format TEXT,
            size_bytes INTEGER NOT NULL,
            width INTEGER,
            height INTEGER,
            duration_ms INTEGER,
            folder_id INTEGER,
            note TEXT,
            colors TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS asset_tags (
            asset_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY(asset_id, tag_id),
            FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS smart_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            query_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_assets_format ON assets(format);
        CREATE INDEX IF NOT EXISTS idx_assets_media_type ON assets(media_type);
        CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder_id);
        CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
        CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);
        """
    )
    conn.commit()
    try:
        conn.execute("ALTER TABLE assets ADD COLUMN preview_name TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.close()


def fetch_all(query: str, params: Iterable = ()):  # type: ignore[override]
    conn = connect()
    cur = conn.execute(query, params)
    rows = cur.fetchall()
    conn.close()
    return rows


def fetch_one(query: str, params: Iterable = ()):  # type: ignore[override]
    conn = connect()
    cur = conn.execute(query, params)
    row = cur.fetchone()
    conn.close()
    return row


def execute(query: str, params: Iterable = ()):  # type: ignore[override]
    conn = connect()
    cur = conn.execute(query, params)
    conn.commit()
    last_id = cur.lastrowid
    conn.close()
    return last_id


def execute_many(query: str, params_list: Iterable[Iterable]):
    conn = connect()
    conn.executemany(query, params_list)
    conn.commit()
    conn.close()


def to_json(value) -> str:
    return json.dumps(value, ensure_ascii=True)


def from_json(value):
    if value is None:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None
