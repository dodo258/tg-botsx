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

/** 10 以内加减，三个选项。只为挡刷屏脚本和手滑，人一眼就会；结果不会是负数。 */
export function makeChallenge(rng: Rng): Challenge {
  const plus = rng.int(0, 1) === 0;
  const a = plus ? rng.int(1, 9) : rng.int(2, 10);
  const b = plus ? rng.int(1, 10 - a) : rng.int(1, a - 1);
  const answer = plus ? a + b : a - b;
  const wrong = shuffle(rng, [-3, -2, -1, 1, 2, 3].map((delta) => answer + delta).filter((value) => value >= 0 && value <= 10)).slice(0, 2);
  return { question: `${a} ${plus ? "+" : "-"} ${b} 等于几？`, correct: String(answer), options: shuffle(rng, [answer, ...wrong]).map(String) };
}
