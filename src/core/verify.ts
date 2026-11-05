// 人机验证题目。纯函数，随机源可注入，便于测试。
// 答案不进 callback_data：每个按钮一个随机令牌，服务端只存正确令牌。

export interface Rng {
  int(min: number, max: number): number;
  token(): string;
}

export const cryptoRng: Rng = {
  int(min, max) {
    const range = max - min + 1;
    const limit = Math.floor(0x1_0000_0000 / range) * range;
    const buffer = new Uint32Array(1);
    let value = 0;
    do {
      crypto.getRandomValues(buffer);
      value = buffer[0] ?? 0;
    } while (value >= limit);
    return min + (value % range);
  },
  token() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
  },
};

export interface Challenge {
  question: string;
  correct: string;
  options: string[];
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[rng.int(0, items.length - 1)];
  if (item === undefined) throw new Error("不能从空列表里取值");
  return item;
}

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

function numberOptions(rng: Rng, answer: number): string[] {
  const values = new Set<number>([answer]);
  const deltas = shuffle(rng, [-5, -3, -2, -1, 1, 2, 3, 5]);
  for (const delta of deltas) {
    if (values.size >= 6) break;
    if (answer + delta >= 0) values.add(answer + delta);
  }
  return [...values].map(String);
}

const SYMBOLS = ["🍎", "⭐", "🐱", "🌙", "🌸", "🍋", "🐟", "🍄"];
const ODD_PAIRS: readonly (readonly [string, string])[] = [
  ["🐶", "🐺"],
  ["🍎", "🍅"],
  ["🌕", "🌑"],
  ["😀", "😎"],
  ["🐱", "🐯"],
];

const GENERATORS: readonly ((rng: Rng) => Challenge)[] = [
  // 数数：比算术更难被通用脚本解析，人看一眼就会
  (rng) => {
    const symbol = pick(rng, SYMBOLS);
    const noise = pick(rng, SYMBOLS.filter((item) => item !== symbol));
    const count = rng.int(3, 8);
    const items = shuffle(rng, [...Array<string>(count).fill(symbol), ...Array<string>(rng.int(2, 4)).fill(noise)]);
    return { question: `下面有几个 ${symbol}？\n\n${items.join(" ")}`, correct: String(count), options: numberOptions(rng, count) };
  },
  (rng) => {
    const pair = pick(rng, ODD_PAIRS);
    const position = rng.int(1, 6);
    const items = Array.from({ length: 6 }, (_, index) => (index + 1 === position ? pair[1] : pair[0]));
    return {
      question: `从左往右数，第几个和别的不一样？\n\n${items.join(" ")}`,
      correct: String(position),
      options: ["1", "2", "3", "4", "5", "6"],
    };
  },
  (rng) => {
    const a = rng.int(11, 39);
    const b = rng.int(2, 19);
    return { question: `${a} + ${b} 等于几？`, correct: String(a + b), options: numberOptions(rng, a + b) };
  },
  (rng) => {
    const pair = shuffle(rng, SYMBOLS).slice(0, 2);
    const first = pair[0] ?? "🍎";
    const second = pair[1] ?? "🍋";
    const others = SYMBOLS.filter((item) => item !== first && item !== second).slice(0, 4);
    return { question: `接下来该是哪一个？\n\n${first} ${second} ${first} ${second} ${first} ？`, correct: second, options: [first, second, ...others] };
  },
];

export function makeChallenge(rng: Rng): Challenge {
  const challenge = pick(rng, GENERATORS)(rng);
  return { ...challenge, options: shuffle(rng, challenge.options) };
}
