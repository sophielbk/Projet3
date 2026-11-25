# ─── Étape 1 : build de l'UI React (Vite) ───────────────────────────────────
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build          # produit /web/dist

# ─── Étape 2 : le gateway Node qui sert l'UI + proxifie /api ─────────────────
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
# L'UI compilée devient le contenu statique servi par le gateway.
COPY --from=web /web/dist ./public

EXPOSE 8080
CMD ["node", "server.js"]
