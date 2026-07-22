& {
    $ErrorActionPreference = "Stop"
    Set-StrictMode -Version 2

    if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "rigyn install: node is required"
    }
    $nodeVersion = (& node -p "process.versions.node").Trim()
    $nodeParts = $nodeVersion.Split(".")
    if ($LASTEXITCODE -ne 0 -or $nodeParts.Length -lt 2 -or
        -not (([int]$nodeParts[0] -eq 24 -and [int]$nodeParts[1] -ge 15) -or [int]$nodeParts[0] -ge 26)) {
        throw "rigyn install: Node.js 24.15+ or 26+ is required"
    }
    $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) {
        $npmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue
    }
    if ($null -eq $npmCommand) {
        throw "rigyn install: npm is required"
    }

    $previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
    $temporaryRoot = $null
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $headers = @{ "User-Agent" = "rigyn-bootstrap"; "Accept" = "application/vnd.github+json" }
        $releaseRoot = "https://github.com/rigyn/rigyn/releases"
        $release = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/rigyn/rigyn/releases/latest" `
            -Headers $headers `
            -TimeoutSec 60
        $tag = [string]$release.tag_name
        if ($release.draft -ne $false -or $release.prerelease -ne $false -or
            $tag -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
            throw "rigyn install: GitHub returned invalid latest-release metadata"
        }
        $version = $tag.Substring(1)

        $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("rigyn-install-" + [Guid]::NewGuid().ToString("N"))
        [void](New-Item -ItemType Directory -Path $temporaryRoot)

        function Get-RigynAsset([string]$Uri, [string]$Destination, [long]$MaximumBytes) {
            Invoke-WebRequest -Uri $Uri -Headers @{ "User-Agent" = "rigyn-bootstrap" } -OutFile $Destination -TimeoutSec 300 -UseBasicParsing
            $length = (Get-Item -LiteralPath $Destination).Length
            if ($length -lt 1 -or $length -gt $MaximumBytes) {
                throw "rigyn install: downloaded asset has an invalid size: $([IO.Path]::GetFileName($Destination))"
            }
        }

        $assetRoot = "$releaseRoot/download/$tag"
        $checksumPath = Join-Path $temporaryRoot "SHA256SUMS"
        Get-RigynAsset "$assetRoot/SHA256SUMS" $checksumPath 1048576
        $archiveNames = @(
            "rigyn-terminal-$version.tgz",
            "rigyn-models-$version.tgz",
            "rigyn-kernel-$version.tgz",
            "rigyn-$version.tgz"
        )
        $archivePaths = @()
        foreach ($archiveName in $archiveNames) {
            $archivePath = Join-Path $temporaryRoot $archiveName
            Get-RigynAsset "$assetRoot/$archiveName" $archivePath 268435456
            $archivePaths += $archivePath
        }

        $wanted = @{}
        foreach ($archiveName in $archiveNames) { $wanted[$archiveName] = $true }
        $expected = @{}
        foreach ($line in Get-Content -LiteralPath $checksumPath) {
            if ($line -eq "") { continue }
            $match = [Regex]::Match($line, '^([a-f0-9]{64})  ([^/\\\r\n]+)$')
            if (-not $match.Success) { throw "rigyn install: SHA256SUMS contains an invalid line" }
            $name = $match.Groups[2].Value
            if (-not $wanted.ContainsKey($name)) { continue }
            if ($expected.ContainsKey($name)) { throw "rigyn install: SHA256SUMS repeats $name" }
            $expected[$name] = $match.Groups[1].Value
        }
        foreach ($archivePath in $archivePaths) {
            $name = [IO.Path]::GetFileName($archivePath)
            if (-not $expected.ContainsKey($name)) { throw "rigyn install: SHA256SUMS does not list $name" }
            $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $expected[$name]) { throw "rigyn install: checksum mismatch for $name" }
        }

        $userConfig = Join-Path $temporaryRoot "user.npmrc"
        $globalConfig = Join-Path $temporaryRoot "global.npmrc"
        [IO.File]::WriteAllText($userConfig, "")
        [IO.File]::WriteAllText($globalConfig, "")
        $environmentNames = @(
            "npm_config_audit", "npm_config_cache", "npm_config_fund", "npm_config_global",
            "npm_config_globalconfig", "npm_config_update_notifier", "npm_config_userconfig"
        )
        $previousEnvironment = @{}
        foreach ($name in $environmentNames) {
            $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        }
        try {
            $env:npm_config_audit = "false"
            $env:npm_config_cache = Join-Path $temporaryRoot "npm-cache"
            $env:npm_config_fund = "false"
            $env:npm_config_global = "false"
            $env:npm_config_globalconfig = $globalConfig
            $env:npm_config_update_notifier = "false"
            $env:npm_config_userconfig = $userConfig
            $npmArguments = @("exec", "--yes")
            foreach ($archivePath in $archivePaths) { $npmArguments += "--package=$archivePath" }
            $npmArguments += @("--", "rigyn", "self-install")
            & $npmCommand.Source @npmArguments
            if ($LASTEXITCODE -ne 0) { throw "rigyn install: npm failed with exit $LASTEXITCODE" }
        } finally {
            foreach ($name in $environmentNames) {
                [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
            }
        }

        Write-Output "rigyn $version was installed from its verified GitHub release."
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
        if ($null -ne $temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        }
    }
}
