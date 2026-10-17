# Para hospedar em qualquer lugar que rode contêiner (Fly.io, Railway, Koyeb...).
# O Node 24 roda o TypeScript direto, sem etapa de build.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "src/server.ts"]
