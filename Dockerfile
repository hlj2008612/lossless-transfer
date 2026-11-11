# Minimal image for a container host (Render / Fly.io / any VPS).
# The platform's proxy terminates TLS, so the server itself speaks plain HTTP:
# no certificate is baked into the image and nothing secret is copied in.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    LT_DIR=/data

WORKDIR /app

# Only what the server needs: the two modules and the static front end.
# (Library data, certificates and tests are excluded by .dockerignore.)
COPY web_transfer.py lossless_transfer.py ./
COPY web ./web

RUN mkdir -p "$LT_DIR"

EXPOSE 8080

# No arguments: every setting comes from the environment (PORT, LT_DIR,
# LT_TOKEN, LT_HOST). The host must provide LT_TOKEN - without it the server
# generates a random one and prints it in the log, which is safe but awkward.
CMD ["python", "web_transfer.py"]
