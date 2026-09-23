# Minimal image for the Express app. Same image is used for every instance
# in docker-compose.yml (app1, app2, ...) -- they differ only by the
# INSTANCE_ID and PORT environment variables set per-service in that file.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json
# actually changes -- avoids a full npm install on every code edit.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "src/server.js"]
