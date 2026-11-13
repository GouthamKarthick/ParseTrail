# Stage 1: build assets and install dependencies
FROM node:20-alpine AS build
RUN apk add --no-cache poppler-utils vips-dev python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: run the app as a non-root user
FROM node:20-alpine
RUN apk add --no-cache poppler-utils vips curl
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Tesseract trained data is gitignored in the repo, so fetch it at build time
# so OCR works inside the image without bundling large binary blobs.
RUN curl -fsSL -o eng.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata && \
    curl -fsSL -o deu.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/deu.traineddata

ENV NODE_ENV=production
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "dist/index.js"]
