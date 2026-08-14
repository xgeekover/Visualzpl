/**
 * ZPL → 편집 가능한 라벨 객체 임포터.
 *
 * 코드 패널에 붙여넣은 외부 ZPL 을 캔버스 객체로 되돌려, 붙여넣은 라벨도
 * 마우스로 편집할 수 있게 한다. `ZplBuilder` 가 만들어내는 명령 집합을 그대로
 * 역변환하므로 이 앱이 생성한 ZPL 은 손실 없이 왕복(round-trip)한다.
 *
 * **정직성 원칙**: 모델에 대응하는 객체가 없는 명령(^GB 박스, ^GFA 이미지 등)은
 * 조용히 버리지 않고 `warnings` 로 보고한다. 가져오기를 하면 그 명령들은
 * 사라지므로, 호출자는 반드시 사용자에게 경고를 보여줘야 한다.
 *
 * 좌표계: ZPL 은 dot, 편집 모델은 mm(=dot/dpmm).
 */

import type {
  BarcodeObject,
  LabelObject,
  QrCodeObject,
  QrErrorCorrection,
  TextObject,
  ZplRotation,
} from '../types';
import { readDeclaredSize } from './renderZpl';

export interface ImportZplResult {
  /** 파싱된 캔버스 객체들 (순서 = ZPL 등장 순서). */
  objects: LabelObject[];
  /** ^PW 로 선언된 라벨 너비(mm). 없으면 null. */
  widthMm: number | null;
  /** ^LL 로 선언된 라벨 길이(mm). 없으면 null. */
  heightMm: number | null;
  /** 가져오지 못한 명령/한계에 대한 사람이 읽는 경고. */
  warnings: string[];
}

/** 편집 모델에 대응하는 객체가 없어 가져올 수 없는 명령 → 사용자 안내 문구. */
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  GB: '박스/선(^GB)',
  GC: '원(^GC)',
  GD: '대각선(^GD)',
  GE: '타원(^GE)',
  GFA: '이미지(^GFA)',
  GFB: '이미지(^GFB)',
  GFC: '이미지(^GFC)',
  FB: '텍스트 블록 줄바꿈(^FB)',
};

/** 지원하는 바코드: 현재 모델은 Code128(^BC)만 표현할 수 있다. */
const IMPORTABLE_BARCODE = 'BC';

/** 편집 모델에 없어 경고 대상인 다른 바코드 심볼로지. */
const OTHER_BARCODES = ['B3', 'B2', 'BA', 'BE', 'B8', 'BU', 'BX', 'B7'];

const toInt = (s: string | undefined, d = 0): number => {
  const n = parseInt(String(s ?? '').trim(), 10);
  return Number.isFinite(n) ? n : d;
};

const asRotation = (c: string | undefined): ZplRotation =>
  c === 'R' || c === 'I' || c === 'B' ? c : 'N';

/** dot → mm. 소수점 3자리에서 반올림해 부동소수 잡음을 없앤다. */
const toMm = (dots: number, dpmm: number): number =>
  Math.round((dots / dpmm) * 1000) / 1000;

type Pending =
  | { kind: 'none' }
  | { kind: 'text'; rot: ZplRotation; heightDots: number; widthDots: number; font: string }
  | { kind: 'barcode'; rot: ZplRotation; heightDots: number; line: boolean; above: boolean }
  | { kind: 'qrcode'; rot: ZplRotation; model: 1 | 2; magnification: number; ec: QrErrorCorrection };

/**
 * ZPL 문자열을 캔버스 객체로 변환한다. 파싱 실패로 예외를 던지지 않는다 —
 * 이해하지 못한 부분은 경고로 남기고 나머지를 최대한 살린다.
 */
