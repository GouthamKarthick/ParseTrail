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
    echo "22122b0ec84c2174d32363b8617800b4a59c9f5700faafe99eb5fe43c809eca0  deu.traineddata" | sha256sum -c - && \
    # v5.5.0 tag is not published on tesseract-ocr/tessdata; the traineddata
    # files live on the main branch. Hashes below were computed locally.
    curl -fsSL -o fra.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/fra.traineddata && \
    echo "eac01c1d72540d6090facb7b2f42dd0a2ee8fc57c5be1b20548ae668e2761913  fra.traineddata" | sha256sum -c - && \
    curl -fsSL -o spa.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/spa.traineddata && \
    echo "0b0fcbb4665189e01ab8019e591f014dd7260460de072543edd4b2cb4ede7c96  spa.traineddata" | sha256sum -c - && \
    curl -fsSL -o ita.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/ita.traineddata && \
    echo "4f7476c611312beb8f8e182888da08ea642d9824ae4402cc6235f61ab1406406  ita.traineddata" | sha256sum -c - && \
    curl -fsSL -o nld.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/nld.traineddata && \
    echo "b1f6767f50daf5903802fb970e7b9f64ee1f12be0b2b324dfdf8e8b05771572f  nld.traineddata" | sha256sum -c - && \
    curl -fsSL -o por.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/por.traineddata && \
    echo "016c6a371bb1e4c48fe521908cf3ba3d751fade0ab846ad5d4086b563f5c528c  por.traineddata" | sha256sum -c -

ENV NODE_ENV=production
RUN mkdir -p /app/uploads /app/logs && chown -R node:node /app/uploads /app/logs
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "dist/index.js"]
