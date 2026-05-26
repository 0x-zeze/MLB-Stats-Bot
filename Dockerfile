FROM node:20-bookworm AS app-base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY dashboard-react/package.json dashboard-react/package-lock.json ./dashboard-react/
RUN npm --prefix dashboard-react ci

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt

COPY . .
RUN npm run dashboard:build

FROM app-base AS bot
ENV NODE_ENV=production PYTHON_BIN=python3 DASHBOARD_ENABLED=false
CMD ["node", "src/index.js"]

FROM app-base AS api
ENV NODE_ENV=production PYTHON_BIN=python3 DASHBOARD_API_HOST=0.0.0.0 DASHBOARD_API_PORT=8010
CMD ["python3", "-m", "uvicorn", "src.dashboard_api:app", "--host", "0.0.0.0", "--port", "8010"]

FROM nginx:1.27-alpine AS dashboard-web
COPY dashboard-react/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=app-base /app/dashboard-react/dist /usr/share/nginx/html
