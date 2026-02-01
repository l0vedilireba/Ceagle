from __future__ import annotations

import json
import shutil
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import STORAGE_DIR
from .db import execute, execute_many, fetch_all, fetch_one, from_json, init_db, to_json
from .utils import (
    detect_media_type,
    file_extension,
    ffmpeg_thumbnail,
    ffprobe_metadata,
    image_metadata,
    is_raw_extension,
    raw_preview,
    sniff_mime,
)

app = FastAPI(title="Meagle")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)


@app.middleware("http")
async def api_prefix_middleware(request: Request, call_next):
    request.state.original_path = request.url.path
    if request.url.path == "/api":
        request.scope["path"] = "/"
    elif request.url.path.startswith("/api/"):
        request.scope["path"] = request.scope["path"][4:] or "/"
    return await call_next(request)

def iter_file_range(file_path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with file_path.open("rb") as handle:
        handle.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            read_size = min(chunk_size, remaining)
            data = handle.read(read_size)
            if not data:
                break
            remaining -= len(data)
            yield data


@app.head("/media/{file_path:path}")
def media_head(file_path: str):
    safe_path = sanitize_path(file_path)
    target = STORAGE_DIR / safe_path
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "file missing")
    file_size = target.stat().st_size
    media_type = sniff_mime(target.name) or "application/octet-stream"
    return Response(
        status_code=200,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
            "Content-Type": media_type,
        },
    )


@app.get("/media/{file_path:path}")
def media_stream(file_path: str, request: Request):
    safe_path = sanitize_path(file_path)
    target = STORAGE_DIR / safe_path
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "file missing")

    file_size = target.stat().st_size
    media_type = sniff_mime(target.name) or "application/octet-stream"
    range_header = request.headers.get("range")
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": media_type,
        "Content-Length": str(file_size),
    }

    if not range_header:
        return FileResponse(target, media_type=media_type, headers=headers)

    try:
        unit, value = range_header.split("=", 1)
        if unit.strip().lower() != "bytes":
            raise ValueError("invalid range unit")
        start_str, end_str = value.split("-", 1)
        if start_str == "":
            length = int(end_str)
            start = max(file_size - length, 0)
            end = file_size - 1
        else:
            start = int(start_str)
            end = int(end_str) if end_str else file_size - 1
        if start < 0 or end < start or start >= file_size:
            raise ValueError("invalid range")
        end = min(end, file_size - 1)
    except Exception:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    headers.update(
        {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(end - start + 1),
        }
    )
    return StreamingResponse(
        iter_file_range(target, start, end),
        status_code=206,
        media_type=media_type,
        headers=headers,
    )


def now_iso() -> str:
    return datetime.utcnow().isoformat()


def normalize_tags(tags: Optional[str]) -> List[str]:
    if not tags:
        return []
    items = [t.strip() for t in tags.split(",")]
    return [t for t in items if t]


def normalize_annotations(value: Optional[str]) -> List[str]:
    if not value:
        return []
    items = [t.strip() for t in value.split(",")]
    return [t.lower() for t in items if t]


def ensure_tags(tag_names: List[str]) -> Dict[str, int]:
    if not tag_names:
        return {}
    existing = fetch_all(
        f"SELECT id, name FROM tags WHERE name IN ({','.join('?' for _ in tag_names)})",
        tag_names,
    )
    tag_map = {row["name"]: row["id"] for row in existing}
    missing = [t for t in tag_names if t not in tag_map]
    for name in missing:
        tag_id = execute("INSERT INTO tags(name) VALUES (?)", (name,))
        tag_map[name] = tag_id
    return tag_map


def set_asset_tags(asset_id: int, tag_names: List[str]) -> List[str]:
    if tag_names is None:
        return []
    tag_names = sorted(set(tag_names))
    tag_map = ensure_tags(tag_names)
    execute("DELETE FROM asset_tags WHERE asset_id = ?", (asset_id,))
    if tag_map:
        execute_many(
            "INSERT INTO asset_tags(asset_id, tag_id) VALUES (?, ?)",
            [(asset_id, tag_map[name]) for name in tag_names],
        )
    return tag_names


