package io.visualzpl.api.dto;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/**
 * 라벨 미리보기 요청 DTO.
 *
 * 프론트엔드는 ZplBuilder.build() 의 결과 문자열과 라벨 메타데이터를 묶어 보낸다.
 *
 * @param zpl       ^XA ... ^XZ 로 둘러싸인 ZPL II 문자열
 * @param widthMm   라벨 가로 (mm)
 * @param heightMm  라벨 세로 (mm)
 * @param dpmm      도트 밀도 (Labelary 지원: 6, 8, 12, 24). null 이면 8.
 * @param index     멀티 라벨 ZPL 에서 렌더링할 라벨 인덱스. null 이면 0.
 */
public record PreviewRequest(

        @NotBlank(message = "zpl must not be blank")
        String zpl,

        @NotNull(message = "widthMm is required")
        @DecimalMin(value = "1.0", message = "widthMm must be >= 1.0")
        Double widthMm,

        @NotNull(message = "heightMm is required")
        @DecimalMin(value = "1.0", message = "heightMm must be >= 1.0")
        Double heightMm,

        @Min(value = 6, message = "dpmm must be one of 6, 8, 12, 24")
        @Max(value = 24, message = "dpmm must be one of 6, 8, 12, 24")
        Integer dpmm,

        @Min(value = 0, message = "index must be >= 0")
        Integer index
) {
    public int dpmmOrDefault() {
        return dpmm != null ? dpmm : 8;
    }

    public int indexOrDefault() {
        return index != null ? index : 0;
    }
}
