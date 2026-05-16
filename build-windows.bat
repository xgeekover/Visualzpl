@echo off
REM ──────────────────────────────────────────────────────────────────────
REM VisualZPL — Windows packaging script
REM
REM Bundles the React frontend + Spring Boot backend into a single
REM relocatable Windows app directory (out/VisualZPL/) containing
REM VisualZPL.exe and a private JRE produced by jpackage.
REM
REM Prerequisites on the build host:
REM   * JDK 17 or newer (jpackage ships with the JDK)
REM   * Node.js 18 or newer
REM ──────────────────────────────────────────────────────────────────────

setlocal enableextensions

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo === [1/5] Building frontend assets ===
echo.
pushd frontend
call npm install
if errorlevel 1 goto :fail
call npm run build
if errorlevel 1 goto :fail
popd

echo.
echo === [2/5] Copying frontend dist into backend static resources ===
echo.
if exist "backend\src\main\resources\static" rmdir /s /q "backend\src\main\resources\static"
mkdir "backend\src\main\resources\static"
xcopy "frontend\dist" "backend\src\main\resources\static\" /E /Y /I
if errorlevel 1 goto :fail

echo.
echo === [3/5] Building backend Spring Boot JAR ===
echo.
pushd backend
call gradlew.bat clean bootJar
if errorlevel 1 (
    popd
    goto :fail
)
popd

echo.
echo === [4/5] Staging artifact for jpackage ===
echo.
if exist dist-stage rmdir /s /q dist-stage
mkdir dist-stage
for %%F in (backend\build\libs\*.jar) do (
    copy "%%F" "dist-stage\visualzpl-backend.jar" >nul
)

echo.
echo === [5/5] Running jpackage (Windows app-image) ===
echo.
if exist out rmdir /s /q out

REM Notes on the jpackage invocation:
REM   * --main-class points at Spring Boot 3.x JarLauncher (the loader
REM     class moved under .launch in Boot 3.2+).
REM   * Logback's visualzpl.log.dir defaults to ${user.dir}/logs, so
REM     anything Java prints from VisualZPL.exe lands next to the
REM     executable in <install-dir>\logs\visualzpl.log automatically.
REM   * Switch --type to "msi" to produce a Windows installer (requires
REM     WiX Toolset). app-image keeps the directory unpacked.
jpackage ^
    --type app-image ^
    --name VisualZPL ^
    --app-version 0.1.0 ^
    --vendor "VisualZPL Project" ^
    --description "Standalone Lightweight ZPL Label Editor" ^
    --input dist-stage ^
    --main-jar visualzpl-backend.jar ^
    --main-class org.springframework.boot.loader.launch.JarLauncher ^
    --java-options "-Dspring.profiles.active=prod" ^
    --java-options "-Xms256m" ^
    --java-options "-Xmx768m" ^
    --dest out

if errorlevel 1 goto :fail

echo.
echo === Build complete ===
echo Artifact: out\VisualZPL\VisualZPL.exe
echo Copy out\VisualZPL\ to the target host or wrap with WinSW / NSSM.
echo.
endlocal
exit /b 0

:fail
echo.
echo ====================================================
echo Build FAILED at one of the preceding steps. See logs.
echo ====================================================
endlocal
exit /b 1
