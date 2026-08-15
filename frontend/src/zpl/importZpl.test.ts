import { describe, expect, it } from 'vitest';
import { importZpl } from './importZpl';
import { ZplBuilder } from '../ZplBuilder';
import type { LabelDocument } from '../types';

describe('importZpl — 붙여넣은 ZPL 을 편집 객체로 되돌린다', () => {
  it('^PW/^LL 로 선언된 라벨 크기를 mm 로 읽는다', () => {
    const result = importZpl('^XA^PW1200^LL800^XZ');
    expect(result.widthMm).toBe(150);
    expect(result.heightMm).toBe(100);
  });

  it('크기 선언이 없으면 null 을 돌려준다 (호출자가 기존 값을 유지하도록)', () => {
    const result = importZpl('^XA^FO40,40^A0N,32,0^FDhi^FS^XZ');
    expect(result.widthMm).toBeNull();
    expect(result.heightMm).toBeNull();
  });

  it('^FO + ^A + ^FD 를 텍스트 객체로 변환한다', () => {
    const { objects } = importZpl('^XA^FO40,80^A0N,32,0^FD상단 텍스트^FS^XZ');
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({
      type: 'text',
      x: 5,
      y: 10,
      fontHeight: 4,
      data: '상단 텍스트',
    });
  });

  it('^BY + ^BC 를 바코드 객체로 변환한다 (모듈 폭·해독 라인 포함)', () => {
    const { objects } = importZpl('^XA^BY3^FO40,120^BCN,96,N,N,N^FD9876543210^FS^XZ');
    expect(objects[0]).toMatchObject({
      type: 'barcode',
      x: 5,
      y: 15,
      height: 12,
      moduleWidth: 3,
      printInterpretationLine: false,
      data: '9876543210',
    });
  });

  it('^BQ 를 QR 객체로 변환하고 ^FD 의 "MA," 접두를 벗긴다', () => {
    const { objects } = importZpl('^XA^FO520,40^BQN,2,4,M,7^FDMA,https://visualzpl.io^FS^XZ');
    expect(objects[0]).toMatchObject({
      type: 'qrcode',
      magnification: 4,
      errorCorrection: 'M',
      data: 'https://visualzpl.io',
    });
  });

  it('회전(^A0R)을 보존한다', () => {
    const { objects } = importZpl('^XA^FO40,40^A0R,32,0^FD회전^FS^XZ');
    expect(objects[0]).toMatchObject({ type: 'text', rotation: 'R' });
  });

  it('여러 필드를 등장 순서대로 가져온다', () => {
    const { objects } = importZpl(
      '^XA^FO40,40^A0N,32,0^FDA^FS^FO40,120^A0N,32,0^FDB^FS^FO40,200^A0N,32,0^FDC^FS^XZ',
    );
    expect(objects.map(o => o.data)).toEqual(['A', 'B', 'C']);
    expect(new Set(objects.map(o => o.id)).size).toBe(3);
  });

  it('표현할 수 없는 명령은 조용히 버리지 않고 경고로 보고한다', () => {
    const { objects, warnings } = importZpl(
      '^XA^FO40,40^GFA,100,100,10,ABCD^FS^FO10,10^GE100,100,2,B^FS^XZ',
    );
    expect(objects).toHaveLength(0);
    expect(warnings.join(' ')).toContain('^GFA');
    expect(warnings.join(' ')).toContain('^GE');
  });

  it('Code128 이외 바코드는 경고하고 객체를 만들지 않는다', () => {
    const { objects, warnings } = importZpl('^XA^FO40,40^B3N,N,80,Y,N^FDABC^FS^XZ');
    expect(objects).toHaveLength(0);
    expect(warnings.join(' ')).toContain('^B3');
  });

  // ── 실무 ZPL 이 통째로 안 들어오던 원인들 (v0.1.6 수정) ──────────────
  it('^CF 로만 폰트를 지정한 텍스트도 가져온다 (^A 없음)', () => {
    const { objects } = importZpl(
      '^XA^CF0,30^FO50,50^FDHELLO^FS^FO50,100^FDWORLD^FS^XZ',
    );
    expect(objects.map(o => o.data)).toEqual(['HELLO', 'WORLD']);
    expect(objects[0]).toMatchObject({ type: 'text', fontHeight: 30 / 8 });
  });

  it('폰트 명령이 아예 없어도 기본 폰트 텍스트로 가져온다', () => {
    const { objects } = importZpl('^XA^FO50,50^FDPLAIN^FS^XZ');
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ type: 'text', data: 'PLAIN' });
  });

  it('^CF 는 이후 필드에만 적용되고 ^A 가 있으면 ^A 가 이긴다', () => {
    const { objects } = importZpl(
      '^XA^CF0,30^FO0,0^FDdefault^FS^FO0,50^A0N,64,0^FDexplicit^FS^FO0,100^FDback^FS^XZ',
    );
    expect(objects.map(o => (o as { fontHeight: number }).fontHeight)).toEqual([
      30 / 8,
      64 / 8,
      30 / 8,
    ]);
  });

  it('^GB 박스를 박스 객체로 가져온다', () => {
    const { objects, warnings } = importZpl('^XA^FO40,80^GB400,200,3,B,0^FS^XZ');
    expect(objects[0]).toMatchObject({
      type: 'box',
      x: 5,
      y: 10,
      widthMm: 50,
      heightMm: 25,
      thicknessDots: 3,
    });
    expect(warnings).toEqual([]);
  });

  it('^GB 가로선(높이 0)은 두께만큼의 얇은 박스가 된다', () => {
    const { objects } = importZpl('^XA^FO40,80^GB400,0,3^FS^XZ');
    expect(objects[0]).toMatchObject({ type: 'box', widthMm: 50, heightMm: 3 / 8 });
  });

  it('^FB 가 있어도 텍스트를 버리지 않는다 (줄바꿈 폭만 경고)', () => {
    const { objects, warnings } = importZpl(
      '^XA^FO50,50^A0N,30,0^FB400,3,0,L^FDwrapped text^FS^XZ',
    );
    expect(objects).toHaveLength(1);
    expect(objects[0].data).toBe('wrapped text');
    expect(warnings.join(' ')).toContain('^FB');
  });

  it('회귀: 지원하지 않는 바코드의 ^FD 가 텍스트로 둔갑하지 않는다', () => {
    // 기본 폰트 폴백이 'none' 과 'skip' 을 구분하지 못하면 바코드가 텍스트가 된다.
    const { objects } = importZpl('^XA^CF0,30^FO40,40^B3N,N,80,Y,N^FDABC^FS^XZ');
    expect(objects).toHaveLength(0);
  });

  it('실무 라벨(박스 + ^CF 텍스트 + 바코드)이 통째로 들어온다', () => {
    const { objects, warnings } = importZpl(`^XA
^PW800^LL400
^FO20,20^GB760,360,3^FS
^FO20,80^GB760,0,3^FS
^CF0,28
^FO40,35^FDPRODUCT LABEL^FS
^FO40,100^FDItem: ABC-123^FS
^BY2^FO40,200^BCN,80,Y,N,N^FD1234567890^FS
^XZ`);
    expect(objects.map(o => o.type)).toEqual([
      'box',
      'box',
      'text',
      'text',
      'barcode',
    ]);
    expect(warnings).toEqual([]);
  });

  it('깨진 입력에도 예외를 던지지 않는다', () => {
    expect(() => importZpl('')).not.toThrow();
    expect(() => importZpl('쓰레기 데이터 ^^^ ^FD^FS')).not.toThrow();
    expect(() => importZpl('^XA^FO^A0N^FD^FS^XZ')).not.toThrow();
  });
});

