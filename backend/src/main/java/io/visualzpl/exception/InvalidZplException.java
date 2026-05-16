package io.visualzpl.exception;

/**
 * 클라이언트 책임의 4xx 에러를 표현한다.
 *
 * - 잘못된 ZPL 문법(Labelary 가 400 으로 응답한 경우)
 * - 지원하지 않는 dpmm 값
 * - 라벨 사이즈 범위 초과 등
 */
public class InvalidZplException extends RuntimeException {

    public InvalidZplException(String message) {
        super(message);
    }

    public InvalidZplException(String message, Throwable cause) {
        super(message, cause);
    }
}
