$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = 'D:\Android\Sdk' }
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
Set-Location $projectDir
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Gallery build failed' }
& npm.cmd run mobile:assets
if ($LASTEXITCODE -ne 0) { throw 'Asset packaging failed' }
$signingFile = Join-Path $projectDir 'mobile\signing.properties'
if (-not (Test-Path -LiteralPath $signingFile)) {
    $signingDir = Join-Path $env:LOCALAPPDATA 'ColdDrop\signing'
    New-Item -ItemType Directory -Path $signingDir -Force | Out-Null
    $keyFile = Join-Path $signingDir 'colddrop-release.jks'
    if (Test-Path -LiteralPath $keyFile) { throw 'Existing signing key found without signing.properties. Restore its password before rebuilding.' }
    $randomBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($randomBytes)
    $rng.Dispose()
    $password = [Convert]::ToBase64String($randomBytes)
    $env:COLDDROP_KEY_PASSWORD = $password
    & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -keystore $keyFile -alias colddrop -keyalg RSA -keysize 3072 -validity 10000 -storepass:env COLDDROP_KEY_PASSWORD -keypass:env COLDDROP_KEY_PASSWORD -dname 'CN=ColdDrop, OU=Personal, O=Rim, C=PK'
    if ($LASTEXITCODE -ne 0) { throw 'Android signing key generation failed' }
    $portableKey = $keyFile.Replace('\', '/')
    [System.IO.File]::WriteAllText($signingFile, "storeFile=$portableKey`nstorePassword=$password`nkeyPassword=$password`n")
    Remove-Item Env:COLDDROP_KEY_PASSWORD
}
Set-Location (Join-Path $projectDir 'mobile')
& .\gradlew.bat assembleRelease -x test -x lint --no-daemon
if ($LASTEXITCODE -ne 0) { throw 'Android APK packaging failed' }
Copy-Item -LiteralPath (Join-Path $projectDir 'mobile\app\build\outputs\apk\release\app-release.apk') -Destination (Join-Path $projectDir 'artifacts\ColdDrop-1.2.0.apk')
Write-Output 'Created artifacts\ColdDrop-1.2.0.apk'
