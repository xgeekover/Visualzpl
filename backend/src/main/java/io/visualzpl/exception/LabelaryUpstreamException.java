package io.visualzpl.exception;

/**
 * Labelary 외부 API 와의 통신 자체가 실패한 경우 발생.
 *
 * - 네트워크 단절
 * - DNS 실패
 * - 5xx 응답
 * - 타임아웃
 *
 * 클라이언트에게는 502 Bad Gateway 로 매핑되어 노출된다.
 */
public class LabelaryUpstreamException extends RuntimeException {

    public LabelaryUpstreamException(String message) {
        super(message);
    }

    public LabelaryUpstreamException(String message, Throwable cause) {
        super(message, cause);
    }
}
