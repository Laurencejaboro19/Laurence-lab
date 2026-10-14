FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Data (SQLite DB + conversation state) lives in /data so it can be mounted as a volume
ENV DB_PATH=/data/laurence_lab.db
RUN mkdir -p /data
VOLUME ["/data"]

CMD ["python", "-m", "laurence_lab_bot"]
