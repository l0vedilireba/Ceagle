import { useEffect, useMemo, useRef, useState } from "react";
import {
  createAnnotation,
  createFolder,
  createSmartFolder,
  deleteAnnotation,
  deleteAsset,
  deleteFolder,
  downloadUrl,
  fetchAnnotations,
  fetchAnnotationOptions,
  fetchAssets,
  fetchFolders,
  fetchSmartFolders,
  fetchTags,
  mediaUrl,
  updateAsset,
  uploadAssetWithProgress
} from "./api.js";

import { appConfig } from "./config.js";

const emptyForm = {
  q: "",
  tags: "",
  format: "",
  media_type: "",
  min_w: "",
  max_w: "",
  min_h: "",
  max_h: "",
  color: ""
};

const resolveTheme = (value) => {
  if (value !== "system") return value;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark-gray" : "light";
};

async function readAllEntries(reader) {
  const entries = [];
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await new Promise((resolve) => reader.readEntries(resolve));
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

async function traverseEntry(entry, files, prefix = "") {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    if (prefix) {
      file.relativePath = `${prefix}${file.name}`;
    }
    files.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await readAllEntries(reader);
    for (const child of entries) {
      // eslint-disable-next-line no-await-in-loop
      await traverseEntry(child, files, `${prefix}${entry.name}/`);
    }
  }
}

async function getFilesFromDataTransfer(dataTransfer) {
  const files = [];
  const directFiles = Array.from(dataTransfer.files || []);
  if (directFiles.length) {
    return directFiles.map((file) => {
      if (file.webkitRelativePath) {
        file.relativePath = file.webkitRelativePath;
      }
      return file;
    });
  }
  const items = Array.from(dataTransfer.items || []);
  if (items.length) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        // eslint-disable-next-line no-await-in-loop
        await traverseEntry(entry, files);
      } else {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  } else {
    files.push(...Array.from(dataTransfer.files || []));
  }
  return files;
}

function isFileDrag(event) {
  const dt = event.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).includes("Files")) return true;
  if (dt.items && Array.from(dt.items).some((item) => item.kind === "file")) return true;
  return false;
}

