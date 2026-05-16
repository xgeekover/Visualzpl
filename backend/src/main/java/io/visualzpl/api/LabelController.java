package io.visualzpl.api;

import io.visualzpl.api.dto.PreviewBase64Response;
import io.visualzpl.api.dto.PreviewRequest;
import io.visualzpl.service.LabelPreviewService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Base64;

/**
 * 라벨 미리보기 REST 엔드포인트.
 *
 *   POST /api/label/preview          — image/png (바이너리)
 *   POST /api/label/preview/base64   — application/json (Base64 인코딩)
 *
 * 어느 쪽이든 동일한 PreviewRequest 본문을 받는다.
 */
@RestController
@RequestMapping("/api/label")
public class LabelController {

    private final LabelPreviewService previewService;

    public LabelController(LabelPreviewService previewService) {
        this.previewService = previewService;
    }

    /**
     * Labelary 가 돌려준 PNG 를 바이너리 그대로 반환한다.
     *
     * 프론트에서 사용 예:
     *   const res = await fetch('/api/label/preview', { method: 'POST',
     *       headers: { 'Content-Type': 'application/json' },
     *       body: JSON.stringify({ zpl, widthMm: 100, heightMm: 50, dpmm: 8 }) });
     *   const blob = await res.blob();
     *   imageEl.src = URL.createObjectURL(blob);
     */
    @PostMapping(
            value = "/preview",
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.IMAGE_PNG_VALUE
    )
    public ResponseEntity<byte[]> previewPng(@Valid @RequestBody PreviewRequest request) {
        byte[] png = previewService.renderPng(request);
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.noStore())
                .body(png);
    }

    /**
     * 동일한 PNG 를 Base64 로 감싸 JSON 으로 반환한다.
     * <img src="data:image/png;base64,..."/> 형태로 바로 쓸 때 편리하다.
     */
    @PostMapping(
            value = "/preview/base64",
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE
    )
    public PreviewBase64Response previewBase64(@Valid @RequestBody PreviewRequest request) {
        byte[] png = previewService.renderPng(request);
        String encoded = Base64.getEncoder().encodeToString(png);
        return new PreviewBase64Response(encoded, MediaType.IMAGE_PNG_VALUE);
    }
}
