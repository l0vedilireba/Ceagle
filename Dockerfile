FROM node:20-alpine AS web-build
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
ENV VITE_API_BASE=/api
ENV VITE_MEDIA_BASE=/api
ENV VITE_BASE=/static/
RUN npm run build

FROM python:3.11-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libraw-dev \
    libheif-dev \
    libjpeg62-turbo \
    zlib1g \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY server/ /app/server/
COPY --from=web-build /web/dist /app/server/web_dist
RUN pip install --no-cache-dir -r /app/server/requirements.txt
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
