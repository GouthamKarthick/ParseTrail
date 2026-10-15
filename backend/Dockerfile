FROM node:20-alpine
# Poppler (pdftotext/pdftoppm) + vips for sharp
RUN apk add --no-cache poppler-utils vips-dev
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
# Pre-bake Flan-T5-small quantized (~80MB) so Render free doesn't download at runtime (one-time)
RUN npx --yes tsx -e "import('@huggingface/transformers').then(async m=>{const p=m.pipeline; const pipe=await p('text2text-generation','Xenova/flan-t5-small',{quantized:true}); console.log('Flan pre-baked')})" || echo "Flan pre-bake skipped (offline build)"
RUN npm run build
EXPOSE 4000
CMD ["node", "dist/index.js"]