export function importZpl(zpl: string, dpmm = 8): ImportZplResult {
  const objects: LabelObject[] = [];
  const warningSet = new Set<string>();
  const declared = readDeclaredSize(zpl);

  // 필드 상태 — ^FO/^FT 로 원점을 잡고, ^A/^BC/^BQ 로 종류를 정한 뒤 ^FD 에서 확정된다.
  let ox = 0;
  let oy = 0;
  let byModule = 2;
  let pending: Pending = { kind: 'none' };
  let seq = 0;

  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  const commit = (data: string): void => {
    switch (pending.kind) {
      case 'text': {
        const obj: TextObject = {
          id: nextId('text'),
          type: 'text',
          x: toMm(ox, dpmm),
          y: toMm(oy, dpmm),
          fontHeight: toMm(pending.heightDots, dpmm),
          data,
        };
        if (pending.rot !== 'N') obj.rotation = pending.rot;
        if (pending.widthDots > 0) obj.fontWidth = toMm(pending.widthDots, dpmm);
        if (pending.font !== '0') obj.font = pending.font;
        objects.push(obj);
        break;
      }
      case 'barcode': {
        const obj: BarcodeObject = {
          id: nextId('barcode'),
          type: 'barcode',
          x: toMm(ox, dpmm),
          y: toMm(oy, dpmm),
          height: toMm(pending.heightDots, dpmm),
          moduleWidth: byModule,
          printInterpretationLine: pending.line,
          printAboveCode: pending.above,
          data,
        };
        if (pending.rot !== 'N') obj.rotation = pending.rot;
        objects.push(obj);
        break;
      }
      case 'qrcode': {
        // ^FD 페이로드는 "<EC><입력모드>,<실데이터>" 형식(예: "MA,https://…").
        const obj: QrCodeObject = {
          id: nextId('qr'),
          type: 'qrcode',
          x: toMm(ox, dpmm),
          y: toMm(oy, dpmm),
          magnification: pending.magnification,
          errorCorrection: pending.ec,
          model: pending.model,
          data: data.replace(/^[LMQH][A-Za-z0-9],/, ''),
        };
        if (pending.rot !== 'N') obj.rotation = pending.rot;
        objects.push(obj);
        break;
      }
      default:
        break;
    }
  };

  for (const raw of zpl.split('^')) {
    if (!raw) continue;
    const up2 = raw.slice(0, 2).toUpperCase();
    const up3 = raw.slice(0, 3).toUpperCase();

    if (UNSUPPORTED_COMMANDS[up3] || UNSUPPORTED_COMMANDS[up2]) {
      warningSet.add(UNSUPPORTED_COMMANDS[up3] ?? UNSUPPORTED_COMMANDS[up2]);
      continue;
    }

    if (up2 === 'FO' || up2 === 'FT') {
      const p = raw.slice(2).split(',');
      ox = toInt(p[0], 0);
      oy = toInt(p[1], 0);
      if (up2 === 'FT') {
        warningSet.add('^FT 기준선 좌표(미세한 세로 위치 차이가 있을 수 있음)');
      }
      continue;
    }

    if (up2 === 'FS') {
      pending = { kind: 'none' };
      continue;
    }

    if (up2 === 'FD') {
      commit(raw.slice(2));
      continue;
    }

    if (up2 === 'BY') {
      byModule = toInt(raw.slice(2).split(',')[0], byModule) || byModule;
      continue;
    }

    if (up2 === IMPORTABLE_BARCODE) {
      const p = raw.slice(2).split(',');
      pending = {
        kind: 'barcode',
        rot: asRotation(p[0]?.toUpperCase()),
        heightDots: toInt(p[1], 80) || 80,
        line: (p[2] ?? 'Y').toUpperCase() !== 'N',
        above: (p[3] ?? 'N').toUpperCase() === 'Y',
      };
      continue;
    }

    if (up2 === 'BQ') {
      const p = raw.slice(2).split(',');
      const ecRaw = (p[3] ?? 'M').toUpperCase();
      pending = {
        kind: 'qrcode',
        rot: asRotation(p[0]?.toUpperCase()),
        model: toInt(p[1], 2) === 1 ? 1 : 2,
        magnification: toInt(p[2], 4) || 4,
        ec: (['L', 'M', 'Q', 'H'].includes(ecRaw) ? ecRaw : 'M') as QrErrorCorrection,
      };
      continue;
    }

    if (OTHER_BARCODES.includes(up2)) {
      warningSet.add(`Code128 이외 바코드(^${up2})`);
      pending = { kind: 'none' };
      continue;
    }

    if (raw[0]?.toUpperCase() === 'A' && raw.length > 1) {
      // ^A<font><rot>,<height>,<width>  (예: A0N,32,0)
      const body = raw.slice(1);
      const font = body[0] ?? '0';
      let idx = 1;
      let rot: ZplRotation = 'N';
      const rc = body[idx]?.toUpperCase();
      if (rc === 'N' || rc === 'R' || rc === 'I' || rc === 'B') {
        rot = rc;
        idx += 1;
      }
      const p = body.slice(idx).replace(/^,/, '').split(',');
      pending = {
        kind: 'text',
        rot,
        heightDots: toInt(p[0], 30) || 30,
        widthDots: toInt(p[1], 0),
        font,
      };
      continue;
    }
    // 그 밖의 명령(^XA ^XZ ^CI ^PW ^LL 등)은 레이아웃/제어라 객체를 만들지 않는다.
  }

  return {
    objects,
    widthMm: declared.widthDots != null ? toMm(declared.widthDots, dpmm) : null,
    heightMm: declared.heightDots != null ? toMm(declared.heightDots, dpmm) : null,
    warnings: [...warningSet],
  };
}
