package io.visualzpl.service;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import io.visualzpl.api.dto.PreviewRequest;
import io.visualzpl.exception.InvalidZplException;
import io.visualzpl.exception.LabelaryUpstreamException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Integration test for LabelPreviewService.
 *
 * Strategy:
 *   - Spin up a WireMock server on a random port (no real Labelary calls).
 *   - Override `labelary.base-url` via @DynamicPropertySource so the
 *     WebClient bean wired by WebClientConfig hits WireMock instead.
 *   - Tighten `labelary.timeout-seconds` so the timeout test runs quickly.
 *
 * Each test stubs a specific upstream behavior (200 / 4xx / 5xx / slow)
 * and asserts that the service either returns the expected payload or
 * translates the failure into the right domain exception.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class LabelPreviewServiceTest {

    @RegisterExtension
    static WireMockExtension labelary = WireMockExtension.newInstance()
            .options(wireMockConfig().dynamicPort())
            .build();

    @DynamicPropertySource
    static void overrideLabelaryProperties(DynamicPropertyRegistry registry) {
        // Redirect the WebClient at the in-process WireMock server.
        registry.add("labelary.base-url", labelary::baseUrl);
        // Shrink the timeout so the "request times out" test does not slow
        // the suite. Two seconds is comfortably above WireMock startup.
        registry.add("labelary.timeout-seconds", () -> "2");
    }

    @Autowired
    LabelPreviewService labelPreviewService;

    /** Minimal but recognizable PNG magic bytes for byte-equality checks. */
    private static final byte[] FAKE_PNG_BYTES = new byte[]{
            (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'
    };

    private static PreviewRequest validRequest() {
        return new PreviewRequest(
                "^XA^FO40,40^A0N,32,0^FDHello^FS^XZ",
                100.0, 50.0, 8, 0
        );
    }

    // ──────────────────────────────────────────────────────────────────
    // Happy path
    // ──────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("200 OK from Labelary → PNG bytes returned verbatim")
    void rendersPngOnSuccessfulUpstream() {
        labelary.stubFor(post(urlPathMatching("/v1/printers/8dpmm/labels/.*/0/"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "image/png")
                        .withBody(FAKE_PNG_BYTES)));

        byte[] result = labelPreviewService.renderPng(validRequest());

        assertNotNull(result, "PNG bytes must not be null on success");
        assertArrayEquals(FAKE_PNG_BYTES, result,
                "Service should pass upstream bytes through unchanged");
    }

    // ──────────────────────────────────────────────────────────────────
    // Upstream failures
    // ──────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("503 from Labelary → LabelaryUpstreamException with HTTP code")
    void translatesUpstream503IntoUpstreamException() {
        labelary.stubFor(post(urlPathMatching("/v1/printers/.*"))
                .willReturn(aResponse()
                        .withStatus(503)
                        .withBody("Labelary is overloaded")));

        LabelaryUpstreamException ex = assertThrows(
                LabelaryUpstreamException.class,
                () -> labelPreviewService.renderPng(validRequest())
        );
        assertTrue(ex.getMessage().contains("503"),
                "Exception message should reference the upstream HTTP code");
    }

    @Test
    @DisplayName("400 from Labelary → InvalidZplException")
    void translatesUpstream400IntoInvalidZpl() {
        labelary.stubFor(post(urlPathMatching("/v1/printers/.*"))
                .willReturn(aResponse()
                        .withStatus(400)
                        .withBody("Bad ZPL: missing ^XZ")));

        InvalidZplException ex = assertThrows(
                InvalidZplException.class,
                () -> labelPreviewService.renderPng(validRequest())
        );
        assertTrue(ex.getMessage().contains("400"),
                "Exception message should reference the upstream HTTP code");
    }

    @Test
    @DisplayName("Upstream stall longer than timeout → LabelaryUpstreamException")
    void detectsConnectionTimeout() {
        labelary.stubFor(post(urlPathMatching("/v1/printers/.*"))
                .willReturn(aResponse()
                        .withFixedDelay(5_000) // 5s > 2s timeout
                        .withStatus(200)
                        .withBody(FAKE_PNG_BYTES)));

        LabelaryUpstreamException ex = assertThrows(
                LabelaryUpstreamException.class,
                () -> labelPreviewService.renderPng(validRequest())
        );
        String msg = ex.getMessage().toLowerCase();
        assertTrue(
                msg.contains("timed out") || msg.contains("timeout"),
                "Exception message should mention a timeout, was: " + ex.getMessage()
        );
    }

    @Test
    @DisplayName("Empty 200 body from Labelary → LabelaryUpstreamException")
    void rejectsEmptyUpstreamBody() {
        labelary.stubFor(post(urlPathMatching("/v1/printers/.*"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "image/png")
                        .withBody(new byte[0])));

        LabelaryUpstreamException ex = assertThrows(
                LabelaryUpstreamException.class,
                () -> labelPreviewService.renderPng(validRequest())
        );
        assertTrue(ex.getMessage().toLowerCase().contains("empty"),
                "Exception message should mention the empty body, was: " + ex.getMessage());
    }

    // ──────────────────────────────────────────────────────────────────
    // Client-side validation (never reaches Labelary)
    // ──────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Unsupported dpmm short-circuits with InvalidZplException")
    void rejectsUnsupportedDpmm() {
        // 10 dpmm is not in the supported set {6, 8, 12, 24}.
        PreviewRequest unsupported = new PreviewRequest(
                "^XA^XZ", 100.0, 50.0, 10, 0
        );

        InvalidZplException ex = assertThrows(
                InvalidZplException.class,
                () -> labelPreviewService.renderPng(unsupported)
        );
        assertTrue(ex.getMessage().contains("Unsupported dpmm"),
                "Message should explicitly name the failed validation: "
                        + ex.getMessage());
        // Defensive: ensure WireMock never received a request.
        labelary.verify(0, com.github.tomakehurst.wiremock.client.WireMock
                .postRequestedFor(urlPathMatching("/v1/printers/.*")));
    }
}
