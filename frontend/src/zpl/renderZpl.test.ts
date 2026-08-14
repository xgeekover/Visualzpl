import { describe, expect, it } from 'vitest';
import { readDeclaredSize } from './renderZpl';

describe('readDeclaredSize — ZPL 이 스스로 선언한 라벨 크기', () => {
  it('^PW/^LL 을 dot 으로 읽는다', () => {
    expect(readDeclaredSize('^XA^PW1200^LL800^XZ')).toEqual({
      widthDots: 1200,
      heightDots: 800,
    });
  });

  it('선언이 없으면 null (호출자가 편집기 크기로 폴백)', () => {
    expect(readDeclaredSize('^XA^FO0,0^FDhi^FS^XZ')).toEqual({
      widthDots: null,
      heightDots: null,
    });
  });

  it('한쪽만 선언돼도 그쪽만 읽는다', () => {
    expect(readDeclaredSize('^XA^PW1200^XZ')).toEqual({
      widthDots: 1200,
      heightDots: null,
    });
  });

  it('중복 선언은 마지막 값이 이긴다 (프린터 동작과 동일)', () => {
    expect(readDeclaredSize('^XA^PW800^LL400^PW1200^LL800^XZ')).toEqual({
      widthDots: 1200,
      heightDots: 800,
    });
  });

  it('0 이나 음수 같은 무의미한 값은 무시한다', () => {
    expect(readDeclaredSize('^XA^PW0^LL-5^XZ')).toEqual({
      widthDots: null,
      heightDots: null,
    });
  });

  it('소문자 명령도 인식한다', () => {
    expect(readDeclaredSize('^xa^pw1200^ll800^xz')).toEqual({
      widthDots: 1200,
      heightDots: 800,
    });
  });
});
