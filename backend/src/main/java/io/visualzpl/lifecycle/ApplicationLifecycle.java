package io.visualzpl.lifecycle;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Application-level lifecycle hooks for clean Windows Service operation.
 *
 * Responsibilities:
 *   - Emit stable INFO log lines on startup and shutdown so an operator can
 *     correlate Windows Service Manager events with the JVM lifecycle.
 *   - Document a {@link PreDestroy} entry point that runs as part of the
 *     Spring bean destruction phase, just before Logback's own JVM
 *     shutdown hook flushes any buffered log events.
 *
 * Windows Service shutdown sequence:
 *   1. The Service Manager sends a stop signal to the wrapper.
 *   2. The wrapper (WinSW / NSSM / Procrun) sends CTRL+C / SIGTERM to the
 *      JVM.
 *   3. Java fires its registered shutdown hooks. Spring Boot's hook closes
 *      the {@code ApplicationContext}.
 *   4. Embedded Tomcat stops accepting new connections (graceful shutdown
 *      is enabled via {@code server.shutdown: graceful}) and waits for
 *      in-flight requests to complete within
 *      {@code spring.lifecycle.timeout-per-shutdown-phase}.
 *   5. Spring destroys beans — {@code @PreDestroy} methods run here.
 *   6. Logback's shutdown hook flushes file appender buffers.
 *   7. JVM exits.
 */
@Component
public class ApplicationLifecycle {

    private static final Logger log = LoggerFactory.getLogger(ApplicationLifecycle.class);

    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        log.info("VisualZPL backend started and ready to accept requests.");
    }

    @EventListener(ContextClosedEvent.class)
    public void onContextClosed() {
        log.info("Spring context is closing — entering graceful shutdown window.");
    }

    /**
     * Runs after the embedded Tomcat has stopped accepting new requests but
     * before Logback's shutdown hook flushes the file appender, so the
     * message below is guaranteed to land in {@code visualzpl.log}.
     */
    @PreDestroy
    public void onPreDestroy() {
        log.info("VisualZPL backend shutdown complete. All cleanup hooks finished.");
    }
}
