# Runs the TypeScript sources directly with Node's built-in type stripping: no build step and no runtime dependencies.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json ./
COPY config ./config
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
