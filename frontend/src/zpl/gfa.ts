/**
 * ^GFA(Graphic Field, ASCII hex) 디코더 + 1비트 비트맵 → PNG 인코더.
 *
 * 두 가지를 순수 TypeScript 로 처리한다 — DOM 에 기대지 않으므로 렌더러(브라우저)와
 * 임포터·테스트(Node) 가 같은 코드를 쓴다.
 *
 * 1) 디코드: ZPL 의 ASCII-hex **압축 표기**까지 해석한다. 라벨 디자이너가 뽑아낸
 *    실무 ZPL 은 대부분 압축돼 있는데, 압축 문자를 단순히 버리면 비트맵이
 *    통째로 어긋난다(가로로 밀리거나 줄이 사라진다).
 *      G–Y = 1–19회, g–z = 20–400회(20 단위) 반복 — 뒤따르는 hex 한 글자에 적용
 *      ','  = 이 줄의 남은 부분을 흰색(0)으로 채움
 *      '!'  = 이 줄의 남은 부분을 검정(F)으로 채움
 *      ':'  = 바로 앞 줄을 그대로 반복
 *
 * 2) PNG 인코드: ^GFA 비트맵은 1비트/픽셀·행 단위 패딩이라 PNG 의 1비트 그레이스케일
 *    레이아웃과 사실상 동일하다. 압축은 deflate 의 **무압축(stored) 블록**을 써서
 *    zlib 의존성 없이 유효한 PNG 를 만든다(로고 크기에서는 용량도 충분히 작다).
 */

export interface DecodedGfa {
  /** 행 단위로 패킹된 비트맵. 비트 1 = 검은 점(ZPL 규약). */
  bytes: Uint8Array;
  bytesPerRow: number;
  widthDots: number;
  heightDots: number;
}

/** 'G'(1)~'Y'(19), 'g'(20)~'z'(400, 20 단위) 반복 횟수. 반복 문자가 아니면 0. */
function repeatCount(ch: string): number {
  if (ch >= 'G' && ch <= 'Y') return ch.charCodeAt(0) - 70; // G=1 … Y=19
  if (ch >= 'g' && ch <= 'z') return (ch.charCodeAt(0) - 102) * 20; // g=20 … z=400
  return 0;
}

const HEX = /[0-9A-Fa-f]/;

/**
 * `^GFA` 뒤에 오는 인자 문자열을 비트맵으로 되돌린다.
 * 형식: `<총바이트>,<총바이트>,<행당바이트>,<데이터>`
 * 해석할 수 없으면 null.
 */
