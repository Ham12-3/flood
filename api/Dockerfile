# Build from the repo root (the API depends on ../ml):  docker build -f api/Dockerfile .
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" FLOODSCOPE_CACHE_DIR=/data/cache \
    FLOODSCOPE_MODEL_DIR=/app/ml/artifacts FLOODSCOPE_SATELLITE_DIR=/app/ml/satellite_results

WORKDIR /app/api
# rasterio and pyproj wheels bundle GDAL and PROJ; onnxruntime serves the AI model (no torch).
COPY ml/pyproject.toml ml/README.md* /app/ml/
COPY ml/floodscope_ml /app/ml/floodscope_ml
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY api/floodscope ./floodscope
COPY ml/artifacts /app/ml/artifacts
COPY ml/satellite_results /app/ml/satellite_results

RUN useradd --create-home app && mkdir -p /data/cache && chown -R app /data
USER app
VOLUME ["/data"]
EXPOSE 8000

CMD ["uvicorn", "floodscope.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