export default function App() {
  const [assets, setAssets] = useState([]);
  const [folders, setFolders] = useState([]);
  const [tags, setTags] = useState([]);
  const [smartFolders, setSmartFolders] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filters, setFilters] = useState({});
  const [activeFolder, setActiveFolder] = useState(null);
  const [activeSmart, setActiveSmart] = useState(null);
  const [selected, setSelected] = useState(null);
  const [viewerAsset, setViewerAsset] = useState(null);
  const [viewerScale, setViewerScale] = useState(1);
  const [annotations, setAnnotations] = useState([]);
  const [annotationText, setAnnotationText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({
    active: false,
    percent: 0,
    current: "",
    index: 0,
    total: 0
  });
  const [deleteProgress, setDeleteProgress] = useState({
    active: false,
    percent: 0,
    current: "",
    index: 0,
    total: 0
  });
  const [uploadErrors, setUploadErrors] = useState([]);
  const [folderName, setFolderName] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "system");
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(theme));
  const [isDragging, setIsDragging] = useState(false);
  const [selectedTags, setSelectedTags] = useState([]);
  const [selectedFormats, setSelectedFormats] = useState([]);
  const [selectedFolders, setSelectedFolders] = useState([]);
  const [selectedColors, setSelectedColors] = useState([]);
  const [selectedNotes, setSelectedNotes] = useState([]);
  const [tagQuery, setTagQuery] = useState("");
  const [formatQuery, setFormatQuery] = useState("");
  const [showTagPopover, setShowTagPopover] = useState(false);
  const [showFormatPopover, setShowFormatPopover] = useState(false);
  const [showFolderPopover, setShowFolderPopover] = useState(false);
  const [showColorPopover, setShowColorPopover] = useState(false);
  const [showNotePopover, setShowNotePopover] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const [activeFilterPanel, setActiveFilterPanel] = useState("tags");
  const [gridSize, setGridSize] = useState(520);
  const [folderQuery, setFolderQuery] = useState("");
  const [colorQuery, setColorQuery] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [showAllColors, setShowAllColors] = useState(false);
  const [duplicateModal, setDuplicateModal] = useState({ open: false, count: 0, sample: "" });
  const [smartNameModal, setSmartNameModal] = useState({ open: false, value: "" });
  const [confirmModal, setConfirmModal] = useState({ open: false, title: "", message: "" });
  const [toasts, setToasts] = useState([]);
  const [recentNotes, setRecentNotes] = useState(() => {
    try {
      const raw = localStorage.getItem("recentNotes");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [annotationOptions, setAnnotationOptions] = useState([]);
  const [colorGroups, setColorGroups] = useState([]);
  const [recentAnnotations, setRecentAnnotations] = useState(() => {
    try {
      const raw = localStorage.getItem("recentAnnotations");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [foldersCollapsed, setFoldersCollapsed] = useState(false);
  const [smartCollapsed, setSmartCollapsed] = useState(true);
  const [recentTags, setRecentTags] = useState(() => {
    try {
      const raw = localStorage.getItem("recentTags");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [detailTagQuery, setDetailTagQuery] = useState("");
  const [showDetailTagPopover, setShowDetailTagPopover] = useState(false);
  const [showAnnotationPopover, setShowAnnotationPopover] = useState(false);
  const dragCounter = useRef(0);
  const duplicateResolver = useRef(null);
  const smartNameResolver = useRef(null);
  const confirmResolver = useRef(null);
  const showAlert = (message, title = "提示") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, title, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 2600);
  };
  const tagPopoverRef = useRef(null);
  const formatPopoverRef = useRef(null);
  const folderPopoverRef = useRef(null);
  const colorPopoverRef = useRef(null);
  const notePopoverRef = useRef(null);
  const detailTagPopoverRef = useRef(null);
  const annotationPopoverRef = useRef(null);
  const themeMenuRef = useRef(null);
  const longPressTimer = useRef(null);
  const longPressTriggered = useRef(false);

  const loadMeta = async () => {
    const [folderData, tagData, smartData, annotationData] = await Promise.all([
      fetchFolders(),
      fetchTags(),
      fetchSmartFolders(),
      fetchAnnotationOptions()
    ]);
    setFolders(folderData);
    setTags(tagData);
    setSmartFolders(smartData);
    setAnnotationOptions(annotationData || []);
  };

  const loadAssets = async (nextFilters) => {
    const data = await fetchAssets(nextFilters || filters);
    setAssets(data);
    if (selected) {
      const next = data.find((item) => item.id === selected.id);
      setSelected(next || null);
    }
  };

  const loadAnnotations = async (assetId) => {
    if (!assetId) {
      setAnnotations([]);
      return;
    }
    const data = await fetchAnnotations(assetId);
    setAnnotations(data);
  };

  useEffect(() => {
    loadMeta();
  }, []);

  useEffect(() => {
    loadAssets();
  }, [filters]);

  useEffect(() => {
    let active = true;
    const buildFormats = (data) => {
      const map = new Map();
      data.forEach((asset) => {
        const value = typeof asset.format === "string" ? asset.format.trim() : "";
        if (!value) return;
        const key = value.toLowerCase();
        if (!map.has(key)) map.set(key, key);
      });
      return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
    };
    const loadFormats = async () => {
      try {
        if (!filters.format) {
          const next = buildFormats(assets);
          if (active) setFormatOptions(next);
          return;
        }
        const nextFilters = { ...filters };
        delete nextFilters.format;
        const data = await fetchAssets(nextFilters);
        if (!active) return;
        setFormatOptions(buildFormats(data));
      } catch (error) {
        if (active) setFormatOptions([]);
      }
    };
    loadFormats();
    return () => {
      active = false;
    };
  }, [filters, assets]);

  useEffect(() => {
    loadAnnotations(selected?.id);
  }, [selected?.id]);

  useEffect(() => {
    let active = true;
    const loadColors = async () => {
      try {
        if (!filters.color) {
          const next = buildColorGroups(assets);
          if (active) setColorGroups(next);
          return;
        }
        const nextFilters = { ...filters };
        delete nextFilters.color;
        const data = await fetchAssets(nextFilters);
        if (!active) return;
        setColorGroups(buildColorGroups(data));
      } catch {
        if (active) setColorGroups([]);
      }
    };
    loadColors();
    return () => {
      active = false;
    };
  }, [filters, assets]);

  useEffect(() => {
    setViewerScale(1);
  }, [viewerAsset?.id]);

  useEffect(() => {
    localStorage.setItem("theme", theme);
    const applyTheme = () => {
      if (theme === "system") {
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        document.body.dataset.theme = prefersDark ? "dark-gray" : "light";
        setResolvedTheme(prefersDark ? "dark-gray" : "light");
      } else {
        document.body.dataset.theme = theme;
        setResolvedTheme(theme);
      }
    };
    applyTheme();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyTheme();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("recentTags", JSON.stringify(recentTags));
  }, [recentTags]);

  useEffect(() => {
    localStorage.setItem("recentNotes", JSON.stringify(recentNotes));
  }, [recentNotes]);

  useEffect(() => {
    localStorage.setItem("recentAnnotations", JSON.stringify(recentAnnotations));
  }, [recentAnnotations]);

  useEffect(() => {
    const handleClick = (event) => {
      const target = event.target;
      const withinPopover =
        target.closest(".popover") ||
        target.closest(".popover-input") ||
        target.closest(".theme-menu") ||
        target.closest(".search-popover") ||
        target.closest(".detail-popover");
      if (withinPopover) return;
      setShowTagPopover(false);
      setShowFormatPopover(false);
      setShowFolderPopover(false);
      setShowColorPopover(false);
      setShowNotePopover(false);
      setShowDetailTagPopover(false);
      setShowAnnotationPopover(false);
      setShowThemeMenu(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);
  const handleSmartClick = (item) => {
    setActiveSmart(item);
    setActiveFolder(null);
    const query = item?.query || {};
    const smartTags = query.tags
      ? query.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    setSelectedTags(smartTags);
    setForm({ ...emptyForm, ...query });
    setFilters(query);
  };

  const touchRecentTags = (tagName) => {
    setRecentTags((prev) => {
      const next = [tagName, ...prev.filter((item) => item !== tagName)];
      return next.slice(0, 12);
    });
  };

  const touchRecentAnnotation = (text) => {
    const value = text.trim();
    if (!value) return;
    setRecentAnnotations((prev) => {
      const next = [value, ...prev.filter((item) => item !== value)];
      return next.slice(0, 12);
    });
  };

  const toggleTag = (tagName) => {
    setSelectedTags((prev) => {
      const next = prev.includes(tagName)
        ? prev.filter((item) => item !== tagName)
        : [...prev, tagName];
      setFilters((current) => ({
        ...current,
        tags: next.join(","),
        folder_id: activeFolder ? activeFolder.id : undefined
      }));
      if (!prev.includes(tagName)) {
        touchRecentTags(tagName);
      }
      return next;
    });
  };

  const toggleFormat = (format) => {
    setSelectedFormats((prev) => {
      const next = prev.includes(format) ? prev.filter((f) => f !== format) : [...prev, format];
      setFilters((current) => ({ ...current, format: next.join(",") }));
      return next;
    });
  };

  const toggleFolder = (folderId) => {
    setSelectedFolders((prev) => {
      const next = prev.includes(folderId) ? prev.filter((id) => id !== folderId) : [...prev, folderId];
      setFilters((current) => ({ ...current, folder_id: next.join(",") }));
      return next;
    });
  };

  const toggleColor = (color) => {
    const normalized = String(color || "").toLowerCase();
    if (!normalized) return;
    setSelectedColors((prev) => {
      const next = prev.includes(normalized)
        ? prev.filter((c) => c !== normalized)
        : [...prev, normalized];
      setFilters((current) => ({ ...current, color: next.join(",") }));
      return next;
    });
    touchRecentColor(normalized);
  };

  const toggleNote = (note) => {
    setSelectedNotes((prev) => {
      const next = prev.includes(note) ? prev.filter((n) => n !== note) : [...prev, note];
      setFilters((current) => ({ ...current, annotations: next.join(",") }));
      return next;
    });
  };

  const toggleSelectedId = (assetId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (!selectedIds.size) return;
    const ok = await new Promise((resolve) => {
      confirmResolver.current = resolve;
      setConfirmModal({
        open: true,
        title: "批量删除",
        message: `确认删除 ${selectedIds.size} 个素材？`
      });
    });
    if (!ok) return;
    const ids = Array.from(selectedIds);
    setDeleteProgress({ active: true, percent: 0, current: "", index: 0, total: ids.length });
    for (const id of selectedIds) {
      const currentIndex = ids.indexOf(id) + 1;
      setDeleteProgress((prev) => ({
        ...prev,
        current: String(id),
        index: currentIndex,
        percent: Math.round((currentIndex / ids.length) * 100)
      }));
      // eslint-disable-next-line no-await-in-loop
      await deleteAsset(id);
    }
    setSelectedIds(new Set());
    setSelectionMode(false);
    setSelected(null);
    await loadAssets();
    await loadMeta();
    setDeleteProgress({ active: false, percent: 0, current: "", index: 0, total: 0 });
  };

  const handleFolderDelete = async (folderId) => {
    const ok = await new Promise((resolve) => {
      confirmResolver.current = resolve;
      setConfirmModal({
        open: true,
        title: "删除文件夹",
        message: "确认删除该文件夹？仅支持删除空文件夹。"
      });
    });
    if (!ok) return;
    try {
      await deleteFolder(folderId);
      if (activeFolder?.id === folderId) {
        setActiveFolder(null);
      }
      await loadMeta();
      await loadAssets();
    } catch (error) {
      showAlert(error.message || "删除失败", "删除失败");
    }
  };

  const handleUploadFiles = async (files) => {
    if (!files.length) return;
    if (!activeFolder) {
      showAlert("请先选择一个文件夹再上传");
      return;
    }
    const hasNestedPath = files.some((file) => file.relativePath && file.relativePath.includes("/"));
    if (!hasNestedPath) {
      try {
        const existing = await fetchAssets({ folder_id: activeFolder.id });
        const existingByName = new Map();
        existing.forEach((asset) => {
          const name = String(asset.filename || "").toLowerCase();
          if (!name) return;
          if (!existingByName.has(name)) existingByName.set(name, []);
          existingByName.get(name).push(asset);
        });
        const dupNames = Array.from(
          new Set(
            files
              .map((file) => String(file.name || "").toLowerCase())
              .filter((name) => name && existingByName.has(name))
          )
        );
        if (dupNames.length) {
          const sample = dupNames.slice(0, 5).join(", ");
          const replace = await new Promise((resolve) => {
            duplicateResolver.current = resolve;
            setDuplicateModal({ open: true, count: dupNames.length, sample });
          });
          if (replace) {
            const deleteIds = new Set();
            dupNames.forEach((name) => {
              existingByName.get(name).forEach((asset) => deleteIds.add(asset.id));
            });
            for (const id of deleteIds) {
              // eslint-disable-next-line no-await-in-loop
              await deleteAsset(id);
            }
            await loadMeta();
          }
        }
      } catch (error) {
        showAlert(error.message || "检查重复文件失败", "上传提示");
      }
    }
    setUploading(true);
    setUploadErrors([]);
    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0) || 1;
    let uploadedBytes = 0;
    setUploadProgress({ active: true, percent: 0, current: files[0].name, index: 0, total: files.length });
    try {
      const concurrency = 3;
      let cursor = 0;
      const uploadOne = async (file, idx) => {
        setUploadProgress((prev) => ({ ...prev, current: file.name, index: idx + 1 }));
        let lastLoaded = 0;
        try {
          await uploadAssetWithProgress(
            file,
            {
              folder_id: activeFolder ? activeFolder.id : undefined,
              tags: selectedTags.join(",")
            },
            (event) => {
              if (!event.lengthComputable) return;
              const delta = event.loaded - lastLoaded;
              lastLoaded = event.loaded;
              uploadedBytes += delta;
              const percent = Math.min(100, Math.round((uploadedBytes / totalBytes) * 100));
              setUploadProgress((prev) => ({ ...prev, percent }));
            },
            (error) => {
              setUploadErrors((prev) => [...prev, `${file.name}: ${error.message}`]);
            }
          );
        } catch (error) {
          setUploadErrors((prev) => [...prev, `${file.name}: ${error.message}`]);
        }
      };
      const workers = Array.from({ length: concurrency }).map(async () => {
        while (cursor < files.length) {
          const file = files[cursor];
          const currentIndex = cursor;
          cursor += 1;
          // eslint-disable-next-line no-await-in-loop
          await uploadOne(file, currentIndex);
        }
      });
      await Promise.all(workers);
      await loadMeta();
      await loadAssets();
    } finally {
      setUploading(false);
      setUploadProgress({ active: false, percent: 0, current: "", index: 0, total: 0 });
    }
  };

  const handleFileInput = async (event) => {
    const files = Array.from(event.target.files || []).map((file) => {
      if (file.webkitRelativePath) {
        file.relativePath = file.webkitRelativePath;
      }
      return file;
    });
    await handleUploadFiles(files);
    event.target.value = "";
  };

  const handleDropUpload = async (event) => {
    event.preventDefault();
    if (!activeFolder) {
      setIsDragging(false);
      showAlert("请先选择一个文件夹再上传");
      return;
    }
    dragCounter.current = 0;
    setIsDragging(false);
    const files = await getFilesFromDataTransfer(event.dataTransfer);
    await handleUploadFiles(files);
  };

  const handleCreateFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    await createFolder({ name, parent_id: activeFolder ? activeFolder.id : null });
    setFolderName("");
    await loadMeta();
  };

  const handleSaveSmart = async () => {
    if (!selectedTags.length) {
      showAlert("请先选择标签");
      return;
    }
    const name = await new Promise((resolve) => {
      smartNameResolver.current = resolve;
      setSmartNameModal({ open: true, value: "" });
    });
    if (!name) return;
    await createSmartFolder({ name, query: { tags: selectedTags.join(",") } });
    await loadMeta();
  };

  const updateSelected = async (patch) => {
    if (!selected) return;
    const updated = await updateAsset(selected.id, patch);
    setSelected(updated);
    await loadMeta();
    await loadAssets();
  };

  const handleAddAnnotation = async (value) => {
    const text = (value ?? annotationText).trim();
    if (!selected || !text) return;
    try {
      await createAnnotation(selected.id, {
        kind: "text",
        data: { text }
      });
      touchRecentAnnotation(text);
      setAnnotationText("");
      await loadAnnotations(selected.id);
    } catch (error) {
      showAlert(error.message || "添加标注失败", "添加失败");
    }
  };

  const handleDeleteAnnotation = async (id) => {
    await deleteAnnotation(id);
    await loadAnnotations(selected?.id);
  };

  const toggleDetailTag = async (tagName) => {
    if (!selected) return;
    const next = selected.tags.includes(tagName)
      ? selected.tags.filter((tag) => tag !== tagName)
      : [...selected.tags, tagName];
    setSelected((prev) => ({ ...prev, tags: next }));
    if (!selected.tags.includes(tagName)) {
      touchRecentTags(tagName);
    }
    await updateSelected({ tags: next });
  };

  const handleDetailTagAdd = async (value) => {
    const name = value.trim();
    if (!name || !selected) return;
    if (selected.tags.includes(name)) return;
    await toggleDetailTag(name);
    setDetailTagQuery("");
  };

  const formatSize = (bytes) => {
    if (!bytes) return "-";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let idx = 0;
    while (value > 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(1)}${units[idx]}`;
  };
  const hslToHex = (h, s = 100, l = 50) => {
    const sat = s / 100;
    const light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = light - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      g = 0;
      b = c;
    } else {
      r = c;
      g = 0;
      b = x;
    }
    const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  };

  // hslToHex retained for potential future use

  const folderPath = (folderId) => {
    if (!folderId) return "未分类";
    const found = folders.find((folder) => folder.id === folderId);
    return found ? found.path : "未分类";
  };

  const activeFolderPath = useMemo(() => activeFolder?.path || "全部", [activeFolder]);

  const themeOptions = useMemo(
    () => [
      { value: "system", label: "跟随系统" },
      { value: "light", label: "白" },
      { value: "light-gray", label: "浅灰" },
      { value: "dark-gray", label: "深灰" },
      { value: "black", label: "黑" },
      { value: "purple", label: "紫" }
    ],
    []
  );
  const displayThemeValue = theme === "system" ? resolvedTheme : theme;
  const currentThemeLabel =
    themeOptions.find((item) => item.value === displayThemeValue)?.label || "主题";

  const parseHexColor = (value) => {
    const normalized = String(value || "").trim().replace("#", "");
    if (normalized.length !== 6) return null;
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b, hex: `#${normalized.toLowerCase()}` };
  };

  const colorDistance = (a, b) =>
    Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

  const buildColorGroups = (data) => {
    const groups = [];
    const threshold = 28;
    data.forEach((asset) => {
      (asset.colors || []).forEach((color) => {
        const rgb = parseHexColor(color);
        if (!rgb) return;
        const found = groups.find((group) => colorDistance(group, rgb) <= threshold);
        if (!found) {
          groups.push({ r: rgb.r, g: rgb.g, b: rgb.b, count: 1, hex: rgb.hex });
          return;
        }
        found.count += 1;
        found.r = Math.round((found.r * (found.count - 1) + rgb.r) / found.count);
        found.g = Math.round((found.g * (found.count - 1) + rgb.g) / found.count);
        found.b = Math.round((found.b * (found.count - 1) + rgb.b) / found.count);
        const toHex = (n) => n.toString(16).padStart(2, "0");
        found.hex = `#${toHex(found.r)}${toHex(found.g)}${toHex(found.b)}`;
      });
    });
    return groups.sort((a, b) => b.count - a.count);
  };

  const [recentColors, setRecentColors] = useState(() => {
    try {
      const raw = localStorage.getItem("recentColors");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("recentColors", JSON.stringify(recentColors));
  }, [recentColors]);

  const touchRecentColor = (color) => {
    const value = String(color || "").toLowerCase();
    if (!value) return;
    setRecentColors((prev) => {
      const next = [value, ...prev.filter((item) => item !== value)];
      return next.slice(0, 5);
    });
  };

  const filteredAllColors = useMemo(() => {
    if (!colorQuery) return colorGroups;
    const needle = colorQuery.toLowerCase();
    return colorGroups.filter((group) => group.hex.includes(needle));
  }, [colorGroups, colorQuery]);

  const topColors = useMemo(() => filteredAllColors.slice(0, 15), [filteredAllColors]);
  const allColors = filteredAllColors;

  const [formatOptions, setFormatOptions] = useState([]);

  const filteredFormats = useMemo(() => {
    if (!formatQuery) return formatOptions;
    const lower = formatQuery.toLowerCase();
    return formatOptions.filter((item) => item.toLowerCase().includes(lower));
  }, [formatOptions, formatQuery]);

  const extraColors = Math.max(0, filteredAllColors.length - 15);

  const filteredTags = useMemo(() => {
    if (!tagQuery) return tags;
    const lower = tagQuery.toLowerCase();
    return tags.filter((item) => item.name.toLowerCase().includes(lower));
  }, [tagQuery, tags]);

  const filteredDetailTags = useMemo(() => {
    if (!detailTagQuery) return tags;
    const lower = detailTagQuery.toLowerCase();
    return tags.filter((item) => item.name.toLowerCase().includes(lower));
  }, [detailTagQuery, tags]);

  const filteredFolders = useMemo(() => {
    if (!folderQuery) return folders;
    const lower = folderQuery.toLowerCase();
    return folders.filter((folder) => (folder.path || "").toLowerCase().includes(lower));
  }, [folderQuery, folders]);

  const filteredAnnotationOptions = useMemo(() => {
    if (!noteQuery) return annotationOptions;
    const lower = noteQuery.toLowerCase();
    return annotationOptions.filter((item) => item.text.toLowerCase().includes(lower));
  }, [noteQuery, annotationOptions]);

  const gridWidth = useMemo(() => {
    return Math.min(720, Math.max(320, gridSize));
  }, [gridSize]);
  const thumbHeight = useMemo(() => Math.round(gridWidth * 0.6), [gridWidth]);

  const cardWidthFor = (asset) => {
    const minWidth = Math.max(80, Math.round(gridWidth * 0.35));
    const maxWidth = Math.round(gridWidth * 1.8);
    if (!asset?.width || !asset?.height) return gridWidth;
    const ratio = asset.width / asset.height;
    const raw = Math.round(thumbHeight * ratio);
    return Math.min(maxWidth, Math.max(minWidth, raw));
  };
  const gridRef = useRef(null);
  const [gridColumns, setGridColumns] = useState(1);

  useEffect(() => {
    if (!gridRef.current) return;
    const updateCols = () => {
      const width = gridRef.current?.offsetWidth || 0;
      const count = Math.max(1, Math.floor(width / gridWidth));
      const limited = Math.min(Math.max(1, assets.length || 1), count);
      setGridColumns(limited);
    };
    updateCols();
    const observer = new ResizeObserver(updateCols);
    observer.observe(gridRef.current);
    return () => observer.disconnect();
  }, [gridWidth, assets.length]);

  const highlightMatch = (text, query) => {
    if (!query) return text;
    const lower = text.toLowerCase();
    const match = lower.indexOf(query.toLowerCase());
    if (match === -1) return text;
    const before = text.slice(0, match);
    const hit = text.slice(match, match + query.length);
    const after = text.slice(match + query.length);
    return (
      <>
        {before}
        <span className="tag-highlight">{hit}</span>
        {after}
      </>
    );
  };

  return (
    <div
      className="app"
      onDragEnter={(event) => {
        if (!isFileDrag(event)) return;
        if (!activeFolder) return;
        event.preventDefault();
        dragCounter.current += 1;
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        if (!activeFolder) return;
        event.preventDefault();
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) {
          setIsDragging(false);
        }
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        if (!activeFolder) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return;
        if (!activeFolder) return;
        handleDropUpload(event);
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-row">
            <h1>{appConfig.brandTitle}</h1>
          </div>
          <p>{appConfig.brandSubtitle}</p>
        </div>

        <div className="panel">
          <div
            className="panel-header clickable"
            onClick={() => {
              setActiveFolder(null);
              setActiveSmart(null);
              setFilters({ ...form, tags: selectedTags.join(","), folder_id: undefined });
            }}
          >
            <h2>全部</h2>
          </div>
        </div>

        <div className="panel">
          <div
            className="panel-header clickable"
            onClick={() => setFoldersCollapsed((prev) => !prev)}
          >
            <button className="panel-toggle" title="展开/收起文件夹">
              <svg
                className={foldersCollapsed ? "" : "expanded"}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </button>
            <h2>文件夹</h2>
            <button
              className="panel-add"
              onClick={(event) => {
                event.stopPropagation();
                const name = window.prompt("新建文件夹名称");
                if (!name) return;
                createFolder({ name, parent_id: activeFolder ? activeFolder.id : null })
                  .then(() => loadMeta())
                  .catch(() => {});
              }}
              title="新建文件夹"
            >
              +
            </button>
          </div>
          {!foldersCollapsed ? (
            <ul className="list">
              {folders.map((folder) => (
                <li
                  key={folder.id}
                  className={activeFolder?.id === folder.id ? "active" : ""}
                  onClick={() => {
                    setActiveFolder(folder);
                    setActiveSmart(null);
                    setFilters({ ...form, tags: selectedTags.join(","), folder_id: folder.id });
                  }}
                >
                  <span className="nav-icon">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 6h7l2 2h9v10H3z" fill="currentColor" />
                    </svg>
                  </span>
                  <span>{folder.path}</span>
                  <button
                    className="folder-delete"
                    title="删除文件夹"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleFolderDelete(folder.id);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="panel">
          <div
            className="panel-header clickable"
            onClick={() => setSmartCollapsed((prev) => !prev)}
          >
            <button className="panel-toggle" title="展开/收起智能文件夹">
              <svg
                className={smartCollapsed ? "" : "expanded"}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </button>
            <h2>智能文件夹</h2>
            <button
              className="panel-add ghost"
              onClick={(event) => {
                event.stopPropagation();
                handleSaveSmart();
              }}
              title="新建智能文件夹"
            >
              +
            </button>
          </div>
          {!smartCollapsed ? (
            <ul className="list">
              {smartFolders.map((item) => (
                <li
                  key={item.id}
                  className={activeSmart?.id === item.id ? "active" : ""}
                  onClick={() => handleSmartClick(item)}
                >
                  {item.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </aside>

      <main
        className="content"
        onDragOver={(event) => {
          if (!isFileDrag(event)) return;
          if (!activeFolder) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          if (!isFileDrag(event)) return;
          if (!activeFolder) return;
          handleDropUpload(event);
        }}
      >
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-group">
              <div className="topbar-title">
                <span>{activeFolderPath}</span>
              </div>
            </div>
            <span className="divider" />
            <button
              className={`icon-button ${showFilterDrawer ? "active" : ""}`}
              onClick={() => setShowFilterDrawer((prev) => !prev)}
              title="筛选"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 5h16l-6.5 7.2v4.6l-3 1.2v-5.8L4 5z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <span className="divider" />
            <div className="grid-zoom topbar-zoom">
              <button onClick={() => setGridSize((prev) => Math.max(320, prev - 20))}>-</button>
              <input
                type="range"
                min="320"
                max="720"
                step="10"
                value={gridWidth}
                onChange={(e) => setGridSize(Number(e.target.value))}
                aria-label="瀑布流缩放"
              />
              <button onClick={() => setGridSize((prev) => Math.min(720, prev + 20))}>+</button>
            </div>
          </div>
          <div className="topbar-right">
            <div className="theme-menu" ref={themeMenuRef}>
              <button
                className="icon-button theme-button"
                onClick={() => setShowThemeMenu((prev) => !prev)}
                title="主题"
              >
                <span className="theme-dot" data-theme={displayThemeValue} aria-hidden="true" />
                <span className="theme-label">{currentThemeLabel}</span>
              </button>
              {showThemeMenu ? (
                <div className="theme-popover">
                  {themeOptions.map((item) => (
                    <button
                      key={item.value}
                      className={theme === item.value ? "active" : ""}
                      onClick={() => {
                        setTheme(item.value);
                        setShowThemeMenu(false);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <span className="divider" />
            <input
              className="topbar-search"
              value={form.q}
              onChange={(e) => {
                const value = e.target.value;
                setForm((prev) => ({ ...prev, q: value }));
                setFilters((prev) => ({ ...prev, q: value }));
              }}
              placeholder="搜索素材"
            />
          </div>
        </header>

        {showFilterDrawer ? (
          <div className="filter-drawer">
            <div className="filter-icons">
              <button
                className={activeFilterPanel === "tags" ? "active" : ""}
                onClick={() => setActiveFilterPanel("tags")}
                title="标签"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M3 12l9-9h6l3 3v6l-9 9L3 12z"
                    fill="currentColor"
                  />
                  <circle cx="16" cy="8" r="1.5" fill="#fff" />
                </svg>
                <span>标签</span>
              </button>
              {!activeFolder ? (
                <button
                  className={activeFilterPanel === "folders" ? "active" : ""}
                  onClick={() => setActiveFilterPanel("folders")}
                  title="文件夹"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 6h7l2 2h9v10H3z" fill="currentColor" />
                  </svg>
                  <span>文件夹</span>
                </button>
              ) : null}
              <button
                className={activeFilterPanel === "format" ? "active" : ""}
                onClick={() => setActiveFilterPanel("format")}
                title="格式"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 4h12v4H6zM6 10h12v10H6z" fill="currentColor" />
                </svg>
                <span>格式</span>
              </button>
              <button
                className={activeFilterPanel === "color" ? "active" : ""}
                onClick={() => setActiveFilterPanel("color")}
                title="颜色"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 3a9 9 0 1 0 0 18c2 0 3-1 3-2.5S14 16 13 16h-1a4 4 0 0 1 0-8"
                    fill="currentColor"
                  />
                </svg>
                <span>颜色</span>
              </button>
              <button
                className={activeFilterPanel === "note" ? "active" : ""}
                onClick={() => setActiveFilterPanel("note")}
                title="标注"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 5h16v14H8l-4 4V5z" fill="currentColor" />
                </svg>
                <span>标注</span>
              </button>
            </div>
            <div className="filter-panel">
              {activeFilterPanel === "tags" ? (
                <div className="search-popover" ref={tagPopoverRef}>
                  <input
                    className="popover-input"
                    value={tagQuery}
                    onFocus={() => setShowTagPopover(true)}
                    onChange={(e) => setTagQuery(e.target.value)}
                    placeholder="搜索或选择标签"
                  />
                  {showTagPopover ? (
                    <div className="popover popover-tags">
                      {recentTags.length ? (
                        <div className="popover-section">
                          <div className="popover-title">最近使用</div>
                          <div className="popover-tags">
                            {recentTags.map((tagName) => (
                              <button
                                key={`recent-${tagName}`}
                                className={selectedTags.includes(tagName) ? "active" : ""}
                                onClick={() => toggleTag(tagName)}
                              >
                                #{highlightMatch(tagName, tagQuery)}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <div className="popover-section">
                        <div className="popover-title">全部标签</div>
                        <div className="popover-tags">
                          {filteredTags.map((tag) => (
                            <button
                              key={tag.name}
                              className={selectedTags.includes(tag.name) ? "active" : ""}
                              onClick={() => toggleTag(tag.name)}
                            >
                              #{highlightMatch(tag.name, tagQuery)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {activeFilterPanel === "format" ? (
                <div
                  className="search-popover"
                  ref={formatPopoverRef}
                  onMouseDownCapture={(event) => event.stopPropagation()}
                >
                  <input
                    className="popover-input"
                    value={formatQuery}
                    onFocus={() => setShowFormatPopover(true)}
                    onChange={(e) => {
                      const value = e.target.value.toLowerCase();
                      setFormatQuery(value);
                    }}
                    placeholder="搜索格式"
                  />
                  {showFormatPopover ? (
                    <div
                      className="popover"
                      onMouseDownCapture={(event) => event.stopPropagation()}
                    >
                      <div className="popover-tags">
                        {filteredFormats.map((item) => (
                          <button
                            key={item}
                            className={selectedFormats.includes(item) ? "active" : ""}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={() => {
                              toggleFormat(item);
                              setFormatQuery("");
                              setShowFormatPopover(true);
                            }}
                          >
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!activeFolder && activeFilterPanel === "folders" ? (
                <div className="search-popover" ref={folderPopoverRef}>
                  <input
                    className="popover-input"
                    value={folderQuery}
                    onFocus={() => setShowFolderPopover(true)}
                    onChange={(e) => setFolderQuery(e.target.value)}
                    placeholder="搜索文件夹"
                  />
                  {showFolderPopover ? (
                    <div className="popover">
                      <div className="popover-tags">
                        {filteredFolders.map((folder) => (
                          <button
                            key={`filter-${folder.id}`}
                            className={selectedFolders.includes(folder.id) ? "active" : ""}
                            onClick={() => toggleFolder(folder.id)}
                          >
                            {folder.path}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {activeFilterPanel === "color" ? (
                <div className="search-popover" ref={colorPopoverRef}>
                  <input
                    className="popover-input"
                    value={colorQuery}
                    onFocus={() => setShowColorPopover(true)}
                    onChange={(e) => setColorQuery(e.target.value)}
                    placeholder="颜色 #RRGGBB"
                  />
                  {showColorPopover ? (
                    <div className="popover color-panel">
                      <div className="color-panel__recent">
                        <div className="popover-title">最近使用</div>
                        <div className="popover-tags color-popover color-grid">
                          {recentColors.map((color) => (
                            <button
                              key={`recent-${color}`}
                              className={selectedColors.includes(color) ? "active" : ""}
                              onClick={() => toggleColor(color)}
                              title={color}
                            >
                              <span className="color-dot" style={{ background: color }} />
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="color-panel__recent">
                        <div className="popover-title">常用颜色</div>
                        <div className="popover-tags color-popover color-grid">
                          {topColors.length ? (
                            topColors.map((group) => (
                              <button
                                key={`palette-${group.hex}`}
                                className={selectedColors.includes(group.hex) ? "active" : ""}
                                onClick={() => toggleColor(group.hex)}
                                title={group.hex}
                              >
                                <span className="color-dot" style={{ background: group.hex }} />
                              </button>
                            ))
                          ) : (
                            <span className="muted">暂无颜色</span>
                          )}
                          {extraColors ? (
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => setShowAllColors(true)}
                            >
                              更多
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {activeFilterPanel === "note" ? (
                <div className="search-popover" ref={notePopoverRef}>
                  <input
                    className="popover-input"
                    value={noteQuery}
                    onFocus={() => setShowNotePopover(true)}
                    onChange={(e) => {
                      const value = e.target.value;
                      setNoteQuery(value);
                    }}
                    onBlur={() => {
                      if (!noteQuery.trim()) return;
                      setRecentNotes((prev) => {
                        const next = [noteQuery.trim(), ...prev.filter((item) => item !== noteQuery.trim())];
                        return next.slice(0, 8);
                      });
                    }}
                    placeholder="搜索标注"
                  />
                  {showNotePopover ? (
                    <div className="popover">
                      <div className="popover-tags">
                        {filteredAnnotationOptions.length ? (
                          filteredAnnotationOptions.map((item) => (
                            <button
                              key={item.text}
                              className={selectedNotes.includes(item.text) ? "active" : ""}
                              onClick={() => toggleNote(item.text)}
                              title={item.text}
                            >
                              <span className="truncate">{item.text}</span>
                              <span className="muted">×{item.count}</span>
                            </button>
                          ))
                        ) : (
                          <span className="muted">暂无标注</span>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {uploadProgress.active || deleteProgress.active ? (
          <div className="upload-progress">
            <div className="upload-progress__meta">
              <span>
                {uploadProgress.active ? "上传" : "删除"} {uploadProgress.active ? uploadProgress.index : deleteProgress.index}
                /{uploadProgress.active ? uploadProgress.total : deleteProgress.total}{" "}
                {uploadProgress.active ? uploadProgress.current : deleteProgress.current}
              </span>
              <span>{uploadProgress.active ? uploadProgress.percent : deleteProgress.percent}%</span>
            </div>
            <div className="upload-progress__bar">
              <div style={{ width: `${uploadProgress.active ? uploadProgress.percent : deleteProgress.percent}%` }} />
            </div>
          </div>
        ) : null}

        {uploadErrors.length ? (
          <div className="upload-errors">
            {uploadErrors.map((item) => (
              <div key={item}>{item}</div>
            ))}
          </div>
        ) : null}

        <section className="grid">
          <div className="grid-header">
            <span>共 {assets.length} 项</span>
          </div>
          {selectionMode ? (
            <div className="batch-bar">
              <span>已选择 {selectedIds.size} 项</span>
              <div className="batch-actions">
                <button className="danger" onClick={handleBatchDelete}>
                  批量删除
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    setSelectionMode(false);
                    setSelectedIds(new Set());
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
          <div
            className="grid-body"
            ref={gridRef}
            style={{ "--card-width": `${gridWidth}px`, "--thumb-height": `${thumbHeight}px` }}
            onDragOver={(event) => {
              if (!isFileDrag(event)) return;
              if (!activeFolder) return;
              event.preventDefault();
            }}
            onDrop={(event) => {
              if (!isFileDrag(event)) return;
              if (!activeFolder) return;
              handleDropUpload(event);
            }}
          >
            {assets.map((asset) => (
              <article
                key={asset.id}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                className={
                  selectionMode && selectedIds.has(asset.id)
                    ? "card active selected"
                    : selected?.id === asset.id
                      ? "card active"
                      : "card"
                }
                style={{ width: cardWidthFor(asset) }}
                onPointerDown={() => {
                  longPressTriggered.current = false;
                  if (longPressTimer.current) clearTimeout(longPressTimer.current);
                  longPressTimer.current = setTimeout(() => {
                    longPressTriggered.current = true;
                    setSelectionMode(true);
                    toggleSelectedId(asset.id);
                  }, 450);
                }}
                onPointerUp={() => {
                  if (longPressTimer.current) clearTimeout(longPressTimer.current);
                }}
                onPointerLeave={() => {
                  if (longPressTimer.current) clearTimeout(longPressTimer.current);
                }}
                onClick={() => {
                  if (longPressTriggered.current) return;
                  if (selectionMode) {
                    toggleSelectedId(asset.id);
                    return;
                  }
                  setSelected(asset);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (selectionMode) return;
                  setViewerAsset(asset);
                }}
              >
                <div className="thumb">
                  <span className="thumb-badge">
                    {asset.format ? asset.format.toUpperCase() : "FILE"}
                  </span>
                  {asset.media_type === "image" ||
                  asset.media_type === "gif" ||
                  (asset.media_type === "raw" && asset.preview_url) ? (
                    <img
                      draggable={false}
                      src={mediaUrl(asset.preview_url || asset.url)}
                      alt={asset.filename}
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                        event.currentTarget.parentElement.classList.add("thumb-fallback");
                      }}
                    />
                  ) : asset.media_type === "video" ? (
                    asset.preview_url ? (
                      <img
                        draggable={false}
                        src={mediaUrl(asset.preview_url)}
                        alt={asset.filename}
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                          event.currentTarget.parentElement.classList.add("thumb-fallback");
                        }}
                      />
                    ) : (
                      <div className="placeholder">视频</div>
                    )
                  ) : asset.media_type === "audio" ? (
                    <div className="placeholder">音频</div>
                  ) : asset.media_type === "raw" ? (
                    <div className="placeholder">RAW</div>
                  ) : (
                    <div className="placeholder">文件</div>
                  )}
                </div>
                <div className="meta">
                  <h3 title={asset.filename}>{asset.filename}</h3>
                </div>
                <div className="meta-hover" aria-hidden="true">
                  <div className="meta-hover__title">{asset.filename}</div>
                  <div className="meta-hover__line">
                    {asset.format?.toUpperCase() || "-"} · {formatSize(asset.size_bytes)}
                  </div>
                  <div className="meta-hover__line">
                    {asset.width && asset.height ? `${asset.width} × ${asset.height}` : "-"}
                  </div>
                  {asset.tags.length ? (
                    <div className="meta-hover__tags">
                      {asset.tags.map((tag) => (
                        <span key={tag}>#{tag}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>

      <aside className="inspector">
        {selected ? (
          <div className="details">
            <h2>素材详情</h2>
            <div className="preview" onClick={() => setViewerAsset(selected)}>
              {selected.media_type === "image" ||
              selected.media_type === "gif" ||
              (selected.media_type === "raw" && selected.preview_url) ? (
                <img
                  src={mediaUrl(selected.preview_url || selected.url)}
                  alt={selected.filename}
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                    event.currentTarget.parentElement.classList.add("thumb-fallback");
                  }}
                />
              ) : selected.media_type === "video" ? (
                <video src={mediaUrl(selected.url)} controls />
              ) : selected.media_type === "audio" ? (
                <audio src={mediaUrl(selected.url)} controls />
              ) : selected.media_type === "raw" ? (
                <div className="placeholder">RAW</div>
              ) : (
                <div className="placeholder">文件</div>
              )}
            </div>
            <details open>
              <summary>基础信息</summary>
              <div className="detail-grid">
                <div className="field">
                  <label>名称</label>
                  <div className="truncate" title={selected.filename}>
                    {selected.filename}
                  </div>
                </div>
                <div className="field">
                  <label>格式</label>
                  <div>{selected.format ? selected.format.toUpperCase() : "-"}</div>
                </div>
                <div className="field">
                  <label>大小</label>
                  <div>{formatSize(selected.size_bytes)}</div>
                </div>
                <div className="field">
                  <label>位置</label>
                  <div>{folderPath(selected.folder_id)}</div>
                </div>
                <div className="field">
                  <label>尺寸</label>
                  <div>
                    {selected.width && selected.height ? `${selected.width} × ${selected.height}` : "-"}
                  </div>
                </div>
              </div>
            </details>
            <details open>
              <summary>标签</summary>
              <div className="detail-tags">
                <div className="search-popover detail-popover" ref={detailTagPopoverRef}>
                  <input
                    className="popover-input"
                    value={detailTagQuery}
                    onFocus={() => setShowDetailTagPopover(true)}
                    onChange={(e) => setDetailTagQuery(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleDetailTagAdd(detailTagQuery);
                      }
                    }}
                    placeholder="搜索或添加标签"
                  />
                  {showDetailTagPopover ? (
                    <div className="popover">
                      {recentTags.length ? (
                        <div className="popover-section">
                          <div className="popover-title">最近使用</div>
                          <div className="popover-tags">
                            {recentTags.map((tagName) => (
                              <button
                                key={`detail-recent-${tagName}`}
                                className={selected.tags.includes(tagName) ? "active" : ""}
                                onClick={() => toggleDetailTag(tagName)}
                              >
                                #{highlightMatch(tagName, detailTagQuery)}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <div className="popover-section">
                        <div className="popover-title">全部标签</div>
                        <div className="popover-tags">
                          {filteredDetailTags.map((tag) => (
                            <button
                              key={`detail-${tag.name}`}
                              className={selected.tags.includes(tag.name) ? "active" : ""}
                              onClick={() => toggleDetailTag(tag.name)}
                            >
                              #{highlightMatch(tag.name, detailTagQuery)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="detail-chips">
                  {selected.tags.map((tagName) => (
                    <button key={tagName} className="chip" onClick={() => toggleDetailTag(tagName)}>
                      #{tagName}
                    </button>
                  ))}
                </div>
              </div>
            </details>
            <details>
              <summary>备注</summary>
              <div className="field">
                <textarea
                  value={selected.note || ""}
                  onChange={(e) => setSelected((prev) => ({ ...prev, note: e.target.value }))}
                  onBlur={() => updateSelected({ note: selected.note })}
                />
              </div>
            </details>
            <details>
              <summary>标注</summary>
              <div className="field">
                <div className="detail-tags">
                  <div className="search-popover detail-popover" ref={annotationPopoverRef}>
                    <input
                      className="popover-input"
                      value={annotationText}
                      onFocus={() => setShowAnnotationPopover(true)}
                      onChange={(e) => setAnnotationText(e.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleAddAnnotation();
                        }
                      }}
                      placeholder="输入标注，回车添加"
                    />
                    {showAnnotationPopover ? (
                      <div className="popover">
                        {recentAnnotations.length ? (
                          <div className="popover-section">
                            <div className="popover-title">最近使用</div>
                            <div className="popover-tags">
                              {recentAnnotations
                                .filter((item) =>
                                  annotationText
                                    ? item.toLowerCase().includes(annotationText.toLowerCase())
                                    : true
                                )
                                .map((item) => (
                                  <button
                                    key={`recent-annotation-${item}`}
                                    onClick={() => {
                                      handleAddAnnotation(item);
                                    }}
                                  >
                                    {item}
                                  </button>
                                ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="detail-chips">
                    {annotations.map((item) => (
                      <span key={item.id} className="annotation-chip">
                        {item.data?.text || ""}
                        <button onClick={() => handleDeleteAnnotation(item.id)}>×</button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </details>
            <div className="field colors">
              <label>颜色</label>
              <div className="swatches">
                {selected.colors.map((color) => (
                  <span key={color} style={{ background: color }} title={color} />
                ))}
              </div>
            </div>
            <div className="detail-actions">
              <a className="download" href={downloadUrl(selected.id)} download>
                下载素材
              </a>
              <button
                className="danger"
                onClick={async () => {
                  const ok = await new Promise((resolve) => {
                    confirmResolver.current = resolve;
                    setConfirmModal({
                      open: true,
                      title: "删除素材",
                      message: "确认删除该素材？"
                    });
                  });
                  if (!ok) return;
                  await deleteAsset(selected.id);
                  setSelected(null);
                  loadAssets();
                  loadMeta();
                }}
              >
                删除素材
              </button>
            </div>
          </div>
        ) : (
          <div className="empty">选择一个素材查看详情</div>
        )}
      </aside>

      {viewerAsset ? (
        <div className="viewer">
          <button
            type="button"
            className="viewer-backdrop"
            aria-label="关闭预览"
            onClick={() => setViewerAsset(null)}
          />
          <div className="viewer-body">
            <button
              type="button"
              className="viewer-close"
              onClick={() => setViewerAsset(null)}
            >
              ×
            </button>
            {viewerAsset.media_type === "image" ||
            viewerAsset.media_type === "gif" ||
            (viewerAsset.media_type === "raw" && viewerAsset.preview_url) ? (
              <img
                src={mediaUrl(viewerAsset.preview_url || viewerAsset.url)}
                alt={viewerAsset.filename}
                style={{ transform: `scale(${viewerScale})` }}
                onWheel={(event) => {
                  event.preventDefault();
                  const delta = event.deltaY > 0 ? -0.1 : 0.1;
                  setViewerScale((prev) => Math.min(3, Math.max(0.5, prev + delta)));
                }}
              />
            ) : viewerAsset.media_type === "video" ? (
              <video src={mediaUrl(viewerAsset.url)} controls />
            ) : viewerAsset.media_type === "audio" ? (
              <audio src={mediaUrl(viewerAsset.url)} controls />
            ) : viewerAsset.media_type === "raw" ? (
              <div className="placeholder">RAW</div>
            ) : (
              <div className="placeholder">文件</div>
            )}
          </div>
        </div>
      ) : null}

      {isDragging ? (
        <div className="drop-overlay">
          <div>
            <strong>拖拽相册到此处上传</strong>
            <span>支持文件夹与多文件</span>
          </div>
        </div>
      ) : null}
      {duplicateModal.open ? (
        <div className="ui-modal">
          <div className="ui-modal__panel">
            <h3>发现重复文件</h3>
            <p>
              当前文件夹内已存在 {duplicateModal.count} 个同名文件（例如：{duplicateModal.sample}
              ）。请选择处理方式。
            </p>
            <div className="ui-modal__actions">
              <button
                className="ghost"
                onClick={() => {
                  setDuplicateModal((prev) => ({ ...prev, open: false }));
                  if (duplicateResolver.current) duplicateResolver.current(false);
                  duplicateResolver.current = null;
                }}
              >
                都保留
              </button>
              <button
                className="primary"
                onClick={() => {
                  setDuplicateModal((prev) => ({ ...prev, open: false }));
                  if (duplicateResolver.current) duplicateResolver.current(true);
                  duplicateResolver.current = null;
                }}
              >
                保留新的
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {smartNameModal.open ? (
        <div className="ui-modal">
          <div className="ui-modal__panel">
            <h3>新建智能文件夹</h3>
            <p>为当前筛选保存一个名称。</p>
            <input
              className="ui-modal__input"
              value={smartNameModal.value}
              onChange={(e) => setSmartNameModal((prev) => ({ ...prev, value: e.target.value }))}
              placeholder="请输入名称"
              autoFocus
            />
            <div className="ui-modal__actions">
              <button
                className="ghost"
                onClick={() => {
                  setSmartNameModal((prev) => ({ ...prev, open: false }));
                  if (smartNameResolver.current) smartNameResolver.current("");
                  smartNameResolver.current = null;
                }}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  const value = smartNameModal.value.trim();
                  setSmartNameModal((prev) => ({ ...prev, open: false }));
                  if (smartNameResolver.current) smartNameResolver.current(value);
                  smartNameResolver.current = null;
                }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmModal.open ? (
        <div className="ui-modal">
          <div className="ui-modal__panel">
            <h3>{confirmModal.title || "请确认"}</h3>
            <p>{confirmModal.message}</p>
            <div className="ui-modal__actions">
              <button
                className="ghost"
                onClick={() => {
                  setConfirmModal((prev) => ({ ...prev, open: false }));
                  if (confirmResolver.current) confirmResolver.current(false);
                  confirmResolver.current = null;
                }}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmModal((prev) => ({ ...prev, open: false }));
                  if (confirmResolver.current) confirmResolver.current(true);
                  confirmResolver.current = null;
                }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toasts.length ? (
        <div className="toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className="toast">
              <div className="toast__title">{toast.title}</div>
              <div className="toast__message">{toast.message}</div>
            </div>
          ))}
        </div>
      ) : null}
      {showAllColors ? (
        <div className="ui-modal">
          <div className="ui-modal__panel">
            <h3>全部颜色</h3>
            <div className="popover-tags color-popover color-grid color-grid--all">
              {allColors.length ? (
                allColors.map((group) => (
                  <button
                    key={`all-${group.hex}`}
                    className={selectedColors.includes(group.hex) ? "active" : ""}
                    onClick={() => toggleColor(group.hex)}
                    title={group.hex}
                  >
                    <span className="color-dot" style={{ background: group.hex }} />
                  </button>
                ))
              ) : (
                <span className="muted">暂无颜色</span>
              )}
            </div>
            <div className="ui-modal__actions">
              <button className="ghost" onClick={() => setShowAllColors(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}















