/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the Spring Boot preview API.
   *
   * - Local dev default: `http://localhost:8080`
   * - Same-origin deployment: set to an empty string so requests go to `/api/...`
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
