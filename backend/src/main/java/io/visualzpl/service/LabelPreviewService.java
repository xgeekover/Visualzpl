package io.visualzpl.service;

import io.visualzpl.api.dto.PreviewRequest;
import io.visualzpl.exception.InvalidZplException;
import io.visualzpl.exception.LabelaryUpstreamException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.Locale;
import java.util.Set;

/**
 * VisualZPL ↔ Labelary 프록시 서비스.
 *
 * 처리 흐름:
 *   (1) 입력 dpmm 검증 (6/8/12/24 만 허용)
 *   (2) mm → inch 환산하여 Labelary URL 경로 구성
 *   (3) WebClient 로 POST 호출, 응답을 PNG 바이트로 수신
 *   (4) 외부 응답 상태별로 도메인 예외로 변환
 *
 * Labelary API 명세 ─ 예시:
 *   POST http://api.labelary.com/v1/printers/8dpmm/labels/4x2/0/
 *        Content-Type: application/x-www-form-urlencoded
 *        Accept:       image/png
 *        Body:         (raw ZPL string)
 */
@Service
public class LabelPreviewService {

    private static final Logger log = LoggerFactory.getLogger(LabelPreviewService.class);

    /** Labelary 가 지원하는 dpmm 값 */
    private static final Set<Integer> SUPPORTED_DPMM = Set.of(6, 8, 12, 24);
    private static final double MM_PER_INCH = 25.4;

    private final WebClient labelary;
    private final Duration timeout;

    public LabelPreviewService(
            @Qualifier("labelaryWebClient") WebClient labelary,
            @Value("${labelary.timeout-seconds:10}") long timeoutSec) {
        this.labelary = labelary;
        this.timeout = Duration.ofSeconds(timeoutSec);
    }

    /**
     * 주어진 ZPL 문서를 Labelary 에 보내 PNG 바이트로 변환한다.
     *
     * @throws InvalidZplException        Labelary 가 4xx 로 응답한 경우 (ZPL 문법 오류 등)
     * @throws LabelaryUpstreamException  네트워크/5xx/타임아웃 등 통신 실패
     */
    public byte[] renderPng(PreviewRequest request) {
        // Capture start time so we can attribute end-to-end latency in the
        // success INFO line. Nano-time is monotonic and not affected by wall
        // clock adjustments.
        final long startedAtNanos = System.nanoTime();

        // DEBUG: emits the full request envelope. Disabled in production by
        // default (root INFO) — flip on by setting `visualzpl.log.level=DEBUG`.
        log.debug(
                "renderPng() received request: widthMm={} heightMm={} dpmm={} index={} zplLength={}",
                request.widthMm(),
                request.heightMm(),
                request.dpmmOrDefault(),
                request.indexOrDefault(),
                request.zpl().length()
        );

        int dpmm = request.dpmmOrDefault();
        if (!SUPPORTED_DPMM.contains(dpmm)) {
            // WARN: client-side mistake, recoverable from the client's
            // perspective (just retry with a supported dpmm).
            log.warn("Rejecting request with unsupported dpmm={} (supported={})",
                    dpmm, SUPPORTED_DPMM);
            throw new InvalidZplException(
                    "Unsupported dpmm: " + dpmm + " (supported: " + SUPPORTED_DPMM + ")");
        }

        String path = buildLabelaryPath(request);

        // INFO: every accepted render attempt — enough to reconstruct
        // request volume and average label size at log-aggregation time.
        log.info("Forwarding render to Labelary: path={} zplBytes={}",
                path, request.zpl().length());

        try {
            byte[] png = labelary.post()
                    .uri(path)
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .accept(MediaType.IMAGE_PNG)
                    .bodyValue(request.zpl())
                    .retrieve()
                    .onStatus(HttpStatusCode::is4xxClientError, resp ->
                            resp.bodyToMono(String.class)
                                    .defaultIfEmpty("Bad ZPL request")
                                    .map(body -> new InvalidZplException(
                                            "Labelary rejected ZPL (HTTP "
                                                    + resp.statusCode().value() + "): " + body)))
                    .onStatus(HttpStatusCode::is5xxServerError, resp ->
                            resp.bodyToMono(String.class)
                                    .defaultIfEmpty("Labelary internal error")
                                    .map(body -> new LabelaryUpstreamException(
                                            "Labelary HTTP "
                                                    + resp.statusCode().value() + ": " + body)))
                    .bodyToMono(byte[].class)
                    .switchIfEmpty(Mono.error(new LabelaryUpstreamException(
                            "Empty response from Labelary")))
                    .block(timeout);

            if (png == null || png.length == 0) {
                log.error("Labelary returned an empty body: path={}", path);
                throw new LabelaryUpstreamException("Empty PNG response from Labelary");
            }

            long elapsedMs = (System.nanoTime() - startedAtNanos) / 1_000_000L;
            log.info("Labelary render OK: path={} pngBytes={} elapsedMs={}",
                    path, png.length, elapsedMs);
            return png;

        } catch (InvalidZplException knownClient) {
            // Already logged as WARN at the gate above when caused by us;
            // here we cover the case where Labelary itself returned 4xx.
            log.warn("Labelary rejected ZPL for path={}: {}", path, knownClient.getMessage());
            throw knownClient;
        } catch (LabelaryUpstreamException knownUpstream) {
            // ERROR with full stack trace — passing the Throwable as the
            // last argument is the SLF4J idiom for stack-trace rendering.
            log.error("Labelary upstream failure for path={}: {}",
                    path, knownUpstream.getMessage(), knownUpstream);
            throw knownUpstream;
        } catch (WebClientRequestException connectivity) {
            // Network / DNS / TLS failure — Labelary unreachable.
            log.error("Cannot reach Labelary at path={}: {}",
                    path, connectivity.getMessage(), connectivity);
            throw new LabelaryUpstreamException(
                    "Cannot reach Labelary: " + connectivity.getMessage(), connectivity);
        } catch (IllegalStateException timeoutLike) {
            // .block(timeout) throws IllegalStateException on timeout.
            log.error("Labelary call timed out after {}s: path={}",
                    timeout.toSeconds(), path, timeoutLike);
            throw new LabelaryUpstreamException(
                    "Labelary call timed out after " + timeout.toSeconds() + "s", timeoutLike);
        } catch (Exception unexpected) {
            log.error("Unexpected error calling Labelary for path={}", path, unexpected);
            throw new LabelaryUpstreamException(
                    "Labelary call failed: " + unexpected.getMessage(), unexpected);
        }
    }

    /**
     * /v1/printers/{dpmm}dpmm/labels/{w}x{h}/{index}/ 형식의 경로를 만든다.
     *
     * 라벨 크기는 inch 단위로 소수점 3 자리까지 표기.
     * Locale.ROOT 를 명시해 환경에 따라 소수점 기호(',' vs '.')가 달라지는 것을 방지.
     */
    private String buildLabelaryPath(PreviewRequest req) {
        double widthIn = req.widthMm() / MM_PER_INCH;
        double heightIn = req.heightMm() / MM_PER_INCH;
        return String.format(
                Locale.ROOT,
                "/v1/printers/%ddpmm/labels/%.3fx%.3f/%d/",
                req.dpmmOrDefault(),
                widthIn,
                heightIn,
                req.indexOrDefault()
        );
    }
}
