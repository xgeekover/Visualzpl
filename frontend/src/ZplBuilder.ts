/**
 * ZplBuilder
 *
 * LabelDocument(JSON) -> ZPL II 문자열 변환 엔진.
 *
 * ZPL 핵심 명령어 요약:
 *   ^XA   라벨 포맷 시작 (Start Format)
 *   ^XZ   라벨 포맷 종료 (End Format)
 *   ^CI   문자 인코딩 (28 = UTF-8)
 *   ^PW   프린트 너비 (Print Width, dot)
 *   ^LL   라벨 길이 (Label Length, dot)
 *   ^FO   필드 원점 (Field Origin) — 좌상단 x,y
 *   ^A    스케일러블/비트맵 폰트 선택 — ^A<font><rot>,<height>,<width>
 *   ^BY   바코드 기본값 — 모듈 폭, 비율, 높이
 *   ^BC   Code 128 바코드 — ^BC<rot>,<h>,<line>,<above>,<check>
 *   ^BQ   QR 코드     — ^BQ<rot>,<model>,<mag>,<ec>,<mask>
 *   ^FD   필드 데이터 (Field Data)
 *   ^FS   필드 종료 (Field Separator)
 */

import {
  BarcodeObject,
  DEFAULT_DPMM,
  ImageObject,
  LabelDocument,
  LabelObject,
  LabelUnit,
  QrCodeObject,
  TextObject,
} from './types';

export class ZplBuilder {
  private readonly dpmm: number;
  private readonly unit: LabelUnit;

  constructor(private readonly document: LabelDocument) {
    this.dpmm = document.dpmm ?? DEFAULT_DPMM;
    this.unit = document.unit;
  }

