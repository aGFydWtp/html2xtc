# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 haruki

# --- builder: clone + install xtctool into a venv -------------------------
# xtctool needs Python 3.11+ (tomllib); all deps ship amd64 wheels, so no
# build-essential is required — only git for the clone.
FROM python:3.12-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# All pip dependencies (including xtctool's transitive deps) are fully pinned
# with hashes in requirements.lock, so a rebuild from the same Git revision
# reproduces the same dependency versions (AGPL Corresponding Source support).
# Regenerate requirements.lock as described in its header when updating deps.
COPY requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock

# Pinned to the commit verified in Phase 0 (2026-07-17: build + Japanese PDF
# conversion checked on linux/amd64).
# sed: upstream packaging bug — [tool.hatch.build.targets.wheel.force-include]
# duplicates files already shipped via packages=["xtctool"] and newer hatchling
# rejects the duplicate, so the section is stripped before install.
# [markdown] extra is required in practice: xtctool's assets/__init__.py
# unconditionally imports jinja2, which only the markdown extra pulls in.
# --no-deps: every dependency (extras included) is already installed from
# requirements.lock above, so nothing unpinned can slip in here.
RUN git clone https://github.com/chazeon/xtctool.git /opt/xtctool \
    && git -C /opt/xtctool checkout d7bff34ff835889e158ca8ff2253de06a3e825cf \
    && sed -i '/force-include/,+1d' /opt/xtctool/pyproject.toml \
    && pip install --no-cache-dir --no-deps "/opt/xtctool[performance,markdown]"

# --- runtime: slim image without git or the source checkout ---------------
FROM python:3.12-slim

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN useradd -m -u 10001 appuser

WORKDIR /app

COPY app.py /app/app.py
COPY config-x3.toml /app/config-x3.toml

USER appuser

# Required for port discovery in local `wrangler dev`; harmless in production.
EXPOSE 8080

CMD ["python", "/app/app.py"]
