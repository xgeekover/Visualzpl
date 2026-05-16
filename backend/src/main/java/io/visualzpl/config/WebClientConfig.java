package io.visualzpl.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.ExchangeStrategies;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.netty.http.client.HttpClient;

import java.time.Duration;

/**
 * Labelary 호출용 WebClient Bean 정의.
 *
 * - PNG 응답을 메모리에 적재할 수 있도록 codec 버퍼 크기를 상향
 * - 연결/응답 타임아웃을 명시
 */
@Configuration
public class WebClientConfig {

    @Bean
    public WebClient labelaryWebClient(
            @Value("${labelary.base-url}") String baseUrl,
            @Value("${labelary.timeout-seconds:10}") long timeoutSec,
            @Value("${labelary.max-response-bytes:5242880}") int maxResponseBytes) {

        ExchangeStrategies strategies = ExchangeStrategies.builder()
                .codecs(c -> c.defaultCodecs().maxInMemorySize(maxResponseBytes))
                .build();

        HttpClient httpClient = HttpClient.create()
                .responseTimeout(Duration.ofSeconds(timeoutSec));

        return WebClient.builder()
                .baseUrl(baseUrl)
                .exchangeStrategies(strategies)
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .build();
    }
}
