# 运行时没有第三方依赖：Node 自带 SQLite，也能把 TypeScript 转成 JavaScript，镜像里只有源码和转好的文件。
# 写死版本：重新构建不会因为上游发新版而意外变化。要升级就改这里，跑完 CI 再上线
FROM node:26.13.0-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN node --disable-warning=ExperimentalWarning src/build.ts dist
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
USER node
VOLUME /data
# 新生代调小：这个程序消息量不大，默认值白占内存。实测 10 个机器人省 20 多 MB，50 个省 50 MB 左右
CMD ["node", "--max-semi-space-size=1", "--disable-warning=ExperimentalWarning", "dist/runtime/node.js"]
