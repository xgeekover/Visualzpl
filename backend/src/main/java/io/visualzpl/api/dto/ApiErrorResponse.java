package io.visualzpl.api.dto;

/**
 * 표준 에러 응답 포맷.
 *
 * @param status   HTTP 상태 코드
 * @param code     클라이언트가 분기 처리할 수 있는 안정적 코드 (예: INVALID_ZPL)
 * @param message  사람이 읽을 수 있는 설명
 */
public record ApiErrorResponse(
        int status,
        String code,
        String message
) {
}
