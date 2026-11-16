@echo off
REM ==============================================================================
REM SyncTheater - Skrip Remux Cepat MKV (AC3/EAC3/DTS) ke MP4 (AAC Stereo 192kbps)
REM Menyalin stream video 100%% utuh (-c:v copy) tanpa re-encode
REM ==============================================================================

if "%~1"=="" (
    echo Penggunaan: prep-movie.bat "film_asli.mkv" ["film_siap_nobar.mp4"]
    exit /b 1
)

set "INPUT_FILE=%~1"
if not exist "%INPUT_FILE%" (
    echo Error: File "%INPUT_FILE%" tidak ditemukan.
    exit /b 1
)

if "%~2"=="" (
    set "OUTPUT_FILE=%~dpn1_siap_nobar.mp4"
) else (
    set "OUTPUT_FILE=%~2"
)

echo [SyncTheater] Memulai remux video tanpa penurunan kualitas...
echo   Input  : "%INPUT_FILE%"
echo   Output : "%OUTPUT_FILE%"

ffmpeg -y -i "%INPUT_FILE%" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k -ac 2 -movflags +faststart "%OUTPUT_FILE%"

if %ERRORLEVEL% EQU 0 (
    echo [SyncTheater] Selesai! File siap diputar: "%OUTPUT_FILE%"
) else (
    echo [SyncTheater] Terjadi kesalahan saat menjalankan FFmpeg.
)
