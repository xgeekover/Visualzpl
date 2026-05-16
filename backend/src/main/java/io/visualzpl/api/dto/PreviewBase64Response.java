package io.visualzpl.api.dto;

/**
 * Base64 PNG 응답.
 *
 * @param imageBase64  Base64 로 인코딩된 PNG 이미지 데이터
 * @param mediaType    원본 미디어 타입 (항상 "image/png")
 */
public record PreviewBase64Response(
        String imageBase64,
        String mediaType
) {
}
