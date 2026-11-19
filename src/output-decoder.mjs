/**
 * 子进程输出解码。Windows 上 cmd 和多数原生命令按系统代码页输出（中文系统是 936/GBK），
 * 直接按 UTF-8 解码会成乱码；而 Node、Python、git 等已经输出 UTF-8。
 * 所以每块先按 UTF-8 严格校验，通过就按 UTF-8，失败再按回退编码（默认 GBK）解。
 * 块边界可能切断一个多字节字符，未完成的尾巴留到下一块再解。
 */

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

function fallbackDecoder(encoding) {
  try {
    return new TextDecoder(encoding);
  } catch {
    return null;
  }
}

/** 末尾不完整的 UTF-8 序列的字节数（0 表示完整）。 */
export function incompleteUtf8Tail(bytes) {
  const end = bytes.length;
  for (let back = 1; back <= Math.min(3, end); back++) {
    const b = bytes[end - back];
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/** GBK 末尾落单的首字节数（0 或 1）。 */
export function incompleteGbkTail(bytes) {
  let i = 0;
  while (i < bytes.length) i += bytes[i] >= 0x81 && bytes[i] <= 0xfe ? 2 : 1;
  return i > bytes.length ? 1 : 0;
}

/**
 * 返回 { write(chunk) → string, end() → string }。
 * 非 Windows 只做流式 UTF-8；Windows 上 UTF-8 不合法时按 fallback（默认 gbk）解。
 */
export function createOutputDecoder({ platform = process.platform, fallback = "gbk" } = {}) {
  if (platform !== "win32") {
    const decoder = new TextDecoder("utf-8");
    return {
      write: (chunk) => decoder.decode(toBytes(chunk), { stream: true }),
      end: () => decoder.decode(),
    };
  }
  const legacy = fallbackDecoder(fallback);
  let pending = Buffer.alloc(0);

  function decodeReady(bytes, final) {
    const cut = final ? 0 : incompleteUtf8Tail(bytes);
    const ready = bytes.subarray(0, bytes.length - cut);
    try {
      const text = UTF8_FATAL.decode(ready);
      pending = Buffer.from(bytes.subarray(bytes.length - cut));
      return text;
    } catch {
      if (!legacy) {
        pending = Buffer.alloc(0);
        return new TextDecoder("utf-8").decode(bytes);
      }
      const keep = final ? 0 : incompleteGbkTail(bytes);
      pending = Buffer.from(bytes.subarray(bytes.length - keep));
      return legacy.decode(bytes.subarray(0, bytes.length - keep));
    }
  }

  return {
    write(chunk) {
      const bytes = pending.length ? Buffer.concat([pending, toBytes(chunk)]) : toBytes(chunk);
      return decodeReady(bytes, false);
    },
    end() {
      if (!pending.length) return "";
      const bytes = pending;
      pending = Buffer.alloc(0);
      return decodeReady(bytes, true);
    },
  };
}

function toBytes(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk ?? ""), "utf8");
}