  /** 문서를 ZPL 문자열로 직렬화한다. */
  build(): string {
    const lines: string[] = [];

    // ^XA : 라벨 포맷 시작
    lines.push('^XA');

    // ^CI28 : 한글/UTF-8 입력을 그대로 처리하도록 인코딩을 UTF-8 로 지정
    lines.push('^CI28');

    // ^PW : 라벨 너비를 dot 단위로 지정 (mm 가 주어진 경우에만 출력)
    if (this.document.widthMm !== undefined) {
      lines.push(`^PW${this.mmToDot(this.document.widthMm)}`);
    }

    // ^LL : 라벨 길이(세로)를 dot 단위로 지정
    if (this.document.heightMm !== undefined) {
      lines.push(`^LL${this.mmToDot(this.document.heightMm)}`);
    }

    // 각 객체를 ZPL 라인으로 변환. 이미지가 아직 인코딩되지 않은 경우는
    // 빈 문자열을 반환하므로 출력에서 건너뛴다.
    for (const obj of this.document.objects) {
      const rendered = this.renderObject(obj);
      if (rendered) lines.push(rendered);
    }

    // ^XZ : 라벨 포맷 종료
    lines.push('^XZ');

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 객체별 렌더링
  // ──────────────────────────────────────────────────────────────────────────

  private renderObject(obj: LabelObject): string {
    switch (obj.type) {
      case 'text':
        return this.renderText(obj);
      case 'barcode':
        return this.renderBarcode(obj);
      case 'qrcode':
        return this.renderQrCode(obj);
      case 'image':
        return this.renderImage(obj);
    }
  }

  /**
   * 텍스트 객체 → ^FO ... ^A0 ... ^FD ... ^FS
   *
   * 예) "Hello" 높이 32dot, 폭 자동:
   *   ^FO40,40^A0N,32,0^FDHello^FS
   */
  private renderText(obj: TextObject): string {
    const x = this.toDot(obj.x);
    const y = this.toDot(obj.y);
    const height = this.toDot(obj.fontHeight);
    const width = obj.fontWidth !== undefined ? this.toDot(obj.fontWidth) : 0;
    const font = obj.font ?? '0';
    const rotation = obj.rotation ?? 'N';

    return [
      // ^FO : 좌상단 시작 좌표를 dot 단위로 지정
      `^FO${x},${y}`,
      // ^A<font><rot>,<h>,<w> : 폰트/회전/높이/폭 지정. font='0'은 내장 스케일러블
      `^A${font}${rotation},${height},${width}`,
      // ^FD : 실제 인쇄될 문자열
      `^FD${this.escapeFieldData(obj.data)}`,
      // ^FS : 필드 종료 (다음 필드로 이동)
      '^FS',
    ].join('');
  }

  /**
   * Code 128 바코드 객체 → ^BY ... ^FO ... ^BC ... ^FD ... ^FS
   *
   * 예) "ABC-12345" 높이 80dot:
   *   ^BY2^FO40,120^BCN,80,Y,N,N^FDABC-12345^FS
   */
  private renderBarcode(obj: BarcodeObject): string {
    const x = this.toDot(obj.x);
    const y = this.toDot(obj.y);
    const height = this.toDot(obj.height);
    const moduleWidth = obj.moduleWidth ?? 2;
    const rotation = obj.rotation ?? 'N';
    const printLine = (obj.printInterpretationLine ?? true) ? 'Y' : 'N';
    const printAbove = (obj.printAboveCode ?? false) ? 'Y' : 'N';

    return [
      // ^BY : 바코드 기본값. 첫 번째 인자 = 1모듈 폭(dot). 비율/높이는 기본값 사용
      `^BY${moduleWidth}`,
      // ^FO : 바코드 좌상단 좌표
      `^FO${x},${y}`,
      // ^BC : Code 128
      //   ${rotation} : 회전
      //   ${height}   : 바코드 높이(dot)
      //   ${printLine}: 사람이 읽는 해독 라인 표시 여부
      //   ${printAbove}: 해독 라인을 바코드 위에 표시할지
      //   N           : UCC 체크 디짓 비활성화 (Code128 자체 체크섬은 자동)
      `^BC${rotation},${height},${printLine},${printAbove},N`,
      // ^FD : 바코드로 인코딩할 데이터
      `^FD${this.escapeFieldData(obj.data)}`,
      // ^FS : 필드 종료
      '^FS',
    ].join('');
  }

  /**
   * QR 코드 객체 → ^FO ... ^BQ ... ^FD ... ^FS
   *
   * 예) "https://..." 모델2, 배율4, EC=M:
   *   ^FO40,240^BQN,2,4,M,7^FDMA,https://...^FS
   *
   * ^FD 데이터는 "<EC><Mode>,<payload>" 형식이며,
   *   <EC>   : L|M|Q|H
   *   <Mode> : 'A' (자동 모드, 영문/숫자/바이너리 자동 판별)
   */
  private renderQrCode(obj: QrCodeObject): string {
    const x = this.toDot(obj.x);
    const y = this.toDot(obj.y);
    const model = obj.model ?? 2;
    const magnification = this.clamp(obj.magnification ?? 5, 1, 10);
    const ec = obj.errorCorrection ?? 'M';
    const rotation = obj.rotation ?? 'N';

    return [
      // ^FO : QR 코드 좌상단 좌표
      `^FO${x},${y}`,
      // ^BQ : QR 코드
      //   ${rotation}      : 회전 (대부분의 펌웨어는 N만 지원)
      //   ${model}         : 1=구버전, 2=표준
      //   ${magnification} : 셀 배율 (1~10)
      //   ${ec}            : 에러 정정 레벨
      //   7                : 마스크 값 기본(7)
      `^BQ${rotation},${model},${magnification},${ec},7`,
      // ^FD : "<EC>A,<payload>" — 'A'는 자동 인코딩 모드
      `^FD${ec}A,${this.escapeFieldData(obj.data)}`,
      // ^FS : 필드 종료
      '^FS',
    ].join('');
  }

  /**
   * Image object → ^FO ... ^GFA ... ^FS
   *
   * The 1-bit hex payload is precomputed by the editor (see ImageToZpl.ts)
   * and cached on `obj.encoded`. If the encoding has not finished yet we
   * emit nothing — the build() loop drops empty lines so the rest of the
   * label still renders.
   *
   *   ^GFA,<totalBytes>,<totalBytes>,<bytesPerRow>,<hex>
   *     A           : ASCII hex format
   *     totalBytes  : bytes transmitted == bytes in the bitmap (uncompressed)
   *     bytesPerRow : width in bytes (each row is padded to a multiple of 8 px)
   */
  private renderImage(obj: ImageObject): string {
    if (!obj.encoded) return '';
    const x = this.toDot(obj.x);
    const y = this.toDot(obj.y);
    const { hexData, bytesPerRow, totalBytes } = obj.encoded;
    return [
      // ^FO : top-left field origin
      `^FO${x},${y}`,
      // ^GFA : Graphic Field, ASCII hex
      `^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hexData}`,
      // ^FS : field separator
      '^FS',
    ].join('');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 유틸
  // ──────────────────────────────────────────────────────────────────────────

  /** 문서가 선언한 단위(mm 또는 dot)에서 dot 정수값으로 변환 */
  private toDot(value: number): number {
    return this.unit === 'dot' ? Math.round(value) : this.mmToDot(value);
  }

  private mmToDot(mm: number): number {
    return Math.round(mm * this.dpmm);
  }

  private clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
  }

  /**
   * ZPL 의 제어 문자(^ ~)가 ^FD 데이터에 들어가면 파서가 명령으로 오인한다.
   * 안전을 위해 공백으로 치환. (필요 시 ^FH 헥사 이스케이프로 확장 가능)
   */
  private escapeFieldData(text: string): string {
    return text.replace(/[\^~]/g, ' ');
  }
}