def get_tags_for_assets(asset_ids: List[int]) -> Dict[int, List[str]]:
    if not asset_ids:
        return {}
    rows = fetch_all(
        f"""
        SELECT asset_tags.asset_id, tags.name
        FROM asset_tags
        JOIN tags ON tags.id = asset_tags.tag_id
        WHERE asset_tags.asset_id IN ({','.join('?' for _ in asset_ids)})
        """,
        asset_ids,
    )
    result: Dict[int, List[str]] = {asset_id: [] for asset_id in asset_ids}
    for row in rows:
        result[row["asset_id"]].append(row["name"])
    return result


def get_annotations_for_assets(asset_ids: List[int]) -> Dict[int, List[str]]:
    if not asset_ids:
        return {}
    rows = fetch_all(
        f"""
        SELECT asset_id, data_json
        FROM annotations
        WHERE asset_id IN ({','.join('?' for _ in asset_ids)})
        """,
        asset_ids,
    )
    result: Dict[int, List[str]] = {asset_id: [] for asset_id in asset_ids}
    for row in rows:
        data = from_json(row["data_json"]) or {}
        text = str(data.get("text") or "").strip()
        if text:
            result[row["asset_id"]].append(text)
    return result


@app.get("/annotations")
def list_annotations():
    rows = fetch_all("SELECT data_json FROM annotations")
    counts: Dict[str, int] = {}
    for row in rows:
        data = from_json(row["data_json"]) or {}
        text = str(data.get("text") or "").strip()
        if not text:
            continue
        key = text.lower()
        counts[key] = counts.get(key, 0) + 1
    result = [{"text": text, "count": count} for text, count in counts.items()]
    result.sort(key=lambda item: item["count"], reverse=True)
    return result


def auto_tags(media_type: str, ext: str, width: Optional[int], height: Optional[int]) -> List[str]:
    tags = [media_type, ext]
    if width and height:
        if width == height:
            tags.append("square")
        elif width > height:
            tags.append("landscape")
        else:
            tags.append("portrait")
    return tags


def asset_to_dict(row, tags_map: Dict[int, List[str]]) -> Dict:
    row_dict = dict(row)
    colors = from_json(row["colors"]) or []
    preview_name = row["preview_name"] if "preview_name" in row.keys() else None
    preview_url = f"/media/{preview_name}" if preview_name else None
    if not preview_url and (row_dict.get("media_type") == "raw" or row_dict.get("format") == "dng"):
        preview_url = f"/assets/{row['id']}/preview"
    return {
        "id": row["id"],
        "filename": row["filename"],
        "stored_name": row["stored_name"],
        "preview_name": preview_name,
        "media_type": row["media_type"],
        "mime": row["mime"],
        "format": row["format"],
        "size_bytes": row["size_bytes"],
        "width": row["width"],
        "height": row["height"],
        "duration_ms": row["duration_ms"],
        "folder_id": row["folder_id"],
        "note": row["note"],
        "colors": colors,
        "created_at": row["created_at"],
        "tags": tags_map.get(row["id"], []),
        "url": f"/media/{row['stored_name']}",
        "preview_url": preview_url,
    }


def sanitize_path(path_value: str) -> str:
    path_value = path_value.replace("\\", "/")
    parts = [p for p in path_value.split("/") if p and p not in {".", ".."}]
    return "/".join(parts)


def split_dir_file(path_value: str) -> Tuple[Optional[str], str]:
    path_value = sanitize_path(path_value)
    if "/" not in path_value:
        return None, path_value
    folder, filename = path_value.rsplit("/", 1)
    return folder or None, filename


def get_or_create_folder_by_path(path_value: str) -> Optional[int]:
    if not path_value:
        return None
    parts = [p for p in sanitize_path(path_value).split("/") if p]
    if not parts:
        return None
    parent_id = None
    current_path = ""
    for part in parts:
        current_path = f"{current_path}/{part}" if current_path else part
        row = fetch_one("SELECT id FROM folders WHERE path = ?", (current_path,))
        if row:
            parent_id = row["id"]
            continue
        folder_id = execute(
            "INSERT INTO folders(name, parent_id, path, created_at) VALUES (?, ?, ?, ?)",
            (part, parent_id, current_path, now_iso()),
        )
        parent_id = folder_id
    return parent_id


def color_distance(a, b) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def parse_hex_color(value: str):
    value = value.strip().lstrip("#")
    if len(value) != 6:
        return None
    try:
        r = int(value[0:2], 16)
        g = int(value[2:4], 16)
        b = int(value[4:6], 16)
        return (r, g, b)
    except ValueError:
        return None


