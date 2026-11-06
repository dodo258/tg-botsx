# 运行时没有第三方依赖：Node 自带 SQLite 和 TypeScript 类型剥离，镜像里只有源码。
FROM node:26-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
USER node
VOLUME /data
CMD ["node", "--disable-warning=ExperimentalWarning", "src/runtime/node.ts"]
