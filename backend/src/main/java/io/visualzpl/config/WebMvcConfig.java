package io.visualzpl.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 프론트엔드(Vite dev server) 와의 CORS 허용 설정.
 *
 * 운영 환경에서는 동일 도메인 배포를 권장하지만,
 * 개발 중 React (5173) → Spring (8080) 직접 호출을 허용한다.
 */
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins(
                        "http://localhost:5173",   // Vite default
                        "http://localhost:3000"    // CRA / Next dev
                )
                .allowedMethods("GET", "POST", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);
    }
}
