@echo off
setlocal
where cl.exe >nul 2>nul
if errorlevel 1 (
    echo Run this script from an x64 Visual Studio Developer Command Prompt.
    exit /b 1
)
pushd "%~dp0"
if not exist "build\multichat" mkdir "build\multichat"
pushd build
lib /nologo /machine:x64 /def:..\native\obs.def /out:obs.lib || exit /b 1
lib /nologo /machine:x64 /def:..\native\obs-frontend-api.def /out:obs-frontend-api.lib || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /MT /LD ..\native\multichat.cpp obs.lib obs-frontend-api.lib winhttp.lib /link /OUT:multichat\multichat.dll /IMPLIB:multichat.lib || exit /b 1
popd
popd