export function decodeGfa(rest: string): DecodedGfa | null {
  const firstComma = [0, 0, 0].map(() => 0);
  // 데이터에도 ','(줄 채움)가 들어가므로 앞 3개 콤마만 인자로 끊는다.
  let idx = 0;
  for (let i = 0; i < 3; i++) {
    const next = rest.indexOf(',', idx);
    if (next < 0) return null;
    firstComma[i] = next;
    idx = next + 1;
  }
  const totalBytes = parseInt(rest.slice(0, firstComma[0]), 10);
  const bytesPerRow = parseInt(rest.slice(firstComma[1] + 1, firstComma[2]), 10);
  const data = rest.slice(firstComma[2] + 1);
  if (!Number.isFinite(bytesPerRow) || bytesPerRow <= 0) return null;

  const nibblesPerRow = bytesPerRow * 2;
  const rows: number[][] = [];
  let row: number[] = [];
  let pending = 0; // 누적된 반복 횟수
  // 행이 니블로 정확히 채워져 방금 자동 종료됐는지. 많은 ZPL 생성기가 행마다
  // 끝에 ',' 를 줄 종결자로 붙이는데, 그걸 '빈 행'으로 세면 이미지가 세로로
  // 두 배가 되며 흰 줄이 끼어든다. 그래서 이 직후의 ','/'!' 는 무시한다.
  let rowJustCompleted = false;

  const endRow = (fill?: number) => {
    if (fill !== undefined) {
      while (row.length < nibblesPerRow) row.push(fill);
    }
    rows.push(row.slice(0, nibblesPerRow));
    row = [];
  };

  for (const ch of data) {
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;

    if (ch === ',' || ch === '!') {
      pending = 0;
      if (rowJustCompleted && row.length === 0) {
        rowJustCompleted = false; // 줄 종결자 — 빈 행을 만들지 않는다
        continue;
      }
      endRow(ch === ',' ? 0x0 : 0xf); // 남은 부분을 흰색/검정으로 채우고 줄 종료
      continue;
    }
    if (ch === ':') {
      // 앞 줄 반복. 첫 줄이면 흰 줄로 간주한다.
      rows.push(rows.length > 0 ? rows[rows.length - 1].slice() : new Array(nibblesPerRow).fill(0));
      row = [];
      pending = 0;
      rowJustCompleted = false;
      continue;
    }

    const rep = repeatCount(ch);
    if (rep > 0) {
      pending += rep; // 'hG' 처럼 연달아 오면 합산된다
      continue;
    }

    if (!HEX.test(ch)) continue; // 알 수 없는 문자는 무시
    const nibble = parseInt(ch, 16);
    const times = pending > 0 ? pending : 1;
    pending = 0;
    rowJustCompleted = false;
    for (let i = 0; i < times; i++) {
      row.push(nibble);
      if (row.length === nibblesPerRow) {
        endRow();
        rowJustCompleted = true;
      }
    }
  }
  if (row.length > 0) endRow(0x0);
  if (rows.length === 0) return null;

  // 선언된 총 바이트 수가 있으면 그쪽을 신뢰한다(압축 해제 결과가 더 길 수 있음).
  const declaredRows =
    Number.isFinite(totalBytes) && totalBytes > 0
      ? Math.floor(totalBytes / bytesPerRow)
      : rows.length;
  const heightDots = Math.max(1, Math.min(rows.length, declaredRows || rows.length));

  const bytes = new Uint8Array(bytesPerRow * heightDots);
  for (let r = 0; r < heightDots; r++) {
    const nibbles = rows[r];
    for (let b = 0; b < bytesPerRow; b++) {
      const hi = nibbles[b * 2] ?? 0;
      const lo = nibbles[b * 2 + 1] ?? 0;
      bytes[r * bytesPerRow + b] = (hi << 4) | lo;
    }
  }

  return { bytes, bytesPerRow, widthDots: bytesPerRow * 8, heightDots };
}

// ── PNG 인코딩 ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map(c => c.charCodeAt(0));
  const body = Uint8Array.from([...typeBytes, ...data]);
  return [...u32be(data.length), ...body, ...u32be(crc32(body))];
}

/** deflate 무압축(stored) 스트림 — zlib 라이브러리 없이 유효한 PNG 를 만든다. */
function zlibStored(raw: Uint8Array): number[] {
  const out: number[] = [0x78, 0x01];
  const MAX = 65535;
  for (let pos = 0; pos < raw.length || pos === 0; pos += MAX) {
    const len = Math.min(MAX, raw.length - pos);
    const last = pos + len >= raw.length ? 1 : 0;
    out.push(last, len & 0xff, (len >>> 8) & 0xff, ~len & 0xff, (~len >>> 8) & 0xff);
    for (let i = 0; i < len; i++) out.push(raw[pos + i]);
    if (last) break;
  }
  out.push(...u32be(adler32(raw)));
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 환경(btoa/Buffer) 차이를 타지 않도록 base64 도 직접 만든다. */
function toBase64(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}

/**
 * ZPL 비트맵(비트 1 = 검정) → PNG DataURL.
 * PNG 1비트 그레이스케일은 0 이 검정이라 바이트를 반전해 넣는다.
 */
export function bitmapToPngDataUrl(decoded: DecodedGfa): string {
  const { bytes, bytesPerRow, widthDots, heightDots } = decoded;

  const raw = new Uint8Array((bytesPerRow + 1) * heightDots);
  for (let r = 0; r < heightDots; r++) {
    raw[r * (bytesPerRow + 1)] = 0; // 필터 타입 None
    for (let b = 0; b < bytesPerRow; b++) {
      raw[r * (bytesPerRow + 1) + 1 + b] = ~bytes[r * bytesPerRow + b] & 0xff;
    }
  }

  const png = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [
      ...u32be(widthDots),
      ...u32be(heightDots),
      1, // bit depth
      0, // color type: grayscale
      0, // compression
      0, // filter
      0, // interlace
    ]),
    ...chunk('IDAT', zlibStored(raw)),
    ...chunk('IEND', []),
  ];

  return `data:image/png;base64,${toBase64(png)}`;
}