def match_color(asset_colors: List[str], target_hex: str, threshold: float) -> bool:
    target_rgb = parse_hex_color(target_hex)
    if not target_rgb:
        return False
    for hex_color in asset_colors:
        rgb = parse_hex_color(hex_color)
        if not rgb:
            continue
        if color_distance(rgb, target_rgb) <= threshold:
            return True
    return False


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/folders")
def list_folders():
    rows = fetch_all("SELECT * FROM folders ORDER BY path")
    return [dict(row) for row in rows]


@app.post("/folders")
def create_folder(payload: Dict = Body(...)):
    name = (payload.get("name") or "").strip()
    parent_id = payload.get("parent_id")
    if not name:
        raise HTTPException(400, "name required")
    path = name
    if parent_id:
        parent = fetch_one("SELECT path FROM folders WHERE id = ?", (parent_id,))
        if not parent:
            raise HTTPException(404, "parent not found")
        path = f"{parent['path']}/{name}"
    created_at = now_iso()
    try:
        folder_id = execute(
            "INSERT INTO folders(name, parent_id, path, created_at) VALUES (?, ?, ?, ?)",
            (name, parent_id, path, created_at),
        )
    except Exception as exc:
        raise HTTPException(400, f"create folder failed: {exc}")
    # Ensure physical directory exists for this folder path
    if path:
        (STORAGE_DIR / sanitize_path(path)).mkdir(parents=True, exist_ok=True)
    return {"id": folder_id, "name": name, "parent_id": parent_id, "path": path, "created_at": created_at}


@app.delete("/folders/{folder_id}")
def delete_folder(folder_id: int):
    row = fetch_one("SELECT id, path FROM folders WHERE id = ?", (folder_id,))
    if not row:
        raise HTTPException(404, "folder not found")
    child = fetch_one("SELECT id FROM folders WHERE parent_id = ? LIMIT 1", (folder_id,))
    if child:
        raise HTTPException(400, "folder not empty")
    asset = fetch_one("SELECT id FROM assets WHERE folder_id = ? LIMIT 1", (folder_id,))
    if asset:
        raise HTTPException(400, "folder not empty")
    execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    try:
        target = STORAGE_DIR / sanitize_path(row["path"])
        target.rmdir()
    except Exception:
        pass
    return {"status": "deleted"}


@app.get("/tags")
def list_tags():
    rows = fetch_all(
        """
        SELECT tags.name, COUNT(asset_tags.asset_id) as count
        FROM tags
        LEFT JOIN asset_tags ON asset_tags.tag_id = tags.id
        GROUP BY tags.id
        ORDER BY tags.name
        """
    )
    return [dict(row) for row in rows]


