FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" FLOODSCOPE_CACHE_DIR=/data/cache

# rasterio wheels bundle GDAL, so no system GDAL is needed.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY floodscope ./floodscope

RUN useradd --create-home app && mkdir -p /data/cache && chown -R app /data
USER app
VOLUME ["/data"]
EXPOSE 8000

CMD ["uvicorn", "floodscope.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