describe('importZpl ↔ ZplBuilder 왕복', () => {
  it('앱이 생성한 ZPL 은 좌표·데이터 손실 없이 되돌아온다', () => {
    const doc: LabelDocument = {
      unit: 'mm',
      dpmm: 8,
      widthMm: 100,
      heightMm: 50,
      objects: [
        { id: 'text-1', type: 'text', x: 5, y: 5, fontHeight: 4, data: 'Sample Text' },
        {
          id: 'barcode-2',
          type: 'barcode',
          x: 5,
          y: 15,
          height: 12,
          moduleWidth: 2,
          printInterpretationLine: true,
          data: '12345678',
        },
        {
          id: 'qr-3',
          type: 'qrcode',
          x: 65,
          y: 5,
          magnification: 4,
          errorCorrection: 'M',
          data: 'https://visualzpl.io',
        },
      ],
    };

    const zpl = new ZplBuilder(doc).build();
    const back = importZpl(zpl, 8);

    expect(back.widthMm).toBe(100);
    expect(back.heightMm).toBe(50);
    expect(back.warnings).toEqual([]);
    expect(back.objects).toHaveLength(3);
    expect(back.objects.map(o => [o.type, o.x, o.y, o.data])).toEqual([
      ['text', 5, 5, 'Sample Text'],
      ['barcode', 5, 15, '12345678'],
      ['qrcode', 65, 5, 'https://visualzpl.io'],
    ]);
  });
});
