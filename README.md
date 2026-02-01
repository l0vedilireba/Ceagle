# Ceagle

Ceagle 是一个轻量的局域网素材管理工具：后端 FastAPI + 前端 React (Vite)。

## 主要功能
- 素材上传、检索、标签与颜色筛选
- 图片/视频/音频预览
- 素材详情、备注与标注
- 适合内网部署

## 目录结构
- `server/` 后端服务（FastAPI）
- `web/` 前端页面（React + Vite）

## 环境要求
- Python 3.10+
- Node.js 18+
- ffmpeg（用于视频缩略图/元数据；Docker 镜像内已包含）

## 本地开发

后端启动：
```bash
cd server
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn server.app:app --reload --host 0.0.0.0 --port 8000
```

前端启动：
```bash
cd web
npm install
npm run dev
```

浏览器访问：
- 前端：`http://localhost:5173`
- 后端：`http://localhost:8000`

## Docker 单容器部署（内网）

构建镜像：
```bash
docker build -t Ceagle:local .
```

运行容器：
```bash
docker run -d --name Ceagle \
  -p 8000:8000 \
  -v Ceagle_data:/app/server/data \
  -v Ceagle_storage:/app/server/storage \
  Ceagle:local
```

访问：
- 前端：`http://<内网IP>:8000`
- API：`http://<内网IP>:8000/api/...`
- 媒体文件：`http://<内网IP>:8000/api/media/...`

## 配置说明
- API 前缀：默认 `/api`
- 媒体存储：`server/storage/`
- 数据库：`server/data/eagle.db`

前端环境变量（构建时生效）：
- `VITE_API_BASE`：默认 `/api`
- `VITE_MEDIA_BASE`：默认 `/api`
- `VITE_BASE`：默认 `/`，Docker 构建时设置为 `/static/`

## 常见问题

1) 白屏、静态资源 422
- 说明静态资源路径被后端路由拦截。
- Docker 构建已设置 `VITE_BASE=/static/`，静态资源会走 `/static/assets/...`。

2) 视频无法拖动进度条
- 需要后端支持 Range 请求（本项目已实现）。

3) 内网部署是否需要外网依赖
- 前端不依赖外网。
- ffmpeg 只需存在于后端环境（Docker 镜像已包含）。
## 截图
<img width="2504" height="1241" alt="ScreenShot_2026-02-01_153118_141" src="https://github.com/user-attachments/assets/ba97826a-093f-4cb1-b94c-b973ab49e88d" />
<img width="2508" height="1236" alt="ScreenShot_2026-02-01_153129_159" src="https://github.com/user-attachments/assets/f9c42428-0960-4993-817a-763ecec4bcdf" />

## License\nApache-2.0


