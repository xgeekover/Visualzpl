import { describe, expect, it } from 'vitest';
import { bitmapToPngDataUrl, decodeGfa } from './gfa';

/** 비트맵을 '#'(검정)/'.'(흰색) 격자로 그려 눈으로 비교할 수 있게 만든다. */
function render(d: { bytes: Uint8Array; bytesPerRow: number; heightDots: number }): string[] {
  const out: string[] = [];
  for (let r = 0; r < d.heightDots; r++) {
    let line = '';
    for (let b = 0; b < d.bytesPerRow; b++) {
      const byte = d.bytes[r * d.bytesPerRow + b];
      for (let bit = 7; bit >= 0; bit--) line += (byte >> bit) & 1 ? '#' : '.';
    }
    out.push(line);
  }
  return out;
}

describe('decodeGfa — ^GFA 비트맵 디코딩', () => {
  it('압축 없는 hex 를 그대로 읽는다', () => {
    // 2바이트/행 × 2행: FF00 / 00FF
    const d = decodeGfa('4,4,2,FF0000FF')!;
    expect(d.bytesPerRow).toBe(2);
    expect(d.widthDots).toBe(16);
    expect(d.heightDots).toBe(2);
    expect(render(d)).toEqual(['########........', '........########']);
  });

  it("','(줄 나머지 흰색)를 해석한다", () => {
    const d = decodeGfa('4,4,2,FF,00,')!;
    expect(render(d)).toEqual(['########........', '................']);
  });

  it("'!'(줄 나머지 검정)를 해석한다", () => {
    // '!' 가 줄을 끝내므로 뒤에 ',' 를 또 붙이지 않는다.
    const d = decodeGfa('4,4,2,00!FF,')!;
    expect(render(d)).toEqual(['........########', '########........']);
  });

  it("':'(앞 줄 반복)을 해석한다", () => {
    // F0F0 이 행을 정확히 채워 자동으로 끝나고, ':' 두 번이 그 행을 복제한다.
    const d = decodeGfa('6,6,2,F0F0::')!;
    const lines = render(d);
    expect(lines[0]).toBe('####....####....');
    expect(lines[1]).toBe(lines[0]);
    expect(lines[2]).toBe(lines[0]);
  });

  it('행마다 "," 를 줄 종결자로 붙이는 흔한 출력에서 빈 줄이 끼지 않는다', () => {
    // 많은 ZPL 생성기가 각 행 끝에 ',' 를 붙인다. 이걸 빈 행으로 세면
    // 이미지가 세로로 두 배가 되며 흰 줄이 끼어든다.
    const d = decodeGfa('6,6,2,FF00,00FF,F0F0,')!;
    expect(d.heightDots).toBe(3);
    expect(render(d)).toEqual([
      '########........',
      '........########',
      '####....####....',
    ]);
  });

  it('빈 줄은 ",," 로 표현된다 (종결자 + 빈 줄)', () => {
    const d = decodeGfa('6,6,2,FF00,,FF00,')!;
    expect(render(d)).toEqual([
      '########........',
      '................',
      '########........',
    ]);
  });

  it('반복 문자 G–Y(1–19회)를 해석한다', () => {
    // 'I' = 3회 → F 를 3번 = FFF, 그 뒤 0 하나 → 한 행(2바이트=4니블)
    const d = decodeGfa('2,2,2,IF0')!;
    expect(render(d)).toEqual(['############....']);
  });

  it('반복 문자 g–z(20회 단위)를 해석한다', () => {
    // 'g' = 20회 → 0 을 20니블. 행당 4니블이므로 5행이 흰색으로 채워진다.
    const d = decodeGfa('10,10,2,g0')!;
    expect(d.heightDots).toBe(5);
    expect(render(d).every(l => l === '................')).toBe(true);
  });

  it('반복 문자를 연달아 쓰면 합산된다 (hG = 40+1)', () => {
    const d = decodeGfa('82,82,2,hGF')!; // F 41니블
    // 41 니블 = 10행(40니블) + 1니블 → 11행째 첫 니블만 채워짐
    expect(d.heightDots).toBeGreaterThanOrEqual(10);
    expect(render(d)[0]).toBe('################');
  });

  it('행당 바이트 수가 없거나 잘못되면 null', () => {
    expect(decodeGfa('4,4,0,FF00')).toBeNull();
    expect(decodeGfa('쓰레기')).toBeNull();
  });

  it('선언된 총 바이트 수만큼만 행을 만든다', () => {
    // 데이터는 3행이지만 총 4바이트(=2행)로 선언 → 2행만
    const d = decodeGfa('4,4,2,FFFF0000FFFF')!;
    expect(d.heightDots).toBe(2);
  });
});

describe('bitmapToPngDataUrl — 순수 TS PNG 인코딩', () => {
  const decoded = decodeGfa('4,4,2,FF0000FF')!;

  it('PNG DataURL 을 만든다', () => {
    const url = bitmapToPngDataUrl(decoded);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('유효한 PNG 시그니처와 청크 구조를 가진다', () => {
    const b64 = bitmapToPngDataUrl(decoded).split(',')[1];
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    expect([...bin.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const text = String.fromCharCode(...bin);
    expect(text).toContain('IHDR');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');
  });

  it('IHDR 에 실제 크기와 1비트 그레이스케일이 기록된다', () => {
    const b64 = bitmapToPngDataUrl(decoded).split(',')[1];
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const view = new DataView(bin.buffer);
    expect(view.getUint32(16)).toBe(16); // width
    expect(view.getUint32(20)).toBe(2); // height
    expect(bin[24]).toBe(1); // bit depth
    expect(bin[25]).toBe(0); // color type: grayscale
  });

  it('큰 비트맵도 예외 없이 인코딩된다 (stored 블록 경계 넘김)', () => {
    const bytesPerRow = 100;
    const heightDots = 800; // 80,000 바이트 → 65535 블록 경계를 넘는다
    const bytes = new Uint8Array(bytesPerRow * heightDots).fill(0xa5);
    const url = bitmapToPngDataUrl({ bytes, bytesPerRow, widthDots: 800, heightDots });
    expect(url.length).toBeGreaterThan(1000);
    const bin = Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0));
    expect(String.fromCharCode(...bin.slice(-8, -4))).toBe('IEND');
  });
});
