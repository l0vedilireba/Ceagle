export const API_BASE = import.meta.env.VITE_API_BASE || "/api";
const MEDIA_BASE = import.meta.env.VITE_MEDIA_BASE || API_BASE;

export async function fetchAssets(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    qs.set(key, value);
  });
  const res = await fetch(`${API_BASE}/assets?${qs.toString()}`);
  if (!res.ok) throw new Error("加载素材失败");
  return res.json();
}

export async function uploadAsset(file, meta = {}) {
  const form = new FormData();
  form.append("file", file);
  if (meta.folder_id) form.append("folder_id", meta.folder_id);
  if (meta.tags) form.append("tags", meta.tags);
  if (meta.note) form.append("note", meta.note);
  const res = await fetch(`${API_BASE}/assets`, { method: "POST", body: form });
  if (!res.ok) throw new Error("上传失败");
  return res.json();
}

export function uploadAssetWithProgress(file, meta = {}, onProgress, onError) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    if (file.relativePath && file.relativePath.includes("/")) {
      form.append("relative_path", file.relativePath);
    }
    if (meta.folder_id) form.append("folder_id", meta.folder_id);
    if (meta.tags) form.append("tags", meta.tags);
    if (meta.note) form.append("note", meta.note);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/assets`);
    xhr.upload.onprogress = (event) => {
      if (onProgress) onProgress(event);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      } else {
        const error = new Error("上传失败");
        if (onError) onError(error);
        reject(error);
      }
    };
    xhr.onerror = () => {
      const error = new Error("上传失败");
      if (onError) onError(error);
      reject(error);
    };
    xhr.send(form);
  });
}

export async function updateAsset(id, payload) {
  const res = await fetch(`${API_BASE}/assets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("更新失败");
  return res.json();
}

export async function deleteAsset(id) {
  const res = await fetch(`${API_BASE}/assets/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除失败");
  return res.json();
}

export async function fetchFolders() {
  const res = await fetch(`${API_BASE}/folders`);
  if (!res.ok) throw new Error("加载文件夹失败");
  return res.json();
}

export async function createFolder(payload) {
  const res = await fetch(`${API_BASE}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("创建文件夹失败");
  return res.json();
}

export async function deleteFolder(id) {
  const res = await fetch(`${API_BASE}/folders/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "删除文件夹失败");
  }
  return res.json();
}

export async function fetchTags() {
  const res = await fetch(`${API_BASE}/tags`);
  if (!res.ok) throw new Error("加载标签失败");
  return res.json();
}

export async function fetchSmartFolders() {
  const res = await fetch(`${API_BASE}/smart-folders`);
  if (!res.ok) throw new Error("加载智能文件夹失败");
  return res.json();
}

export async function fetchAnnotationOptions() {
  const res = await fetch(`${API_BASE}/annotations`);
  if (!res.ok) throw new Error("加载标注失败");
  return res.json();
}

export async function createSmartFolder(payload) {
  const res = await fetch(`${API_BASE}/smart-folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("创建智能文件夹失败");
  return res.json();
}

export async function fetchAnnotations(assetId) {
  const res = await fetch(`${API_BASE}/assets/${assetId}/annotations`);
  if (!res.ok) throw new Error("加载标注失败");
  return res.json();
}

export async function createAnnotation(assetId, payload) {
  const res = await fetch(`${API_BASE}/assets/${assetId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "创建标注失败");
  }
  return res.json();
}

export async function deleteAnnotation(id) {
  const res = await fetch(`${API_BASE}/annotations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除标注失败");
  return res.json();
}

export function mediaUrl(path) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  const base = MEDIA_BASE.endsWith("/") ? MEDIA_BASE.slice(0, -1) : MEDIA_BASE;
  return `${base}${path}`;
}

export function downloadUrl(assetId) {
  const base = API_BASE.endsWith("/") ? API_BASE.slice(0, -1) : API_BASE;
  return `${base}/assets/${assetId}/download`;
}
