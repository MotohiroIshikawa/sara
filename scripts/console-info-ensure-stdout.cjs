/* eslint-disable @typescript-eslint/no-require-imports */
const util = require("node:util");
const orig = typeof console.info === "function" ? console.info.bind(console) : null;

// console.info を「必ず stdout に出す」実装に差し替え（warnには流さない）
console.info = (...args) => {
  try {
    process.stdout.write(util.format(...args) + "\n");
  } catch {}
  // 元の info も残す（重複が嫌ならこの行は消してOK）
  if (orig) {
    try { orig(...args); } catch {}
  }
};