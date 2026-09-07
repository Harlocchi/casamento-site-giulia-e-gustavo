# Imagem única: o server.js serve a API /api/* E o site (index.html + fotos/ + vídeos).
# O contexto de build tem que ser a RAIZ do repositório (não a pasta server/).
FROM node:22-slim

WORKDIR /app

# Copia o repositório inteiro (o .dockerignore tira node_modules, .env e logs).
COPY . .

# Dependências do backend (só produção). --prefix roda dentro de ./server sem 'cd'.
RUN npm ci --omit=dev --prefix server

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# server.js roda as migrações pendentes no boot; se falharem, não sobe.
CMD ["node", "server/server.js"]
