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

# Pinned to an immutable tesseract-ocr/tessdata commit with sha256 verification.
ARG TESSDATA_COMMIT=ced78752cc61322fb554c280d13360b35b8684e4
RUN curl -fsSL -o deu.traineddata https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_COMMIT}/deu.traineddata && \
    echo "896b3b4956503ab9daa10285db330881b2d74b70d889b79262cc534b9ec699a4  deu.traineddata" | sha256sum -c - && \
    curl -fsSL -o eng.traineddata https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_COMMIT}/eng.traineddata && \
    echo "daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047  eng.traineddata" | sha256sum -c - && \
    curl -fsSL -o fra.traineddata https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_COMMIT}/fra.traineddata && \
    echo "eac01c1d72540d6090facb7b2f42dd0a2ee8fc57c5be1b20548ae668e2761913  fra.traineddata" | sha256sum -c - && \
    curl -fsSL -o ita.traineddata https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_COMMIT}/ita.traineddata && \
    echo "4f7476c611312beb8f8e182888da08ea642d9824ae4402cc6235f61ab1406406  ita.traineddata" | sha256sum -c - && \
    curl -fsSL -o nld.traineddata https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_COMMIT}/nld.traineddata && \
    echo "b1f6767f50daf5903802fb970e7b9f64ee1f12be0b2b324dfdf8e8b05771572f  nld.traineddata" | sha256sum -c - && \
    curl -fsSL -o por.traineddata https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_COMMIT}/por.traineddata && \
    echo "016c6a371bb1e4c48fe521908cf3ba3d751fade0ab846ad5d4086b563f5c528c  por.traineddata" | sha256sum -c - && \
    curl -fsSL -o spa.traineddata https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_COMMIT}/spa.traineddata && \
    echo "0b0fcbb4665189e01ab8019e591f014dd7260460de072543edd4b2cb4ede7c96  spa.traineddata" | sha256sum -c - && true

ENV NODE_ENV=production
RUN mkdir -p /app/uploads /app/logs && chown -R node:node /app/uploads /app/logs
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "dist/index.js"]
