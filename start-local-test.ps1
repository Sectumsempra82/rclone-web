$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$testRoot = Join-Path $PSScriptRoot '.work/local-test'
New-Item -ItemType Directory -Force "$testRoot/config", "$testRoot/data/source/Batch A/nested", "$testRoot/data/source/Batch B", "$testRoot/data/destination" | Out-Null
if (!(Test-Path "$testRoot/password")) {
    $testPassword = [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText("$testRoot/password", $testPassword)
    [IO.File]::WriteAllText("$testRoot/rclone.env", "RCLONE_RC_USER=local-test`nRCLONE_RC_PASS=$testPassword`n")
}
if (!(Test-Path "$testRoot/config/rclone.conf")) {
    [IO.File]::WriteAllText("$testRoot/config/rclone.conf", "[Source]`ntype = alias`nremote = /data/source`n`n[Destination]`ntype = alias`nremote = /data/destination`n")
}
foreach ($sample in @(@('Batch A/small.bin', 1MB), @('Batch A/medium.bin', 16MB), @('Batch A/nested/large.bin', 64MB), @('Batch B/second.bin', 32MB))) {
    $samplePath = Join-Path "$testRoot/data/source" $sample[0]
    if (!(Test-Path $samplePath)) {
        $stream = [IO.File]::Create($samplePath)
        try { $stream.SetLength($sample[1]) } finally { $stream.Dispose() }
    }
}
docker compose -f compose.local.yaml up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed' }
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $null = Invoke-WebRequest 'http://127.0.0.1:5572/' -TimeoutSec 2
        $ready = $true
        break
    } catch { Start-Sleep -Seconds 1 }
}
if (!$ready) { throw 'GUI did not become ready; check docker compose -f compose.local.yaml logs' }
$testPassword = [IO.File]::ReadAllText("$testRoot/password").Trim()
$loginUrl = 'http://127.0.0.1:5572/login?url=http://127.0.0.1:5573&user=local-test&pass=' + [Uri]::EscapeDataString($testPassword)
Start-Process $loginUrl
Write-Host 'GUI: http://127.0.0.1:5572/transfers (browser opens with local test credentials)'
Write-Host 'User: local-test'
Write-Host "Password is saved in $testRoot/password"
Write-Host 'Copy Source folders to Destination to test transfers (limited to 4 MiB/s).'
Write-Host 'Stop: docker compose -f compose.local.yaml down (keeps queue and sample data).'
