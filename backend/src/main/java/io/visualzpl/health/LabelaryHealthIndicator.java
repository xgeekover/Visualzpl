package io.visualzpl.health;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Mono;

import java.time.Duration;

/**
 * Custom HealthIndicator that probes the configured Labelary host.
 *
 * Any HTTP response (including 4xx and 5xx) is treated as "host is
 * reachable" because we only care about network reachability for
 * liveness — we are not validating the response code of a fake request.
 *
 * Surfaces under /actuator/health as the "labelary" component, e.g.:
 *
 *   {
 *     "status": "UP",
 *     "components": {
 *       "labelary":  { "status": "UP",  "details": { "upstreamStatus": 404, "latencyMs": 42 } },
 *       "diskSpace": { "status": "UP",  "details": { "free": ... } }
 *     }
 *   }
 */
@Component("labelary")
public class LabelaryHealthIndicator implements HealthIndicator {

    private static final Logger log = LoggerFactory.getLogger(LabelaryHealthIndicator.class);
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(3);

    private final WebClient labelary;

    public LabelaryHealthIndicator(
            @Qualifier("labelaryWebClient") WebClient labelary) {
        this.labelary = labelary;
    }

    @Override
    public Health health() {
        final long startedAtNanos = System.nanoTime();
        try {
            Integer upstreamStatus = labelary.get()
                    .uri("/")
                    .retrieve()
                    .toBodilessEntity()
                    .map(resp -> resp.getStatusCode().value())
                    // 4xx/5xx still proves the host is reachable; turn the
                    // exception into a status code rather than failing.
                    .onErrorResume(
                            WebClientResponseException.class,
                            e -> Mono.just(e.getStatusCode().value()))
                    .block(PROBE_TIMEOUT);

            long elapsedMs = (System.nanoTime() - startedAtNanos) / 1_000_000L;
            return Health.up()
                    .withDetail("upstreamStatus", upstreamStatus)
                    .withDetail("latencyMs", elapsedMs)
                    .build();
        } catch (Exception e) {
            log.warn("Labelary health probe failed: {}", e.getMessage());
            return Health.down()
                    .withDetail("error", e.getMessage())
                    .build();
        }
    }
}
