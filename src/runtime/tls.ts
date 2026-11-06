// 自签名证书。运行时零依赖、容器里也没有 openssl，所以用 Node 自带的 crypto 手工拼 X.509。
// 放在 Cloudflare 代理（SSL 模式 Full）或自己的反代后面时，它只负责这一段的加密。
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const size = body.length;
  const head = size < 0x80 ? [size] : size < 0x100 ? [0x81, size] : [0x82, size >> 8, size & 0xff];
  return Buffer.concat([Buffer.from([tag, ...head]), body]);
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const utf8 = (text: string) => der(0x0c, Buffer.from(text));
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const OID_ECDSA_SHA256 = "2a8648ce3d040302";
const OID_COMMON_NAME = "550403";

function time(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return der(0x18, Buffer.from(`${text}Z`));
}

export function makeSelfSigned(commonName: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signatureAlgorithm = seq(oid(OID_ECDSA_SHA256));
  const name = seq(der(0x31, seq(oid(OID_COMMON_NAME), utf8(commonName))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    signatureAlgorithm,
    name,
    seq(time(new Date(now - 86_400_000)), time(new Date(now + 3650 * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = createSign("SHA256").update(tbs).sign({ key: privateKey, dsaEncoding: "der" });
  const certificate = seq(tbs, signatureAlgorithm, der(0x03, Buffer.from([0]), signature));
  const body = certificate.toString("base64").replace(/(.{64})/g, "$1\n").trim();
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n` };
}

/** 第一次启动时生成，之后沿用。 */
export function loadOrCreateCert(dir: string): { key: string; cert: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  if (existsSync(keyFile) && existsSync(certFile)) return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  const made = makeSelfSigned("tg-botsx");
  writeFileSync(keyFile, made.key, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  writeFileSync(certFile, made.cert, { mode: 0o644 });
  return made;
}
