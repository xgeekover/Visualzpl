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
      '^XA^FO40,40^GB400,200,2,B,0^FS^FO40,40^GFA,100,100,10,ABCD^FS^XZ',
    );
    expect(objects).toHaveLength(0);
    expect(warnings.join(' ')).toContain('^GB');
    expect(warnings.join(' ')).toContain('^GFA');
  });

  it('Code128 이외 바코드는 경고하고 객체를 만들지 않는다', () => {
    const { objects, warnings } = importZpl('^XA^FO40,40^B3N,N,80,Y,N^FDABC^FS^XZ');
    expect(objects).toHaveLength(0);
    expect(warnings.join(' ')).toContain('^B3');
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
