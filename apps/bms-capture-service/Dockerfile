FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BMS_BROWSER_PROFILE_DIR=/tmp/mpltalkies-bms-profile

WORKDIR /service
COPY pyproject.toml README.md ./
COPY mpltalkies_bms ./mpltalkies_bms
RUN pip install --no-cache-dir . \
    && playwright install --with-deps chromium \
    && chmod -R a+rx /ms-playwright

USER 65532:65532
CMD ["sh", "-c", "uvicorn mpltalkies_bms.app:app --host 0.0.0.0 --port ${PORT}"]

