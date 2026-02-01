import mimetypes
import shutil
import subprocess
import json
from pathlib import Path
from typing import List, Optional, Tuple

from PIL import Image

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover - optional support
    pillow_heif = None

IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "heic"}
RAW_EXTS = {"dng"}
VIDEO_EXTS = {"mp4", "mov", "mkv", "webm", "avi"}
AUDIO_EXTS = {"mp3", "wav", "aac", "flac", "ogg", "m4a"}


def sniff_mime(filename: str, provided: Optional[str] = None) -> Optional[str]:
    if provided:
        return provided
    return mimetypes.guess_type(filename)[0]


def detect_media_type(mime: Optional[str], ext: str) -> str:
    ext = ext.lower()
    if ext == "gif":
        return "gif"
    if mime:
        if mime.startswith("image/"):
            return "image"
        if mime.startswith("video/"):
            return "video"
        if mime.startswith("audio/"):
            return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in RAW_EXTS:
        return "raw"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return "file"


def image_metadata(path: Path) -> Tuple[Optional[int], Optional[int], List[str]]:
    if path.suffix.lower() == ".heic" and pillow_heif is not None:
        try:
            heif_file = pillow_heif.read_heif(str(path))
            img = Image.frombytes(
                heif_file.mode,
                heif_file.size,
                heif_file.data,
                "raw",
                heif_file.mode,
                heif_file.stride,
            ).convert("RGB")
            width, height = img.size
            colors = extract_colors(img)
            return width, height, colors
        except Exception as exc:
            print(f"[image-metadata] failed to decode {path.name}: {exc!r}")
            return None, None, []
    try:
        with Image.open(path) as img:
            img = img.convert("RGB")
            width, height = img.size
            colors = extract_colors(img)
            return width, height, colors
    except Exception as exc:
        print(f"[image-metadata] failed to decode {path.name}: {exc!r}")
        return None, None, []


def raw_preview(path: Path) -> Tuple[Optional[Image.Image], Optional[int], Optional[int], List[str]]:
    try:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            rgb = raw.postprocess()
        img = Image.fromarray(rgb).convert("RGB")
        width, height = img.size
        colors = extract_colors(img)
        return img, width, height, colors
    except Exception:
        return None, None, None, []


def is_raw_extension(ext: str) -> bool:
    return ext.lower() in RAW_EXTS


def ffprobe_metadata(path: Path):
    if not shutil.which("ffprobe"):
        return None, None, None
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        data = json.loads(result.stdout or "{}")
        width = None
        height = None
        duration_ms = None
        streams = data.get("streams") or []
        if streams:
            width = streams[0].get("width")
            height = streams[0].get("height")
        duration = None
        fmt = data.get("format") or {}
        if "duration" in fmt:
            try:
                duration = float(fmt.get("duration"))
            except (TypeError, ValueError):
                duration = None
        if duration is not None:
            duration_ms = int(duration * 1000)
        return width, height, duration_ms
    except Exception:
        return None, None, None


def ffmpeg_thumbnail(path: Path, output: Path) -> bool:
    if not shutil.which("ffmpeg"):
        return False
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                "00:00:01",
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-vf",
                "scale='min(1280,iw)':-2",
                str(output),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        return output.exists()
    except Exception:
        return False


def extract_colors(img: Image.Image, max_colors: int = 5) -> List[str]:
    small = img.copy()
    small.thumbnail((64, 64))
    colors = small.getcolors(64 * 64)
    if not colors:
        return []
    colors.sort(key=lambda item: item[0], reverse=True)
    top = [rgb_to_hex(color[1]) for color in colors[:max_colors]]
    return top


def rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(rgb[0], rgb[1], rgb[2])


def file_extension(filename: str) -> str:
    return Path(filename).suffix.lstrip(".").lower()
