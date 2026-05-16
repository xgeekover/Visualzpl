package io.visualzpl;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * VisualZPL 백엔드 부트 클래스.
 *
 * 책임:
 *   - REST API 노출 (라벨 미리보기 프록시)
 *   - 외부 Labelary API 호출 추상화
 */
@SpringBootApplication
public class VisualZplApplication {

    public static void main(String[] args) {
        SpringApplication.run(VisualZplApplication.class, args);
    }
}
