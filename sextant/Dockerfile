FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DATA_DIR=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY sextant ./sextant
RUN useradd --create-home sextant && mkdir /data && chown sextant /data
USER sextant
VOLUME /data
CMD ["python", "-m", "sextant"]
