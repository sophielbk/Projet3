# Image Debian (glibc) : better-sqlite3 y récupère un binaire pré-compilé,
# donc aucun outil de build natif n'est nécessaire.
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
