# Stage 1: build assets and install dependencies
FROM node:20-alpine AS build
RUN apk add --no-cache poppler-utils vips-dev python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: run the app as a non-root user
FROM node:20-alpine
RUN apk add --no-cache poppler-utils vips curl
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Tesseract trained data is gitignored in the repo, so fetch it at build time
# so OCR works inside the image without bundling large binary blobs.
# Pinned to tesseract-ocr/tessdata v5.5.0 with sha256 verification.
RUN curl -fsSL -o eng.traineddata https://github.com/tesseract-ocr/tessdata/raw/v5.5.0/eng.traineddata && \
    echo "4cd26ef5e03857b50bb104835aad26b17161d723f3978c894ed55fe05d8315bf  eng.traineddata" | sha256sum -c - && \
    curl -fsSL -o deu.traineddata https://github.com/tesseract-ocr/tessdata/raw/v5.5.0/deu.traineddata && \
    echo "22122b0ec84c2174d32363b8617800b4a59c9f5700faafe99eb5fe43c809eca0  deu.traineddata" | sha256sum -c -

ENV NODE_ENV=production
RUN mkdir -p /app/uploads /app/logs && chown -R node:node /app/uploads /app/logs
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "dist/index.js"]
