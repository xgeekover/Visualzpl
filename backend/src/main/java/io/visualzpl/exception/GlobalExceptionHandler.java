package io.visualzpl.exception;

import io.visualzpl.api.dto.ApiErrorResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.stream.Collectors;

/**
 * 모든 컨트롤러에 공통 적용되는 예외 → HTTP 응답 매핑.
 *
 * 매핑 규칙:
 *   - 입력 검증 실패        → 400 VALIDATION_ERROR
 *   - InvalidZpl 예외       → 400 INVALID_ZPL
 *   - LabelaryUpstream 예외 → 502 LABELARY_UPSTREAM_ERROR
 *   - 기타 모든 예외         → 500 INTERNAL_ERROR (메시지는 노출하지 않음)
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiErrorResponse> handleValidation(MethodArgumentNotValidException ex) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .map(err -> err.getField() + ": " + err.getDefaultMessage())
                .collect(Collectors.joining(", "));
        log.debug("Validation error: {}", message);
        return ResponseEntity.badRequest()
                .body(new ApiErrorResponse(400, "VALIDATION_ERROR", message));
    }

    @ExceptionHandler(InvalidZplException.class)
    public ResponseEntity<ApiErrorResponse> handleInvalidZpl(InvalidZplException ex) {
        log.warn("Invalid ZPL request: {}", ex.getMessage());
        return ResponseEntity.badRequest()
                .body(new ApiErrorResponse(400, "INVALID_ZPL", ex.getMessage()));
    }

    @ExceptionHandler(LabelaryUpstreamException.class)
    public ResponseEntity<ApiErrorResponse> handleLabelaryUpstream(LabelaryUpstreamException ex) {
        log.error("Labelary upstream error", ex);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(new ApiErrorResponse(502, "LABELARY_UPSTREAM_ERROR", ex.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiErrorResponse> handleUnknown(Exception ex) {
        log.error("Unhandled exception", ex);
        return ResponseEntity.internalServerError()
                .body(new ApiErrorResponse(500, "INTERNAL_ERROR", "Internal server error"));
    }
}
