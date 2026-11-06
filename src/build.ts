// 构建镜像时把 TypeScript 预先转成 JavaScript。直接跑 .ts 时 Node 要多加载一套类型处理的东西，常驻内存多 20 MB 左右。
// 开发和测试仍然直接跑 .ts，这个脚本只给 Dockerfile 用。用法：node src/build.ts [输出目录]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const source = resolve(import.meta.dirname);
const target = resolve(process.argv[2] ?? "dist");

function convert(file: string): void {
  // 只改相对导入的后缀。Node 不会替你把 ./x.ts 改成 ./x.js
  const code = stripTypeScriptTypes(readFileSync(file, "utf8")).replace(/((?:from|import)\s+"\.{1,2}\/[^"]+)\.ts"/g, '$1.js"');
  const output = join(target, relative(source, file)).replace(/\.ts$/, ".js");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, code);
}

function walk(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".ts")) convert(path);
  }
}

walk(source);
writeFileSync(join(target, "package.json"), '{"type":"module"}\n');
console.log(`已转换到 ${target}`);
