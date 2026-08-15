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
  BoxObject,
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
  GC: '원(^GC)',
  GD: '대각선(^GD)',
  GE: '타원(^GE)',
  GFA: '이미지(^GFA)',
  GFB: '이미지(^GFB)',
  GFC: '이미지(^GFC)',
};

/** ^A/^CF 가 하나도 없을 때 쓰는 글자 높이(dot). 프린터 기본 폰트에 준한다. */
const DEFAULT_FONT_HEIGHT_DOTS = 30;

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

interface TextStyle {
  rot: ZplRotation;
  heightDots: number;
  widthDots: number;
  font: string;
}

type Pending =
  /** 필드 종류가 아직 선언되지 않음 → ^FD 가 오면 기본 폰트 텍스트로 본다. */
  | { kind: 'none' }
  /**
   * 종류는 선언됐지만 편집 모델로 표현할 수 없음(Code128 외 바코드 등).
   * 'none' 과 반드시 구분해야 한다 — 그러지 않으면 기본 폰트 폴백이 끼어들어
   * 바코드가 텍스트로 둔갑한다.
   */
  | { kind: 'skip' }
  | ({ kind: 'text' } & TextStyle)
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
  // ^CF 로 지정하는 기본 폰트. 필드마다 ^A 를 쓰지 않는 ZPL 이 매우 흔하므로,
  // ^A 가 없으면 이 값(그것도 없으면 프린터 기본값)으로 텍스트를 만든다.
  // 이것이 없으면 ^CF 만 쓰는 라벨의 모든 텍스트가 통째로 사라진다.
  let defaultFont: TextStyle = {
    rot: 'N',
    heightDots: DEFAULT_FONT_HEIGHT_DOTS,
    widthDots: 0,
    font: '0',
  };

  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  const commit = (data: string): void => {
    // ^A 없이 ^FD 만 있는 필드는 ^CF(또는 프린터 기본) 폰트를 쓰는 텍스트다.
    const effective: Pending =
      pending.kind === 'none' ? { kind: 'text', ...defaultFont } : pending;

    switch (effective.kind) {
      case 'text': {
        const obj: TextObject = {
          id: nextId('text'),
          type: 'text',
          x: toMm(ox, dpmm),
          y: toMm(oy, dpmm),
          fontHeight: toMm(effective.heightDots, dpmm),
          data,
        };
        if (effective.rot !== 'N') obj.rotation = effective.rot;
        if (effective.widthDots > 0) obj.fontWidth = toMm(effective.widthDots, dpmm);
        if (effective.font !== '0') obj.font = effective.font;
        objects.push(obj);
        break;
      }
      case 'barcode': {
        const obj: BarcodeObject = {
          id: nextId('barcode'),
          type: 'barcode',
          x: toMm(ox, dpmm),
          y: toMm(oy, dpmm),
          height: toMm(effective.heightDots, dpmm),
          moduleWidth: byModule,
          printInterpretationLine: effective.line,
          printAboveCode: effective.above,
          data,
        };
        if (effective.rot !== 'N') obj.rotation = effective.rot;
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
          magnification: effective.magnification,
          errorCorrection: effective.ec,
          model: effective.model,
          data: data.replace(/^[LMQH][A-Za-z0-9],/, ''),
        };
        if (effective.rot !== 'N') obj.rotation = effective.rot;
        objects.push(obj);
        break;
      }
      default:
        break;
    }
  };

  /** ^GB<w>,<h>,<t>,<color>,<rounding> → 박스/선 객체. */
  const commitBox = (rest: string): void => {
    const p = rest.split(',');
    const widthDots = toInt(p[0], 0);
    const heightDots = toInt(p[1], 0);
    const thickness = Math.max(1, toInt(p[2], 1));
    // ZPL 은 폭/높이가 두께보다 작으면 두께로 채운다 — 가로/세로 직선이 이 형태다.
    const obj: BoxObject = {
      id: nextId('box'),
      type: 'box',
      x: toMm(ox, dpmm),
      y: toMm(oy, dpmm),
      widthMm: toMm(Math.max(widthDots, thickness), dpmm),
      heightMm: toMm(Math.max(heightDots, thickness), dpmm),
      thicknessDots: thickness,
      data: '',
    };
    objects.push(obj);
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

    if (up2 === 'GB') {
      commitBox(raw.slice(2));
      continue;
    }

    if (up2 === 'CF') {
      // ^CF<font>,<height>,<width> — 이후 필드의 기본 폰트를 바꾼다.
      const body = raw.slice(2);
      const p = body.split(',');
      const font = (p[0] ?? '').trim();
      defaultFont = {
        rot: 'N',
        heightDots: toInt(p[1], defaultFont.heightDots) || defaultFont.heightDots,
        widthDots: toInt(p[2], 0),
        font: font || defaultFont.font,
      };
      continue;
    }

    if (up2 === 'FB') {
      // 텍스트 블록. 모델에 줄바꿈 폭 개념이 없어 한 줄로 들어오지만,
      // 텍스트 자체는 살린다(예전엔 여기서 경고만 남기고 넘어갔다).
      warningSet.add('^FB 자동 줄바꿈(텍스트는 가져오되 줄바꿈 폭은 유지되지 않음)');
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
      // 'none' 이 아니라 'skip' — 뒤따르는 ^FD 가 텍스트로 잘못 들어오면 안 된다.
      pending = { kind: 'skip' };
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