@app.post("/assets")
async def upload_asset(
    file: UploadFile = File(...),
    folder_id: Optional[int] = Form(None),
    tags: Optional[str] = Form(None),
    note: Optional[str] = Form(None),
    relative_path: Optional[str] = Form(None),
):
    filename = file.filename
    if not filename:
        raise HTTPException(400, "filename required")
    rel_dir = None
    if relative_path:
        rel_dir, rel_filename = split_dir_file(relative_path)
        if rel_filename:
            filename = rel_filename
    ext = file_extension(filename)
    mime = sniff_mime(filename, file.content_type)
    media_type = detect_media_type(mime, ext)
    if is_raw_extension(ext):
        media_type = "raw"

    folder_id = get_or_create_folder_by_path(rel_dir) if relative_path else folder_id
    storage_subdir = None
    if rel_dir:
        storage_subdir = rel_dir
    elif folder_id:
        folder_row = fetch_one("SELECT path FROM folders WHERE id = ?", (folder_id,))
        if folder_row:
            storage_subdir = folder_row["path"]

    stored_filename = f"{uuid4().hex}.{ext}" if ext else uuid4().hex
    if storage_subdir:
        stored_name = f"{sanitize_path(storage_subdir)}/{stored_filename}"
        dest = STORAGE_DIR / sanitize_path(storage_subdir) / stored_filename
        dest.parent.mkdir(parents=True, exist_ok=True)
    else:
        stored_name = stored_filename
        dest = STORAGE_DIR / stored_name
    with dest.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    size_bytes = dest.stat().st_size
    width = height = None
    colors: List[str] = []
    preview_name = None
    duration_ms = None
    if media_type in {"image", "gif"}:
        width, height, colors = image_metadata(dest)
        if ext == "heic":
            try:
                from PIL import Image
                from .utils import pillow_heif

                preview_filename = f"{uuid4().hex}.jpg"
                if storage_subdir:
                    preview_name = f"{sanitize_path(storage_subdir)}/{preview_filename}"
                    preview_path = STORAGE_DIR / sanitize_path(storage_subdir) / preview_filename
                    preview_path.parent.mkdir(parents=True, exist_ok=True)
                else:
                    preview_name = preview_filename
                    preview_path = STORAGE_DIR / preview_filename
                if pillow_heif is not None:
                    heif_file = pillow_heif.read_heif(str(dest))
                    img = Image.frombytes(
                        heif_file.mode,
                        heif_file.size,
                        heif_file.data,
                        "raw",
                        heif_file.mode,
                        heif_file.stride,
                    ).convert("RGB")
                else:
                    img = Image.open(dest).convert("RGB")
                img.thumbnail((1600, 1600))
                img.save(preview_path, "JPEG", quality=90)
            except Exception as exc:
                preview_name = None
                print(f"[heic-preview] failed to decode {dest.name}: {exc!r}")
    elif media_type == "raw":
        preview_img, width, height, colors = raw_preview(dest)
        if preview_img:
            preview_filename = f"{uuid4().hex}.jpg"
            if storage_subdir:
                preview_name = f"{sanitize_path(storage_subdir)}/{preview_filename}"
                preview_path = STORAGE_DIR / sanitize_path(storage_subdir) / preview_filename
                preview_path.parent.mkdir(parents=True, exist_ok=True)
            else:
                preview_name = preview_filename
                preview_path = STORAGE_DIR / preview_filename
            preview_img.thumbnail((1600, 1600))
            preview_img.save(preview_path, "JPEG", quality=90)
    elif media_type == "video":
        width, height, duration_ms = ffprobe_metadata(dest)
        if duration_ms:
            duration_ms = int(duration_ms)
        preview_filename = f"{uuid4().hex}.jpg"
        if storage_subdir:
            preview_name = f"{sanitize_path(storage_subdir)}/{preview_filename}"
            preview_path = STORAGE_DIR / sanitize_path(storage_subdir) / preview_filename
        else:
            preview_name = preview_filename
            preview_path = STORAGE_DIR / preview_filename
        if ffmpeg_thumbnail(dest, preview_path):
            preview_name = preview_name
        else:
            preview_name = None

    created_at = now_iso()
    asset_id = execute(
        """
        INSERT INTO assets(filename, stored_name, preview_name, media_type, mime, format, size_bytes, width, height, duration_ms, folder_id, note, colors, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            filename,
            stored_name,
            preview_name,
            media_type,
            mime,
            ext,
            size_bytes,
            width,
            height,
            duration_ms,
            folder_id,
            note,
            to_json(colors),
            created_at,
        ),
    )

    user_tags = normalize_tags(tags)
    tags_final = set(user_tags)
    for tag in auto_tags(media_type, ext, width, height):
        if tag:
            tags_final.add(tag)
    tag_names = set_asset_tags(asset_id, sorted(tags_final))

    print(
        f"[upload-image] id={asset_id} ext={ext} media_type={media_type} "
        f"preview_name={preview_name} size={width}x{height}"
    )
    row = fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    return asset_to_dict(row, {asset_id: tag_names})


@app.get("/assets")
def list_assets(
    q: Optional[str] = None,
    tags: Optional[str] = None,
    annotations: Optional[str] = None,
    folder_id: Optional[str] = None,
    format: Optional[str] = None,
    media_type: Optional[str] = None,
    min_w: Optional[int] = None,
    max_w: Optional[int] = None,
    min_h: Optional[int] = None,
    max_h: Optional[int] = None,
    color: Optional[str] = None,
    color_threshold: Optional[float] = 60.0,
):
    sql = "SELECT * FROM assets WHERE 1=1"
    params: List = []
    if folder_id:
        if isinstance(folder_id, str) and "," in folder_id:
            ids = [item for item in folder_id.split(",") if item.strip().isdigit()]
            if ids:
                sql += f" AND folder_id IN ({','.join('?' for _ in ids)})"
                params.extend(ids)
        else:
            sql += " AND folder_id = ?"
            params.append(folder_id)
    if format:
        if isinstance(format, str) and "," in format:
            formats = [item.strip().lower() for item in format.split(",") if item.strip()]
            if formats:
                sql += f" AND format IN ({','.join('?' for _ in formats)})"
                params.extend(formats)
        else:
            sql += " AND format = ?"
            params.append(format.lower())
    if media_type:
        sql += " AND media_type = ?"
        params.append(media_type)
    if min_w is not None:
        sql += " AND (width >= ? OR width IS NULL)"
        params.append(min_w)
    if max_w is not None:
        sql += " AND (width <= ? OR width IS NULL)"
        params.append(max_w)
    if min_h is not None:
        sql += " AND (height >= ? OR height IS NULL)"
        params.append(min_h)
    if max_h is not None:
        sql += " AND (height <= ? OR height IS NULL)"
        params.append(max_h)
    sql += " ORDER BY created_at DESC"

    rows = fetch_all(sql, params)
    asset_ids = [row["id"] for row in rows]
    tag_filters = normalize_tags(tags)
    q_lower = q.lower() if q else None
    annotation_filters = normalize_annotations(annotations)
    need_annotations = bool(q_lower or annotation_filters)
    tags_map = get_tags_for_assets(asset_ids)
    annotations_map = get_annotations_for_assets(asset_ids) if need_annotations else {}
    color_filters = [c.strip() for c in color.split(",")] if color and "," in color else ([color] if color else [])

    results = []
    for row in rows:
        asset = asset_to_dict(row, tags_map)
        asset_tags = set(asset["tags"])

        if tag_filters and not (set(tag_filters) & asset_tags):
            continue
        if annotation_filters:
            asset_annotations = [text.lower() for text in annotations_map.get(asset["id"], [])]
            if not set(annotation_filters) & set(asset_annotations):
                continue
        if q_lower:
            annotation_text = " ".join(annotations_map.get(asset["id"], []))
            hay = " ".join(
                [
                    asset["filename"],
                    asset.get("note") or "",
                    " ".join(asset["tags"]),
                    annotation_text,
                ]
            )
            if q_lower not in hay.lower():
                continue
        if color_filters:
            if not asset.get("colors"):
                continue
            if not any(match_color(asset["colors"], c, color_threshold or 60.0) for c in color_filters if c):
                continue
        results.append(asset)

    return results


@app.get("/assets/{asset_id}")
def get_asset(asset_id: int):
    row = fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    if not row:
        raise HTTPException(404, "asset not found")
    tags_map = get_tags_for_assets([asset_id])
    return asset_to_dict(row, tags_map)


@app.put("/assets/{asset_id}")
def update_asset(asset_id: int, payload: Dict = Body(...)):
    row = fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    if not row:
        raise HTTPException(404, "asset not found")

    folder_id = payload.get("folder_id", row["folder_id"])
    note = payload.get("note", row["note"])
    tags = payload.get("tags")
    if tags is not None:
        tag_names = set_asset_tags(asset_id, tags)
    else:
        tag_names = get_tags_for_assets([asset_id]).get(asset_id, [])

    execute(
        "UPDATE assets SET folder_id = ?, note = ? WHERE id = ?",
        (folder_id, note, asset_id),
    )
    updated = fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    return asset_to_dict(updated, {asset_id: tag_names})


@app.delete("/assets/{asset_id}")
def delete_asset(asset_id: int):
    row = fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    if not row:
        raise HTTPException(404, "asset not found")
    try:
        (STORAGE_DIR / row["stored_name"]).unlink(missing_ok=True)
    except Exception:
        pass
    execute("DELETE FROM assets WHERE id = ?", (asset_id,))
    return {"status": "deleted"}


@app.get("/assets/{asset_id}/download")
def download_asset(asset_id: int):
    row = fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    if not row:
        raise HTTPException(404, "asset not found")
    file_path = STORAGE_DIR / row["stored_name"]
    if not file_path.exists():
        raise HTTPException(404, "file missing")
    return FileResponse(
        file_path,
        media_type=row["mime"] or "application/octet-stream",
        filename=row["filename"],
    )


@app.get("/assets/{asset_id}/preview")
def preview_asset(asset_id: int):
    row = fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    if not row:
        raise HTTPException(404, "asset not found")
    row_dict = dict(row)
    preview_name = row["preview_name"] if "preview_name" in row.keys() else None
    if preview_name:
        preview_path = STORAGE_DIR / preview_name
        if preview_path.exists():
            return FileResponse(preview_path, media_type="image/jpeg")
    stored_path = STORAGE_DIR / row["stored_name"]
    if not stored_path.exists():
        raise HTTPException(404, "file missing")
    if row_dict.get("media_type") == "raw" or row_dict.get("format") == "dng":
        preview_img, _, _, _ = raw_preview(stored_path)
        if not preview_img:
            raise HTTPException(415, "preview not available")
        preview_filename = f"{uuid4().hex}.jpg"
        stored_parent = Path(row["stored_name"]).parent
        if stored_parent and str(stored_parent) != ".":
            preview_name = f"{sanitize_path(str(stored_parent))}/{preview_filename}"
            preview_path = STORAGE_DIR / sanitize_path(str(stored_parent)) / preview_filename
            preview_path.parent.mkdir(parents=True, exist_ok=True)
        else:
            preview_name = preview_filename
            preview_path = STORAGE_DIR / preview_filename
        preview_img.thumbnail((1600, 1600))
        preview_img.save(preview_path, "JPEG", quality=90)
        execute("UPDATE assets SET preview_name = ? WHERE id = ?", (preview_name, asset_id))
        return FileResponse(preview_path, media_type="image/jpeg")
    return FileResponse(stored_path, media_type=row["mime"] or "application/octet-stream")


@app.get("/smart-folders")
def list_smart_folders():
    rows = fetch_all("SELECT * FROM smart_folders ORDER BY created_at DESC")
    result = []
    for row in rows:
        item = dict(row)
        item["query"] = from_json(item.get("query_json")) or {}
        result.append(item)
    return result


@app.post("/smart-folders")
def create_smart_folder(payload: Dict = Body(...)):
    name = (payload.get("name") or "").strip()
    query = payload.get("query")
    if not name or not isinstance(query, dict):
        raise HTTPException(400, "name and query required")
    created_at = now_iso()
    folder_id = execute(
        "INSERT INTO smart_folders(name, query_json, created_at) VALUES (?, ?, ?)",
        (name, json.dumps(query, ensure_ascii=True), created_at),
    )
    return {"id": folder_id, "name": name, "query": query, "created_at": created_at}


@app.get("/smart-folders/{smart_id}/assets")
def smart_folder_assets(smart_id: int):
    row = fetch_one("SELECT * FROM smart_folders WHERE id = ?", (smart_id,))
    if not row:
        raise HTTPException(404, "smart folder not found")
    query = from_json(row["query_json"]) or {}
    return list_assets(**query)


@app.get("/assets/{asset_id}/annotations")
def list_annotations(asset_id: int):
    rows = fetch_all("SELECT * FROM annotations WHERE asset_id = ? ORDER BY created_at DESC", (asset_id,))
    result = []
    for row in rows:
        item = dict(row)
        item["data"] = from_json(item.get("data_json")) or {}
        result.append(item)
    return result


@app.post("/assets/{asset_id}/annotations")
def create_annotation(asset_id: int, payload: Dict = Body(...)):
    row = fetch_one("SELECT id FROM assets WHERE id = ?", (asset_id,))
    if not row:
        raise HTTPException(404, "asset not found")
    kind = (payload.get("kind") or "text").strip()
    data = payload.get("data") or {}
    created_at = now_iso()
    annotation_id = execute(
        "INSERT INTO annotations(asset_id, kind, data_json, created_at) VALUES (?, ?, ?, ?)",
        (asset_id, kind, json.dumps(data, ensure_ascii=True), created_at),
    )
    return {"id": annotation_id, "asset_id": asset_id, "kind": kind, "data": data, "created_at": created_at}


@app.delete("/annotations/{annotation_id}")
def delete_annotation(annotation_id: int):
    execute("DELETE FROM annotations WHERE id = ?", (annotation_id,))
    return {"status": "deleted"}


WEB_DIST = Path(__file__).resolve().parent / "web_dist"
if WEB_DIST.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIST), name="static")


@app.get("/{path:path}")
def spa_fallback(path: str, request: Request):
    original_path = getattr(request.state, "original_path", request.url.path)
    if original_path.startswith("/api"):
        raise HTTPException(404, "not found")
    if not WEB_DIST.exists():
        raise HTTPException(404, "web not built")
    safe_path = sanitize_path(path)
    target = WEB_DIST / safe_path if safe_path else WEB_DIST / "index.html"
    if target.exists() and target.is_file():
        return FileResponse(target)
    index_path = WEB_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    raise HTTPException(404, "index missing")
