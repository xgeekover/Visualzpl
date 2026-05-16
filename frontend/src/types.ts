/**
 * VisualZPL - 라벨 데이터 모델
 *
 * 203 DPI(=8 dots/mm) 산업용 라벨 프린터를 기준으로 한다.
 * 사용자는 mm 단위로 좌표를 입력하고, 내부적으로 ZplBuilder가 dot 단위로
 * 환산해 ZPL 문자열을 만든다.
 */

/** 203 DPI 기준 1mm ≈ 8 dots. (정확히는 7.9921 dots/mm) */
export const DEFAULT_DPMM = 8;

/** 좌표/크기 입력 단위 */
export type LabelUnit = 'mm' | 'dot';

/**
 * ZPL 필드 회전 코드
 *  N = 0°, R = 90°(시계방향), I = 180°, B = 270°
 */
export type ZplRotation = 'N' | 'R' | 'I' | 'B';

/** QR 에러 정정 레벨 (복원율 L<M<Q<H) */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

/** 모든 라벨 객체가 공유하는 공통 필드 */
interface BaseLabelObject {
  /** 도면 내 고유 식별자 (편집기에서 사용) */
  id: string;
  /** 객체 타입 디스크리미네이터 */
  type: 'text' | 'barcode' | 'qrcode' | 'image';
  /** 좌상단 X 좌표 (LabelDocument.unit 단위) */
  x: number;
  /** 좌상단 Y 좌표 (LabelDocument.unit 단위) */
  y: number;
  /** 회전 (기본 'N') */
  rotation?: ZplRotation;
  /** 인쇄될 실제 문자열 / 바코드 값 / 이미지 표시명(파일명) */
  data: string;
}

/** 텍스트 객체 */
export interface TextObject extends BaseLabelObject {
  type: 'text';
  /** 글자 높이 (LabelDocument.unit 단위) */
  fontHeight: number;
  /** 글자 폭. 0 또는 미지정 시 폭은 높이에 비례 자동 결정 */
  fontWidth?: number;
  /** ZPL 폰트 코드. 기본 '0'(스케일러블 폰트) */
  font?: string;
}

/** Code 128 바코드 객체 */
export interface BarcodeObject extends BaseLabelObject {
  type: 'barcode';
  /** 바코드 높이 (LabelDocument.unit 단위) */
  height: number;
  /** 1 모듈(가장 가는 막대) 너비. dot 단위. 기본 2 */
  moduleWidth?: number;
  /** 해독 라인(사람이 읽는 숫자) 인쇄 여부. 기본 true */
  printInterpretationLine?: boolean;
  /** 해독 라인을 바코드 위에 둘지 여부. 기본 false (아래) */
  printAboveCode?: boolean;
}

/** QR 코드 객체 */
export interface QrCodeObject extends BaseLabelObject {
  type: 'qrcode';
  /** 셀 배율(1~10). 기본 5 */
  magnification?: number;
  /** 에러 정정 레벨. 기본 'M' */
  errorCorrection?: QrErrorCorrection;
  /** QR 모델 (1 = 구버전, 2 = 표준). 기본 2 */
  model?: 1 | 2;
}

/** Precomputed ZPL Graphic Field payload, cached on an ImageObject. */
export interface ImageEncodedPayload {
  /** Cache key derived from sourceDataUrl + widthMm + heightMm + threshold + dpmm. */
  key: string;
  /** ASCII hex string used as the ^GFA data block. */
  hexData: string;
  /** Bytes per row (each row is padded so width % 8 === 0). */
  bytesPerRow: number;
  /** Total bytes of the bitmap. */
  totalBytes: number;
  /** Effective rendered width in dots (== bytesPerRow * 8). */
  widthDots: number;
  /** Rendered height in dots. */
  heightDots: number;
}

/**
 * Bitmap image object — compiled into ZPL ^GFA (Graphic Field, ASCII hex).
 *
 * Encoding is asynchronous, so it is computed by an effect in the editor and
 * cached on `encoded`. ZplBuilder reads `encoded` directly and remains sync.
 */
export interface ImageObject extends BaseLabelObject {
  type: 'image';
  /** Original PNG/JPEG payload as a DataURL — used by both fabric and the encoder. */
  sourceDataUrl: string;
  /** Print width in mm. */
  widthMm: number;
  /** Print height in mm. */
  heightMm: number;
  /** Luminance threshold 0-255 (pixels darker than this become black). Default 128. */
  threshold?: number;
  /** Lazy-populated ZPL payload — undefined until the encoder finishes. */
  encoded?: ImageEncodedPayload;
}

/** 변환 엔진 입력의 객체 합타입 */
export type LabelObject =
  | TextObject
  | BarcodeObject
  | QrCodeObject
  | ImageObject;

/** 한 장의 라벨 문서를 표현하는 최상위 타입 */
export interface LabelDocument {
  /** 좌표/크기 입력 단위 */
  unit: LabelUnit;
  /** mm → dot 환산 계수. 기본 8 (203 DPI) */
  dpmm?: number;
  /** 라벨 너비 (mm). 지정 시 ^PW 명령으로 출력 */
  widthMm?: number;
  /** 라벨 길이 (mm). 지정 시 ^LL 명령으로 출력 */
  heightMm?: number;
  /** 캔버스에 배치된 객체들 */
  objects: LabelObject[];
}
