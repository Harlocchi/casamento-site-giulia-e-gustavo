# Imagem única: o server.js serve a API /api/* E o site (index.html + fotos/ + vídeos).
# O contexto de build tem que ser a RAIZ do repositório (não a pasta server/).
FROM node:22-slim

WORKDIR /app

# 1) Só os manifestos do backend primeiro — cacheia o npm ci entre builds
#    enquanto as dependências não mudam.
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --no-audit --no-fund --prefix server

# 2) O resto do repositório (o .dockerignore tira node_modules, .env e logs).
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# server.js roda as migrações pendentes no boot; se falharem, não sobe.
CMD ["node", "server/server.js"]
