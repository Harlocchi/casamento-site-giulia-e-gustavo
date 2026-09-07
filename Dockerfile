# Imagem única: o server.js serve a API /api/* E o site (index.html + fotos/)
FROM node:22-slim

WORKDIR /app

# deps do backend (só produção) — cache-friendly
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# código do backend + arquivos estáticos do site
COPY server ./server
COPY index.html ./index.html
COPY shot_01.webm ./shot_01.webm
COPY shot_01.mp4 ./shot_01.mp4
COPY shot_01.png ./shot_01.png
COPY fotos ./fotos

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# server.js roda as migrações pendentes no boot; se falharem, não sobe.
CMD ["node", "server/server.js"]
